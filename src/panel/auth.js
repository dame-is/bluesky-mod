// Who may open the panel, and how they prove it.
//
// The panel has no password of its own. The bot already knows who it works
// for: the roster (src/lib/senders.js), checked by DID on every DM. So signing
// in is a DM. Someone on the roster sends the bot the word "panel", the bot
// answers with a code, and the code typed into the sign-in page becomes a
// cookie. Whoever can read that person's DMs with the bot could already tell
// it what to do, so the code hands out nothing new.
//
// A session carries the DID it was issued to and nothing else. What that DID
// may do is read from the roster on every request, so someone taken off the
// roster loses the panel at the next restart, like the DMs.
//
// Codes and session tokens are stored as SHA-256 hashes. A code is eight
// digits and lives ten minutes, so the hash protects it from a glance at the
// table and not from a search; the guard on guessing is the attempt limit in
// server.js.

import crypto from 'node:crypto';

import { select, upsert, update, del } from '../bot/db.js';

export const CODE_TTL_MS = 10 * 60_000;
export const SESSION_COOKIE = 'bm_panel';
const CODE_DIGITS = 8;
const DAY_MS = 24 * 60 * 60_000;
/** How often a session's last-seen time is written, at most. */
const TOUCH_EVERY_MS = 5 * 60_000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

