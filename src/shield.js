// The shield: who may reply to the owner's posts, and whether they may be
// quoted, changed when a pile-on starts, and put back when it is over.
//
// TWO LEVELS.
//
//   Triggers (MOD_SHIELD), per post. When so many accounts outside the
//   owner's circle reply to one thread, or quote one post, within a window,
//   replies there are closed to the people the owner follows and mentions,
//   or quotes are turned off. "ask" puts it to the owner with a 👍 and a
//   numbered menu; "auto" does it and says so, with the way back.
//
//   Attack mode (MOD_ATTACK), everything at once: replies closed and quotes
//   off on every recent post, quotes by strangers detached from the posts
//   under fire, new posts gated as they are made, and watches started on the
//   hottest posts so the usual triage and 👍 decide who gets blocked. It trips
//   on a pile-on across all posts and mentions, or on "shields up", and
//   stands down after MOD_ATTACK_HOURS or on "shields down".
//
// WHO COUNTS. Only accounts outside the owner's circle: UNKNOWN or NOTABLE by
// the same bands every scan uses. Friends replying in a hurry never trip
// anything. A score that cannot be read counts nobody, so an AppView outage
// cannot close anything.
//
// EXACT RESTORE. Every gate written is recorded with what was there before
// (shield_gate). Putting it back writes the old record, or deletes the gate
// if there was none, and only while the gate still reads as the shield left
// it: a gate the owner changed since is theirs, and is left alone. Gates
// layered on the same post (a trigger, then attack mode) come off in either
// order without one stranding the other.
//
// NEVER LOOSER. A post the owner already limited keeps its limit
// (gateRules.js).
//
// NO GATES WITHOUT THE OWNER. Threadgates and postgates live in the owner's
// repo, so writing them needs MOD_OWNER_APP_PASSWORD (gates.js). Without it
// the shield still notices, says so, and offers what needs no password: a
// watch on the post.
//
// The stream it counts from (Spacedust, ownerActivity.js) has no replay. A
// pile-on that happened while the bot was down is not counted.

import crypto from 'node:crypto';

import { OWNER_DID, APPVIEW } from './constants.js';
import { fetchWithTimeout } from './lib/atproto.js';
import { postWebUrl } from './lib/links.js';
import { select, selectAll, upsert, update, del } from './bot/db.js';
import {
  allowRules,
  describeAllow,
  nextThreadgate,
  nextPostgate,
  sameRecord,
  repliesLimited,
  quotesOff,
} from './lib/gateRules.js';
import { rateText } from './lib/shieldConfig.js';
import { shieldCommandText } from './lib/shieldCommand.js';

/** Bands outside the owner's circle: the ones a threshold counts. */
export const OUTSIDE_BANDS = new Set(['UNKNOWN', 'NOTABLE']);

/** How often the shield looks at the stream. */
export const SHIELD_EVERY_MS = 60_000;

/** How long one post's trigger stays quiet after it was put to the owner. */
const NOTICE_AGAIN_MS = 6 * 3_600_000;
/** How long an attack-mode question stays quiet after it was asked. */
const ATTACK_ASK_AGAIN_MS = 2 * 3_600_000;
/** A trigger gate comes off only after this long with no strangers on the post. */
const QUIET_BEFORE_RESTORE_MS = 60 * 60_000;
/** At most this many trigger notices go in one tick; the rest wait. */
const NOTICES_PER_TICK = 2;
/** How long an account's band is reused before it is scored again. */
const SCORE_TTL_MS = 30 * 60_000;
/**
 * How long a gate's record is kept once it has come off. A gate still on is
 * kept for as long as it is on: it is how it comes back off.
 */
const KEEP_RESTORED_MS = 90 * 24 * 3_600_000;
const PRUNE_EVERY_MS = 24 * 3_600_000;

const REPLY_KINDS = ['reply', 'threadReply'];
const QUOTE_KINDS = ['quote'];
const ALL_KINDS = ['reply', 'threadReply', 'quote', 'mention'];

const link = (uri) => postWebUrl(uri) || uri;

/** One of the owner's own posts, as opposed to a watched post someone else wrote. */
const ownPost = (uri) => String(uri ?? '').startsWith(`at://${OWNER_DID}/app.bsky.feed.post/`);

/**
 * An interaction aimed at the owner: on one of their posts, or a mention. The
 * stream may also carry posts being watched that someone else wrote, and a
 * pile-on there is not one on the owner.
 */
const aboutOwner = (e) => e.kind === 'mention' || [...e.posts].some(ownPost);

/**
 * In a dry run nothing is stored, so what was noticed is kept here instead,
 * or the same trigger would be logged every minute.
 */
const dryNotices = {};
/** Likewise, when attack mode would have run until, in a dry run. */
let dryAttackUntil = 0;
const iso = (ms) => new Date(ms).toISOString();

// --- who is outside the circle -----------------------------------------------

/**
 * Which of a set of accounts are outside the owner's circle, scored in one
 * call for those not seen lately. The owner's own replies in their thread are
 * never anyone's pile-on.
 *
 * @param {object} opts
 * @param {(dids: string[]) => Promise<Map<string, {band: string}>>} opts.score
 */
