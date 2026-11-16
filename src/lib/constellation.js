// A small client for the Constellation backlinks index
// (https://constellation.microcosm.blue). Every call returns `null` on a
// network or HTTP error, so callers can report "unknown" without wrapping each
// call in try/catch.

import { fetchWithTimeout } from './atproto.js';
import { CONSTELLATION_URL } from '../constants.js';

const RETRY_DELAYS_MS = [1000, 2500, 5000, 10_000];
// The longest a Retry-After is taken at its word. A DM answer waits on these
// calls, and an instance that asks for ten minutes has effectively said no; a
// capped wait still backs off, and the last retry still gives up.
const MAX_RETRY_DELAY_MS = 15_000;

async function fetchJsonOrNull(url, init) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (init?.signal?.aborted) return null;
    try {
      // Each attempt gets its own ceiling. A hung request then fails into the
      // retry below rather than holding up the caller that waits on it.
      const res = await fetchWithTimeout(url, {
        ...init,
        headers: { Accept: 'application/json', ...init?.headers },
      });
      if (res.ok) return await res.json();

      // The public instance is best-effort and rate-limited. Slow down when it
      // asks, rather than turning a 429 into "backlinks unavailable" and
      // throwing away an otherwise healthy harvest.
      const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      if (!retryable || attempt === RETRY_DELAYS_MS.length) return null;
      await wait(retryDelayMs(res, attempt), init?.signal);
    } catch {
      if (init?.signal?.aborted || attempt === RETRY_DELAYS_MS.length) return null;
      await wait(RETRY_DELAYS_MS[attempt], init?.signal);
    }
  }
  return null;
}

function retryDelayMs(response, attempt) {
  const raw = response.headers?.get?.('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return clampDelay(seconds * 1000);
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) return clampDelay(dateMs - Date.now());
  }
  return RETRY_DELAYS_MS[attempt];
}

function clampDelay(ms) {
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, ms));
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      done();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * All sources (collection + record path) that point at `target`, with
 * per-source counts and distinct linking DIDs. `target` can be an AT URI
 * (record) or a bare DID (identity backlinks such as follows and blocks).
 *
 * Shape of `/links/all`:
 *   { links: { "app.bsky.feed.like": { ".subject.uri": { records, distinct_dids } } } }
 */
export async function getBacklinkSources(target, { signal } = {}) {
  if (!target) return null;
  const url = `${CONSTELLATION_URL}/links/all?target=${encodeURIComponent(target)}`;
  return fetchJsonOrNull(url, signal ? { signal } : undefined);
}

/**
 * Paginated backlinks for a (target, source) pair. Returns the raw response,
 * with its rows under `records`, or `null`.
 */
export async function getBacklinks(target, source, { limit = 25, cursor, dids, signal } = {}) {
  if (!target || !source) return null;
  const params = new URLSearchParams({
    subject: target,
    source,
    limit: String(limit),
  });
  if (cursor) params.set('cursor', cursor);
  // Only links made by these accounts: "which of these fifty block the owner"
  // in one request, rather than paging through everyone who does.
  for (const did of dids || []) params.append('did', did);
  const url = `${CONSTELLATION_URL}/xrpc/blue.microcosm.links.getBacklinks?${params}`;
  return fetchJsonOrNull(url, signal ? { signal } : undefined);
}

/**
 * Records that link both to `subject` through `source` and to a second target
 * through `pathToOther`. For list memberships this returns the list URI beside
 * the list-item record, avoiding one repository hydration per membership.
 *
 * Shape:
 *   { items: [{ linkRecord: { did, collection, rkey }, otherSubject }], cursor }
 */
export async function getManyToMany(
  subject,
  source,
  pathToOther,
  { limit = 100, cursor, otherSubject, signal } = {},
) {
  if (!subject || !source || !pathToOther) return null;
  const params = new URLSearchParams({
    subject,
    source,
    pathToOther,
    limit: String(limit),
  });
  // Only links whose other end is this one subject: "is this account on THIS
  // list", answered without paging past every other list they are on.
  if (otherSubject) params.set('otherSubject', otherSubject);
  if (cursor) params.set('cursor', cursor);
  const url = `${CONSTELLATION_URL}/xrpc/blue.microcosm.links.getManyToMany?${params}`;
  return fetchJsonOrNull(url, signal ? { signal } : undefined);
}

/** The `{ did, collection, rkey }` rows out of a `getBacklinks` response. */
export function backlinkRows(page) {
  return page?.records || [];
}

/**
 * Flatten `getBacklinkSources` into
 *   [{ collection, path, source, count, distinctDids }, ...]
 * sorted by count, highest first. Returns `null` if the call failed.
 */
export function flattenSources(raw) {
  if (!raw) return null;
  const out = [];
  for (const [collection, paths] of Object.entries(raw.links || {})) {
    if (!paths || typeof paths !== 'object') continue;
    for (const [path, info] of Object.entries(paths)) {
      const count = info?.records ?? 0;
      const distinctDids = info?.distinct_dids ?? null;
      // `/links/all` gives the path with a leading dot (".subject"), but the
      // `source` parameter of `getBacklinks` takes it without
      // ("app.bsky.graph.follow:subject").
      const sourcePath = path.startsWith('.') ? path.slice(1) : path;
      out.push({
        collection,
        path,
        source: `${collection}:${sourcePath}`,
        count,
        distinctDids,
      });
    }
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}
