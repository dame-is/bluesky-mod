// The small slice of AT Protocol plumbing the bot needs without an SDK:
// fetch with a ceiling, and a DID's PDS read from its DID document.

import { PLC_DIRECTORY } from '../constants.js';

// A single request must never wedge a loop that waits on it, so every request
// carries a 15s abort. A caller's own signal is kept as well, but it only
// fires when the caller gives up, and nothing gives up on a server that has
// stopped answering. So the two are combined.
const REQUEST_TIMEOUT_MS = 15_000;
function withTimeout(init, ms = REQUEST_TIMEOUT_MS) {
  const base = init || {};
  const timeout = AbortSignal.timeout(ms);
  if (!base.signal) return { ...base, signal: timeout };
  const signal = AbortSignal.any([base.signal, timeout]);
  // The combined signal holds its sources weakly, so a timeout signal nothing
  // else refers to can be collected before it fires, leaving the request with
  // no ceiling. Hanging it off the signal the request keeps keeps it alive.
  signal.timeoutSignal = timeout;
  return { ...base, signal };
}

/**
 * `fetch` with the same 15s ceiling every request in this module carries.
 * A signal in init would replace the one on a Request, so a Request's own
 * signal is the caller's when init has none.
 */
export function fetchWithTimeout(url, init, ms) {
  const signal =
    init?.signal ?? (url instanceof Request ? url.signal : undefined);
  return fetch(url, withTimeout({ ...init, signal }, ms));
}

async function fetchJson(url, init) {
  const res = await fetch(url, withTimeout(init));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url} :: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.url = url;
    throw err;
  }
  return res.json();
}

/**
 * Resolve a DID's PDS endpoint from its DID document: the PLC directory for
 * `did:plc:*`, the host's `/.well-known/did.json` for `did:web:*`.
 * Returns a URL string with no trailing slash.
 *
 * Only the `#atproto_pds` entry counts. A document can list other services,
 * such as a labeler, and the first entry is not necessarily the PDS. A
 * did:web document may write the id in full (`did:web:host#atproto_pds`).
 */
export async function resolvePds(did) {
  const doc = await getDidDocument(did);
  const services = Array.isArray(doc?.service) ? doc.service : [];
  const pds = services.find(
    (s) => typeof s?.id === 'string' && s.id.endsWith('#atproto_pds'),
  )?.serviceEndpoint;
  if (typeof pds !== 'string' || !pds) {
    throw new Error(`No PDS endpoint for ${did}`);
  }
  return pds.replace(/\/$/, '');
}

// DID documents, cached in memory.
//
// The promise is cached rather than the answer, so a burst of lookups for the
// same DID shares one request. A failed lookup is dropped, so the next caller
// asks again rather than inheriting the failure. Ten minutes, because what
// callers read off a DID document (the PDS) changes only when the account
// moves to another host.
const DID_DOC_TTL = 10 * 60_000;
const _didDocCache = new Map(); // did -> { promise, ts }

function cachedRead(cache, key, ttl, read) {
  const held = cache.get(key);
  if (held && Date.now() - held.ts < ttl) return held.promise;
  const promise = read();
  cache.set(key, { promise, ts: Date.now() });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}

/**
 * Fetch the DID document from the PLC directory. `did:plc:*` only; use
 * `getDidDocument` for a DID of either method.
 */
export async function getPlcDocument(did) {
  if (!did) throw new Error('getPlcDocument: missing did');
  return cachedRead(_didDocCache, did, DID_DOC_TTL, () =>
    fetchJson(`${PLC_DIRECTORY}/${encodeURIComponent(did)}`),
  );
}

/**
 * Where a `did:web` keeps its document: `did:web:example.com` →
 * `https://example.com/.well-known/did.json`. A port arrives percent-encoded
 * (`did:web:localhost%3A2583`). Further `:` segments would be a path, which
 * atproto doesn't use for accounts, so those are refused rather than guessed
 * at. `null` for anything that isn't a usable `did:web`.
 */
export function didWebDocumentUrl(did) {
  const m = /^did:web:([^:/?#]+)$/.exec(String(did || ''));
  if (!m) return null;
  const host = m[1].replace(/%3A/gi, ':');
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
  return `https://${host}/.well-known/did.json`;
}

/** The DID document for a `did:plc` or a `did:web`, through the same cache. */
export async function getDidDocument(did) {
  if (!did) throw new Error('getDidDocument: missing did');
  if (!String(did).startsWith('did:web:')) return getPlcDocument(did);
  const url = didWebDocumentUrl(did);
  if (!url) throw new Error(`Unsupported did:web identifier ${did}`);
  return cachedRead(_didDocCache, did, DID_DOC_TTL, () => fetchJson(url));
}
