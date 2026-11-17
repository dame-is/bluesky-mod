// What a slice of the network has been talking about over a window of time.
//
// `get_trends` answers this for the whole network, which the owner is barely
// part of. This module answers it for a slice they chose: the accounts they
// follow, a custom feed, or a list. It fetches, windows and selects. What the
// posts mean is left to the analyst, and who anyone is stays in score.js,
// where it can be replayed.
//
// The circle is read by fanning out over public author feeds rather than
// calling getTimeline, which answers as the viewer and so would need the
// owner's session. The bot is not the owner, and author feeds are public.
//
// There is no For You slice. That generator personalises off the requester's
// DID, and an unauthenticated getFeed answers 200 with a generic feed: a
// plausible answer that is not the owner's. Until there is an honest way to
// read theirs, the bot says it cannot.

import { APPVIEW } from '../constants.js';
import { resolveActor } from './target.js';
import { postWebUrl } from './links.js';
import { fetchWithTimeout } from './atproto.js';

export const DEFAULT_WINDOW_HOURS = 24;

/**
 * The longest window that can be asked for. Past about a week the fan-out is
 * an archive read: authors need several pages each, the post count runs to
 * five figures, and the selection throws away more than it keeps.
 */
export const MAX_WINDOW_HOURS = 168;

/** The most posts the model is handed. The `more` follow-up asks for 150. */
const MAX_SAMPLE = 150;

/** How many author feeds to read at once. */
const CONCURRENCY = 8;

/** The feed endpoints' largest page. */
const PAGE = 100;

/** Author-feed pages to read before reporting the author as cut. */
const MAX_PAGES_PER_AUTHOR = 4;

/** Pages of a feed or list before stopping. Those are one shared stream. */
const MAX_FEED_PAGES = 12;

/**
 * Size the first author-feed page to the window.
 *
 * An author feed carries a few KB of JSON per post, so bandwidth is what a
 * fan-out costs. Most accounts post a few times a day, so a page of 15, or
 * 0.6 per hour of window if that is more, covers them in one request and
 * the busy few pay for a second. Erring small only costs a request.
 */
function firstPageSize(hours) {
  return Math.min(PAGE, Math.max(15, Math.ceil(hours * 0.6)));
}

/** The longest delay a timer takes. Past it Node fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Fetch JSON, and tell a failure that will never succeed from one that might.
 * A deactivated account answers 400 from getAuthorFeed forever, and retrying
 * it spends the fan-out's budget on the one member who cannot be read.
 *
 * Once `signal` has fired, the error is thrown rather than retried: a retry
 * with a fired signal fails at once and then sleeps.
 */
async function getJson(url, fetchImpl, signal, tries = 3) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (res.ok) return { body: await res.json(), permanent: false };
      if (![429, 502, 503, 504].includes(res.status)) {
        return { body: null, permanent: true };
      }
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
    }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  return { body: null, permanent: false };
}

