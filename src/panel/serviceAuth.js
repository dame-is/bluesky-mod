// Signing in with an atproto account, for an admin page on another site.
//
// A site that already signs its owner in with atproto OAuth can ask the
// owner's PDS for a short-lived token addressed to the bot
// (com.atproto.server.getServiceAuth, with `aud` the bot's DID and `lxm` one
// of the two below) and send it as `Authorization: Bearer <token>`. The token
// is signed with the account's own key, which is checked here against the key
// in its DID document. Nothing is shared between the site and the bot, so
// there is no secret to leak, and a token stops working within minutes.
//
// Who the account is to the bot (owner, writer, reader, or nobody) is still
// read from the roster, as for a DM or a panel cookie. The token's `lxm` can
// only narrow that: a read token never writes, whoever holds it.

import { parseDidKey, verifySignature } from '@atproto/crypto';

import { LXM } from '../../client/api.js';
import { PLC_DIRECTORY } from '../constants.js';
import { didWebDocumentUrl, fetchWithTimeout } from '../lib/atproto.js';

/** The two methods a token may be scoped to, as the client names them. */
export { LXM };

/** Tokens that claim to live longer than this are refused, whatever `exp` says. */
const MAX_LIFETIME_MS = 10 * 60_000;
/** How far a clock may be ahead of this one. */
const SKEW_MS = 60_000;
/** How long a signing key is trusted before its document is read again. */
const KEY_TTL_MS = 60_000;
/** A key read this recently is not read again, so forged tokens cannot make the bot fetch a document per request. */
const REREAD_AFTER_MS = 5_000;

const DID = /^did:(plc:[a-z0-9]+|web:[a-zA-Z0-9.%-]+)$/;

/** Does this look like a JWT, as opposed to a panel session token? */
export const looksLikeJwt = (token) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(String(token || ''));

async function readDidDocument(did) {
  const url = did.startsWith('did:web:')
    ? didWebDocumentUrl(did)
    : `${PLC_DIRECTORY}/${encodeURIComponent(did)}`;
  if (!url) throw new Error(`cannot read the DID document for ${did}`);
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`could not read the DID document for ${did}`);
  return res.json();
}

/** The account's signing key, as a did:key, from its DID document. */
function keyFrom(doc, did) {
  const vm = (doc?.verificationMethod || []).find(
    (m) => m?.id === `${did}#atproto` || m?.id === '#atproto',
  );
  if (!vm?.publicKeyMultibase) throw new Error(`${did} publishes no atproto signing key`);
  return `did:key:${vm.publicKeyMultibase}`;
}

// Keys are held a minute. A key that verifies nothing is read again at once,
// so a rotated key works on the next request; a key rotated away because it
// leaked is trusted for at most that minute.
const keys = new Map(); // did -> { at, promise }

function cachedKey(did, readDoc, { fresh = false } = {}) {
  const held = keys.get(did);
  const age = held ? Date.now() - held.at : Infinity;
  if (age < (fresh ? REREAD_AFTER_MS : KEY_TTL_MS)) return held.promise;
  const promise = Promise.resolve(readDoc(did)).then((doc) => keyFrom(doc, did));
  keys.set(did, { at: Date.now(), promise });
  promise.catch(() => {
    if (keys.get(did)?.promise === promise) keys.delete(did);
  });
  return promise;
}

/** Forget the held keys. For tests. */
export function forgetKeys() {
  keys.clear();
}

const b64 = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/**
 * Check a service-auth token.
 *
 * Cheap checks first, the signature last: issuer, audience, method, expiry,
 * lifetime, algorithm, then the key from the DID document.
 *
 * @param {string} token
 * @param {object} opts
 * @param {string} opts.audience  the bot's DID
 * @param {Function} [opts.readDoc]  did => its DID document
 * @returns {Promise<{ did: string, scope: 'read'|'write', exp: number }>}
 */
export async function verifyServiceAuth(
  token,
  { audience, readDoc = readDidDocument, now = Date.now() } = {},
) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  let header;
  let payload;
  try {
    header = b64(parts[0]);
    payload = b64(parts[1]);
  } catch {
    throw new Error('malformed token');
  }
  if (!audience) throw new Error('the bot is not signed in yet');

  const iss = String(payload?.iss || '');
  if (!DID.test(iss)) throw new Error('the token names no account');
  const aud = String(payload.aud || '');
  // A PDS may address the token to the DID or to one of its services.
  if (aud !== audience && !aud.startsWith(`${audience}#`)) {
    throw new Error('the token was made for another service');
  }
  const scope = payload.lxm === LXM.write ? 'write' : payload.lxm === LXM.read ? 'read' : null;
  if (!scope) throw new Error(`the token is for ${payload.lxm || 'nothing'}, not ${LXM.read} or ${LXM.write}`);

  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) {
    throw new Error('the token has expired');
  }
  if (payload.exp * 1000 - now > MAX_LIFETIME_MS) {
    throw new Error('the token lives longer than ten minutes');
  }
  if (typeof payload.iat === 'number' && payload.iat * 1000 > now + SKEW_MS) {
    throw new Error('the token was made in the future');
  }

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = new Uint8Array(Buffer.from(parts[2], 'base64url'));
  const check = async (didKey) => {
    if (header?.alg !== parseDidKey(didKey).jwtAlg) return false;
    // Non-malleable signatures only: a high-S copy of a captured token would
    // otherwise be a second valid token.
    return verifySignature(didKey, signed, sig, { allowMalleableSig: false });
  };
  let ok = await check(await cachedKey(iss, readDoc));
  if (!ok) ok = await check(await cachedKey(iss, readDoc, { fresh: true }));
  if (!ok) throw new Error('bad signature');

  return { did: iss, scope, exp: payload.exp };
}
