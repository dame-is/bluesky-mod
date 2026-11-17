// Watching a post. Pile-ons run for hours, and a watch keeps up without the
// owner sending the same post again.
//
// A watch has a plan of its own that keeps growing. Every few minutes the
// post's quotes and replies are harvested again; anyone new is scored, added
// to the watch's plan with what they wrote, and read by the same triage as
// everything else. The baseline, everyone already there when the watch
// started, is a scan of its own and never on the watch's plan, so the watch
// never reads or adds it, whatever else labels it. Then, depending on what
// the owner asked for:
//
//   ask   (the default) nothing is added. The hourly digest says what was found
//         and a 👍 adds the hostile ones.
//   auto  ("watch this and block the hostile ones") the accounts triage
//         reads as hostile are added as they are found, and the digest says
//         who, with the way to take one back. CONNECTED and NOTABLE accounts
//         are held for a 👍 even then: someone close to the owner or widely
//         followed is never blocked on a model's reading alone.
//
// Likes and reposts are not read: they carry no words to judge. The first scan
// covers them, and "likers" / "unknowns" on the card are the tools for those.
//
// Also here: noticing when one of the owner's own posts suddenly draws quotes
// and replies, so the bot can offer a watch before the owner has to ask.

import crypto from 'node:crypto';

import { OWNER_DID, APPVIEW } from '../constants.js';
import { fetchWithTimeout } from '../lib/atproto.js';
import { resolveTarget, TargetError } from '../lib/target.js';
import { harvestPost } from '../lib/harvest.js';
import { summarise } from '../lib/score.js';
import { postWebUrl } from '../lib/links.js';
import { select, selectAll, upsert, update } from './db.js';
import { listUri, ownerOf } from './listWrite.js';
import {
  proposePlan,
  applyPlanToTriage,
  countDecisions,
  shortCode,
} from './bulkPlan.js';
import { runTriage, evidenceUriFor } from './triage.js';

/** How often a watched post is read again. */
export const WATCH_EVERY_MS = 5 * 60_000;
/** How often a watch with news reports. */
const DIGEST_EVERY_MS = 60 * 60_000;
/** Engagement worth reading on a watched post. */
const READ_KINDS = ['quote', 'reply', 'threadReply'];
/** Bands a watch never adds without a 👍, even in auto. */
const HELD_BANDS = ['PROTECTED', 'CONNECTED', 'NOTABLE'];

const hoursLeft = (w, now) =>
  Math.max(0, Math.round((Date.parse(w.until) - now) / 3_600_000));

/** Live watches, newest first. */
export async function liveWatches({ now = Date.now() } = {}) {
  const rows = await select('watch', {
    select:
      'id,convo_id,uri,plan_id,mode,created_at,until,last_checked_at,last_digest_at,stats',
    is: { stopped_at: 'null' },
    order: 'created_at.desc',
  });
  return (rows || []).filter((w) => Date.parse(w.until) > now);
}

/**
 * Start watching, or extend and re-mode a watch already running on that post.
 *
 * @returns {Promise<{ watch, plan, extended: boolean }>}
 */
