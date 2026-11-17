// Everyone who touched a post, and how.
//
// Constellation is the source rather than the AppView's getLikes and
// getRepostedBy, because the AppView answers as a viewer. It filters out
// accounts behind the blocks and mutes already in place, so using it to
// decide who to block hides the people already acted on and changes its
// answer as you work. Constellation indexes the firehose and answers the same
// for everyone.
//
// Sources are discovered, not declared. A counts call returns every
// (collection, path) pair pointing at the record, so a like is found the same
// way as engagement from a lexicon this code has never heard of. A fixed list
// would go blind each time the network adds a verb.
//
// Nothing here judges anyone. It returns who did what; bands, trust and the
// protected-set veto live in `score.js` and run over this output, so a harvest
// can be re-scored later as the circle moves.

import {
  getBacklinkSources,
  getBacklinks,
  backlinkRows,
  flattenSources,
} from './constellation.js';

/** Constellation pages at 100; anything larger is silently clamped. */
const PAGE = 100;

/**
 * How many pages to pull from a single source before giving up on it.
 *
 * The tail of a viral post's likes is strangers who all score UNKNOWN, so
 * reading every one is slow and tells you little. The cap is per source, so a
 * post with 20k likes still yields every reply and quote, the engagements that
 * carry intent. `truncated` on the result says when it applied, and callers
 * surface it.
 */
const MAX_PAGES = 60;

/**
 * How many sources outside Bluesky's own kinds one harvest pages.
 *
 * Each source costs at least one request, made one after another, and anyone
 * can add sources to a post: one record holding the post's URI at a thousand
 * paths is a thousand sources. Bluesky's own kinds are a handful of exact
 * paths and are always paged; the rest are paged by count up to this cap. A
 * source past it is not read, and the harvest says it is not everyone.
 */
const MAX_OTHER_SOURCES = 10;

/**
 * Map a Constellation source onto an engagement kind.
 *
 * Bluesky's own verbs get names, matched on exact paths. Anything else is
 * `other`: its collection name is chosen by whoever wrote the record, so it
 * stays out of the breakdown, which reaches replies and models unfenced.
 * `reply` (parent) is someone answering the post itself. `threadReply` (root)
 * is anyone in the thread the post starts, including people who never
 * addressed its author, so a direct reply to a thread's first post counts
 * under both. A quote is a record embed, alone or beside media.
 */
function engagementKind({ collection, path }) {
  const p = path.startsWith('.') ? path.slice(1) : path;
  if (collection === 'app.bsky.feed.like' && p === 'subject.uri') return 'like';
  if (collection === 'app.bsky.feed.repost' && p === 'subject.uri') {
    return 'repost';
  }
  if (collection === 'app.bsky.feed.post') {
    if (p === 'reply.parent.uri') return 'reply';
    if (p === 'reply.root.uri') return 'threadReply';
    if (p === 'embed.record.uri' || p === 'embed.record.record.uri') {
      return 'quote';
    }
  }
  if (collection === 'app.bsky.feed.threadgate' && p === 'post') return 'gate';
  return 'other';
}

/**
 * Engagement kinds loudest first, for display order and `primaryKind`.
 *
 * A quote takes more deliberate effort than a reply, a reply more than a
 * repost, a repost more than a like. This says nothing about how hostile any
 * of them is.
 */
const KIND_ORDER = [
  'quote',
  'reply',
  'threadReply',
  'repost',
  'like',
  'gate',
];

/** The loudest thing this account did, for one-line summaries. */
function primaryKind(engagements) {
  for (const kind of KIND_ORDER) {
    if (engagements[kind]) return kind;
  }
  const rest = Object.keys(engagements);
  return rest.length ? rest[0] : null;
}

/**
 * Page one source (up to MAX_PAGES) and hand back its rows.
 *
 * A source that fails outright comes back empty with `failed: true` rather
 * than throwing, because one dead lexicon should not cost you the likes; the
 * harvest lists it in `unread` and calls itself truncated. One that fails part
 * way comes back `truncated`, never complete: a partial read that passes for a
 * whole one would silence every "not everyone" warning downstream. A failed
 * page is asked for once more before that.
 */
async function drainSource(uri, source, { signal, maxPages = MAX_PAGES } = {}) {
  const rows = [];
  let cursor;
  let pages = 0;
  const read = () => getBacklinks(uri, source, { limit: PAGE, cursor, signal });
  while (pages < maxPages) {
    const page = (await read()) ?? (signal?.aborted ? null : await read());
    if (!page) return { rows, truncated: pages > 0, failed: pages === 0 };
    rows.push(...backlinkRows(page));
    pages += 1;
    cursor = page.cursor;
    if (!cursor) return { rows, truncated: false, failed: false };
  }
  return { rows, truncated: true, failed: false };
}