export function createClassifier({ score, ttlMs = SCORE_TTL_MS, now = () => Date.now() }) {
  const cache = new Map();
  return async function outsideAmong(dids) {
    const wanted = [...new Set(dids)].filter((d) => d && d !== OWNER_DID);
    const t = now();
    const stale = wanted.filter((d) => !(cache.get(d)?.at > t - ttlMs));
    if (stale.length) {
      const scored = await score(stale);
      for (const d of stale) {
        const band = scored?.get?.(d)?.band ?? null;
        // Not scored is not counted: unknown is not "a stranger".
        if (band) cache.set(d, { outside: OUTSIDE_BANDS.has(band), at: t });
      }
    }
    return new Set(wanted.filter((d) => cache.get(d)?.outside));
  };
}

/**
 * Whether one of the owner's posts starts a thread, from its record. A
 * threadgate only works on a thread's first post.
 */
export function createPostInfo({ gates = null, fetchImpl = fetchWithTimeout } = {}) {
  const cache = new Map();
  return async function postInfo(uri) {
    if (cache.has(uri)) return cache.get(uri);
    let info = null;
    if (gates) {
      info = await gates.post(uri).catch(() => null);
    } else {
      try {
        const res = await fetchImpl(
          `${APPVIEW}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`,
          { headers: { Accept: 'application/json' } },
        );
        const p = res.ok ? (await res.json())?.posts?.[0] : null;
        info = p ? { uri, root: !p.record?.reply } : null;
      } catch {
        info = null;
      }
    }
    if (info) cache.set(uri, info);
    return info;
  };
}

// --- state -------------------------------------------------------------------

export async function readState() {
  const [row] = (await select('shield_state', { eq: { id: 1 } }).catch(() => [])) || [];
  return {
    attackSince: row?.attack_since ?? null,
    attackUntil: row?.attack_until ?? null,
    attackWhy: row?.attack_why ?? null,
    notices: row?.notices || {},
  };
}

async function writeState(patch) {
  await upsert('shield_state', [{ id: 1, ...patch }]);
}

// --- guarded posts -------------------------------------------------------------

/** How long a guard lasts when the owner names no time. */
export const GUARD_HOURS = 72;
/** The longest a guard may run: the stream's window is six hours, the post's life is days. */
export const GUARD_MAX_HOURS = 14 * 24;

/**
 * Posts being guarded at `now`: post -> { mode, until }. A guard runs the
 * per-post triggers on its post in its own mode, whatever MOD_SHIELD says, so
 * the owner can arm one post they expect trouble on without arming them all.
 */
export async function liveGuards({ now = Date.now() } = {}) {
  const rows =
    (await select('shield_guard', {
      select: 'post,mode,until',
      is: { stopped_at: 'null' },
    }).catch(() => [])) || [];
  return new Map(
    rows
      .filter((r) => Date.parse(r.until) > now)
      .map((r) => [r.post, { mode: r.mode, until: r.until }]),
  );
}

/**
 * Guard one of the owner's posts for `hours`, or extend and re-mode a guard
 * already on it. `mode` 'auto' acts when a threshold is passed (with the
 * owner's app password; without it, it can only tell), 'ask' only tells.
 */
export async function guardPost(post, { mode = 'auto', hours = GUARD_HOURS, now = Date.now() } = {}) {
  if (!ownPost(post)) throw new Error('only your own posts can be guarded');
  const h = Math.min(GUARD_MAX_HOURS, Math.max(1, Math.round(hours || GUARD_HOURS)));
  const until = iso(now + h * 3_600_000);
  await upsert('shield_guard', [
    { post, mode: mode === 'ask' ? 'ask' : 'auto', created_at: iso(now), until, stopped_at: null },
  ]);
  return { post, mode: mode === 'ask' ? 'ask' : 'auto', until, hours: h };
}

/** Stop guarding a post. Whether there was a guard to stop. */
export async function unguardPost(post, { now = Date.now() } = {}) {
  const live = (await liveGuards({ now })).has(post);
  if (live) await update('shield_guard', { eq: { post } }, { stopped_at: iso(now) });
  return live;
}

/** Is attack mode on at `now`? */
export const attackOn = (state, now = Date.now()) =>
  Boolean(state?.attackUntil && Date.parse(state.attackUntil) > now);

/** Gates the shield wrote that are still on, optionally for one post. */
export async function liveGates({ post = null, kind = null, why = null } = {}) {
  const eq = {};
  if (post) eq.post = post;
  if (kind) eq.kind = kind;
  if (why) eq.why = why;
  return selectAll('shield_gate', {
    select: 'id,post,kind,prior,applied,why,applied_at,restore_after',
    eq,
    is: { restored_at: 'null' },
    order: 'applied_at.asc',
  });
}

// --- writing and restoring gates ---------------------------------------------

// One gate write at a time, from the tick, a DM and a new post alike, so two
// of them never read the same gate and both write over it.
let lock = Promise.resolve();

/**
 * When a gate was applied, never the same instant twice in this process, so
 * gates layered on one post always come off newest first.
 */
let lastStamp = 0;
function stamp(now) {
  lastStamp = Math.max(now, lastStamp + 1);
  return iso(lastStamp);
}
function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