export async function startWatch({
  convoId,
  target,
  hours = 24,
  auto = false,
  now = Date.now(),
  signal,
}) {
  const resolved = await resolveTarget(target);
  // A watch reads a post's quotes and replies. A list's members or a feed's
  // subscribers are not that, and never harvested as if they were.
  if (resolved.collection !== 'app.bsky.feed.post') {
    throw new TargetError('I watch posts, and that is not a post.');
  }
  const until = new Date(now + hours * 3_600_000).toISOString();
  const mode = auto ? 'auto' : 'ask';
  const running = (await liveWatches({ now })).find(
    (w) => w.uri === resolved.uri,
  );
  if (running) {
    await update('watch', { eq: { id: running.id } }, { until, mode });
    const plan = running.plan_id ? await findPlanById(running.plan_id) : null;
    return { watch: { ...running, until, mode }, plan, extended: true };
  }
  // The baseline: everyone so far, scored, with what they wrote, as a scan
  // of its own. The watch's plan starts empty and holds only who arrives
  // later, so its adds, its counts and the 👍 on its digest never reach
  // anyone who was already there, even once a triage of the scan labels them.
  const plan = await proposePlan({
    link: resolved.uri,
    kind: 'everyone',
    signal,
  });
  const planId = crypto.randomUUID();
  await upsert('plan', [
    {
      id: planId,
      created_at: new Date(now).toISOString(),
      approved_at: null,
      approved_bands: null,
      totals: { uri: resolved.uri, kind: 'watch' },
      note: `watch of ${resolved.uri}`,
    },
  ]);
  const watch = {
    convo_id: convoId,
    uri: resolved.uri,
    plan_id: planId,
    mode,
    until,
    stats: {
      baseline: plan.total,
      baselinePlan: plan.planId,
      newSinceDigest: 0,
      checks: 0,
    },
  };
  await upsert('watch', [watch]);
  const [row] = await select('watch', {
    select: 'id,convo_id,uri,plan_id,mode,created_at,until,stats',
    eq: { plan_id: planId },
    limit: 1,
  });
  return { watch: row || watch, plan, extended: false };
}

async function findPlanById(id) {
  const rows = await select('plan', {
    select: 'id,created_at,approved_at,approved_bands,totals,note',
    eq: { id },
    limit: 1,
  });
  return rows?.[0] ?? null;
}

/** Stop the watch on this post, or the newest one if no post was named. */
export async function stopWatch({ target = null, now = Date.now() } = {}) {
  const live = await liveWatches({ now });
  let watch = live[0] ?? null;
  if (target) {
    const uri = (await resolveTarget(target).catch(() => null))?.uri;
    watch = live.find((w) => w.uri === uri) ?? null;
  }
  if (!watch) return null;
  await update(
    'watch',
    { eq: { id: watch.id } },
    { stopped_at: new Date(now).toISOString() },
  );
  return watch;
}

/** The reply to "what are you watching". */
export function watchesText(watches, { now = Date.now() } = {}) {
  if (!watches.length) {
    return 'Not watching anything. Send a post with "watch this" to start.';
  }
  return [
    `Watching ${watches.length === 1 ? 'one post' : `${watches.length} posts`}:`,
    ...watches.map(
      (w) =>
        `- ${postWebUrl(w.uri) || w.uri} (${hoursLeft(w, now)}h left, ${w.mode === 'auto' ? 'blocking the hostile ones' : 'asking before adding'})`,
    ),
    '',
    '"stop watching" ends the newest; send the post with it to end that one.',
  ].join('\n');
}

/**
 * Read a watched post again: new quote-posters and repliers join the plan with
 * what they wrote, the triage reads them, and an auto watch adds the hostile.
 *
 * @param {object} deps { score(dids) -> Map, writeAgent, generate, model, log }
 * @returns {Promise<{ fresh: number, hostile: number, added: number, held: number }>}
 */
