// What the network already says about an account before the bot says anything
// about it: is it on the moderation list, and does it already block the owner.
//
// Reads of many accounts at once (a scan, a lookup) use a held copy of the
// list, walked from the bot's repo: a list of several thousand accounts is a
// few dozen pages and a few seconds. A write does not trust that copy, because
// the list can be edited from any client signed in as the bot. A write asks
// Constellation about the one account, in one request, and adds what this
// process wrote in the last few minutes, which Constellation may not have
// indexed yet.
//
// Blocks come from Constellation. A block lives in the blocker's repo with the
// blocked DID as its subject, so "who blocks the owner" is a backlink query,
// paged 1,000 at a time.
//
// Unknown is not "no". Every reader returns null when it could not find out,
// and callers say so rather than reporting a clean record.

import { OWNER_DID } from '../constants.js';
import { fetchWithTimeout, resolvePds } from '../lib/atproto.js';
import { getBacklinks, getManyToMany } from '../lib/constellation.js';

const BLOCK_SOURCE = 'app.bsky.graph.block:subject';
const LISTITEM_SOURCE = 'app.bsky.graph.listitem:subject';

/** How long a walked copy of the list, and the blockers, are trusted for reads. */
const FACTS_TTL_MS = 30 * 60_000;
/**
 * A failed load is retried sooner than a good one is refreshed. One that only
 * ran into a page cap is kept for the full FACTS_TTL_MS: walking it again
 * gives the same answer, and costs hundreds of requests on the job queue.
 * The list and the blockers each keep their own time, so one failing does not
 * send the other to be read again.
 */
const RETRY_MS = 2 * 60_000;
/** How long this process remembers its own writes over Constellation's lag. */
const OWN_WRITES_MS = 10 * 60_000;
/** listRecords pages one walk of the list reads: 40,000 listitems. */
const LIST_MAX_PAGES = 400;

const ownerOf = (uri) =>
  /^at:\/\/(did:[^/]+)\//.exec(String(uri ?? ''))?.[1] ?? null;

/**
 * The listitem rkeys for `did` on `list`, from Constellation.
 *
 * Filtered by `otherSubject`: a popular account is on hundreds of lists, and
 * an unfiltered first page can miss this one entirely. Only records in the
 * list owner's repo count. null means could not tell, never "not listed".
 */
async function listitemRkeys(list, did, { maxPages = 5 } = {}) {
  const owner = ownerOf(list);
  const rkeys = [];
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await getManyToMany(did, LISTITEM_SOURCE, 'list', {
      limit: 100,
      otherSubject: list,
      cursor,
    });
    if (!res) return null;
    for (const i of res.items || []) {
      if (
        i?.linkRecord?.did === owner &&
        i?.linkRecord?.collection === 'app.bsky.graph.listitem' &&
        i?.otherSubject === list
      ) {
        rkeys.push(i.linkRecord.rkey);
      }
    }
    cursor = res.cursor;
    if (!cursor) return rkeys;
  }
  // Still more pages: whatever is true, it is not "none".
  return rkeys.length ? rkeys : null;
}

/**
 * Walk the listitems of `list` in the repo that owns it, up to `maxPages`.
 * `complete` is false when the walk stopped at the cap with more to read.
 * Throws when a page cannot be read; null when the URI names no owner.
 */
async function walkListed(list, { fetchImpl, maxPages }) {
  const owner = ownerOf(list);
  if (!owner) return null;
  const pds = await resolvePds(owner);
  const listed = new Map();
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const q = new URLSearchParams({
      repo: owner,
      collection: 'app.bsky.graph.listitem',
      limit: '100',
    });
    if (cursor) q.set('cursor', cursor);
    const res = await fetchImpl(
      `${pds}/xrpc/com.atproto.repo.listRecords?${q}`,
    );
    if (!res.ok) throw new Error(`listRecords failed: ${res.status}`);
    const body = await res.json();
    for (const rec of body.records || []) {
      if (rec.value?.list !== list || !rec.value?.subject) continue;
      const rkey = String(rec.uri).split('/').pop();
      listed.set(rec.value.subject, [
        ...(listed.get(rec.value.subject) || []),
        rkey,
      ]);
    }
    cursor = body.cursor;
    if (!cursor || !(body.records || []).length) {
      return { listed, complete: true };
    }
  }
  return { listed, complete: false };
}

