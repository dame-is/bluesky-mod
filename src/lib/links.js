// Links the bot renders as tappable in a DM.
//
// Facets go only on exact URLs this codebase built, never on any URL found in
// the text. The analyst quotes bios and posts, and a general linkifier would
// end up rendering a stranger's link as tappable inside a moderation report
// about them.

// Record keys and DIDs as atproto defines them. Anything else is not a post
// this code can link to.
const POST_URI =
  /^at:\/\/(did:[a-z]+:[a-zA-Z0-9._:%-]+)\/app\.bsky\.feed\.post\/(?!\.\.?$)([a-zA-Z0-9._:~-]{1,512})$/;

/**
 * The bsky.app URL for an at:// post URI, or null for anything that is not a
 * post, rather than a broken link.
 */
export function postWebUrl(atUri, { handle = null } = {}) {
  const m = POST_URI.exec(String(atUri ?? ''));
  if (!m) return null;
  // A handle when there is one, because a person reading a DM learns nothing
  // from a DID. Handles can change hands, so this suits a link tapped within
  // the hour and not anything stored. Only a DNS-shaped handle is used, so
  // nothing with a path separator or query reaches a tappable URL, and
  // `handle.invalid`, which the AppView reports for a broken handle, falls
  // back to the DID.
  const h = String(handle ?? '');
  const who =
    /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i.test(h) &&
    !/\.invalid$/i.test(h)
      ? h.toLowerCase()
      : m[1];
  return `https://bsky.app/profile/${who}/post/${m[2]}`;
}

/** The handle or DID in a bsky.app post URL, such as one postWebUrl built. */
export function handleInPostUrl(url) {
  const m = /^https:\/\/bsky\.app\/profile\/([^/]+)\/post\/[^/?#]+$/.exec(
    String(url ?? ''),
  );
  return m ? m[1] : null;
}

/**
 * Link facets for the exact URLs in `allow`, wherever they appear in `text`.
 *
 * A URL this code built from an at:// URI looks the same as one the analyst
 * copied out of a stranger's post, so matching by shape is not enough. The
 * caller passes the URLs it built for this message, from a tool result and
 * never from prose, and nothing else is matched.
 *
 * atproto counts facet ranges in UTF-8 bytes, not JS string indices, so an
 * emoji earlier in the message shifts every offset after it.
 */
export function ownLinkFacets(text, { allow = [] } = {}) {
  const s = String(text ?? '');
  // Longest first, so a URL that is a prefix of another cannot take its range.
  const exact = [...new Set((allow || []).filter(Boolean).map(String))].sort(
    (a, b) => b.length - a.length,
  );
  if (!exact.length) return [];

  const re = new RegExp(
    exact.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g',
  );
  const enc = new TextEncoder();
  const facets = [];
  // One pass, so ranges come out in order and never overlap. The server may
  // reject a record whose ranges overlap.
  for (const m of s.matchAll(re)) {
    const byteStart = enc.encode(s.slice(0, m.index)).length;
    const byteEnd = byteStart + enc.encode(m[0]).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }],
    });
  }
  return facets;
}
