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

let held = null;
let loading = null;
/**
 * did -> { at, rkey } for adds this process made; did -> at for removals.
 * Each is kept in the order written, oldest first, so the ones too old to be
 * read are dropped from the front on every write.
 */
const ownAdds = new Map();
const ownRemovals = new Map();

const writtenAt = (entry) => entry?.at ?? entry;

function recent(map, did, now) {
  const at = writtenAt(map.get(did));
  return typeof at === 'number' && now - at < OWN_WRITES_MS;
}

function dropOld(map, now) {
  for (const [did, entry] of map) {
    if (now - writtenAt(entry) < OWN_WRITES_MS) return;
    map.delete(did);
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

/**
 * The held list and blockers, each reloaded when it is stale. Concurrent
 * callers share one load.
 *
 * A list longer than the walk reads is held as far as it got, with
 * `complete: false`: an account it saw is listed, and one it did not reach is
 * unknown rather than unlisted.
 */
export async function graphFacts({ list, now = Date.now } = {}) {
  const t = now();
  const listDue =
    !held || held.list !== list || due(held.listAt, held.listFailed, t);
  const blockersDue = !held || due(held.blockersAt, held.blockersFailed, t);
  if (!listDue && !blockersDue) return held;
  if (!loading) {
    loading = (async () => {
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
      held = { ...held };
      if (walk) {
        Object.assign(held, {
          list,
          listed: walk.value?.listed ?? null,
          complete: Boolean(walk.value?.complete),
          listFailed: Boolean(walk.failed),
          listAt: at,
        });
      }
      if (blockers) {
        Object.assign(held, {
          blockers: blockers.value ?? null,
          blockersFailed: Boolean(blockers.failed),
          blockersAt: at,
        });
      }
      return held;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

/**
 * Is `did` on the list, as far as the held copy and this process's own writes
 * know? true, false, or null for could not tell. For reading, not for writing.
 */
export function isListed(list, did, { now = Date.now() } = {}) {
  if (recent(ownAdds, did, now)) return true;
  if (recent(ownRemovals, did, now)) return false;
  if (!held || held.list !== list || !held.listed) return null;
  if (held.listed.has(did)) return true;
  return held.complete ? false : null;
}

/** Does `did` block the owner, as far as the held copy knows? null if unknown. */
export function blocksMe(did) {
  if (!held?.blockers) return null;
  return held.blockers.has(did);
}

/** Set-like views for the scorer, which only ever calls `.has`. */
export function listedView(list) {
  return { has: (did) => isListed(list, did) === true };
}
export function blockersView() {
  return { has: (did) => blocksMe(did) === true };
}

/** Record a write this process made, so reads and the next write see it. */
export function noteListed(list, did, rkey = null) {
  const now = Date.now();
  ownRemovals.delete(did);
  ownAdds.delete(did);
  ownAdds.set(did, { at: now, rkey });
  dropOld(ownAdds, now);
  dropOld(ownRemovals, now);
  if (held?.list === list && held.listed) {
    held.listed.set(
      did,
      [...(held.listed.get(did) || []), rkey].filter(Boolean),
    );
  }
}
export function noteUnlisted(list, did) {
  const now = Date.now();
  ownAdds.delete(did);
  ownRemovals.delete(did);
  ownRemovals.set(did, now);
  dropOld(ownAdds, now);
  dropOld(ownRemovals, now);
  if (held?.list === list && held.listed) held.listed.delete(did);
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
  if (recent(ownRemovals, did, now)) rkeys = [];
  const own = ownAdds.get(did);
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
  held = null;
  loading = null;
  ownAdds.clear();
  ownRemovals.clear();
}

/** For tests: how many of this process's own writes are held. */
export function ownWritesHeld() {
  return ownAdds.size + ownRemovals.size;
}