/**
 * Everyone on `list`, with each one's listitem rkeys, from the repo that owns
 * the list.
 *
 * A public read against that repo's PDS, so it needs no session. Duplicates
 * are kept: an account added by two plans has two listitems, and taking them
 * off the list means deleting both. null when the walk stops at `maxPages`
 * with more to read, since a partial list would call everyone past the cut
 * "not listed".
 */
export async function readListed(
  list,
  { fetchImpl = fetchWithTimeout, maxPages = LIST_MAX_PAGES } = {},
) {
  const walk = await walkListed(list, { fetchImpl, maxPages });
  return walk?.complete ? walk.listed : null;
}

/**
 * Everyone who blocks `target`. null when there are more than `maxPages`
 * pages of them; a throw when Constellation does not answer.
 */
async function readBlockers(target = OWNER_DID, { maxPages = 50 } = {}) {
  const out = new Set();
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await getBacklinks(target, BLOCK_SOURCE, {
      limit: 1000,
      cursor,
    });
    if (!res) throw new Error('Constellation did not answer about blocks');
    for (const r of res.records || []) if (r?.did) out.add(r.did);
    cursor = res.cursor;
    if (!cursor) return out;
  }
  return null;
}

// --- the held copy -----------------------------------------------------------
//
// One copy per list, so multi-list mode can read several lists without each
// read throwing out the last, and one copy of the blockers, which are the
// owner's whatever the list. This process's own writes are kept per list and
// account too: an account added to one list is not on another, and the rkey
// of its listitem on one list must never be offered for a delete on another.

/** list -> { listed, complete, listFailed, listAt } */
const heldLists = new Map();
/** { blockers, blockersFailed, blockersAt } */
let heldBlockers = null;
/** list -> the load in flight for it, shared by concurrent callers. */
const loading = new Map();
/**
 * `${list} ${did}` -> { at, rkey } for adds this process made; the same key ->
 * at for removals. Each is kept in the order written, oldest first, so the
 * ones too old to be read are dropped from the front on every write.
 */
const ownAdds = new Map();
const ownRemovals = new Map();

/** The key own writes are kept under. A space is in neither a URI nor a DID. */
const ownKey = (list, did) => `${list} ${did}`;

const writtenAt = (entry) => entry?.at ?? entry;

function recent(map, key, now) {
  const at = writtenAt(map.get(key));
  return typeof at === 'number' && now - at < OWN_WRITES_MS;
}

function dropOld(map, now) {
  for (const [key, entry] of map) {
    if (now - writtenAt(entry) < OWN_WRITES_MS) return;
    map.delete(key);
  }
}

/** Is a half of the held copy, loaded at `at`, due to be read again? */
const due = (at, failed, now) =>
  at == null || now - at >= (failed ? RETRY_MS : FACTS_TTL_MS);

/** `{ value }`, or `{ failed: true }` when the read threw. */
const settle = (promise) =>
  promise.then(
    (value) => ({ value }),
    () => ({ failed: true }),
  );

/** One list's held copy with the blockers beside it, as callers read it. */
const view = (list) => ({ list, ...heldLists.get(list), ...heldBlockers });

/**
 * The held list and blockers, each reloaded when it is stale. Concurrent
 * callers for the same list share one load.
 *
 * A list longer than the walk reads is held as far as it got, with
 * `complete: false`: an account it saw is listed, and one it did not reach is
 * unknown rather than unlisted.
 */
export async function graphFacts({ list, now = Date.now } = {}) {
  const t = now();
  const mine = heldLists.get(list);
  const listDue = !mine || due(mine.listAt, mine.listFailed, t);
  const blockersDue =
    !heldBlockers ||
    due(heldBlockers.blockersAt, heldBlockers.blockersFailed, t);
  if (!listDue && !blockersDue) return view(list);
  if (!loading.has(list)) {
    loading.set(
      list,
      (async () => {
        const [walk, blockers] = await Promise.all([
          listDue
            ? settle(
                walkListed(list, {
                  fetchImpl: fetchWithTimeout,
                  maxPages: LIST_MAX_PAGES,
                }),
              )
            : null,
          blockersDue ? settle(readBlockers(OWNER_DID)) : null,
        ]);
        const at = now();
        if (walk) {
          heldLists.set(list, {
            listed: walk.value?.listed ?? null,
            complete: Boolean(walk.value?.complete),
            listFailed: Boolean(walk.failed),
            listAt: at,
          });
        }
        if (blockers) {
          heldBlockers = {
            blockers: blockers.value ?? null,
            blockersFailed: Boolean(blockers.failed),
            blockersAt: at,
          };
        }
        return view(list);
      })().finally(() => {
        loading.delete(list);
      }),
    );
  }
  return loading.get(list);
}