/**
 * Change gates and record what was there before.
 *
 * @param {object} gates  gates.js
 * @param {Array<{ post: string, kind: 'threadgate'|'postgate', want: object }>} wants
 *   `want` is what nextThreadgate or nextPostgate takes
 * @param {object} opts
 * @param {'trigger'|'attack'|'manual'} opts.why
 * @param {string|null} [opts.restoreAfter]  when a trigger's gate may come off
 * @param {Map<string, object|null>} [opts.current]  gates already read, by
 *   `${kind} ${post}`, so attack mode reads each kind once
 * @param {boolean} [opts.dryRun]  work out what would change, write nothing
 * @returns {Promise<{ changed: object[], unchanged: object[] }>}
 */
export function applyGates(gates, wants, { why, restoreAfter = null, current = null, dryRun = false, now = Date.now() }) {
  return withLock(async () => {
    const changed = [];
    const unchanged = [];
    for (const w of wants) {
      const key = `${w.kind} ${w.post}`;
      const prior = current?.has(key) ? current.get(key) : await gates.read(w.kind, w.post);
      const next =
        w.kind === 'threadgate'
          ? nextThreadgate(w.post, prior, { ...w.want, now: iso(now) })
          : nextPostgate(w.post, prior, { ...w.want, now: iso(now) });
      if (!next) unchanged.push({ ...w, current: prior });
      else changed.push({ ...w, prior: prior ?? null, applied: next });
    }
    if (dryRun || !changed.length) return { changed, unchanged };

    // Recorded before the write, so a gate on the owner's post is never
    // there without the record of how to take it off. A write that fails is
    // closed again with its reason.
    const rows = changed.map((c) => ({
      id: crypto.randomUUID(),
      post: c.post,
      kind: c.kind,
      prior: c.prior,
      applied: c.applied,
      why,
      applied_at: stamp(now),
      restore_after: restoreAfter,
    }));
    await upsert('shield_gate', rows);
    try {
      await gates.write(
        changed.map((c) => ({ kind: c.kind, post: c.post, value: c.applied, existed: c.prior !== null })),
      );
    } catch (err) {
      for (const r of rows) {
        await update(
          'shield_gate',
          { eq: { id: r.id } },
          { restored_at: iso(now), restore_note: `not written: ${String(err?.message || err).slice(0, 120)}` },
        ).catch(() => {});
      }
      throw err;
    }
    return { changed, unchanged };
  });
}

/**
 * Take gates the shield wrote back off, putting back what was there.
 *
 * Per post and kind, newest first. A gate with a newer one of the shield's
 * on top that stays is folded into it: the one on top will put back what
 * this one found. Otherwise the gate there now is compared with what the
 * shield wrote, and only if they match is the earlier one put back. One the
 * owner changed since is left, and said so.
 *
 * @returns {Promise<{ restored: object[], left: object[] }>}
 */
export function restoreGates(gates, rows, { now = Date.now(), dryRun = false } = {}) {
  return withLock(async () => {
    const restored = [];
    const left = [];
    const ids = new Set(rows.map((r) => r.id));
    const groups = new Map();
    for (const r of rows) groups.set(`${r.kind} ${r.post}`, { post: r.post, kind: r.kind });
    const writes = [];
    const marks = [];
    const reprior = [];

    for (const { post, kind } of groups.values()) {
      const stack = (await liveGates({ post, kind })).sort((a, b) =>
        a.applied_at === b.applied_at ? 0 : a.applied_at < b.applied_at ? 1 : -1,
      );
      const existing = await gates.read(kind, post);
      let cur = existing;
      let moved = false;
      let broken = false;
      let above = null;
      for (const row of stack) {
        if (!ids.has(row.id)) {
          above = row;
          continue;
        }
        if (above) {
          if (sameRecord(above.prior, row.applied)) {
            above.prior = row.prior;
            reprior.push(above);
            marks.push({ row, note: 'under a later gate, which now puts back what this one found' });
            restored.push(row);
          } else {
            marks.push({ row, note: 'changed since' });
            left.push(row);
          }
          continue;
        }
        if (!broken && sameRecord(cur, row.applied)) {
          cur = row.prior;
          moved = true;
          marks.push({ row, note: null });
          restored.push(row);
        } else {
          broken = true;
          marks.push({ row, note: 'changed since' });
          left.push(row);
        }
      }
      if (moved) writes.push({ kind, post, value: cur, existed: existing !== null });
    }
    if (dryRun) return { restored, left };

    if (writes.length) await gates.write(writes);
    for (const r of reprior) {
      await update('shield_gate', { eq: { id: r.id } }, { prior: r.prior });
    }
    for (const { row, note } of marks) {
      await update(
        'shield_gate',
        { eq: { id: row.id } },
        { restored_at: iso(now), ...(note ? { restore_note: note } : {}) },
      );
    }
    return { restored, left };
  });
}

/** What a threshold or a command wants on one post. */
const repliesWant = (post, rule, hide = []) => ({
  post,
  kind: 'threadgate',
  want: { allow: allowRules(rule), hide },
});
const quotesWant = (post, detach = []) => ({
  post,
  kind: 'postgate',
  want: { disable: true, detach },
});

// --- attack mode -------------------------------------------------------------

