// A session for the OWNER's account, for the shield and nothing else.
//
// Who may reply to a post, and whether it may be quoted, are records in the
// post author's own repo (a threadgate and a postgate), so only a session for
// the owner can write them. The bot otherwise holds no credential for the
// owner, and this one is opt-in: MOD_OWNER_APP_PASSWORD, an app password the
// owner can revoke at any time from their own settings. Nothing outside
// gates.js is handed this session, and gates.js writes only those two record
// types (see there).
//
// Stored and resumed like the bot's own session (botAgent.js), in its own
// table, because createSession is capped at 30 per 5 minutes and 300 a day per
// account, and these would be spent from the OWNER's allowance. The stored
// refresh token is a bearer credential for the owner's account, which is one
// more reason the database is private.
//
// Two refusals, both before the session is used for anything:
//   - a session for any account but MOD_OWNER_DID, so a password from the
//     wrong account cannot write gates into someone else's repo;
//   - a session with full account access, which is what the account password
//     (rather than an app password) gives. config.js refuses a value that
//     does not look like an app password; this catches one that does.

import { AtpAgent } from '@atproto/api';
import { fetchWithTimeout, resolvePds } from './lib/atproto.js';
import { select, upsert } from './bot/db.js';

const FALLBACK_SERVICE = 'https://bsky.social';
const REQUEST_MS = 60_000;

function agentFetch(input, init) {
  return fetchWithTimeout(input, init, REQUEST_MS);
}

/**
 * The scope an access token carries, read from its payload, or null when it
 * cannot be read. An app password's session is `com.atproto.appPass` (or
 * `appPassPrivileged`); the account password's is `com.atproto.access`.
 */
export function tokenScope(jwt) {
  try {
    const payload = String(jwt ?? '').split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof json?.scope === 'string' ? json.scope : null;
  } catch {
    return null;
  }
}

/** Why this session must not be used, or null when it may. */
export function sessionProblem(session, ownerDid) {
  if (!session?.did) return 'the owner session has no account';
  if (session.did !== ownerDid) {
    return `MOD_OWNER_APP_PASSWORD authenticated as ${session.did}, not as MOD_OWNER_DID (${ownerDid}); it must be an app password for your own account`;
  }
  if (tokenScope(session.accessJwt) === 'com.atproto.access') {
    return 'MOD_OWNER_APP_PASSWORD is your account password, not an app password. Make an app password (Settings > Privacy and Security > App Passwords) and use that';
  }
  return null;
}

async function readSession() {
  const rows = await select('owner_session', { select: 'session', eq: { id: 1 } });
  return rows?.[0]?.session ?? null;
}

async function writeSession(session) {
  await upsert('owner_session', [
    { id: 1, session, refreshed_at: new Date().toISOString() },
  ]);
}

async function serviceFor(ownerDid) {
  if (process.env.MOD_OWNER_SERVICE) {
    return process.env.MOD_OWNER_SERVICE.replace(/\/$/, '');
  }
  try {
    return await resolvePds(ownerDid);
  } catch {
    return FALLBACK_SERVICE;
  }
}

/**
 * An authenticated agent for the owner's account.
 *
 * @param {object} opts
 * @param {string} opts.ownerDid
 * @param {string} opts.password       MOD_OWNER_APP_PASSWORD
 * @param {Function} [opts.onExpired]  called when the library drops the
 *   session; see session.js
 * @returns {Promise<{ agent: object, via: 'resume'|'login' }>}
 * @throws when the session is for another account or has full access
 */
export async function ownerAgent({ ownerDid, password, onExpired = null }) {
  if (!ownerDid || !password) {
    throw new Error('MOD_OWNER_DID and MOD_OWNER_APP_PASSWORD must both be set');
  }
  const service = await serviceFor(ownerDid);
  const agent = new AtpAgent({
    service,
    fetch: agentFetch,
    persistSession: (event, session) => {
      if (event === 'expired') {
        onExpired?.();
        return;
      }
      // Never stored unless it is a session this module would use.
      if (!session || sessionProblem(session, ownerDid)) return;
      if (event === 'create' || event === 'update') {
        writeSession(session).catch(() => {});
      }
    },
  });

  let via = 'login';
  const stored = await readSession().catch(() => null);
  if (stored?.refreshJwt && stored.did === ownerDid) {
    try {
      await agent.resumeSession(stored);
      via = 'resume';
    } catch (err) {
      // A dead refresh token drops the session and falls through to a login;
      // anything else (a network error, a 5xx) is thrown so the caller backs
      // off instead of spending a createSession.
      if (agent.session) throw err;
    }
  }
  if (via === 'login') {
    await agent.login({ identifier: ownerDid, password });
  }

  const problem = sessionProblem(agent.session, ownerDid);
  // Thrown rather than returned, so nothing downstream ever holds the agent.
  if (problem) throw Object.assign(new Error(problem), { refused: true });
  return { agent, via };
}
