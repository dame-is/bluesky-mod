// The web panel: a small HTTP server inside the bot's process.
//
// It serves the files in ./public and a JSON API over the bot's store. It is
// off unless PANEL_PORT is set, and listens on this machine only unless
// PANEL_HOST says otherwise (docs/PANEL.md).
//
// Three rules shape it:
//
//  1. Nobody is answered without a session, and a session comes only from a
//     code the bot sent by DM to someone on its roster (auth.js).
//  2. Reads come from the store. The one path that changes the list is the
//     bot's own command path (commands.js), on the bot's job queue.
//  3. Everything the panel shows about other people (handles, names, bios,
//     quotes) was written by them. It leaves here as JSON and the page sets
//     it as text, never as markup.
//
// No framework: node:http, a table of routes, and files read from disk.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  SESSION_COOKIE,
  attemptLimiter,
  codeMessage,
  endSession,
  endSessionsFor,
  issueCode,
  pruneAuth,
  redeemCode,
  sessionFor,
  sessionsFor,
  tierOf,
} from './auth.js';
import { TargetError } from '../lib/target.js';
import { runPanelCommand } from './commands.js';
import { MAX_PER_REQUEST } from './profiles.js';
import * as q from './queries.js';
import { looksLikeJwt, verifyServiceAuth } from './serviceAuth.js';

/**
 * The shape of the JSON API. Raised when a change would break a page or a
 * client written against an older one (docs/API.md).
 */
export const API_VERSION = 1;

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
/** The client package (client/), whose modules the page imports from /client/. */
const CLIENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** Sent with every response. The page loads nothing from anywhere else,
 *  except avatars from the AppView's image host. */
const HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' https://cdn.bsky.app data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const MAX_BODY_BYTES = 64 * 1024;
const MAX_VOUCH_DIDS = 1000;
const DID = /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/;
const CODE = /^[0-9a-f]{8}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const int = (value, fallback, { min = 0, max = 1e6 } = {}) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
    throw new HttpError(415, 'Send JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'That request is too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // Falls through to the error below.
  }
  throw new HttpError(400, 'That request is not a JSON object.');
}

/**
 * Build the panel.
 *
 * @param {object} opts
 * @param {object} opts.settings  config.panel: { port, host, url, sessionDays,
 *   corsOrigins }, and `readOnly` for a dry run: everyone may read, nobody writes
 * @param {object} opts.roster    who is answered and who may write
 * @param {object} opts.deps      what the panel borrows from the running bot:
 *   enqueue(label, job)  run a job on the bot's queue and resolve with its result
 *   writeAgent()         the bot's session, for writes
 *   runCommand           dmLoop.js's runCommand
 *   proposePlan          bulkPlan.js's proposePlan
 *   lookUp(actor)        score one account now
 *   ownerConvo()         the owner's DM conversation id
 *   model()              the model id in use, or null
 *   generate             the model call triage uses
 *   lists()              { multi, lists }: the bot's lists, the main one first
 *   members(uri)         who is on that list by the bot's repo, or null
 *   profiles(dids)       names and faces for DIDs
 *   stopWatch(uri)       stop the watch on a post
 *   status()             what the process is doing
 *   health()             the same, with the disk and the database
 *   settings(session)    the settings worth showing
 *   preflight(link)      score who engaged with a post, storing nothing
 *   rebuild()            start a new follow-graph snapshot: { started, reason }
 *   rescore()            re-score the list now: { started, reason }
 *   shield()             the shield's state, or null where it is not running
 *   runShield(text, o)   shieldDm.js's runShieldCommand
 * @param {Function} [opts.log]
 * @param {Function} [opts.readDoc]  did => DID document, for checking tokens
 */