/**
 * Turn attack mode on, or extend it.
 *
 * @param {object} deps { gates, activity, outsideAmong, cfg, startWatch, dryRun, log }
 * @param {object} opts { why: 'trip'|'manual', hours, now }
 * @returns {Promise<{ until: string, gated: number, posts: number, detached: number,
 *   hidden: number, watching: string[], canGate: boolean, extended: boolean }>}
 */
export async function shieldsUp(deps, { why = 'manual', hours = null, now = Date.now() } = {}) {
  const { gates, activity, outsideAmong, cfg, startWatch = null, dryRun = false, log = () => {} } = deps;
  const state = await readState();
  const extended = attackOn(state, now);
  const span = (hours || cfg.attack.hours) * 3_600_000;
  const until = iso(Math.max(now + span, extended ? Date.parse(state.attackUntil) : 0));

  // Who is piling on, and where, over the trip window (or the last hour).
  const windowMs = cfg.attack.trip?.windowMs ?? 60 * 60_000;
  const recent = activity
    .events({ sinceMs: Math.max(windowMs, 60 * 60_000), kinds: ALL_KINDS })
    .filter(aboutOwner);
  const outside = recent.length
    ? await outsideAmong(recent.map((e) => e.actor)).catch(() => new Set())
    : new Set();
  const hot = new Map();
  for (const e of recent) {
    if (!outside.has(e.actor)) continue;
    for (const post of e.posts) {
      if (!ownPost(post)) continue;
      const h = hot.get(post) || { actors: new Set(), quotes: [], replies: [] };
      h.actors.add(e.actor);
      if (e.kind === 'quote') h.quotes.push(e.record);
      if (e.kind === 'reply' || e.kind === 'threadReply') h.replies.push(e.record);
      hot.set(post, h);
    }
  }

  let gated = 0;
  let posts = 0;
  let detached = 0;
  let hidden = 0;
  if (gates) {
    const recentPosts = await gates.recentPosts({ days: cfg.attack.days, max: cfg.attack.maxPosts, now });
    const byUri = new Map(recentPosts.map((p) => [p.uri, p]));
    // A post under fire is gated however old it is.
    const postInfo = createPostInfo({ gates });
    for (const uri of hot.keys()) {
      if (!byUri.has(uri)) {
        const info = await postInfo(uri);
        if (info) byUri.set(uri, info);
      }
    }
    const [threadgates, postgates] = await Promise.all([
      gates.readAll('threadgate'),
      gates.readAll('postgate'),
    ]);
    const current = new Map();
    const wants = [];
    for (const p of byUri.values()) {
      const h = hot.get(p.uri);
      if (p.root) {
        const hide = cfg.attack.hideReplies ? h?.replies || [] : [];
        current.set(`threadgate ${p.uri}`, threadgates.get(p.uri) ?? null);
        wants.push(repliesWant(p.uri, cfg.replyRule, hide));
        hidden += hide.length;
      }
      const detach = cfg.attack.detachQuotes ? h?.quotes || [] : [];
      current.set(`postgate ${p.uri}`, postgates.get(p.uri) ?? null);
      wants.push(quotesWant(p.uri, detach));
      detached += detach.length;
    }
    posts = byUri.size;
    const out = await applyGates(gates, wants, { why: 'attack', current, dryRun, now });
    gated = out.changed.length;
  }

  if (dryRun) {
    dryAttackUntil = Date.parse(until);
  } else {
    await writeState({
      attack_since: extended ? state.attackSince : iso(now),
      attack_until: until,
      attack_why: extended ? state.attackWhy : why,
    });
  }

  // The hottest posts get a watch, which reads what strangers wrote and
  // puts the hostile ones to the owner with a 👍. Ask mode: attack mode
  // never adds anyone to a list by itself.
  const watching = [];
  if (startWatch && !dryRun && cfg.attack.watches > 0) {
    const hottest = [...hot.entries()]
      .sort((a, b) => b[1].actors.size - a[1].actors.size)
      .slice(0, cfg.attack.watches)
      .map(([uri]) => uri);
    for (const uri of hottest) {
      try {
        await startWatch(uri);
        watching.push(uri);
      } catch (err) {
        log('Shield could not start a watch', { uri, err: String(err?.message || err) });
      }
    }
  }
  log(dryRun ? 'DRY_RUN: attack mode would go on' : 'Attack mode on', {
    why,
    until,
    gated,
    posts,
    detached,
    hidden,
    watching: watching.length,
  });
  return { until, gated, posts, detached, hidden, watching, canGate: Boolean(gates), extended };
}

/**
 * Turn attack mode off and take its gates off.
 *
 * @returns {Promise<{ was: boolean, restored: number, left: object[] }>}
 */
export async function shieldsDown(deps, { now = Date.now() } = {}) {
  const { gates, dryRun = false, log = () => {} } = deps;
  const state = await readState();
  const was = attackOn(state, now) || Boolean(state.attackUntil);
  const rows = await liveGates({ why: 'attack' });
  let restored = [];
  let left = [];
  if (rows.length && gates) {
    ({ restored, left } = await restoreGates(gates, rows, { now, dryRun }));
  }
  if (dryRun) dryAttackUntil = 0;
  else await writeState({ attack_since: null, attack_until: null, attack_why: null });
  log(dryRun ? 'DRY_RUN: attack mode would stand down' : 'Attack mode off', {
    restored: restored.length,
    left: left.length,
  });
  return { was, restored: new Set(restored.map((r) => r.post)).size, left };
}

