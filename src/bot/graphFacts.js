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
/** A failed load is retried sooner than a good one is refreshed. */
const RETRY_MS = 2 * 60_000;
/** How long this process remembers its own writes over Constellation's lag. */
const OWN_WRITES_MS = 10 * 60_000;

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
  { fetchImpl = fetchWithTimeout, maxPages = 400 } = {},
) {
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
    if (!cursor || !(body.records || []).length) return listed;
  }
  return null;
}

/**
 * Everyone who blocks `target`. null means could not tell, including when
 * there are more than `maxPages` pages of them.
 */
async function readBlockers(target = OWNER_DID, { maxPages = 50 } = {}) {
  const out = new Set();
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await getBacklinks(target, BLOCK_SOURCE, {
      limit: 1000,
      cursor,
    });
    if (!res) return null;
    for (const r of res.records || []) if (r?.did) out.add(r.did);
    cursor = res.cursor;
    if (!cursor) return out;
  }
  return null;
}

// --- the held copy -----------------------------------------------------------

let held = null;
let loading = null;
/** did -> { at, rkey } for adds this process made; did -> at for removals. */
const ownAdds = new Map();
const ownRemovals = new Map();

function recent(map, did, now) {
  const at = map.get(did)?.at ?? map.get(did);
  return typeof at === 'number' && now - at < OWN_WRITES_MS;
}

/**
 * The held list and blockers, reloaded when stale. Concurrent callers share
 * one load.
 */
export async function graphFacts({ list, now = Date.now } = {}) {
  const fresh =
    held &&
    held.list === list &&
    now() - held.loadedAt <
      (held.listed && held.blockers ? FACTS_TTL_MS : RETRY_MS);
  if (fresh) return held;
  if (!loading) {
    loading = (async () => {
      const [listed, blockers] = await Promise.all([
        readListed(list).catch(() => null),
        readBlockers(OWNER_DID).catch(() => null),
      ]);
      held = { list, listed, blockers, loadedAt: now() };
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
  return held.listed.has(did);
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
  ownRemovals.delete(did);
  ownAdds.set(did, { at: Date.now(), rkey });
  if (held?.list === list && held.listed) {
    held.listed.set(
      did,
      [...(held.listed.get(did) || []), rkey].filter(Boolean),
    );
  }
}
export function noteUnlisted(list, did) {
  ownAdds.delete(did);
  ownRemovals.set(did, Date.now());
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