/**
 * Is `did` on the list, as far as the held copy and this process's own writes
 * know? true, false, or null for could not tell. For reading, not for writing.
 */
export function isListed(list, did, { now = Date.now() } = {}) {
  const key = ownKey(list, did);
  if (recent(ownAdds, key, now)) return true;
  if (recent(ownRemovals, key, now)) return false;
  const held = heldLists.get(list);
  if (!held?.listed) return null;
  if (held.listed.has(did)) return true;
  return held.complete ? false : null;
}

/** Does `did` block the owner, as far as the held copy knows? null if unknown. */
export function blocksMe(did) {
  if (!heldBlockers?.blockers) return null;
  return heldBlockers.blockers.has(did);
}

/** Set-like views for the scorer, which only ever calls `.has`. */
export function listedView(list) {
  return { has: (did) => isListed(list, did) === true };
}
/** On any of these lists, for a reader that counts every list as one. */
export function listedOnAnyView(lists) {
  return { has: (did) => lists.some((list) => isListed(list, did) === true) };
}
export function blockersView() {
  return { has: (did) => blocksMe(did) === true };
}

/**
 * The held copy of the list as it stands, without reading anything: who is
 * on it, whether the walk reached the end, and when it was walked. Null when
 * nothing is held. For the panel, which would rather show a list that is a
 * few minutes old than wait behind a job.
 */
export function heldListed(list) {
  const held = heldLists.get(list);
  if (!held?.listed) return null;
  return { listed: held.listed, complete: Boolean(held.complete), at: held.listAt };
}

/** Record a write this process made, so reads and the next write see it. */
export function noteListed(list, did, rkey = null) {
  const now = Date.now();
  const key = ownKey(list, did);
  ownRemovals.delete(key);
  ownAdds.delete(key);
  ownAdds.set(key, { at: now, rkey });
  dropOld(ownAdds, now);
  dropOld(ownRemovals, now);
  const held = heldLists.get(list);
  if (held?.listed) {
    held.listed.set(
      did,
      [...(held.listed.get(did) || []), rkey].filter(Boolean),
    );
  }
}
export function noteUnlisted(list, did) {
  const now = Date.now();
  const key = ownKey(list, did);
  ownAdds.delete(key);
  ownRemovals.delete(key);
  ownRemovals.set(key, now);
  dropOld(ownAdds, now);
  dropOld(ownRemovals, now);
  heldLists.get(list)?.listed?.delete(did);
}

/**
 * The listitem rkeys to act on for one write: Constellation's answer, plus an
 * add this process made too recently to be indexed, minus a removal likewise.
 * Falls back to walking the repo when Constellation cannot say. null means
 * nobody could tell.
 *
 * `walk: false` skips that fallback, for a caller asking about many accounts at
 * once: fifty lookups each walking the repo is fifty walks where it wanted one.
 */
export async function rkeysForWrite(
  list,
  did,
  { now = Date.now(), walk = true } = {},
) {
  let rkeys = await listitemRkeys(list, did).catch(() => null);
  if (rkeys === null && walk) {
    const listed = await readListed(list).catch(() => null);
    rkeys = listed ? listed.get(did) || [] : null;
  }
  if (rkeys === null) return null;
  // Anything Constellation still shows after a recent removal was deleted
  // after it was indexed.
  if (recent(ownRemovals, ownKey(list, did), now)) rkeys = [];
  const own = ownAdds.get(ownKey(list, did));
  if (
    own &&
    now - own.at < OWN_WRITES_MS &&
    own.rkey &&
    !rkeys.includes(own.rkey)
  ) {
    rkeys = [...rkeys, own.rkey];
  }
  return rkeys;
}

/** For tests. */
export function resetGraphFacts() {
  heldLists.clear();
  heldBlockers = null;
  loading.clear();
  ownAdds.clear();
  ownRemovals.clear();
}

/** For tests: how many of this process's own writes are held. */
export function ownWritesHeld() {
  return ownAdds.size + ownRemovals.size;
}