/**
 * A post the owner just made, from Jetstream. While attack mode is on it is
 * gated at once, before the strangers already watching find it.
 *
 * @returns {Promise<boolean>} whether it was gated
 */
export async function onOwnerPost(event, deps, { now = Date.now() } = {}) {
  const { gates, cfg, dryRun = false, log = () => {} } = deps;
  if (event?.kind !== 'commit' || event.did !== OWNER_DID) return false;
  const c = event.commit;
  if (c?.operation !== 'create' || c.collection !== 'app.bsky.feed.post') return false;
  if (!gates || !attackOn(await readState(), now)) return false;
  const uri = `at://${OWNER_DID}/app.bsky.feed.post/${c.rkey}`;
  const wants = [quotesWant(uri)];
  if (!c.record?.reply) wants.unshift(repliesWant(uri, cfg.replyRule));
  const out = await applyGates(gates, wants, { why: 'attack', dryRun, now });
  log(dryRun ? 'DRY_RUN: would gate a new post' : 'Gated a new post during attack mode', {
    uri,
    gates: out.changed.length,
  });
  return out.changed.length > 0;
}

// --- one post, by threshold or by command ------------------------------------

/**
 * Close replies on one post. `why` 'trigger' comes off by itself after
 * MOD_SHIELD_RESTORE_HOURS once the post is quiet; 'manual' stays.
 *
 * @returns {Promise<{ ok: boolean, changed: boolean, text: string }>}
 */
export async function closeReplies(deps, post, { rule = null, why = 'manual', now = Date.now() } = {}) {
  const { gates, cfg, dryRun = false } = deps;
  const info = await gates.post(post);
  if (!info) return { ok: false, changed: false, text: 'I could not find that post on your account.' };
  if (!info.root) {
    return {
      ok: false,
      changed: false,
      text: 'That post is a reply. Who may reply is set on the first post of the thread, so send me that one.',
    };
  }
  const words = rule?.length ? rule : cfg.replyRule;
  const restoreAfter = why === 'trigger' && cfg.restoreHours ? iso(now + cfg.restoreHours * 3_600_000) : null;
  const out = await applyGates(gates, [repliesWant(post, words)], { why, restoreAfter, dryRun, now });
  if (!out.changed.length) {
    const already = out.unchanged[0]?.current;
    return {
      ok: true,
      changed: false,
      text: repliesLimited(already)
        ? `Replies on ${link(post)} were already limited to ${describeAllow(already.allow)}, so I left them as they are.`
        : `Nothing to change on ${link(post)}.`,
    };
  }
  const allowed = describeAllow(out.changed[0].applied.allow);
  return {
    ok: true,
    changed: true,
    text: `Closed replies on ${link(post)}. Only ${allowed} can reply now.`,
  };
}

/**
 * Turn quotes off on one post. As closeReplies for `why`.
 */
export async function disableQuotes(deps, post, { why = 'manual', detach = [], now = Date.now() } = {}) {
  const { gates, cfg, dryRun = false } = deps;
  const info = await gates.post(post);
  if (!info) return { ok: false, changed: false, text: 'I could not find that post on your account.' };
  const restoreAfter = why === 'trigger' && cfg.restoreHours ? iso(now + cfg.restoreHours * 3_600_000) : null;
  const out = await applyGates(gates, [quotesWant(post, detach)], { why, restoreAfter, dryRun, now });
  if (!out.changed.length) {
    return {
      ok: true,
      changed: false,
      text: quotesOff(out.unchanged[0]?.current)
        ? `Quotes on ${link(post)} were already off.`
        : `Nothing to change on ${link(post)}.`,
    };
  }
  const d = detach.length ? ` Detached ${detach.length} ${detach.length === 1 ? 'quote' : 'quotes'} already made.` : '';
  return { ok: true, changed: true, text: `Turned quotes off on ${link(post)}.${d}` };
}

/**
 * Take the shield's gates of one kind off one post. A limit the owner set
 * themselves is not the shield's, and stays.
 */
export async function reopen(deps, post, kind, { now = Date.now() } = {}) {
  const { gates, dryRun = false } = deps;
  const what = kind === 'threadgate' ? 'Replies' : 'Quotes';
  const rows = await liveGates({ post, kind });
  const { restored, left } = rows.length
    ? await restoreGates(gates, rows, { now, dryRun })
    : { restored: [], left: [] };
  const still = await gates.read(kind, post);
  const limited = kind === 'threadgate' ? repliesLimited(still) : quotesOff(still);
  if (!rows.length) {
    return {
      ok: true,
      changed: false,
      text: limited
        ? `I didn't limit ${what.toLowerCase()} on ${link(post)}; that was set in your client, so change it there.`
        : `${what} on ${link(post)} are already open.`,
    };
  }
  if (left.length && !restored.length) {
    return {
      ok: true,
      changed: false,
      text: `That gate was changed since I set it, so I left it as it is. Change it in your client.`,
    };
  }
  return {
    ok: true,
    changed: true,
    text: limited
      ? `Took my limit off ${link(post)}, but you had limited ${what.toLowerCase()} there before, so that stays.`
      : `${what} on ${link(post)} are open again.`,
  };
}