/** Eight digits from the system's randomness. */
export function newCode() {
  return String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

/** "4821 9357", as it is shown and as most people will type it. */
export const formatCode = (code) => `${code.slice(0, 4)} ${code.slice(4)}`;

/** What someone typed, as the eight digits in it, or null. */
export function readCode(typed) {
  const digits = String(typed ?? '').replace(/[\s-]+/g, '');
  return /^\d{8}$/.test(digits) ? digits : null;
}

/**
 * Who this DID is to the bot: 'owner', 'writer' (may change the list),
 * 'reader' (answered, read-only), or null for someone the bot does not
 * answer at all.
 */
export function tierOf(did, roster) {
  if (!roster?.answers(did)) return null;
  if (did === roster.owner) return 'owner';
  return roster.writes(did) ? 'writer' : 'reader';
}

// Issuing and redeeming run one at a time, so two requests carrying the same
// code cannot both read it as unused.
let gate = Promise.resolve();
const oneAtATime = (fn) => {
  const next = gate.then(fn, fn);
  gate = next.catch(() => {});
  return next;
};

/**
 * A new code for `did`. Asking again replaces the one before, so only the
 * newest message in the DM works.
 */
export function issueCode(did, { now = Date.now() } = {}) {
  return oneAtATime(async () => {
    await del('panel_code', { eq: { did } });
    const code = newCode();
    await upsert('panel_code', [
      {
        code_hash: sha(code),
        did,
        created_at: iso(now),
        expires_at: iso(now + CODE_TTL_MS),
        used_at: null,
      },
    ]);
    return code;
  });
}

/** The bot's reply to "panel". `url` is where the panel lives, when known. */
export function codeMessage(code, { url = '' } = {}) {
  const where = url ? `Type it at ${url}` : "Type it on the panel's sign-in page";
  return `Your panel code is ${formatCode(code)}. ${where}. It works once, for ten minutes.`;
}

/**
 * Exchange a typed code for a session. Null for a code that is wrong, used
 * or out of date, and for one whose account has left the roster.
 *
 * @returns {Promise<null | { token: string, did: string, expiresAt: string }>}
 */
export function redeemCode(
  typed,
  { now = Date.now(), sessionDays = 30, roster = null } = {},
) {
  const code = readCode(typed);
  if (!code) return Promise.resolve(null);
  return oneAtATime(async () => {
    const [row] =
      (await select('panel_code', { eq: { code_hash: sha(code) } })) || [];
    if (!row || row.used_at || !(Date.parse(row.expires_at) > now)) return null;
    await update(
      'panel_code',
      { eq: { code_hash: row.code_hash } },
      { used_at: iso(now) },
    );
    if (roster && !tierOf(row.did, roster)) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = iso(now + sessionDays * DAY_MS);
    await upsert('panel_session', [
      {
        token_hash: sha(token),
        did: row.did,
        created_at: iso(now),
        expires_at: expiresAt,
        last_seen_at: iso(now),
      },
    ]);
    return { token, did: row.did, expiresAt };
  });
}

/**
 * The session a cookie names, with what its account may do today.
 *
 * @returns {Promise<null | { did: string, tier: string, canWrite: boolean,
 *   id: string, createdAt: string, expiresAt: string }>}
 */
export async function sessionFor(token, { now = Date.now(), roster } = {}) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const hash = sha(token);
  const [row] = (await select('panel_session', { eq: { token_hash: hash } })) || [];
  if (!row || !(Date.parse(row.expires_at) > now)) return null;
  const tier = tierOf(row.did, roster);
  if (!tier) {
    // Off the roster: their sign-ins are forgotten, so putting them back on
    // it later does not bring an old cookie back to life.
    await endSessionsFor(row.did).catch(() => {});
    return null;
  }
  if (!(now - Date.parse(row.last_seen_at || 0) < TOUCH_EVERY_MS)) {
    await update(
      'panel_session',
      { eq: { token_hash: hash } },
      { last_seen_at: iso(now) },
    ).catch(() => {});
  }
  return {
    did: row.did,
    tier,
    canWrite: tier !== 'reader',
    // The first characters of the hash: enough to tell two sessions apart in
    // a list, and no use as a credential.
    id: hash.slice(0, 12),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** Sign out: forget this one cookie. */
export async function endSession(token) {
  if (!token) return;
  await del('panel_session', { eq: { token_hash: sha(token) } });
}

/**
 * Sign out everywhere: forget every cookie issued to this account, and any
 * code it asked for and has not used.
 */
export async function endSessionsFor(did) {
  await del('panel_session', { eq: { did } });
  await del('panel_code', { eq: { did } });
}

/** This account's sign-ins, newest first, for "where am I signed in". */
export async function sessionsFor(did, { now = Date.now() } = {}) {
  const rows = await select('panel_session', {
    select: 'token_hash,created_at,expires_at,last_seen_at',
    eq: { did },
    order: 'created_at.desc',
    limit: 50,
  });
  return (rows || [])
    .filter((r) => Date.parse(r.expires_at) > now)
    .map((r) => ({
      id: r.token_hash.slice(0, 12),
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
    }));
}

/**
 * Clear codes and sessions that are out of date, and with `roster` those of
 * anyone no longer on it. The roster is read from the environment at start,
 * so this at start is what makes taking someone off it final.
 */
export async function pruneAuth({ now = Date.now(), roster = null } = {}) {
  const cut = iso(now);
  await del('panel_code', { where: { expires_at: `lt.${cut}` } });
  await del('panel_session', { where: { expires_at: `lt.${cut}` } });
  if (!roster) return;
  for (const table of ['panel_session', 'panel_code']) {
    const rows = (await select(table, { select: 'did' })) || [];
    for (const did of new Set(rows.map((r) => r.did))) {
      if (!tierOf(did, roster)) await del(table, { eq: { did } });
    }
  }
}

/**
 * A limit on wrong codes: `max` per `windowMs` for one address, and five
 * times that for everyone together, so many addresses cannot share a search.
 * Kept in memory. A restart forgets it, and a restart also takes longer than
 * the tries it would buy.
 */
export function attemptLimiter({ max = 5, windowMs = 10 * 60_000 } = {}) {
  const byKey = new Map();
  const recent = (key, now) => {
    const kept = (byKey.get(key) || []).filter((t) => now - t < windowMs);
    if (kept.length) byKey.set(key, kept);
    else byKey.delete(key);
    return kept;
  };
  return {
    /**
     * Count a try from this address, before its code is read. Null when the
     * address, or everyone together, is over the limit. Counted at the start
     * so that tries opened together are each counted before any is answered;
     * `refund` gives the try back when the code turned out right.
     */
    take(key, now = Date.now()) {
      if (recent(key, now).length >= max || recent('*', now).length >= max * 5) {
        return null;
      }
      for (const k of [key, '*']) byKey.set(k, [...recent(k, now), now]);
      return {
        refund() {
          for (const k of [key, '*']) {
            const kept = byKey.get(k) || [];
            const i = kept.indexOf(now);
            if (i !== -1) kept.splice(i, 1);
            if (!kept.length) byKey.delete(k);
          }
        },
      };
    },
  };
}
