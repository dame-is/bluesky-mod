// The moderator account's session, stored and resumed rather than re-created.
//
// `agent.login()` spends com.atproto.server.createSession, which is capped at
// 30 per 5 minutes and 300 per day per account. A process that keeps
// restarting can spend that in an afternoon and lock the account out of its
// own automation. Refreshing a stored session has no such cap.
//
// So: resume from the stored session, let the SDK refresh it, persist whatever
// it hands back, and log in only when the refresh token is dead (expired,
// revoked, or the app password was rotated).
//
// The stored session holds a refresh token, which is a bearer credential for
// the account. It lives in the `bot_session` table, so whoever can read the
// database file can act as the moderator account.

import { AtpAgent } from '@atproto/api';
import { fetchWithTimeout, resolvePds } from '../lib/atproto.js';
import { select, upsert } from './db.js';

/**
 * Where to authenticate when the identifier does not say.
 *
 * Only right for an account Bluesky hosts. createSession at bsky.social for an
 * account it does not host answers "Invalid identifier or password", which
 * reads as a bad app password when the password is fine.
 */
const FALLBACK_SERVICE = 'https://bsky.social';

/** DMs are served by the chat service, not the PDS or the AppView. */
const CHAT_SERVICE_DID = 'did:web:api.bsky.chat';

/**
 * The ceiling on any one request the agent makes, chat included, so a server
 * that stops answering cannot hold the job queue. Generous on purpose: a list
 * write the PDS has taken but not yet answered would otherwise be reported
 * as failed, though sending it again is safe.
 */
const AGENT_REQUEST_MS = 60_000;

/**
 * fetch for the agent, with that ceiling. The library calls it with a Request
 * and no init, and puts a caller's signal on that Request; fetchWithTimeout
 * combines that signal with the ceiling.
 */
function agentFetch(input, init) {
  return fetchWithTimeout(input, init, AGENT_REQUEST_MS);
}

/**
 * The chat-service view of an agent that is already logged in.
 *
 * The plain agent writes to the list and this view reads and sends DMs.
 * `withProxy` wraps the same session, so one createSession covers both.
 */
export function chatView(agent) {
  return agent.withProxy('bsky_chat', CHAT_SERVICE_DID);
}

/**
 * Credentials for the moderator account.
 *
 * `identifier` should be the bot's DID, which src/config.js requires. A
 * handle still logs in, but a handle can change hands and it cannot be
 * checked against the session that comes back.
 */
function credentials() {
  const identifier = process.env.MOD_IDENTIFIER;
  const password = process.env.MOD_APP_PASSWORD;
  if (!identifier || !password) {
    throw new Error('MOD_IDENTIFIER and MOD_APP_PASSWORD must be configured');
  }
  return { identifier, password };
}

/**
 * Whether a session is for the configured account. Only checkable when the
 * identifier is a DID, so a handle passes.
 */
function isExpectedAccount(identifier, session) {
  return !identifier.startsWith('did:') || session?.did === identifier;
}

/**
 * Refuse a session for any account but the configured one.
 *
 * A DID and an app password from two different accounts log in fine (the
 * password is valid, just for someone else), and every write afterwards lands
 * in the wrong repo.
 */
function assertExpectedAccount(identifier, session) {
  if (isExpectedAccount(identifier, session)) return;
  throw new Error(
    `MOD_IDENTIFIER is ${identifier} but the app password authenticated as ${session?.did}; ` +
      'the identifier and the password belong to different accounts',
  );
}

async function readSession() {
  const rows = await select('bot_session', {
    select: 'session',
    eq: { id: 1 },
  });
  return rows?.[0]?.session ?? null;
}

async function writeSession(session) {
  await upsert('bot_session', [
    { id: 1, session, refreshed_at: new Date().toISOString() },
  ]);
}

/**
 * The PDS that holds this account.
 *
 * atproto has no central login: credentials are only valid at the server that
 * hosts the repo, and the DID document says which one that is. MOD_SERVICE
 * overrides, for a PDS whose DID document is unreachable or a local test PDS.
 */
async function serviceFor(identifier) {
  if (process.env.MOD_SERVICE)
    return process.env.MOD_SERVICE.replace(/\/$/, '');
  if (!identifier.startsWith('did:')) return FALLBACK_SERVICE;
  try {
    return await resolvePds(identifier);
  } catch {
    // An unreachable directory should not take the bot offline when the
    // fallback might still be the right answer.
    return FALLBACK_SERVICE;
  }
}

/**
 * An authenticated agent for the moderator account.
 *
 * @param {object} [opts]
 * @param {Function} [opts.onExpired] called when the library drops the session
 *   because a refresh was refused. Every call after that goes out with no
 *   credentials, so a long-running caller has to log in again; see
 *   src/session.js.
 * @returns {Promise<{ agent: object, via: 'resume'|'login' }>}
 */
export async function botAgent({ onExpired = null } = {}) {
  const { identifier, password } = credentials();
  const service = await serviceFor(identifier);

  // persistSession fires on refresh and on login, so every path that produces
  // a usable session writes it back. A failed write is ignored: the session
  // still works for this run, and throwing would turn a storage error into an
  // outage. A session for another account is never written: login hands it
  // over here before the account check below refuses it.
  const agent = new AtpAgent({
    service,
    fetch: agentFetch,
    persistSession: (event, session) => {
      if (event === 'expired') {
        onExpired?.();
        return;
      }
      if (!session || !isExpectedAccount(identifier, session)) return;
      if (event === 'create' || event === 'update') {
        writeSession(session).catch(() => {});
      }
    },
  });

  let via = 'login';
  const stored = await readSession().catch(() => null);
  // A stored session for another account is never resumed. It is left over
  // from a misconfigured run or an earlier bot account, and resuming it would
  // fail the account check below even once the configuration is right.
  const resumable = stored?.refreshJwt && isExpectedAccount(identifier, stored);
  if (resumable) {
    try {
      // resumeSession always refreshes. A dead refresh token is the one
      // failure that falls through to a real login: the library drops the
      // session for it (401, ExpiredToken, InvalidToken, InvalidDID) and keeps
      // it for anything else, such as a network error or a 5xx. Those are
      // thrown, so the caller backs off instead of spending a createSession.
      await agent.resumeSession(stored);
      via = 'resume';
    } catch (err) {
      if (agent.session) throw err;
      via = 'login';
    }
  }

  if (via === 'login') {
    await agent.login({ identifier, password });
  }

  assertExpectedAccount(identifier, agent.session);

  return { agent, via };
}