/** Keep the shield's gates on a post until the owner takes them off. */
export async function keepClosed(post) {
  const rows = await liveGates({ post });
  for (const r of rows) {
    await update('shield_gate', { eq: { id: r.id } }, { restore_after: null, why: r.why === 'trigger' ? 'manual' : r.why });
  }
  return rows.length;
}

/** Forget gates that came off more than KEEP_RESTORED_MS ago. */
export async function pruneRestored({ now = Date.now() } = {}) {
  const old = await selectAll('shield_gate', {
    select: 'id',
    where: { restored_at: [`not.is.null`, `lt.${iso(now - KEEP_RESTORED_MS)}`] },
    order: 'id.asc',
  });
  for (let i = 0; i < old.length; i += 50) {
    await del('shield_gate', { where: { id: { in: old.slice(i, i + 50).map((r) => r.id) } } });
  }
  return old.length;
}

// --- the tick ----------------------------------------------------------------

/**
 * One look at the stream: stand attack mode down when its time is up, take
 * off trigger gates whose post has gone quiet, trip attack mode, and fire
 * per-post triggers.
 *
 * @param {object} deps
 * @param {object} deps.cfg            config.shield
 * @param {object|null} deps.gates     gates.js, or null with no owner password
 * @param {object} deps.activity       ownerActivity.js
 * @param {Function} deps.outsideAmong createClassifier()
 * @param {Function} deps.postInfo     createPostInfo()
 * @param {Function} deps.notify       ({ text, options, pending, describe, links }) => Promise
 * @param {Function} [deps.startWatch] (uri) => Promise
 * @param {boolean} [deps.dryRun]
 * @returns {Promise<{ fired: string[] }>} what fired, for the log and tests
 */
export async function shieldTick(deps, { now = Date.now() } = {}) {
  const { cfg, gates, activity, outsideAmong, postInfo, notify, dryRun = false, log = () => {} } = deps;
  const fired = [];
  const state = await readState();
  const notices = dryRun ? { ...state.notices, ...dryNotices } : { ...state.notices };
  const noticed = (key, againMs) => notices[key] && now - Date.parse(notices[key]) < againMs;
  const tell = async (key, msg) => {
    if (dryRun) {
      log('DRY_RUN: the shield would say', { key, text: msg.text });
      dryNotices[key] = iso(now);
    } else {
      await notify(msg);
    }
    notices[key] = iso(now);
    fired.push(key);
  };

  // Attack mode's time is up.
  if (state.attackUntil && !attackOn(state, now)) {
    const out = await shieldsDown(deps, { now });
    await tell('attack-down', standDownText(out, { timer: true }));
  }

  // Trigger gates whose post has been quiet long enough.
  if (gates) {
    const due = (await liveGates({ why: 'trigger' })).filter(
      (r) => r.restore_after && Date.parse(r.restore_after) <= now,
    );
    const quietEnough = activity.coversMs() >= QUIET_BEFORE_RESTORE_MS;
    for (const post of new Set(due.map((r) => r.post))) {
      if (!quietEnough) break;
      const recent = activity.events({ post, sinceMs: QUIET_BEFORE_RESTORE_MS, kinds: ALL_KINDS });
      const loud = recent.length ? await outsideAmong(recent.map((e) => e.actor)).catch(() => null) : new Set();
      if (loud === null || loud.size) continue;
      const rows = due.filter((r) => r.post === post);
      const { restored } = await restoreGates(gates, rows, { now, dryRun });
      if (restored.length) {
        const kinds = new Set(restored.map((r) => r.kind));
        const what = kinds.size === 2 ? 'replies and quotes' : kinds.has('threadgate') ? 'replies' : 'quotes';
        await tell(`reopen:${post}`, {
          text: `Opened ${what} on ${link(post)} again: it has been quiet for an hour.`,
          links: [postWebUrl(post)],
        });
      }
    }
  }

  let on = attackOn(await readState(), now) || (dryRun && dryAttackUntil > now);

  // Attack mode trips on everything at once.
  const trip = cfg.attack.trip;
  if (!on && cfg.attack.mode !== 'off' && trip && !noticed('attack', ATTACK_ASK_AGAIN_MS)) {
    const events = activity.events({ sinceMs: trip.windowMs, kinds: ALL_KINDS }).filter(aboutOwner);
    const raw = new Set(events.map((e) => e.actor));
    if (raw.size >= trip.count) {
      const outside = await outsideAmong([...raw]).catch(() => new Set());
      if (outside.size >= trip.count) {
        const minutes = Math.round(trip.windowMs / 60_000);
        if (cfg.attack.mode === 'auto' && (gates || !cfg.canGate)) {
          const out = await shieldsUp(deps, { why: 'trip', now });
          await tell('attack', shieldsUpText(out, { tripped: `${outside.size} accounts outside your circle in ${minutes} min` }));
          // It covers every post, so no post needs its own trigger now.
          on = true;
        } else {
          // Shields up does something only with gates to write or watches to
          // start. With neither, this is a heads-up and no more.
          const useful = Boolean(gates || deps.startWatch);
          await tell('attack', {
            text:
              `${outside.size} accounts outside your circle replied to, quoted or mentioned you in the last ${minutes} min.` +
              (gates ? '' : `\n\n${NO_PASSWORD}`),
            options: [
              ...(useful
                ? [
                    {
                      label: gates
                        ? 'Shields up: close replies and quotes everywhere'
                        : 'Shields up: watch the posts under fire',
                      command: shieldCommandText({ action: 'up' }),
                    },
                    { label: 'Shields up for 6 hours', command: shieldCommandText({ action: 'up', hours: 6 }) },
                  ]
                : []),
              { label: 'Show the shield', command: shieldCommandText({ action: 'status' }) },
            ],
            pending: useful ? [shieldCommandText({ action: 'up' })] : null,
            describe: gates
              ? `shields up for ${cfg.attack.hours}h: replies and quotes closed on your recent posts`
              : `shields up for ${cfg.attack.hours}h: watch the posts under fire`,
          });
        }
      }
    }
  }

  // Per-post triggers. While attack mode is on it has already done this. A
  // guarded post runs them in its guard's mode even with MOD_SHIELD off.
  const guards = on ? new Map() : await liveGuards({ now });
  if ((cfg.mode !== 'off' || guards.size) && !on) {
    let sent = 0;
    for (const t of triggerKinds(cfg)) {
      const byPost = activity.byPost({ sinceMs: t.rate.windowMs, kinds: t.kinds });
      for (const [post, seen] of byPost) {
        if (sent >= NOTICES_PER_TICK) break;
        if (!ownPost(post)) continue;
        const mode = guards.get(post)?.mode ?? cfg.mode;
        if (mode === 'off') continue;
        if (seen.actors.size < t.rate.count) continue;
        const key = `${t.name}:${post}`;
        if (noticed(key, NOTICE_AGAIN_MS)) continue;
        if ((await liveGates({ post, kind: t.kind })).length) continue;
        const outside = await outsideAmong([...seen.actors]).catch(() => new Set());
        if (outside.size < t.rate.count) continue;
        if (t.name === 'replies' && !(await postInfo(post))?.root) continue;
        // Already limited, by the owner or anyone: nothing to offer.
        if (gates) {
          const current = await gates.read(t.kind, post).catch(() => null);
          if (t.name === 'replies' ? repliesLimited(current) : quotesOff(current)) continue;
        }
        await tell(key, await triggerNotice(deps, { t, post, count: outside.size, now, mode }));
        sent += 1;
      }
    }
  }

  if (!dryRun && !noticed('prune', PRUNE_EVERY_MS)) {
    const pruned = await pruneRestored({ now }).catch(() => 0);
    if (pruned) log('Shield forgot old gates', { pruned });
    notices.prune = iso(now);
  }

  if (!dryRun && (fired.length || notices.prune !== state.notices.prune)) {
    // Old notices are dropped, so the row stays small.
    const keep = Object.fromEntries(
      Object.entries(notices).filter(([, at]) => now - Date.parse(at) < 24 * 3_600_000),
    );
    await writeState({ notices: keep });
  }
  return { fired };
}

