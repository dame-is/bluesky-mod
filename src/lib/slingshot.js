// A small client for Slingshot (https://slingshot.microcosm.blue), microcosm's
// edge cache of records and identities.
//
// Used where the bot's usual source is down, not instead of it: an identity
// when the PLC directory or the AppView cannot be reached. Slingshot answers
// handle, DID and PDS in one call, and checks the handle against the DID
// document both ways before it answers.
//
// Not used for post text. The AppView's getPosts returns 25 hydrated posts a
// call, which no one-record-a-call cache beats, and measured against real
// pile-ons it left out only posts by suspended accounts (about 1 in 200).
//
// Every call returns null when it could not find out, so callers keep the
// answer they would have given without it. SLINGSHOT_URL=off turns it off.
//
// No import from atproto.js, which falls back to this module: each request
// carries its own ceiling instead.

import { SLINGSHOT_URL } from '../constants.js';

const REQUEST_MS = 10_000;
const DID = /^did:(plc|web):[a-zA-Z0-9._:%-]+$/;

/** Is Slingshot turned on? */
export const slingshotEnabled = () => Boolean(SLINGSHOT_URL);

async function getJson(path, { fetchImpl = fetch, signal, base = SLINGSHOT_URL } = {}) {
  if (!base) return null;
  const timeout = AbortSignal.timeout(REQUEST_MS);
  try {
    const res = await fetchImpl(`${base}${path}`, {
      headers: { Accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * A handle or DID as `{ did, handle, pds }`, verified both ways by Slingshot,
 * or null.
 */
export async function resolveMiniDoc(identifier, opts = {}) {
  if (!identifier) return null;
  const body = await getJson(
    `/xrpc/blue.microcosm.identity.resolveMiniDoc?identifier=${encodeURIComponent(identifier)}`,
    opts,
  );
  if (!DID.test(body?.did ?? '')) return null;
  // Asked by DID, the answer must be that DID.
  if (String(identifier).startsWith('did:') && body.did !== identifier) return null;
  return {
    did: body.did,
    handle: typeof body.handle === 'string' ? body.handle : null,
    pds:
      typeof body.pds === 'string' && /^https:\/\//.test(body.pds)
        ? body.pds.replace(/\/$/, '')
        : null,
  };
}