export async function checkWatch(watch, deps, { now = Date.now() } = {}) {
  const { score, writeAgent, generate, model, log = () => {} } = deps;
  const plan = await findPlanById(watch.plan_id);
  if (!plan) return { fresh: 0, hostile: 0, added: 0, held: 0 };
  const stats = watch.stats || {};

  const harvest = await harvestPost(watch.uri, {
    only: READ_KINDS,
    maxPages: 20,
  });
  // Known: on the watch's plan already, or in the baseline scan.
  const known = new Set();
  for (const id of [plan.id, stats.baselinePlan].filter(Boolean)) {
    const rows = await selectAll('decision', {
      select: 'did',
      eq: { plan_id: id },
      order: 'did.asc',
    });
    for (const r of rows) known.add(r.did);
  }
  // Never the owner, the bot or the watched post's author, whose replies in
  // their own thread are not a pile-on, as a scan leaves them out.
  const skip = new Set([OWNER_DID, ownerOf(watch.uri), ownerOf(listUri())]);
  const newcomers = harvest.participants.filter(
    (p) => !known.has(p.did) && !skip.has(p.did),
  );

  if (newcomers.length) {
    const scores = await score(newcomers.map((p) => p.did));
    const { rows } = summarise(
      { ...harvest, participants: newcomers },
      scores,
      { excludeSelf: OWNER_DID },
    );
    await upsert(
      'decision',
      rows.map((r) => ({
        plan_id: plan.id,
        did: r.did,
        band: r.band,
        trust: r.trust ?? null,
        distance: r.distance ?? null,
        vouches: r.vouches ?? null,
        action: null,
        evidence_uri: evidenceUriFor(r),
        engaged: Object.keys(r.engagements || {}),
        already_listed: Boolean(r.alreadyListed),
        blocks_me: Boolean(r.blocksYou),
      })),
    );
  }

  // Triage reads newcomers from earlier checks that no model has labelled
  // yet, oldest first, then this check's. One check reads one wave of model
  // calls, and the rest wait in `unread` for the next. The baseline is not on
  // this plan, so the watch never adds anyone who was already there when it
  // started, including accounts the owner had just taken off the list.
  const toRead = [
    ...new Set([...(stats.unread || []), ...newcomers.map((p) => p.did)]),
  ];
  const hostileBefore = await countDecisions(plan, { label: 'hostile' });
  if (toRead.length) {
    await runTriage(plan, {
      generate,
      model,
      log,
      dids: toRead,
      // An auto watch adds what it reads before anyone looks, so each post
      // gets a model call of its own and can sway no label but its own.
      ...(watch.mode === 'auto' ? { perCall: 1 } : {}),
    }).catch((err) =>
      log('Watch triage failed', {
        uri: watch.uri,
        err: String(err?.message || err),
      }),
    );
  }
  const unread = toRead.length ? await stillUnread(plan, toRead) : [];
  const hostileNow = await countDecisions(plan, { label: 'hostile' });
  const hostile = Math.max(0, hostileNow - hostileBefore);

  // A failed add is logged and the check goes on, so what it found is still
  // counted. The rows stay hostile and not acted on, and the next check
  // tries them again.
  let added = 0;
  if (watch.mode === 'auto' && hostileNow && writeAgent) {
    const out = await applyPlanToTriage(writeAgent, plan, 'hostile', {
      by: 'watch',
      skipBands: HELD_BANDS,
    }).catch((err) => {
      log('Watch add failed', {
        uri: watch.uri,
        err: String(err?.message || err),
      });
      return { added: 0 };
    });
    added = out.added || 0;
  }
  const held =
    watch.mode === 'auto'
      ? await countDecisions(plan, {
          label: 'hostile',
          bands: ['CONNECTED', 'NOTABLE'],
        })
      : hostileNow;
  // A 👍 on the digest adds only what was labelled by now. The labels of
  // later checks carry later times, so they wait for the next digest.
  const heldAsOf = held ? await newestLabel(plan, 'hostile') : null;

  const next = {
    ...stats,
    checks: (stats.checks || 0) + 1,
    newSinceDigest: (stats.newSinceDigest || 0) + newcomers.length,
    hostileSinceDigest: (stats.hostileSinceDigest || 0) + hostile,
    addedSinceDigest: (stats.addedSinceDigest || 0) + added,
    addedTotal: (stats.addedTotal || 0) + added,
    newTotal: (stats.newTotal || 0) + newcomers.length,
    held,
    heldAsOf,
    unread,
  };
  await update(
    'watch',
    { eq: { id: watch.id } },
    { last_checked_at: new Date(now).toISOString(), stats: next },
  );
  watch.stats = next;
  log('Checked a watched post', {
    uri: watch.uri,
    fresh: newcomers.length,
    hostile,
    added,
    held,
  });
  return { fresh: newcomers.length, hostile, added, held };
}

/**
 * Which of these accounts have words that no model has labelled yet, in the
 * order given.
 */
