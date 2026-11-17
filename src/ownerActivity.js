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
 */
export function createActivity({
  now = () => Date.now(),
  keepMs = KEEP_MS,
  max = MAX_EVENTS,
} = {}) {
  /** record uri -> { kind, actor, record, posts:Set, at } in arrival order. */
  const byRecord = new Map();
  let startedAt = now();
  let lastAt = null;
  const listeners = new Set();

  function prune() {
    const cutoff = now() - keepMs;
    for (const [key, e] of byRecord) {
      if (e.at >= cutoff && byRecord.size <= max) break;
      byRecord.delete(key);
      // What was dropped for room is no longer covered.
      if (e.at >= cutoff) startedAt = Math.max(startedAt, e.at);
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
     * How far back the window is whole: since the stream (re)connected or the
     * oldest dropped interaction, whichever is later. A consumer asking about
     * an hour this does not cover falls back to a poll.
     */
    coversMs() {
      return now() - startedAt;
    },

    /** A gap in the stream: what came before it may be missing. */
    gap() {
      startedAt = now();
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
export const activity = createActivity();