export function createPanel({ settings, roster, deps, log = () => {}, readDoc }) {
  const limiter = attemptLimiter();
  const secureCookie = /^https:/i.test(settings.url || '');
  const corsOrigins = new Set(settings.corsOrigins || []);

  const json = (res, status, body, extra = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      ...HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(res.cors || {}),
      ...extra,
    });
    res.end(text);
  };

  const sessionCookie = (token, maxAgeS) =>
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}` +
    (secureCookie ? '; Secure' : '');

  /**
   * A request that changes something must come from the panel's own page:
   * the page sends this header, which another site's form cannot, and a
   * browser's Origin must be the panel's. The cookie is SameSite=Strict as
   * well; this does not rest on that alone.
   */
  function assertOwnPage(req) {
    if (req.headers['x-panel-request'] !== '1') {
      throw new HttpError(403, 'That request did not come from the panel.');
    }
    const origin = req.headers.origin;
    if (origin && !ownOrigin(req, origin)) {
      throw new HttpError(403, 'That request came from another site.');
    }
  }

  /**
   * Is this the panel's own address? With PANEL_URL set, that address and no
   * other. Without it, the address the request was sent to, as this server or
   * a proxy in front of it saw it.
   */
  function ownOrigin(req, origin) {
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const allowed = settings.url
      ? [new URL(settings.url).origin]
      : [`http://${req.headers.host}`, ...(forwarded ? [`${forwarded}://${req.headers.host}`] : [])];
    return allowed.includes(origin);
  }

  /**
   * The session a bearer token stands for. Two kinds are taken: a service-auth
   * token from the account's own PDS (serviceAuth.js), and a panel session
   * token, which is what a cookie holds, asked for at sign-in with
   * `"token": true` (docs/API.md).
   */
  async function bearerSession(token) {
    if (looksLikeJwt(token)) {
      let claim;
      try {
        claim = await verifyServiceAuth(token, {
          audience: deps.status().bot?.did || null,
          allow: (did) => Boolean(tierOf(did, roster)),
          ...(readDoc ? { readDoc } : {}),
        });
      } catch (err) {
        throw new HttpError(401, `That token was refused: ${err.message}.`);
      }
      const tier = tierOf(claim.did, roster);
      if (!tier) throw new HttpError(401, 'That account is not one the bot answers.');
      return {
        did: claim.did,
        tier,
        canWrite: tier !== 'reader',
        id: null,
        createdAt: null,
        expiresAt: new Date(claim.exp * 1000).toISOString(),
        via: 'atproto',
      };
    }
    const session = await sessionFor(token, { roster });
    if (!session) throw new HttpError(401, 'That token is wrong or out of date. Sign in again.');
    return { ...session, via: 'token' };
  }

  /** Only the account the bot works for, signed in to write. */
  const needOwner = (session) => {
    if (session.tier !== 'owner' || !session.canWrite) {
      throw new HttpError(403, 'Only the account the bot works for can do that.');
    }
  };

  const members = async (uri) => {
    try {
      return (await deps.members(uri)) || null;
    } catch {
      return null;
    }
  };

  const rkeyOf = (uri) => String(uri || '').split('/').pop() || null;

  /**
   * The bot's lists, the main one first. With one list this is that list and
   * nothing asks which. With several (MOD_MULTI_LIST) a page names the one it
   * wants by its record key, and one that is not there is refused, never
   * swapped for the main list.
   */
  async function listsNow() {
    let got;
    try {
      got = await deps.lists();
    } catch (err) {
      throw new HttpError(502, String(err?.message || err).slice(0, 300));
    }
    const lists = got.lists.map((l) => ({ uri: l.uri, rkey: l.rkey, name: l.name, n: l.n }));
    return { multi: Boolean(got.multi), lists, primary: lists[0] };
  }

  async function chosenList(url) {
    const all = await listsNow();
    const key = url.searchParams.get('list');
    if (!key || !all.multi) return { ...all, list: all.primary };
    const list = all.lists.find((l) => l.rkey === key);
    if (!list) throw new HttpError(404, 'The bot has no list with that key. It may have been deleted.');
    return { ...all, list };
  }

  /** Which list something in the log was on, as a record key. */
  const keyFor = (uri, all) => rkeyOf(uri) || all.primary.rkey;

  const needWrite = (session) => {
    if (!session.canWrite) {
      throw new HttpError(403, 'This account is read-only here.');
    }
  };

  // --- routes ------------------------------------------------------------------
  // `GET /api/x` -> ({ session, url, body }) => what to send as JSON.

  const routes = {
    'GET /api/me': async ({ session }) => {
      const status = deps.status();
      return {
        apiVersion: API_VERSION,
        did: session.did,
        tier: session.tier,
        canWrite: session.canWrite,
        via: session.via || 'cookie',
        expiresAt: session.expiresAt,
        bot: status.bot,
        owner: status.owner,
        hasModel: Boolean(status.model),
        dryRun: Boolean(status.dryRun),
      };
    },

    'GET /api/lists': async () => {
      const all = await listsNow();
      return {
        multi: all.multi,
        lists: all.lists.map(({ rkey, name, n }) => ({ rkey, name, n })),
      };
    },

    'GET /api/overview': async ({ session, url }) => {
      const at = await chosenList(url);
      const out = await q.overview({
        days: int(url.searchParams.get('days'), 30, { min: 7, max: 90 }),
        members: await members(at.list.uri),
        list: at.list.uri,
        primary: at.primary.uri,
        mainMembers: at.list === at.primary ? null : await members(at.primary.uri),
        canWrite: session.canWrite,
      });
      return {
        ...out,
        changes: out.changes.map((e) => ({ ...e, list: keyFor(e.list, at) })),
      };
    },

    'GET /api/health': async () => deps.health(),

    'GET /api/scans': async ({ session, url }) => {
      const state = url.searchParams.get('state');
      const before = String(url.searchParams.get('before') || '');
      return q.scans({
        canWrite: session.canWrite,
        state: ['waiting', 'adding', 'added', 'cancelled', 'undone'].includes(state)
          ? state
          : null,
        before: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(before) ? before : null,
        limit: int(url.searchParams.get('limit'), 60, { min: 1, max: 100 }),
      });
    },

    'POST /api/scans': async ({ body }) => {
      const link = String(body.link || '').trim();
      const kind = String(body.kind || 'everyone');
      if (!link || link.length > 600) throw new HttpError(400, 'Paste a link to a post.');
      if (!['everyone', 'likers', 'reposters', 'repliers', 'quoters'].includes(kind)) {
        throw new HttpError(400, 'That is not a kind of engagement.');
      }
      // A scan reads and stores, and adds nobody, so a read-only account may
      // run one here as it may in a DM.
      try {
        const plan = await deps.enqueue('panel-scan', () => deps.proposePlan({ link, kind }));
        return { code: plan.code };
      } catch (err) {
        // "That is not a post" is the sender's to fix; anything else is the
        // network's.
        throw new HttpError(
          err instanceof TargetError ? 400 : 502,
          `That scan failed: ${String(err?.message || err).slice(0, 200)}`,
        );
      }
    },

    'GET /api/scan': async ({ session, url }) => {
      const code = String(url.searchParams.get('code') || '').toLowerCase();
      const found = CODE.test(code) ? await q.scan(code, session) : null;
      if (!found) throw new HttpError(404, 'There is no plan with that code.');
      // The list its approvals go to, once one has bound it. Only asked for
      // with several lists; with one there is nothing to say.
      const all = await listsNow().catch(() => null);
      const bound = found.list || (found.approved ? all?.primary.uri : null);
      return { ...found, list: all?.multi && bound ? rkeyOf(bound) : null };
    },

    'GET /api/queue': async ({ url }) => {
      const all = await listsNow();
      return q.queue({
        members: await members(all.primary.uri),
        list: all.primary.uri,
        primary: all.primary.uri,
        band: q.CLOSE.includes(url.searchParams.get('band')) ? url.searchParams.get('band') : null,
        offset: int(url.searchParams.get('offset'), 0),
        limit: int(url.searchParams.get('limit'), 30, { min: 1, max: 100 }),
      });
    },

    'POST /api/queue/keep': async ({ session, body }) => {
      needWrite(session);
      if (!DID.test(String(body.did))) throw new HttpError(400, 'Name an account by its DID.');
      await q.keep(body.did, { band: String(body.band || ''), by: session.did });
      return { ok: true };
    },

    'POST /api/queue/reopen': async ({ session, body }) => {
      needWrite(session);
      if (!DID.test(String(body.did))) throw new HttpError(400, 'Name an account by its DID.');
      await q.reopen(body.did);
      return { ok: true };
    },

    'GET /api/list': async ({ url }) => {
      const at = await chosenList(url);
      return q.listPage({
        members: await members(at.list.uri),
        list: at.list.uri,
        primary: at.primary.uri,
        band: url.searchParams.get('band') || null,
        family: url.searchParams.get('family') || null,
        q: String(url.searchParams.get('q') || '').slice(0, 200),
        sort: url.searchParams.get('sort') === 'recent' ? 'recent' : 'closest',
        offset: int(url.searchParams.get('offset'), 0),
        limit: int(url.searchParams.get('limit'), 50, { min: 1, max: 200 }),
      });
    },

    // Who is on the list by the bot's own repo. Lists are public, so any tier.
    'GET /api/list/members': async ({ url }) => {
      const at = await chosenList(url);
      const held = await members(at.list.uri);
      if (!held) throw new HttpError(502, 'The list could not be read just now. Try again in a minute.');
      return { list: at.list.rkey, complete: Boolean(held.complete), dids: held.dids };
    },

    'GET /api/list/radar': async ({ url }) => {
      const at = await chosenList(url);
      return q.listRadar({
        members: await members(at.list.uri),
        list: at.list.uri,
        primary: at.primary.uri,
      });
    },

    'GET /api/activity': async ({ session, url }) => {
      const filter = url.searchParams.get('filter');
      const [all, out] = await Promise.all([
        listsNow(),
        q.activity({
          filter: ['added', 'removed', 'undone'].includes(filter) ? filter : null,
          offset: int(url.searchParams.get('offset'), 0, { max: 5000 }),
          limit: int(url.searchParams.get('limit'), 30, { min: 1, max: 100 }),
          canWrite: session.canWrite,
        }),
      ]);
      return { ...out, events: out.events.map((e) => ({ ...e, list: keyFor(e.list, all) })) };
    },

    // "What are you watching" is answered only for someone who may write,
    // in a DM and here.
    'GET /api/watches': async ({ session }) => {
      needWrite(session);
      return q.watches();
    },

    'POST /api/watches/stop': async ({ session, body }) => {
      needWrite(session);
      const uri = String(body.uri || '');
      if (!/^at:\/\/[^\s]+$/.test(uri)) throw new HttpError(400, 'Name the watched post.');
      const stopped = await deps.enqueue('panel-watch', () => deps.stopWatch(uri));
      return { ok: Boolean(stopped) };
    },

    'GET /api/protected': async ({ url }) =>
      q.protectedPage({
        q: String(url.searchParams.get('q') || '').slice(0, 200),
        offset: int(url.searchParams.get('offset'), 0),
        limit: int(url.searchParams.get('limit'), 50, { min: 1, max: 200 }),
      }),

    'GET /api/graph': async () => q.graph(),

    // Vouch counts from the snapshot: for the accounts named, or the most
    // vouched, for a site's own use of the follow graph.
    'POST /api/graph/vouches': async ({ body }) => {
      const dids = Array.isArray(body.dids) ? body.dids.filter((d) => DID.test(String(d))) : null;
      if (dids && dids.length > MAX_VOUCH_DIDS) {
        throw new HttpError(400, `Ask for at most ${MAX_VOUCH_DIDS} accounts at a time.`);
      }
      return q.vouches({
        dids,
        min: int(body.min, 1, { min: 1, max: 10_000 }),
        limit: int(body.limit, 1000, { min: 1, max: 5000 }),
      });
    },

    'POST /api/graph/rebuild': async ({ session }) => {
      needOwner(session);
      return deps.rebuild();
    },

    'POST /api/rescore': async ({ session }) => {
      needOwner(session);
      return deps.rescore();
    },

    // Who engaged with a post and how close they are, without storing a plan.
    'POST /api/check': async ({ body }) => {
      const link = String(body.link || '').trim();
      if (!link || link.length > 600) throw new HttpError(400, 'Paste a link to a post.');
      try {
        return await deps.enqueue('panel-check', () => deps.preflight(link));
      } catch (err) {
        throw new HttpError(
          err instanceof TargetError ? 400 : 502,
          `That check failed: ${String(err?.message || err).slice(0, 200)}`,
        );
      }
    },

    // What the shield is set to do and what it has limited. Its commands go
    // through POST /api/command, owner only, as in a DM.
    'GET /api/shield': async () => {
      const state = await deps.shield();
      return state || { running: false };
    },

    'GET /api/models': async ({ url }) => {
      const status = deps.status();
      return {
        ...(await q.usage({ days: int(url.searchParams.get('days'), 30, { min: 7, max: 90 }) })),
        provider: status.provider,
        models: status.models,
        mode: status.dmMode,
      };
    },

    'GET /api/people': async ({ session }) => {
      const mine = await sessionsFor(session.did);
      // Who else the bot answers is the owner's to see.
      const others =
        session.tier === 'owner'
          ? roster.all.map((did) => ({ did, tier: tierOf(did, roster) }))
          : [{ did: session.did, tier: session.tier }];
      return { people: others, sessions: mine, current: session.id };
    },

    'GET /api/settings': async ({ session }) => deps.settings(session),

    'GET /api/account': async ({ session, url }) => {
      const actor = String(url.searchParams.get('actor') || '').trim();
      if (!actor || actor.length > 300) throw new HttpError(400, 'Name an account.');
      // Scored now, on the queue, like a lookup in a DM. A lookup that fails
      // still leaves what the log says.
      let live = null;
      let failed = null;
      try {
        live = await deps.enqueue('panel-lookup', () => deps.lookUp(actor));
      } catch (err) {
        failed = String(err?.message || err).slice(0, 200);
      }
      const did = live?.did || (DID.test(actor) ? actor : null);
      if (!did) throw new HttpError(404, failed || 'I could not find that account.');
      const all = await listsNow();
      const history = await q.accountHistory(did, session);
      // Every list they are on, the main one first.
      const onLists = [];
      for (const l of all.lists) {
        const page = await q.listPage({
          members: await members(l.uri),
          list: l.uri,
          primary: all.primary.uri,
          q: did,
          limit: 1,
        });
        if (page.rows[0]) onLists.push({ ...page.rows[0], list: l.rkey });
      }
      return {
        did,
        live,
        failed,
        onLists,
        ...history,
        entries: history.entries.map((e) => ({ ...e, list: keyFor(e.list, all) })),
      };
    },

    'POST /api/profiles': async ({ body }) => {
      const dids = Array.isArray(body.dids) ? body.dids.slice(0, MAX_PER_REQUEST) : [];
      return { profiles: await deps.profiles(dids) };
    },

    'POST /api/command': async ({ session, body }) => {
      if (settings.readOnly) {
        throw new HttpError(403, 'This is a dry run, so the panel only reads. Commands go through once DRY_RUN is off.');
      }
      const out = await runPanelCommand(body.command, session, deps);
      if (!out.ok) throw new HttpError(out.status, out.error);
      q.forgetList();
      log('Ran a command from the panel', {
        action: out.action,
        by: session.tier,
        outcome: out.outcome ?? 'none',
      });
      return out;
    },

    'POST /api/sign-out': async ({ req }) => {
      await endSession(req.bearer && !looksLikeJwt(req.bearer) ? req.bearer : cookieOf(req, SESSION_COOKIE));
      return { ok: true, _headers: { 'Set-Cookie': sessionCookie('', 0) } };
    },

    'POST /api/sign-out-everywhere': async ({ session }) => {
      await endSessionsFor(session.did);
      return { ok: true, _headers: { 'Set-Cookie': sessionCookie('', 0) } };
    },
  };

  async function signIn(req, res) {
    // Another site's page may sign in too, when PANEL_CORS_ORIGINS names it,
    // but only for a token it holds itself: a cookie stays the panel's own.
    const origin = req.headers.origin;
    const crossSite = Boolean(origin && res.cors && !ownOrigin(req, origin));
    if (crossSite) {
      if (req.headers['x-panel-request'] !== '1') {
        throw new HttpError(403, 'That request did not come from a page that may sign in.');
      }
    } else {
      assertOwnPage(req);
    }
    const who = req.socket.remoteAddress || 'unknown';
    // Counted before the body is read, so a burst of requests opened
    // together is held to the limit too. A right code gets its try back.
    const tried = limiter.take(who);
    if (!tried) {
      throw new HttpError(429, 'Too many wrong codes. Wait ten minutes, then ask the bot for a new one.');
    }
    const body = await readJson(req);
    if (crossSite && body.token !== true) {
      throw new HttpError(403, 'Another site may sign in only for a token. Send "token": true.');
    }
    const session = await redeemCode(body.code, {
      sessionDays: settings.sessionDays,
      roster,
    });
    if (!session) {
      throw new HttpError(401, 'That code is wrong, used or out of date. Send the bot "panel" for a new one.');
    }
    tried.refund();
    log('Signed in to the panel', { tier: tierOf(session.did, roster), token: body.token === true });
    if (body.token === true) {
      return json(res, 200, { ok: true, token: session.token, expiresAt: session.expiresAt });
    }
    json(res, 200, { ok: true }, {
      'Set-Cookie': sessionCookie(session.token, Math.round(settings.sessionDays * 86400)),
    });
  }

  async function api(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/sign-in') {
      return signIn(req, res);
    }
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''))?.[1] || null;
    req.bearer = bearer;
    let session = bearer
      ? await bearerSession(bearer)
      : await sessionFor(cookieOf(req, SESSION_COOKIE), { roster });
    if (!session) throw new HttpError(401, 'Sign in first.');
    if (settings.readOnly) session = { ...session, canWrite: false };
    // Past here the caller is someone the bot answers (see `handle`).
    req.signedIn = true;
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) throw new HttpError(404, 'There is nothing at that address.');
    let body = {};
    if (req.method !== 'GET') {
      // A bearer token is sent on purpose, never by a browser on its own, so
      // the check for a forged request is for cookies alone.
      if (!bearer) assertOwnPage(req);
      body = await readJson(req);
    }
    const { _headers, ...out } = (await route({ req, session, url, body })) || {};
    return json(res, 200, out, _headers);
  }

  /** A browser asking whether another site's page may call the API. */
  function preflight(req, res) {
    if (!res.cors) throw new HttpError(403, 'That site may not call this bot.');
    res.writeHead(204, {
      ...res.cors,
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Panel-Request',
      'Access-Control-Max-Age': '600',
    });
    res.end();
  }

  function serveFile(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'Not allowed.');
    }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Bad address.');
    }
    if (rel === '/') rel = '/index.html';
    let root = PUBLIC_DIR;
    if (rel.startsWith('/client/')) {
      // The client's modules, and nothing else from that folder.
      root = CLIENT_DIR;
      rel = rel.slice('/client'.length);
      if (!rel.endsWith('.js') || rel.endsWith('.test.js')) throw new HttpError(404, 'Not found.');
    }
    const file = path.join(root, rel);
    // Inside that folder and nowhere else, whatever the path spells.
    if (!file.startsWith(root + path.sep) || rel.includes('\0')) {
      throw new HttpError(404, 'Not found.');
    }
    const type = TYPES[path.extname(file)];
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
    if (!type || !stat?.isFile()) throw new HttpError(404, 'Not found.');
    const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
    const head = {
      ...HEADERS,
      'Content-Type': type,
      // Asked about on every load, so an update to the bot is an update to
      // the page with no stale copy in between.
      'Cache-Control': 'no-cache',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, head);
      return res.end();
    }
    res.writeHead(200, { ...head, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    // pipeline, not pipe: it closes the file when the browser goes away
    // before the end, where pipe would leave it open for good.
    return pipeline(fs.createReadStream(file), res, () => {});
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://panel.invalid');
      if (url.pathname.startsWith('/api/')) {
        // Another site's page, when PANEL_CORS_ORIGINS names it. Cookies are
        // never allowed across sites, so what it can send is a bearer token.
        const origin = req.headers.origin;
        if (origin && corsOrigins.has(origin)) {
          res.cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
        }
        if (req.method === 'OPTIONS') return preflight(req, res);
        await api(req, res, url);
      } else serveFile(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log('The panel could not answer', { err: String(err?.message || err) });
      if (res.headersSent) return res.end();
      // Why it broke can name a host or a file. Someone signed in is told;
      // anyone else is told only that it broke, and the log has the rest.
      json(res, status, {
        error:
          status !== 500
            ? err.message
            : req.signedIn
              ? `That did not work: ${String(err?.message || err).slice(0, 300)}`
              : 'That did not work. The bot’s log says why.',
      });
    }
  }

  const server = http.createServer(handle);
  // How long a request may take to arrive. The largest is a few kilobytes of
  // JSON, so one that dawdles is not a browser. How long an answer may take
  // is not limited by this: an approval writes for a while before it replies.
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  let pruner = null;

  return {
    handle,
    /** The bot's reply to "panel" from someone on the roster. */
    async codeFor(did) {
      if (!tierOf(did, roster)) return null;
      return codeMessage(await issueCode(did), { url: settings.url });
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(settings.port, settings.host, () => {
          server.off('error', reject);
          // Once now, with the roster: anyone taken off it since the last
          // run loses their sign-ins. Then hourly, for what has run out.
          pruneAuth({ roster }).catch(() => {});
          pruner = setInterval(() => pruneAuth().catch(() => {}), 60 * 60_000);
          if (pruner.unref) pruner.unref();
          resolve(server.address());
        });
      });
    },
    /** Where it is listening, once it is. */
    address: () => server.address(),
    close() {
      if (pruner) clearInterval(pruner);
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
