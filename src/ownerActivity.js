// What people have been doing AT the owner lately, from the Spacedust stream:
// replies, quotes and mentions, per post, in a rolling window held in memory.
//
// It answers "how many people outside your circle replied to this post in the
// last ten minutes" in a lookup rather than a harvest. Three things read it:
// the alert that offers a watch when a post takes off (watching.js), watches,
// which skip a harvest when nothing new arrived (watch.js), and the shield,
// whose thresholds close replies or disable quotes (shield.js).
//
// It is a signal, not a record. The stream has no replay, so a restart or a
// dropped connection forgets what came before; `since()` says how far back
// the window actually reaches, and consumers fall back to a poll before then.
//
// Nothing here judges anyone. Who is a stranger is the scorer's answer, asked
// by whoever reads this.

import { kindOf } from './spacedust.js';
import { isDid } from './lib/target.js';

/** How long an interaction is kept. Longer than any threshold's window. */
export const KEEP_MS = 6 * 3_600_000;
/** The most interactions held, so a vast pile-on cannot grow the heap without end. */
export const MAX_EVENTS = 50_000;

/**
 * How long the stream may be down and still count as unbroken. The socket is
 * recycled every quarter hour for liveness (socket.js) and comes back within
 * a second or two; Spacedust also holds each link 21 seconds before sending
 * it, so a short reconnect loses almost nothing. A longer outage starts the
 * window again.
 */
export const GAP_TOLERANCE_MS = 30_000;

/** When one record links several ways, the kind it counts as. */
const PRIORITY = ['quote', 'reply', 'threadReply', 'mention'];

const repoOf = (uri) => /^at:\/\/(did:[^/]+)\//.exec(String(uri ?? ''))?.[1] ?? null;
const collectionOf = (uri) => String(uri ?? '').split('/')[3] ?? null;

/**
 * One Spacedust frame as an interaction, or null for anything else.
 *
 * `actor` is whoever wrote the linking record, read from its URI. `post` is
 * the subject when it is a record: one of the owner's posts (or a watched
 * post), and null for a mention, whose subject is the account itself.
 */
export function parseLink(msg) {
  if (msg?.kind !== 'link') return null;
  const l = msg.link || {};
  const kind = kindOf(l.source);
  if (!kind) return null;
  const actor = repoOf(l.source_record);
  if (!isDid(actor)) return null;
  if (collectionOf(l.source_record) !== 'app.bsky.feed.post') return null;
  const subject = String(l.subject ?? '');
  const post = subject.startsWith('at://') ? subject : null;
  if (kind !== 'mention' && !post) return null;
  return {
    kind,
    actor,
    record: l.source_record,
    post,
    deleted: l.operation === 'delete',
  };
}

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now]
 * @param {number} [opts.keepMs]
 * @param {number} [opts.max]
 * @param {boolean} [opts.coveredFromStart] count the window as whole from
 *   creation. The bot's own starts uncovered, and is covered from the first
 *   time the stream opens (`opened`).
 * @param {string|null} [opts.ownerDid] whose posts the stream always covers;
 *   anyone else's are covered from the connection that asked for them
 */