const BSKY_FEED =
  /^https?:\/\/[^/]*bsky\.app\/profile\/([^/]+)\/feed\/([^/?#]+)/i;
const BSKY_LIST =
  /^https?:\/\/[^/]*bsky\.app\/profile\/([^/]+)\/lists\/([^/?#]+)/i;
const AT_URI = /^at:\/\/([^/]+)\/([^/]+)\/([^/?#]+)/;

/**
 * Turn what the owner pasted into a slice: the word `circle`, an at:// URI,
 * or a bsky.app feed or list link.
 *
 * The kind comes from the collection, not the URL shape. getFeed and
 * getListFeed take different parameters, and asking the wrong one returns an
 * empty feed rather than an error.
 *
 * @returns {Promise<{kind: 'circle'|'feed'|'list', uri?: string}>}
 */
export async function resolveSlice(
  spec,
  { fetchImpl = fetchWithTimeout, signal, appview = APPVIEW } = {},
) {
  const raw = String(spec ?? '').trim();
  if (!raw || /^(circle|follows|following|my circle)$/i.test(raw)) {
    return { kind: 'circle' };
  }

  let did = null;
  let collection = null;
  let rkey = null;

  const at = raw.match(AT_URI);
  if (at) {
    [, did, collection, rkey] = at;
  } else {
    const feed = raw.match(BSKY_FEED);
    const list = raw.match(BSKY_LIST);
    const m = feed || list;
    if (!m) {
      throw new Error(
        `"${raw}" is not a slice I can read. Use "circle", an at:// URI, or a bsky.app feed or list link.`,
      );
    }
    collection = feed ? 'app.bsky.feed.generator' : 'app.bsky.graph.list';
    rkey = m[2];
    did = m[1];
  }

  if (!did.startsWith('did:')) {
    did = await resolveActor(did, { fetchImpl, signal, appview });
  }
  const uri = `at://${did}/${collection}/${rkey}`;

  if (collection === 'app.bsky.feed.generator') return { kind: 'feed', uri };
  if (collection === 'app.bsky.graph.list') return { kind: 'list', uri };
  throw new Error(
    `${collection} is not a feed or a list, so there is no stream of posts to read.`,
  );
}

/** Links a post carries, from its facets and from an external embed. */
function linksIn(record, embed) {
  const out = [];
  for (const facet of record?.facets || []) {
    for (const f of facet?.features || []) {
      if (f?.$type === 'app.bsky.richtext.facet#link' && f.uri) out.push(f.uri);
    }
  }
  const ext = embed?.external?.uri || embed?.media?.external?.uri;
  if (ext) out.push(ext);
  return [...new Set(out)];
}

/** The registrable-ish host of a URL, for counting what a slice links to. */
export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * When a post was made: the earlier of `createdAt`, which the author sets,
 * and `indexedAt`, which the AppView sets. The AppView sorts feeds the same
 * way, and a post dated in the future cannot sort ahead of newer ones.
 */
function postTime(record, post) {
  const times = [record?.createdAt, post?.indexedAt]
    .map((t) => Date.parse(t))
    .filter(Number.isFinite);
  return times.length ? Math.min(...times) : 0;
}

/**
 * When an item entered the feed. A repost sits in an author feed at the time
 * of the repost, not of the post, so paging and the window go by that.
 */
function feedTime(item, p) {
  const reposted = Date.parse(item?.reason?.indexedAt);
  return Number.isFinite(reposted) ? reposted : p.at;
}

/**
 * One feed item, flattened to the fields a digest reads.
 *
 * `reason` marks a repost. It is read here rather than inferred from the
 * author DID, because an author feed holds other people's posts too, and
 * "they said this" and "they amplified this" are different sentences in the
 * answer.
 */
export function normalisePost(item) {
  const post = item?.post;
  const record = post?.record;
  if (!post?.uri || typeof record?.text !== 'string') return null;
  const embed = post.embed || {};
  const type = String(embed.$type || '');
  // A quote with media carries the media's type one level down.
  const media = `${type} ${String(embed.media?.$type || '')}`;
  const reposter = item?.reason?.by;
  return {
    uri: post.uri,
    did: post.author?.did || '',
    handle: post.author?.handle || post.author?.did || '',
    text: record.text,
    at: postTime(record, post),
    likes: post.likeCount ?? 0,
    reposts: post.repostCount ?? 0,
    replies: post.replyCount ?? 0,
    quotes: post.quoteCount ?? 0,
    isReply: Boolean(record.reply),
    // A post can arrive once from its author and once from each member who
    // reposted it, so these two describe this copy. mergeCopy folds copies.
    amplifiedBy: reposter?.handle ? [reposter.handle] : [],
    said: !reposter,
    hasImage: media.includes('images'),
    hasVideo: media.includes('video'),
    isQuote: type.includes('record'),
    links: linksIn(record, embed),
  };
}

/** Total deliberate engagement. Used for ordering, never for judging anyone. */
export function engagementOf(p) {
  return (p.likes || 0) + (p.reposts || 0) + (p.replies || 0) + (p.quotes || 0);
}

/**
 * Fold a second copy of the same post into the first.
 *
 * The fan-out sees a post once per member who touched it. Counting each copy
 * measures reposting rather than conversation, but dropping them loses the
 * most useful number in a follow-graph digest: how many of the circle passed
 * it on. So copies collapse into one post that lists its amplifiers. If any
 * copy came straight from its author's feed, a member wrote it.
 */
export function mergeCopy(existing, incoming) {
  if (!existing) return incoming;
  existing.said = existing.said || incoming.said;
  for (const who of incoming.amplifiedBy) {
    if (!existing.amplifiedBy.includes(who)) existing.amplifiedBy.push(who);
  }
  return existing;
}

/**
 * How many of the slice amplified a post. The like count is the network's
 * signal; this is the slice's.
 */
export function ampOf(p) {
  return p.amplifiedBy?.length || 0;
}

/**
 * Every post one account made or reposted inside the window.
 *
 * Pages only while the last page was still inside it, so a quiet account
 * costs one small request. `complete: false` means the page cap cut the
 * author off, and the caller reports it: a digest that silently saw half of
 * the busiest account is wrong about the slice. `aborted: true` means time
 * ran out, between pages or when `signal` fired mid-request.
 */
export async function authorWindow(
  did,
  {
    sinceMs,
    hours = DEFAULT_WINDOW_HOURS,
    fetchImpl = fetchWithTimeout,
    signal,
    appview = APPVIEW,
    includeReplies = false,
    deadline = Infinity,
  } = {},
) {
  const filter = includeReplies ? 'posts_with_replies' : 'posts_no_replies';
  const out = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES_PER_AUTHOR; page += 1) {
    if (Date.now() >= deadline) {
      return { posts: out, complete: false, aborted: true, permanent: false };
    }
    const limit = page === 0 ? firstPageSize(hours) : PAGE;
    const url =
      `${appview}/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(did)}` +
      `&limit=${limit}&filter=${filter}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    let got;
    try {
      got = await getJson(url, fetchImpl, signal);
    } catch (err) {
      if (!signal?.aborted) throw err;
      return { posts: out, complete: false, aborted: true, permanent: false };
    }
    const { body, permanent } = got;
    if (!body) {
      return { posts: out, complete: false, aborted: false, permanent };
    }

    let oldest = Infinity;
    for (const item of body.feed || []) {
      const p = normalisePost(item);
      if (!p) continue;
      const t = feedTime(item, p);
      oldest = Math.min(oldest, t);
      if (t >= sinceMs) out.push(p);
    }

    cursor = body.cursor;
    // Out of posts, or past the far edge of the window.
    if (!cursor || oldest < sinceMs) {
      return { posts: out, complete: true, aborted: false, permanent: false };
    }
  }
  return { posts: out, complete: false, aborted: false, permanent: false };
}

/**
 * The circle's posts inside the window, read one author feed at a time.
 *
 * An account the owner follows may have been deactivated and answer 400
 * forever, so unreadable members are counted rather than thrown. Every
 * member ends up read, unreadable or unread, and `coverage` says how many of
 * each, so the answer can say how much of the circle it saw.
 */
export async function circleWindow({
  dids,
  sinceMs,
  hours = DEFAULT_WINDOW_HOURS,
  fetchImpl = fetchWithTimeout,
  signal,
  appview = APPVIEW,
  includeReplies = false,
  concurrency = CONCURRENCY,
  budgetMs = 60_000,
}) {
  const queue = [...new Set((dids || []).filter(Boolean))];
  const total = queue.length;
  const byUri = new Map();
  const cut = [];
  let unreadable = 0;
  let read = 0;
  const deadline = Date.now() + budgetMs;
  let stopped = false;

  async function worker() {
    while (!stopped && queue.length) {
      if (Date.now() >= deadline) {
        stopped = true;
        return;
      }
      const did = queue.shift();
      const r = await authorWindow(did, {
        sinceMs,
        hours,
        fetchImpl,
        signal,
        appview,
        includeReplies,
        deadline,
      });
      if (r.aborted) {
        // Out of time partway through. Back on the queue, so it counts as
        // unread rather than as half-read.
        queue.unshift(did);
        stopped = true;
        return;
      }
      if (!r.complete && r.posts.length === 0) {
        unreadable += 1;
        continue;
      }
      if (!r.complete) cut.push(did);
      for (const p of r.posts) byUri.set(p.uri, mergeCopy(byUri.get(p.uri), p));
      read += 1;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, total || 1) }, worker),
  );

  return {
    posts: [...byUri.values()],
    coverage: {
      accounts: total,
      read,
      unreadable,
      // Still queued when the budget ran out. A digest of 140 of 230
      // accounts is a different claim from one of all of them.
      unread: queue.length,
      truncatedAuthors: cut.length,
    },
  };
}

/**
 * A custom feed or a list, read as one stream until it leaves the window.
 *
 * Unauthenticated, so a feed that personalises off the requester answers as
 * nobody. For a list or a non-personalised feed that is the stream everyone
 * sees. For a personalised one it is not the owner's feed (see For You at
 * the top).
 *
 * Throws when not even the first page can be read. An empty window from a
 * feed that does not exist would read as a quiet day. Past `deadline`, or
 * once `signal` fires, it stops with what it has, and `pagesCapped` says the
 * stream was not read to the edge of the window.
 */
export async function feedWindow({
  uri,
  kind = 'feed',
  sinceMs,
  fetchImpl = fetchWithTimeout,
  signal,
  appview = APPVIEW,
  includeReplies = true,
  deadline = Infinity,
}) {
  const method =
    kind === 'list' ? 'app.bsky.feed.getListFeed' : 'app.bsky.feed.getFeed';
  const param = kind === 'list' ? 'list' : 'feed';
  const posts = [];
  const seen = new Map();
  let cursor;
  let complete = false;

  for (let page = 0; page < MAX_FEED_PAGES; page += 1) {
    const url =
      `${appview}/xrpc/${method}?${param}=${encodeURIComponent(uri)}&limit=${PAGE}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    let body = null;
    let late = Date.now() >= deadline;
    if (!late) {
      try {
        ({ body } = await getJson(url, fetchImpl, signal));
      } catch (err) {
        if (!signal?.aborted) throw err;
        late = true;
      }
    }
    if (!body) {
      if (page === 0) {
        throw new Error(
          late
            ? `the ${kind} ${uri} did not answer in time.`
            : `could not read the ${kind} ${uri}. It may not exist, or its server may be down.`,
        );
      }
      break;
    }

    let oldest = Infinity;
    for (const item of body.feed || []) {
      const p = normalisePost(item);
      if (!p) continue;
      const t = feedTime(item, p);
      oldest = Math.min(oldest, t);
      if (t < sinceMs) continue;
      if (!includeReplies && p.isReply) continue;
      // A ranked feed can serve the same post on two pages as its ranking
      // shifts under the cursor. Counting it twice overstates it.
      const first = seen.get(p.uri);
      if (first) {
        mergeCopy(first, p);
        continue;
      }
      seen.set(p.uri, p);
      posts.push(p);
    }

    cursor = body.cursor;
    if (!cursor || oldest < sinceMs) {
      complete = true;
      break;
    }
  }

  return {
    posts,
    coverage: { stream: uri, pagesCapped: !complete, posts: posts.length },
  };
}

/**
 * Counts over the window, done in code. A model reading eighty posts gets a
 * count roughly right, which is the wrong kind of right for a count.
 *
 * Said and amplified are counted apart: a member writing something and a
 * member reposting a stranger are different acts, and one total answers
 * neither question. `topAuthors` counts only what members wrote, because a
 * ranking built from reposts ranks strangers.
 */
export function summariseWindow(
  posts,
  { topAuthors = 8, topDomains = 8 } = {},
) {
  const byAuthor = new Map();
  const byDomain = new Map();
  let said = 0;
  let amplified = 0;
  let replies = 0;
  let withLinks = 0;
  let withMedia = 0;
  let engagement = 0;

  for (const p of posts) {
    if (p.said) {
      said += 1;
      const key = p.handle || p.did;
      const a = byAuthor.get(key) || { handle: key, posts: 0, engagement: 0 };
      a.posts += 1;
      a.engagement += engagementOf(p);
      byAuthor.set(key, a);
    } else {
      amplified += 1;
    }

    if (p.isReply) replies += 1;
    if (p.links.length) withLinks += 1;
    if (p.hasImage || p.hasVideo) withMedia += 1;
    engagement += engagementOf(p);

    for (const d of new Set(p.links.map(domainOf).filter(Boolean))) {
      byDomain.set(d, (byDomain.get(d) || 0) + 1);
    }
  }

  return {
    posts: posts.length,
    said,
    amplified,
    authors: byAuthor.size,
    replies,
    withLinks,
    withMedia,
    engagement,
    topAuthors: [...byAuthor.values()]
      .sort((a, b) => b.posts - a.posts)
      .slice(0, topAuthors),
    topDomains: [...byDomain.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, topDomains),
  };
}

/**
 * Which posts the model reads.
 *
 * Said and amplified are selected separately. Ranked together, reposts of
 * huge posts from outside the slice fill the top, which rebuilds the
 * network-wide answer and calls it the owner's circle. Amplified posts rank
 * first by how many of the slice passed them on, then by engagement: six
 * members reposting something modest says more about the circle than one
 * member reposting something huge.
 *
 * Each account is capped at `perAuthor` posts, because engagement order alone
 * hands the sample to the loudest few. Breadth is what is being measured.
 */
export function selectPosts(
  posts,
  { limit = 60, perAuthor = 3, sort = 'engagement', focus = '' } = {},
) {
  const needle = String(focus || '')
    .trim()
    .toLowerCase();
  const pool = needle
    ? posts.filter((p) => p.text.toLowerCase().includes(needle))
    : [...posts];

  const byEngagement = (a, b) => engagementOf(b) - engagementOf(a);
  const byRecency = (a, b) => b.at - a.at;
  const byAmplification = (a, b) => ampOf(b) - ampOf(a) || byEngagement(a, b);

  const take = (list, cap) => {
    const taken = new Map();
    const kept = [];
    for (const p of list) {
      if (kept.length >= cap) break;
      const key = p.handle || p.did;
      const n = taken.get(key) || 0;
      if (n >= perAuthor) continue;
      taken.set(key, n + 1);
      kept.push(p);
    }
    return kept;
  };

  const order = sort === 'recent' ? byRecency : byEngagement;
  const saidPool = pool.filter((p) => p.said).sort(order);
  const ampPool = pool
    .filter((p) => !p.said)
    .sort(sort === 'recent' ? byRecency : byAmplification);

  // What the slice wrote gets the larger share, and a group that runs short
  // hands its unused slots to the other.
  const saidCap = Math.ceil(limit * 0.65);
  const firstPass = take(saidPool, saidCap);
  const amplified = take(ampPool, limit - firstPass.length);
  const spare = limit - firstPass.length - amplified.length;
  const said = spare > 0 ? take(saidPool, firstPass.length + spare) : firstPass;

  const kept = [...said, ...amplified];
  return {
    said,
    amplified,
    kept,
    matched: pool.length,
    omitted: Math.max(0, pool.length - kept.length),
  };
}

/** Relative age, so the model reads "3h" instead of doing date arithmetic. */
function ago(at, now) {
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * What a post is when it has no words: an image, a video or a bare quote.
 * A blank line tells the model nothing and invites it to describe a post it
 * cannot see. Nothing here reads images, so the shape is all it gets.
 */
function describeEmpty(p) {
  if (p.hasVideo) return '(video, no text)';
  if (p.hasImage) return '(image, no text)';
  if (p.isQuote) return '(quote post, no text of its own)';
  return '(no text)';
}

/**
 * One post as a header line and its text, numbered with a marker the answer
 * can cite.
 *
 * The model writes `[7]` and code swaps in the link, so the model picks which
 * post and code decides where the link points. A marker can only index the
 * list the tool returned, so it cannot name a post the digest never saw,
 * which is what makes the link safe to render as tappable.
 */
function renderOne(p, now, chars, n) {
  const amp = ampOf(p);
  const head =
    `[${n}] @${p.handle} · ${ago(p.at, now)} · ` +
    `${p.likes}L ${p.reposts}R ${p.replies}C` +
    (amp
      ? ` · amplified by ${amp} of the slice (${p.amplifiedBy
          .slice(0, 4)
          .map((h) => `@${h}`)
          .join(', ')}${amp > 4 ? ', …' : ''})`
      : '') +
    (p.isReply ? ' · reply' : '');
  // Cut by code point, so the cut never leaves half a surrogate pair.
  const text = Array.from(p.text.trim());
  const body = !text.length
    ? describeEmpty(p)
    : text.length > chars
      ? `${text.slice(0, chars - 1).join('')}…`
      : text.join('');
  const tail = p.links.length
    ? `\n  links: ${[...new Set(p.links.map(domainOf).filter(Boolean))].join(', ')}`
    : '';
  // One line of text per post, so nobody's text can start a line that looks
  // like another post's header.
  const line = body.replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, ' ');
  return `${head}\n  ${line}${tail}`;
}

/**
 * The post sample as one block of text, for the caller to fence. Every
 * character of it was written by other people.
 *
 * The two groups are labelled rather than interleaved, so the model can tell
 * "someone the owner follows wrote this" from "someone the owner follows
 * passed this on". Text is trimmed, not summarised: summarising each post
 * alone would make the model's editorial call without the rest in view.
 */
export function renderPosts(
  { said, amplified },
  { now = Date.now(), chars = 320, totals = null } = {},
) {
  // Numbered straight through both groups, in the order of `kept`, so
  // marker n is sample[n - 1].
  let n = 0;
  const section = (title, list, total) => {
    if (!list.length) return '';
    const of = total != null && total > list.length ? ` of ${total}` : '';
    return (
      `${title} (${list.length}${of})\n\n` +
      list
        .map((p) => {
          n += 1;
          return renderOne(p, now, chars, n);
        })
        .join('\n\n')
    );
  };

  return [
    section('WRITTEN BY THE SLICE', said, totals?.said),
    section('AMPLIFIED BY THE SLICE', amplified, totals?.amplified),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * A short cache over the fetch, not the answer.
 *
 * Keyed on the slice and window only, so a follow-up that changes `focus`,
 * `sort` or `limit` re-selects from posts in hand instead of reading every
 * author feed again. Four entries, because the same process holds the vouch
 * snapshot in memory.
 */
const CACHE = new Map();
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 4;

export function clearPulseCache() {
  CACHE.clear();
}

function cacheGet(key, now) {
  const hit = CACHE.get(key);
  if (!hit || now - hit.at > CACHE_TTL_MS) return null;
  return hit;
}

function cacheSet(key, value, now) {
  // Delete first, so a refreshed entry moves to the back of the eviction order.
  CACHE.delete(key);
  CACHE.set(key, { at: now, ...value });
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
}

/**
 * One digest: resolve the slice, read the window, count it, sample it.
 *
 * @param {object} opts
 * @param {string}   [opts.source]          `circle`, an at:// URI, or a bsky.app feed/list link
 * @param {number}   [opts.hours]           window, clamped to 1..MAX_WINDOW_HOURS
 * @param {string[]} [opts.circleDids]      required when the slice is the circle
 * @param {string}   [opts.focus]           only posts containing this text
 * @param {'engagement'|'recent'} [opts.sort]
 * @param {number}   [opts.limit]           posts to sample, clamped to 1..MAX_SAMPLE
 */
export async function pulse({
  source = 'circle',
  hours = DEFAULT_WINDOW_HOURS,
  circleDids = [],
  focus = '',
  sort = 'engagement',
  limit = 60,
  perAuthor = 3,
  includeReplies = false,
  fetchImpl = fetchWithTimeout,
  signal,
  appview = APPVIEW,
  budgetMs = 60_000,
  now = Date.now(),
  useCache = true,
} = {}) {
  // One budget for the whole digest, enforced in flight as well as between
  // requests. A page that never answers would otherwise hold the job queue
  // long after the budget ran out. The caller's signal (the tool loop's
  // deadline) stops it too.
  const budget = Math.min(
    MAX_TIMER_MS,
    Math.max(1, Math.ceil(Number(budgetMs)) || 60_000),
  );
  const deadline = Date.now() + budget;
  const outOfTime = AbortSignal.timeout(budget);
  const stop = signal ? AbortSignal.any([signal, outOfTime]) : outOfTime;
  // The combined signal holds its sources weakly, so the timeout is hung off
  // it to keep it alive until it fires, as atproto.js does.
  if (stop !== outOfTime) stop.timeoutSignal = outOfTime;

  const window = Math.min(
    MAX_WINDOW_HOURS,
    Math.max(1, Number(hours) || DEFAULT_WINDOW_HOURS),
  );
  const sinceMs = now - window * 3_600_000;
  // The model chooses `limit`, and every sampled post goes back into its
  // context, so it is bounded here.
  const sample = Math.min(MAX_SAMPLE, Math.max(1, Math.floor(limit) || 60));

  const slice = await resolveSlice(source, {
    fetchImpl,
    signal: stop,
    appview,
  });
  if (slice.kind === 'circle' && !circleDids.length) {
    throw new Error(
      'the circle is empty in this snapshot, so there is nobody to read. The follow-graph snapshot may still be building.',
    );
  }

  const key = JSON.stringify([
    slice.kind,
    slice.uri || 'circle',
    window,
    includeReplies,
  ]);
  let fetched = useCache ? cacheGet(key, now) : null;
  const cached = Boolean(fetched);

  if (!fetched) {
    fetched =
      slice.kind === 'circle'
        ? await circleWindow({
            dids: circleDids,
            sinceMs,
            hours: window,
            fetchImpl,
            signal: stop,
            appview,
            includeReplies,
            budgetMs: deadline - Date.now(),
          })
        : await feedWindow({
            uri: slice.uri,
            kind: slice.kind,
            sinceMs,
            fetchImpl,
            signal: stop,
            appview,
            includeReplies,
            deadline,
          });
    if (useCache) cacheSet(key, fetched, now);
  }

  const totals = summariseWindow(fetched.posts);
  const selection = selectPosts(fetched.posts, {
    limit: sample,
    perAuthor,
    sort,
    focus,
  });

  return {
    slice: {
      kind: slice.kind,
      uri: slice.uri || null,
      label:
        slice.kind === 'circle'
          ? `the ${circleDids.length} accounts the owner follows`
          : `${slice.kind} ${slice.uri}`,
    },
    window: {
      hours: window,
      since: new Date(sinceMs).toISOString(),
      until: new Date(now).toISOString(),
    },
    coverage: {
      ...fetched.coverage,
      cached,
      cachedAgeMs: cached ? now - fetched.at : 0,
    },
    totals,
    focus: focus || null,
    sort,
    matched: selection.matched,
    shown: selection.kept.length,
    said: selection.said.length,
    amplified: selection.amplified.length,
    omitted: selection.omitted,
    posts: selection.kept,
    // The marker table: `[n]` in the answer is sample[n - 1], in the order
    // renderPosts numbers them. It is for code, which swaps each marker the
    // answer cites for its link. The link carries the author's handle, a
    // domain someone registered, so it is not for the model: agent.js leaves
    // the table out of what network_pulse hands it.
    sample: selection.kept.map((p, i) => ({
      n: i + 1,
      url: postWebUrl(p.uri, { handle: p.handle }),
    })),
    rendered: renderPosts(selection, { now, totals }),
  };
}