async function stillUnread(plan, dids) {
  const rows = await selectAll('decision', {
    select: 'did,evidence_uri,triage',
    eq: { plan_id: plan.id },
    order: 'did.asc',
  });
  const open = new Set(
    rows.filter((r) => r.evidence_uri && !r.triage).map((r) => r.did),
  );
  return dids.filter((d) => open.has(d));
}

/** When the newest `label` on the plan was given, or null. */
async function newestLabel(plan, label) {
  const [row] =
    (await select('decision', {
      select: 'triage_at',
      eq: { plan_id: plan.id, triage: label },
      order: 'triage_at.desc',
      limit: 1,
    })) || [];
  return row?.triage_at ?? null;
}

/**
 * The hourly digest for a watch, or null when there is nothing to say.
 * `pending` is the classic command a 👍 runs. Nothing is written here:
 * digestSent records the digest once it has gone, so one that fails to send
 * goes again with the same counts.
 *
 * @returns {Promise<null | { text: string, pending: string[]|null, describe: string|null }>}
 */
export async function digestFor(
  watch,
  { now = Date.now(), ending = false } = {},
) {
  const s = watch.stats || {};
  const due =
    ending ||
    !watch.last_digest_at ||
    now - Date.parse(watch.last_digest_at) >= DIGEST_EVERY_MS;
  if (!due) return null;
  const news = s.newSinceDigest || s.hostileSinceDigest || s.addedSinceDigest;
  if (!news && !ending) return null;

  const code = shortCode(watch.plan_id);
  const link = postWebUrl(watch.uri) || watch.uri;
  const lines = [];
  if (ending) {
    lines.push(
      `Stopped watching ${link}: ${s.newTotal || 0} new quotes and replies, ${s.addedTotal || 0} added.`,
    );
  } else {
    lines.push(
      `Watching ${link} (${hoursLeft(watch, now)}h left): ${s.newSinceDigest || 0} new quotes and replies since the last update, ${s.hostileSinceDigest || 0} read as hostile.`,
    );
  }
  let pending = null;
  let describe = null;
  if (watch.mode === 'auto' && s.addedSinceDigest) {
    lines.push(`Added ${s.addedSinceDigest} (plan ${code}).`);
  }
  if (s.held) {
    lines.push(
      watch.mode === 'auto'
        ? `${s.held} hostile ${s.held === 1 ? 'one is' : 'ones are'} CONNECTED or NOTABLE, so I held ${s.held === 1 ? 'it' : 'them'}. Read them: review ${code} hostile`
        : `Read them: review ${code} hostile`,
    );
    // The accounts `held` counts and nothing labelled after them: hostile
    // labels up to the last check, and on an auto watch only the held bands.
    const bands = watch.mode === 'auto' ? ' CONNECTED,NOTABLE' : '';
    pending = [`approve ${code} hostile${bands} asof=${s.heldAsOf}`];
    describe = `add the ${s.held} read as hostile on the watched post (plan ${code})`;
  }
  return {
    text: lines.join('\n'),
    pending,
    describe,
    links: [postWebUrl(watch.uri)],
  };
}

/** Record that a digest went: the next one is about what came after it. */
export async function digestSent(watch, { now = Date.now() } = {}) {
  const stats = {
    ...watch.stats,
    newSinceDigest: 0,
    hostileSinceDigest: 0,
    addedSinceDigest: 0,
  };
  const patch = { last_digest_at: new Date(now).toISOString(), stats };
  await update('watch', { eq: { id: watch.id } }, patch);
  Object.assign(watch, patch);
}

/**
 * Watches whose time is up and that are not closed yet. Each is closed with
 * endWatch once its closing digest has gone, so a digest that fails to send
 * is tried again. liveWatches already leaves them out, so nothing reads them
 * in between.
 */
export async function expiredWatches({ now = Date.now() } = {}) {
  const rows = await select('watch', {
    select: 'id,convo_id,uri,plan_id,mode,until,last_digest_at,stats',
    is: { stopped_at: 'null' },
  });
  return (rows || []).filter((w) => !(Date.parse(w.until) > now));
}

