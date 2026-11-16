// Does this firehose event mean "analyst, look at this"?
//
// Pure, because this function IS the security boundary for the public path:
// everything downstream of a `true` here posts to the network under the
// moderator account's name, and a boundary you cannot exercise in a test is a
// boundary you are hoping about.
//
// The author is checked here as well as in the Jetstream subscription. The
// subscription's `wantedDids` filter is a bandwidth choice made by the
// transport, and a dropped query parameter, a proxy that rewrites the URL, or
// a subscription widened to debug something would turn it off silently. Here
// it is a rule.
//
// A mention from anyone NOT on the roster is not a trigger. The bot is
// mentionable by the whole network and the analyst reads its input as
// instructions, so a stranger's mention is dropped without a reply, not even
// an error, which would itself be a reply.
//
// The roster is a predicate so this file never has to know how the tiers are
// spelled. senders.js is the only place that decides who is on it.

import { looksLikeTarget } from './target.js';

const MENTION = 'app.bsky.richtext.facet#mention';
const LINK = 'app.bsky.richtext.facet#link';

/** The DID in `at://did:plc:xxx/collection/rkey`, or null. */
export function authorOf(uri) {
  const m = /^at:\/\/(did:[^/]+)\//.exec(String(uri ?? ''));
  return m ? m[1] : null;
}

/** The quoted post's URI, across both embed shapes that can carry one. */
export function quotedUri(record) {
  const embed = record?.embed;
  if (!embed) return null;
  if (embed.$type === 'app.bsky.embed.record') return embed.record?.uri ?? null;
  if (embed.$type === 'app.bsky.embed.recordWithMedia') {
    return embed.record?.record?.uri ?? null;
  }
  return null;
}

/**
 * Every post reference the message points at, best candidate first.
 *
 * Facet links come before text tokens because the client TRUNCATES the visible
 * text of a pasted URL: `bsky.app/profile/alice.example.com/pos...` is what the
 * record says and the whole URI is only in the facet. Reading the text alone
 * finds a mangled link or none at all, which looks exactly like "the owner
 * didn't paste one".
 */
export function linkCandidates(record) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const s = String(v ?? '').trim();
    if (!s || seen.has(s) || !looksLikeTarget(s)) return;
    seen.add(s);
    out.push(s);
  };

  for (const facet of record?.facets || []) {
    for (const feature of facet?.features || []) {
      if (feature?.$type === LINK) push(feature.uri);
    }
  }
  for (const token of String(record?.text ?? '').split(/\s+/)) {
    push(token.replace(/[),.]+$/, ''));
  }
  return out;
}

/** True when any facet mentions `did`. */
export function mentions(record, did) {
  for (const facet of record?.facets || []) {
    for (const feature of facet?.features || []) {
      if (feature?.$type === MENTION && feature.did === did) return true;
    }
  }
  return false;
}

/**
 * Classify one Jetstream commit event.
 *
 * @param {object} event  a Jetstream commit envelope
 * @param {object} opts
 * @param {string} opts.ownerDid  the account that owns the list
 * @param {string} opts.botDid    the moderator account
 * @param {(did: string) => boolean} [opts.answers]  is this author answered?
 *   Defaults to the owner alone, the narrowest roster there is.
 * @returns {{
 *   trigger: boolean,
 *   reason: string,
 *   uri?: string,
 *   cid?: string,
 *   author?: string,
 *   text?: string,
 *   target?: string|null,
 *   targetSource?: 'link'|'quote'|'parent'|null,
 *   reply?: { root: {uri:string,cid:string}, parent: {uri:string,cid:string} },
 *   isFollowUp?: boolean,
 * }}
 */
export function classify(
  event,
  { ownerDid, botDid, answers = (did) => did === ownerDid },
) {
  if (event?.kind !== 'commit')
    return { trigger: false, reason: 'not-a-commit' };

  const commit = event.commit || {};
  if (commit.collection !== 'app.bsky.feed.post') {
    return { trigger: false, reason: 'wrong-collection' };
  }
  // Only creates. An edit of an old post would otherwise re-trigger the whole
  // analysis, and a delete carries no record to read at all.
  if (commit.operation !== 'create') {
    return { trigger: false, reason: 'not-a-create' };
  }
  if (!answers(event.did)) {
    return { trigger: false, reason: 'not-on-the-roster' };
  }

  const record = commit.record || {};
  if (typeof record.text !== 'string') {
    return { trigger: false, reason: 'no-text' };
  }

  // Fail closed without the bot's own DID. `authorOf(null) === null` would
  // read nearly every post as addressed to the bot.
  if (!botDid) return { trigger: false, reason: 'no-bot-did' };

  const parentUri = record.reply?.parent?.uri ?? null;
  const quoted = quotedUri(record);

  const addressed =
    mentions(record, botDid) ||
    authorOf(parentUri) === botDid ||
    authorOf(quoted) === botDid;
  if (!addressed) return { trigger: false, reason: 'not-addressed-to-the-bot' };

  const uri = `at://${event.did}/${commit.collection}/${commit.rkey}`;
  const self = { uri, cid: commit.cid };

  // What to analyse, best evidence first. A pasted link is an explicit request.
  // Failing that, the post the owner is quoting or replying to is the thing in
  // front of them, unless it is the bot's own post, which is a follow-up in an
  // existing conversation rather than a new subject.
  let target = null;
  let targetSource = null;
  const [link] = linkCandidates(record);
  if (link) {
    target = link;
    targetSource = 'link';
  } else if (quoted && authorOf(quoted) !== botDid) {
    target = quoted;
    targetSource = 'quote';
  } else if (parentUri && authorOf(parentUri) !== botDid) {
    target = parentUri;
    targetSource = 'parent';
  }

  return {
    trigger: true,
    reason: 'addressed',
    uri,
    cid: commit.cid,
    // Who asked, which may be anyone on the roster. The thread history needs
    // it to tell the asker's posts from the bot's.
    author: event.did,
    text: record.text,
    target,
    targetSource,
    // Threaded under the same root, so the answer lands where the question was
    // asked rather than starting a new top-level post about someone.
    reply: {
      root: record.reply?.root ?? self,
      parent: self,
    },
    isFollowUp: authorOf(parentUri) === botDid,
  };
}