function triggerKinds(cfg) {
  const out = [];
  if (cfg.replies) out.push({ name: 'replies', kind: 'threadgate', kinds: REPLY_KINDS, rate: cfg.replies });
  if (cfg.quotes) out.push({ name: 'quotes', kind: 'postgate', kinds: QUOTE_KINDS, rate: cfg.quotes });
  return out;
}

/** The DM for one post past a threshold, acting first when the mode is auto. */
async function triggerNotice(deps, { t, post, count, now, mode = deps.cfg.mode }) {
  const { cfg, gates } = deps;
  const minutes = Math.round(t.rate.windowMs / 60_000);
  const did = t.name === 'replies' ? 'replied to' : 'quoted';
  const head = `${count} accounts outside your circle ${did} ${link(post)} in ${minutes} min.`;
  const watch = { label: 'Watch it for 24 hours', command: shieldCommandText({ action: 'watch', post }) };
  const up = { label: 'Shields up everywhere', command: shieldCommandText({ action: 'up' }) };
  const act =
    t.name === 'replies'
      ? { action: 'close', post, label: `Close replies to ${cfg.replyRule.join(' and ')}` }
      : { action: 'quotesOff', post, label: 'Turn quotes off' };
  const undo =
    t.name === 'replies'
      ? { label: 'Open replies again now', command: shieldCommandText({ action: 'open', post }) }
      : { label: 'Turn quotes back on now', command: shieldCommandText({ action: 'quotesOn', post }) };
  const keep = { label: 'Keep it that way (no reopening by itself)', command: shieldCommandText({ action: 'keep', post }) };

  if (!gates) {
    return { text: `${head}\n\n${NO_PASSWORD}`, options: [watch], links: [postWebUrl(post)] };
  }
  if (mode === 'auto') {
    const out =
      t.name === 'replies'
        ? await closeReplies(deps, post, { why: 'trigger', now })
        : await disableQuotes(deps, post, { why: 'trigger', now });
    const back = out.changed && cfg.restoreHours
      ? ` I'll undo it after ${cfg.restoreHours}h once it has been quiet for an hour.`
      : '';
    return {
      text: `${head}\n${out.text}${back}`,
      options: out.changed ? [undo, ...(cfg.restoreHours ? [keep] : []), watch, up] : [watch, up],
      links: [postWebUrl(post)],
    };
  }
  const command = shieldCommandText(act);
  return {
    text: head,
    options: [{ label: act.label, command }, watch, up],
    pending: [command],
    describe: t.name === 'replies'
      ? `close replies on that post to ${cfg.replyRule.join(' and ')}`
      : 'turn quotes off on that post',
    links: [postWebUrl(post)],
  };
}