/** Close a watch whose time is up. */
export async function endWatch(watch, { now = Date.now() } = {}) {
  await update(
    'watch',
    { eq: { id: watch.id } },
    { stopped_at: new Date(now).toISOString() },
  );
}

// --- the owner's own posts ---------------------------------------------------

/** New quotes and replies in an hour on one of the owner's posts, worth a DM. */
const ALERT_THRESHOLD = Math.max(
  1,
  Number(process.env.MOD_ALERT_THRESHOLD) || 15,
);
const ALERT_AGAIN_MS = 6 * 3_600_000;
const BASELINE_MS = 60 * 60_000;
/** How far back the owner's posts are checked. */
const RECENT_MS = 48 * 3_600_000;

/**
 * The owner's recent posts that are suddenly drawing quotes and replies.
 *
 * Each post's count is kept with when it was taken. A count at least an hour
 * old becomes the new baseline; growth past the threshold since a baseline
 * under an hour old is an alert, at most once every six hours per post, and
 * never for a post already being watched. The six hours start when alertSent
 * records that the alert went, so one that failed to send is offered again.
 *
 * @returns {Promise<Array<{ uri: string, growth: number, count: number }>>}
 */
export async function ownPostAlerts({
  fetchImpl = fetchWithTimeout,
  now = Date.now(),
  threshold = ALERT_THRESHOLD,
} = {}) {
  const res = await fetchImpl(
    `${APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(OWNER_DID)}&limit=30&filter=posts_no_replies`,
  );
  if (!res.ok) return [];
  const body = await res.json();
  // Keyed by URI: a post the owner reposted is in the feed twice, and would
  // otherwise be alerted on twice.
  const recent = [
    ...new Map(
      (body.feed || [])
        .map((f) => f?.post)
        .filter(
          (p) =>
            p?.author?.did === OWNER_DID &&
            now - Date.parse(p.indexedAt || p.record?.createdAt || 0) <
              RECENT_MS,
        )
        .map((p) => [p.uri, p]),
    ).values(),
  ];
  if (!recent.length) return [];

  const uris = recent.map((p) => p.uri);
  const known = new Map(
    (
      (await select('post_alert', {
        select: 'uri,last_count,last_seen_at,alerted_at',
        where: { uri: { in: uris } },
      }).catch(() => [])) || []
    ).map((r) => [r.uri, r]),
  );
  const watched = new Set((await liveWatches({ now })).map((w) => w.uri));

  const alerts = [];
  const writes = [];
  for (const p of recent) {
    const count = (p.quoteCount || 0) + (p.replyCount || 0);
    const row = known.get(p.uri);
    const age = row?.last_seen_at
      ? now - Date.parse(row.last_seen_at)
      : Infinity;
    if (!row || age >= BASELINE_MS) {
      writes.push({
        uri: p.uri,
        last_count: count,
        last_seen_at: new Date(now).toISOString(),
        alerted_at: row?.alerted_at ?? null,
      });
      continue;
    }
    const growth = count - (row.last_count || 0);
    const quietSince = row.alerted_at
      ? now - Date.parse(row.alerted_at) >= ALERT_AGAIN_MS
      : true;
    if (growth >= threshold && quietSince && !watched.has(p.uri)) {
      alerts.push({ uri: p.uri, growth, count });
    }
  }
  if (writes.length) await upsert('post_alert', writes).catch(() => {});
  return alerts;
}

/** Record that an alert went. */
export async function alertSent({ uri }, { now = Date.now() } = {}) {
  await upsert('post_alert', [{ uri, alerted_at: new Date(now).toISOString() }]);
}

/** The message for one alert, and what a 👍 does. */
export function alertText({ uri, growth }) {
  return {
    text: `Your post ${postWebUrl(uri) || uri} picked up ${growth} quotes and replies in the last hour.`,
    pending: [`watch ${uri}`],
    describe: 'watch it for 24 hours and hold anything hostile for your OK',
    links: [postWebUrl(uri)],
  };
}
