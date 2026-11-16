// The Atmosphere MCP server, as a tool the analyst can call.
//
// aturi.to publishes read tools over the atproto network: author feeds,
// threads, post search, identity history, lexicon activity, the atproto docs.
// They let the analyst answer "what has this person been posting about", not
// only "what band are they in".
//
// The server is trusted to report what the network says. The content it
// returns is not: post text, bios and display names are written by the people
// being analysed, so every result goes back to the model fenced, whole, as
// data.
//
// A tool is exposed only if its name starts with a verb that reads. An
// allow-pattern holds up when the server publishes something new, where a
// denylist only covers the writes someone thought of. The client sends no
// credentials, so the server cannot act as the bot either way; the pattern
// keeps the analyst's rule, that it only looks, true whatever is published.
//
// `list_` is a read here: in MCP, `list_records` enumerates. In the bot's own
// tool names "list" means adding someone to the block list, which is why
// agent.test.js treats it as a write. Each guard keeps its own vocabulary.

import { tool } from 'ai';
import { z } from 'zod';
import { untrusted } from './agent.js';

const ATMOSPHERE_URL = 'https://aturi.to/api/mcp';

/** A tool is exposed only if it starts with a verb that reads. */
export const READ_VERB = /^(get|list|search|resolve|describe|read|sample)_/;

/**
 * Per-call ceiling. Most calls answer in about a second, but
 * `sample_jetstream` holds a live firehose window open, and a tool loop can
 * make several calls while the owner watches a DM thread do nothing.
 */
const CALL_TIMEOUT_MS = 20_000;

/**
 * The JSON-RPC message answering request `id`. Streamable HTTP may answer with
 * plain JSON or with an SSE stream, and a stream can carry notifications ahead
 * of the response, so each SSE event is read on its own.
 */
function parseBody(text, id) {
  const events = text
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n'),
    )
    .filter(Boolean);
  if (!events.length) return JSON.parse(text);
  for (const data of events) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      continue;
    }
    // An error about a request the server could not read carries a null id.
    if (message?.id === id || (message?.error && message.id == null)) {
      return message;
    }
  }
  throw new Error('no response in the event stream');
}

/**
 * A client for a stateless MCP server. aturi.to issues no `Mcp-Session-Id` and
 * accepts `tools/call` with no handshake, so there is no session to keep, and
 * a few lines of JSON-RPC do the job of a dependency. A server that issues
 * session ids would need this to track them.
 */
export function createAtmosphereClient({
  url = ATMOSPHERE_URL,
  fetchImpl = fetch,
  timeoutMs = CALL_TIMEOUT_MS,
} = {}) {
  let nextId = 0;

  async function rpc(method, params) {
    const id = (nextId += 1);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`atmosphere ${method} failed: ${res.status}`);
      }
      let body;
      try {
        body = parseBody(await res.text(), id);
      } catch (err) {
        throw new Error(`atmosphere ${method}: ${err.message}`);
      }
      if (body.error) {
        throw new Error(
          `atmosphere ${method}: ${body.error.message || JSON.stringify(body.error)}`,
        );
      }
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    listTools: () => rpc('tools/list', {}),
    callTool: (name, args) =>
      rpc('tools/call', { name, arguments: args || {} }),
  };
}

/** Result content as one string, whatever shape the server used. */
export function flatten(result) {
  const parts = result?.content;
  if (!Array.isArray(parts)) return JSON.stringify(result ?? null);
  return parts
    .map((p) => (typeof p?.text === 'string' ? p.text : JSON.stringify(p)))
    .join('\n');
}

/**
 * A one-line summary for the catalogue. The server's descriptions are prose
 * ("You want an account's recent posts...") several hundred characters long,
 * and the catalogue needs only enough to pick from.
 */
function summarise(description) {
  const first = String(description || '')
    .split(/[.\n]/)[0]
    .replace(/^You (have|want|need|already have)\s*/i, '')
    .trim();
  return first.length > 64 ? `${first.slice(0, 61)}...` : first;
}

/**
 * The allowed remote tools as ONE dispatcher tool. Tool definitions are
 * resent on every step of the loop, and the server's dozens of schemas would
 * cost thousands of tokens a step, including on turns that never touch the
 * network. The dispatcher carries a catalogue of names and fetches a schema
 * only on request, so an unfamiliar tool costs one extra step and every tool
 * stays reachable.
 *
 * A failed call comes back with the tool's schema, so a retry after bad
 * arguments has what it needs.
 */
export function bridgeTools(listed, { call, log = () => {} }) {
  const allowed = new Map();
  const skipped = [];

  for (const t of listed || []) {
    if (!t?.name) continue;
    if (!READ_VERB.test(t.name)) {
      skipped.push(t.name);
      continue;
    }
    allowed.set(t.name, t);
  }
  if (skipped.length) {
    log('Atmosphere tools withheld, not a read verb', { skipped });
  }
  log('Atmosphere tools loaded', { count: allowed.size });
  if (!allowed.size) return {};

  const catalogue = [...allowed.values()]
    .map((t) => `${t.name}: ${summarise(t.description)}`)
    .join('\n');

  const describe = (t) => ({
    tool: t.name,
    description: t.description,
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
  });

  return {
    atmosphere: tool({
      description:
        'Read the atproto network: profiles, author feeds, threads, post search, ' +
        'identity history, lexicon activity, the atproto docs. Read-only. ' +
        "Pass `tool` plus `args`. If you are unsure of a tool's arguments, call " +
        'it with `describe: true` first to get its schema.\n\nAvailable:\n' +
        catalogue,
      inputSchema: z.object({
        tool: z.string().describe('one of the names listed in the description'),
        args: z
          .record(z.string(), z.any())
          .optional()
          .describe('arguments for that tool'),
        describe: z
          .boolean()
          .optional()
          .describe('true to return the schema instead of calling it'),
      }),
      execute: async ({ tool: name, args, describe: wantSchema }) => {
        const t = allowed.get(name);
        if (!t) {
          return `No atmosphere tool called ${name}. Names are listed in this tool's description.`;
        }
        if (wantSchema) return describe(t);
        try {
          const result = await call(name, args || {});
          // Fenced whole. Splitting the structural fields from the prose to
          // trust one half would mean judging which fields are safe on a
          // schema this file does not own.
          return untrusted(`atmosphere:${name}`, flatten(result));
        } catch (err) {
          return {
            error: `The ${name} lookup failed: ${err.message}`,
            ...describe(t),
          };
        }
      },
    }),
  };
}

/**
 * The Atmosphere dispatcher, ready to merge into the analyst's tools. Returns
 * an empty object when the server cannot be reached: the gate's own tools
 * answer every scoring question, and losing the network reads must not stop
 * the owner getting a band back.
 */
export async function loadAtmosphereTools({
  client = createAtmosphereClient(),
  log = () => {},
} = {}) {
  try {
    const listed = await client.listTools();
    return bridgeTools(listed?.tools, {
      call: (name, args) => client.callTool(name, args),
      log,
    });
  } catch (err) {
    log('Atmosphere unavailable, continuing with the gate tools only', {
      err: err.message,
    });
    return {};
  }
}
