// The small slice of AT Protocol plumbing the bot needs without an SDK:
// fetch with a ceiling, and a DID's PDS read from its DID document.

import { PLC_DIRECTORY } from '../constants.js';

// A single request must never wedge a loop that waits on it. Attach a 15s
// abort so a hung fetch rejects instead of hanging forever.
//
// A caller's own signal is kept, but it is not a substitute: it fires when the
// caller gives up, and nothing gives up on a server that has simply stopped
// answering. So the two are combined (`AbortSignal.any`).
const REQUEST_TIMEOUT_MS = 15_000;
function withTimeout(init, ms = REQUEST_TIMEOUT_MS) {
  const base = init || {};
  if (
    typeof AbortSignal === 'undefined' ||
    typeof AbortSignal.timeout !== 'function'
  ) {
    return base;
  }
  const timeout = AbortSignal.timeout(ms);
  if (!base.signal) return { ...base, signal: timeout };
  if (typeof AbortSignal.any !== 'function') return base;
  const signal = AbortSignal.any([base.signal, timeout]);
  // The combined signal holds its sources weakly, and Node 20 lets a pending
  // `AbortSignal.timeout` be collected when nothing else refers to it: after
  // a GC the timeout never fired, and the request hung as if it had none.
  // Hanging it off the signal the request keeps keeps it alive as long as
  // the request is.
  signal.timeoutSignal = timeout;
  return { ...base, signal };
}

/**
 * `fetch` with the same 15s ceiling every request in this module carries, for
 * clients that talk to other services (Constellation) and so can't go through
 * `fetchJson`.
 */
export function fetchWithTimeout(url, init, ms) {
  return fetch(url, withTimeout(init, ms));
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
 */
export async function resolvePds(did) {
  const doc = await getDidDocument(did);
  const services = doc?.service || [];
  // Atproto PDS service id can be `#atproto_pds`.
  const pds =
    services.find((s) => s.id === '#atproto_pds')?.serviceEndpoint ||
    services[0]?.serviceEndpoint;
  if (!pds) throw new Error(`No PDS endpoint for ${did}`);
  return pds.replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// DID documents, cached in memory.
//
// Cached as the PROMISE, not the answer, so a burst of lookups for the same
// DID in one tick shares one request. A lookup that fails is dropped, so the
// next caller asks again rather than inheriting the failure. Ten minutes,
// because what callers read off a DID document (the PDS) moves only on an
// account migration.
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

/**
 * The DID document for a `did:plc` or a `did:web`, through the same cache.
 *
 * A `did:web` is read from its own host.
 */
export async function getDidDocument(did) {
  if (!did) throw new Error('getDidDocument: missing did');
  if (!String(did).startsWith('did:web:')) return getPlcDocument(did);
  const url = didWebDocumentUrl(did);
  if (!url) throw new Error(`Unsupported did:web identifier ${did}`);
  return cachedRead(_didDocCache, did, DID_DOC_TTL, () => fetchJson(url));
}