/** What the owner is told when gates cannot be written. */
export const NO_PASSWORD =
  'I can\'t close replies or turn off quotes without MOD_OWNER_APP_PASSWORD, an app password for your account. Watching the post works without it.';

/** The message for attack mode going on. */
export function shieldsUpText(out, { tripped = null } = {}) {
  const lines = [];
  const until = when(out.until);
  if (tripped) lines.push(`Attack mode is on: ${tripped}.`);
  else lines.push(out.extended ? `Attack mode extended to ${until}.` : `Attack mode is on until ${until}.`);
  if (out.canGate) {
    lines.push(
      `Closed replies and turned quotes off across ${out.posts} recent ${out.posts === 1 ? 'post' : 'posts'} (${out.gated} ${out.gated === 1 ? 'change' : 'changes'}).` +
        (out.detached ? ` Detached ${out.detached} quotes from strangers.` : '') +
        (out.hidden ? ` Hid ${out.hidden} replies.` : '') +
        ' New posts get the same until it ends.',
    );
  } else {
    lines.push(NO_PASSWORD);
  }
  if (out.watching.length) {
    lines.push(`Watching the ${out.watching.length === 1 ? 'post' : `${out.watching.length} posts`} drawing the most; I'll ask before blocking anyone.`);
  }
  return {
    text: lines.join('\n'),
    options: [
      { label: 'Stand down now and put everything back', command: shieldCommandText({ action: 'down' }) },
      { label: 'Keep it on for 24 hours more', command: shieldCommandText({ action: 'up', hours: 24 }) },
      { label: 'Show the shield', command: shieldCommandText({ action: 'status' }) },
    ],
  };
}

/** The message for attack mode going off. */
export function standDownText(out, { timer = false } = {}) {
  const head = timer ? 'Attack mode has ended.' : out.was ? 'Stood down.' : 'Attack mode was not on.';
  const lines = [head];
  if (out.restored) {
    lines.push(`Put replies and quotes back as they were on ${out.restored} ${out.restored === 1 ? 'post' : 'posts'}.`);
  }
  if (out.left?.length) {
    const n = new Set(out.left.map((r) => r.post)).size;
    lines.push(`${n} ${n === 1 ? 'post was' : 'posts were'} changed since, so I left ${n === 1 ? 'it' : 'them'} as you set ${n === 1 ? 'it' : 'them'}.`);
  }
  return {
    text: lines.join('\n'),
    options: timer ? [{ label: 'Shields up again', command: shieldCommandText({ action: 'up' }) }] : null,
  };
}

/** A time in UTC, short. */
export function when(at) {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return 'later';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The answer to "shield". */
export async function statusText(deps, { now = Date.now() } = {}) {
  const { cfg, gates, activity } = deps;
  const state = await readState();
  const live = await liveGates();
  const posts = new Set(live.map((r) => r.post)).size;
  const lines = [];
  lines.push(
    attackOn(state, now)
      ? `Attack mode: on until ${when(state.attackUntil)}.`
      : `Attack mode: off (${cfg.attack.mode === 'off' ? 'never trips' : `${cfg.attack.mode === 'auto' ? 'goes on' : 'asks'} at ${rateText(cfg.attack.trip)}`}).`,
  );
  lines.push(
    cfg.mode === 'off'
      ? 'Per-post triggers: off.'
      : `Per-post triggers: ${cfg.mode}, replies at ${rateText(cfg.replies)}, quotes at ${rateText(cfg.quotes)}.`,
  );
  lines.push(posts ? `Limits I've set: ${posts} ${posts === 1 ? 'post' : 'posts'}.` : 'Limits I\'ve set: none.');
  const guarded = (await liveGuards({ now }).catch(() => new Map())).size;
  if (guarded) lines.push(`Guarding: ${guarded} ${guarded === 1 ? 'post' : 'posts'}.`);
  const hours = Math.floor(activity.coversMs() / 3_600_000);
  const minutes = Math.floor(activity.coversMs() / 60_000);
  lines.push(
    deps.streaming === false
      ? 'Not listening: MOD_STREAM is off, so nothing trips by itself.'
      : !activity.live()
        ? 'Not connected to the stream right now, so nothing trips by itself until it is back.'
        : `Listening for ${hours ? `${hours}h` : `${minutes} min`}, ${activity.size()} replies, quotes and mentions held.`,
  );
  // A password that was given and refused says why, not "set one".
  if (!gates) lines.push(deps.gatesProblem || NO_PASSWORD);
  return {
    text: lines.join('\n'),
    options: attackOn(state, now)
      ? [{ label: 'Stand down and put everything back', command: shieldCommandText({ action: 'down' }) }]
      : [{ label: 'Shields up', command: shieldCommandText({ action: 'up' }) }],
  };
}