/**
 * Harvest every account that interacted with `uri`.
 *
 * @param {string} uri at:// URI of the post (from `resolveTarget`)
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxPages] per-source page cap
 * @param {string[]} [opts.only] engagement kinds to read (e.g. quote, reply,
 *   threadReply); the rest are skipped. A watch reads the words, and the likes
 *   on a busy post are most of its pages.
 * @param {(s: {done: number, total: number, source: string}) => void} [opts.onProgress]
 * @returns {Promise<{
 *   uri: string,
 *   harvestedAt: string,
 *   sources: Array<{collection: string, path: string, source: string, count: number,
 *                   distinctDids: number|null, kind: string, truncated: boolean,
 *                   failed: boolean}>,
 *   participants: Array<{did: string, engagements: Record<string, number>,
 *                        primary: string|null, records: Array<{kind: string, rkey: string,
 *                        collection: string}>, total: number}>,
 *   totals: { participants: number, engagements: Record<string, number>, records: number },
 *   truncated: boolean,
 *   unread: Array<{kind: string, count: number}>,
 * }>}
 *
 * `truncated` is true when anything was left out: a source cut at the page
 * cap, a source that never answered, or a source past MAX_OTHER_SOURCES.
 * `unread` names the kinds of the last two, with Constellation's count of
 * their records.
 */
export async function harvestPost(uri, opts = {}) {
  const { signal, maxPages, onProgress, only = null } = opts;
  const raw = await getBacklinkSources(uri, { signal });
  const flat = flattenSources(raw);
  if (!flat) {
    // A caller's abort is a timeout, not a dead index.
    signal?.throwIfAborted();
    throw new Error(
      'Constellation did not answer. The backlink index is the only complete source for this, so there is no degraded mode worth running',
    );
  }

  // Only sources with something in them are paged: Bluesky's own kinds, then
  // the largest of the rest, which `flat` already lists first.
  const wanted = flat.filter(
    (s) => s.count > 0 && (!only || only.includes(engagementKind(s))),
  );
  const known = wanted.filter((s) => engagementKind(s) !== 'other');
  const others = wanted.filter((s) => engagementKind(s) === 'other');
  const live = [...known, ...others.slice(0, MAX_OTHER_SOURCES)];
  const unreadByKind = new Map();
  const unread = (kind, count) =>
    unreadByKind.set(kind, (unreadByKind.get(kind) || 0) + count);
  for (const s of others.slice(MAX_OTHER_SOURCES)) unread('other', s.count);
  const sources = [];
  const byDid = new Map();
  let records = 0;

  let done = 0;
  for (const src of live) {
    const kind = engagementKind(src);
    onProgress?.({ done, total: live.length, source: src.source });
    const { rows, truncated, failed } = await drainSource(uri, src.source, {
      signal,
      maxPages,
    });
    for (const row of rows) {
      if (!row?.did) continue;
      records += 1;
      let entry = byDid.get(row.did);
      if (!entry) {
        entry = { did: row.did, engagements: {}, records: [], total: 0 };
        byDid.set(row.did, entry);
      }
      entry.engagements[kind] = (entry.engagements[kind] || 0) + 1;
      entry.total += 1;
      entry.records.push({
        kind,
        rkey: row.rkey,
        collection: row.collection ?? src.collection,
      });
    }
    sources.push({ ...src, kind, truncated, failed });
    if (failed) unread(kind, src.count);
    done += 1;
  }
  onProgress?.({ done, total: live.length, source: null });

  const participants = [...byDid.values()].map((p) => ({
    ...p,
    primary: primaryKind(p.engagements),
  }));
  // Loudest engagement first, then most engagements, so a quote-poster is at
  // the top of the list and a single silent liker is at the bottom.
  participants.sort((a, b) => {
    const ai = KIND_ORDER.indexOf(a.primary);
    const bi = KIND_ORDER.indexOf(b.primary);
    const an = ai === -1 ? KIND_ORDER.length : ai;
    const bn = bi === -1 ? KIND_ORDER.length : bi;
    return an - bn || b.total - a.total;
  });

  const engagements = {};
  for (const p of participants) {
    for (const [kind, n] of Object.entries(p.engagements)) {
      engagements[kind] = (engagements[kind] || 0) + n;
    }
  }

  return {
    uri,
    harvestedAt: new Date().toISOString(),
    sources,
    participants,
    totals: { participants: participants.length, engagements, records },
    truncated: sources.some((s) => s.truncated) || unreadByKind.size > 0,
    unread: [...unreadByKind].map(([kind, count]) => ({ kind, count })),
  };
}