export function createActivity({
  now = () => Date.now(),
  keepMs = KEEP_MS,
  max = MAX_EVENTS,
  coveredFromStart = true,
  ownerDid = null,
} = {}) {
  /** record uri -> { kind, actor, record, posts:Set, at } in arrival order. */
  const byRecord = new Map();
  /** Since when the window is whole, or null for not at all. */
  let startedAt = coveredFromStart ? now() : null;
  /** When the stream stopped, while it is stopped. */
  let downAt = null;
  /** Records asked for by URI (a watched post), and since when each is covered. */
  const subjectSince = new Map();
  let lastAt = null;
  const listeners = new Set();

  /** Down past the tolerance: nothing before now can be vouched for. */
  const broken = () => downAt !== null && now() - downAt > GAP_TOLERANCE_MS;

  function prune() {
    const cutoff = now() - keepMs;
    for (const [key, e] of byRecord) {
      if (e.at >= cutoff && byRecord.size <= max) break;
      byRecord.delete(key);
      // What was dropped for room is no longer covered.
      if (e.at >= cutoff && startedAt !== null) {
        startedAt = Math.max(startedAt, e.at);
      }
    }
  }

  return {
    /**
     * Take one frame. A record seen again (a direct reply links as parent and
     * as root) is one interaction, counted as its loudest kind and under
     * every post it touched. A delete takes it out.
     *
     * @returns {object|null} the interaction as now held, or null
     */
    record(msg) {
      const link = parseLink(msg);
      if (!link) return null;
      if (link.deleted) {
        byRecord.delete(link.record);
        return null;
      }
      const at = now();
      lastAt = at;
      let e = byRecord.get(link.record);
      if (!e) {
        e = { kind: link.kind, actor: link.actor, record: link.record, posts: new Set(), at };
        byRecord.set(link.record, e);
      } else if (PRIORITY.indexOf(link.kind) < PRIORITY.indexOf(e.kind)) {
        e.kind = link.kind;
      }
      if (link.post) e.posts.add(link.post);
      prune();
      for (const fn of listeners) {
        try {
          fn(e);
        } catch {
          /* a listener's failure is its own */
        }
      }
      return e;
    },

    /**
     * Interactions since `sinceMs` ago, optionally only these kinds and only
     * those touching `post`.
     */
    events({ sinceMs = keepMs, kinds = null, post = null } = {}) {
      const cutoff = now() - sinceMs;
      const out = [];
      for (const e of byRecord.values()) {
        if (e.at < cutoff) continue;
        if (kinds && !kinds.includes(e.kind)) continue;
        if (post && !e.posts.has(post)) continue;
        out.push(e);
      }
      return out;
    },

    /**
     * Per post: who interacted and how, since `sinceMs` ago. A mention with no
     * post is left out.
     *
     * @returns {Map<string, { actors: Set<string>, records: object[], kinds: Record<string, number> }>}
     */
    byPost({ sinceMs = keepMs, kinds = null } = {}) {
      const out = new Map();
      for (const e of this.events({ sinceMs, kinds })) {
        for (const post of e.posts) {
          let p = out.get(post);
          if (!p) {
            p = { actors: new Set(), records: [], kinds: {} };
            out.set(post, p);
          }
          p.actors.add(e.actor);
          p.records.push(e);
          p.kinds[e.kind] = (p.kinds[e.kind] || 0) + 1;
        }
      }
      return out;
    },

    /**
     * How far back the window is whole: since the stream connected after its
     * last real outage, or the oldest interaction dropped for room, whichever
     * is later. 0 while the stream has never opened or has been down past
     * the tolerance. A consumer asking about more than this falls back to a
     * poll.
     */
    coversMs() {
      if (startedAt === null || broken()) return 0;
      return now() - startedAt;
    },

    /** Connected, or back within the tolerance: the window is being kept. */
    live() {
      return startedAt !== null && !broken();
    },

    /**
     * Since when interactions with this post have all been seen, or null.
     * The owner's posts are covered as long as the stream is; a watched post
     * of someone else's from the first connection that asked for it.
     */
    coveredSince(uri) {
      if (startedAt === null || broken()) return null;
      if (ownerDid && repoOf(uri) === ownerDid) return startedAt;
      const since = subjectSince.get(uri);
      return since === undefined ? null : Math.max(since, startedAt);
    },

    /**
     * A connection opened, asking for these records by URI. After an outage
     * past the tolerance, or the first time, the window starts again.
     */
    opened(subjects = []) {
      const t = now();
      if (startedAt === null || broken()) {
        startedAt = t;
        subjectSince.clear();
      }
      downAt = null;
      const asked = new Set(subjects);
      for (const uri of subjectSince.keys()) {
        if (!asked.has(uri)) subjectSince.delete(uri);
      }
      for (const uri of asked) {
        if (!subjectSince.has(uri)) subjectSince.set(uri, t);
      }
    },

    /** The connection stopped. Coverage holds through a short reconnect. */
    closed() {
      if (downAt === null) downAt = now();
    },

    /** A gap in the stream: what came before it may be missing. */
    gap() {
      startedAt = now();
      subjectSince.clear();
    },

    /** When the newest interaction arrived, or null. */
    lastAt: () => lastAt,

    /** Called with each interaction as it is recorded. Returns an unsubscribe. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    size: () => byRecord.size,
  };
}

/**
 * The one the bot runs on: fed by the Spacedust stream in index.js, read by
 * the alerts, watches and the shield. Empty, and covering nothing, while the
 * stream is off (MOD_STREAM=false).
 */
export const activity = createActivity({
  coveredFromStart: false,
  ownerDid: process.env.MOD_OWNER_DID || null,
});
