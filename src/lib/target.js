// Turn a pasted post link or at:// URI into an at:// URI.
//
// Every Bluesky client serves the same `/profile/<actor>/post/<rkey>` path,
// because they all read the same AppView. So this matches on the path and
// ignores the host, rather than keeping a list of domains that rejects any
// client newer than the list.
//
// A handle-form link carries a handle, and a handle is a rented name: whoever
// holds it today is who the link resolves to. That is fine for a link you
// just copied and wrong for anything stored, so resolution happens here, once,
// and everything downstream carries the DID.

import { APPVIEW } from '../constants.js';
import { fetchWithTimeout } from './atproto.js';
import { resolveMiniDoc } from './slingshot.js';

/** `/profile/<actor>/post/<rkey>`, on any host, with or without trailing junk. */
const WEB_POST = /\/profile\/([^/?#]+)\/post\/([^/?#]+)/;

/** A bare at:// URI, with the collection left open so non-post targets parse. */
const AT_URI = /^at:\/\/(did:[^/]+)\/([^/]+)\/([^/?#]+)/;

/** `did:plc:...` / `did:web:...`. Anything else is a handle. */
const DID = /^did:[a-z]+:/;

/**
 * The full DID syntax. A DID decoded out of a link, or handed back by the
 * AppView, is checked against it, so a `%2F` cannot smuggle a path into the
 * at:// URI built from it.
 */
const DID_SYNTAX = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/;

/** Whether a string is a DID by that syntax. */
export const isDid = (value) => DID_SYNTAX.test(String(value ?? ''));

export class TargetError extends Error {}

/** The DID in `at://did:plc:xxx/collection/rkey`, or null. */
export function authorOf(uri) {
  const m = /^at:\/\/(did:[^/]+)\//.exec(String(uri ?? ''));
  return m ? m[1] : null;
}

/**
 * Resolve a handle to a DID through the AppView.
 *
 * Throws rather than returning null: the caller named this handle on purpose,
 * so one that will not resolve is an error to report, not a silence.
 */
export async function resolveHandle(
  handle,
  { fetchImpl = fetchWithTimeout, signal, appview = APPVIEW } = {},
) {
  const url = `${appview}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
  // When the AppView is down, Slingshot answers from its own copy, checked
  // against the DID document both ways. Only then: "no such handle" from the
  // AppView is an answer, and asking elsewhere could only contradict it.
  const elsewhere = async () =>
    (await resolveMiniDoc(handle, { signal }).catch(() => null))?.did ?? null;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (cause) {
    const did = signal?.aborted ? null : await elsewhere();
    if (did) return did;
    throw new TargetError(`could not reach the AppView to resolve ${handle}`, {
      cause,
    });
  }
  if (!res.ok) {
    const missing = res.status === 400 || res.status === 404;
    const did = missing ? null : await elsewhere();
    if (did) return did;
    throw new TargetError(
      missing
        ? `no account found for handle ${handle}`
        : `the AppView could not resolve ${handle} (HTTP ${res.status})`,
    );
  }
  const body = await res.json().catch(() => null);
  if (!DID_SYNTAX.test(body?.did ?? '')) {
    throw new TargetError(`no DID in the response for ${handle}`);
  }
  return body.did;
}

/**
 * Parse a pasted reference into `{ uri, did, collection, rkey }`.
 *
 * Accepts:
 *   at://did:plc:xxx/app.bsky.feed.post/3abc
 *   https://bsky.app/profile/alice.example.com/post/3abc   (any client host)
 *   https://bsky.app/profile/did:plc:xxx/post/3abc
 *
 * @param {string} input
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [opts]
 */
export async function resolveTarget(input, opts = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new TargetError('nothing to resolve');

  const at = raw.match(AT_URI);
  if (at) {
    const [, did, collection, rkey] = at;
    return { uri: `at://${did}/${collection}/${rkey}`, did, collection, rkey };
  }

  const web = raw.match(WEB_POST);
  if (web) {
    const [, encoded, rkey] = web;
    let actor;
    try {
      actor = decodeURIComponent(encoded);
    } catch {
      actor = null;
    }
    if (actor === null || (DID.test(actor) && !DID_SYNTAX.test(actor))) {
      throw new TargetError(`not a usable account in that link: ${encoded}`);
    }
    const did = DID.test(actor) ? actor : await resolveHandle(actor, opts);
    const collection = 'app.bsky.feed.post';
    return { uri: `at://${did}/${collection}/${rkey}`, did, collection, rkey };
  }

  throw new TargetError(
    'not a post link or at:// URI. Paste a post URL from any Bluesky client, or the at:// URI itself',
  );
}

/**
 * True when `input` looks like something `resolveTarget` can take.
 *
 * Cheap and synchronous, for deciding whether a message names a target at all
 * before spending a handle resolution on it. A `true` here is not a promise
 * that the record exists.
 */
export function looksLikeTarget(input) {
  const raw = String(input ?? '').trim();
  return AT_URI.test(raw) || WEB_POST.test(raw);
}

/**
 * Pull every candidate target out of a free-text message.
 *
 * A DM is prose with a link somewhere in it ("what's the deal with this one
 * <url>"), so the message is scanned rather than parsed. Returns the matched
 * substrings in the order they appear, deduplicated, for the caller to
 * resolve. Brackets, quotes and sentence punctuation around a link are
 * dropped.
 */
export function extractTargets(text) {
  const found = [];
  const seen = new Set();
  for (const token of String(text ?? '').split(/\s+/)) {
    const cleaned = token
      .replace(/^[(<["'\u201c\u2018]+/, '')
      .replace(/[)>\]"'\u201d\u2019,.!?;]+$/, '');
    if (!looksLikeTarget(cleaned) || seen.has(cleaned)) continue;
    seen.add(cleaned);
    found.push(cleaned);
  }
  return found;
}

/**
 * An actor reference (handle or DID) as a DID.
 *
 * Scoring is keyed by DID: `score()` looks profiles up by the exact string it
 * is handed, so a handle passed straight in comes back as an unresolved
 * account rather than an error. Anything taking user input resolves here
 * first.
 */
export async function resolveActor(actor, opts = {}) {
  const raw = String(actor ?? '')
    .trim()
    .replace(/^@/, '');
  if (!raw) throw new TargetError('nothing to resolve');
  if (DID.test(raw)) return raw;
  return resolveHandle(raw, opts);
}
