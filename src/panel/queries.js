// What the panel shows, read from the store.
//
// Everything here is a read, except the two functions at the end that keep
// or reopen an account in the review queue, and those touch the panel's own
// table and never the list. Changes to the list go through the bot's command
// path (commands.js), the same one a DM takes.
//
// Days are UTC days, because the log's timestamps are UTC text and a day is
// their first ten characters.

import { select, selectAll, count, rpc, upsert, del } from '../bot/db.js';
import { shortCode, findPlan } from '../bot/bulkPlan.js';
import { BANDS } from '../lib/score.js';
import { usableSnapshot } from '../snapshot.js';
import { CLOSE, viaFamily } from '../../client/bands.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const dayOf = (ms) => iso(ms).slice(0, 10);

/** Bluesky's write limits per account: points an hour and a day. */
export const WRITE_LIMITS = { hour: 5000, day: 35_000 };
const POINTS = { create: 3, delete: 1 };

export { CLOSE, viaFamily };
const closeness = (band) => {
  const i = CLOSE.indexOf(band);
  return i === -1 ? CLOSE.length : i;
};

const CANCELLED = /\(cancelled\)\s*$/;

/**
 * The words that asked for what a plan did. A typed block's note is the
 * words themselves; a scan's note starts with what was scanned and gains
 * "; approved: <words>" for each approval.
 */
export function wordsOf(plan) {
  const note = String(plan?.note || '').replace(CANCELLED, '').trim();
  if (!note) return [];
  if (!plan.totals) return [note];
  return note
    .split('; approved: ')
    .slice(1)
    .map((w) => w.trim())
    .filter(Boolean);
}

// --- plans ---------------------------------------------------------------------

const PLAN_COLUMNS =
  'id,created_at,approved_at,approved_bands,totals,note,list_uri';

function planSummary(plan, counts = {}, carrying = null) {
  const t = plan.totals || {};
  const cancelled = CANCELLED.test(plan.note || '');
  const added = counts.added || 0;
  const live = counts.live || 0;
  const state = carrying
    ? 'adding'
    : live > 0
      ? 'added'
      : cancelled
        ? 'cancelled'
        : added > 0
          ? 'undone'
          : 'waiting';
  return {
    code: shortCode(plan.id),
    createdAt: plan.created_at,
    // The list this plan's writes go to, once an approval has bound it
    // (planList.js). Null with `approved` set is the main list.
    list: plan.list_uri || null,
    approved: Boolean(plan.approved_at),
    uri: t.uri || null,
    kind: t.kind || null,
    total: counts.total ?? t.selected ?? 0,
    // Counted from the plan's rows, not read from what the scan stored: a
    // watch's plan stores no totals and grows as people arrive.
    byBand: Object.fromEntries(
      BANDS.map((b) => [b, counts[`band_${b.toLowerCase()}`] ?? t.byBand?.[b] ?? 0]),
    ),
    engagements: t.engagements || {},
    alreadyListed: t.alreadyListed || 0,
    truncated: Boolean(t.truncated),
    withText: counts.with_text || 0,
    labels: {
      hostile: counts.hostile || 0,
      arguing: counts.arguing || 0,
      neutral: counts.neutral || 0,
    },
    // When the newest "hostile" label was given. An approval of the hostile
    // ones carries it, so it adds what this page counted and nothing a watch
    // labels afterwards (the bot's own menus do the same with "asof=").
    hostileAsOf: counts.hostile_at ? new Date(Date.parse(counts.hostile_at)).toISOString() : null,
    added,
    live,
    state,
    carrying: carrying
      ? { added: carrying.added, nextAt: carrying.next_at }
      : null,
  };
}

async function summarise(plans) {
  if (!plans.length) return [];
  const ids = plans.map((p) => p.id);
  const [counts, carrying] = await Promise.all([
    rpc('panel_plan_counts', { ids }),
    select('continuation', {
      select: 'plan_id,next_at,added',
      where: { plan_id: { in: ids } },
    }),
  ]);
  const byId = new Map(counts.map((c) => [c.plan_id, c]));
  const carry = new Map((carrying || []).map((c) => [c.plan_id, c]));
  return plans.map((p) => planSummary(p, byId.get(p.id), carry.get(p.id)));
}

/**
 * Scans, newest first. `state` narrows to one of planSummary's states.
 *
 * A watch keeps its newcomers in a plan of its own. Which posts are watched
 * is told only to someone who may write, in a DM and here, so without
 * `canWrite` those plans are left out.
 */
export async function scans({ state = null, limit = 60, canWrite = true, before = null } = {}) {
  const plans = (
    (await select('plan', {
      select: PLAN_COLUMNS,
      where: {
        totals: 'not.is.null',
        ...(before ? { created_at: `lt.${before}` } : {}),
      },
      order: 'created_at.desc',
      limit: 200,
    })) || []
  ).filter((p) => canWrite || p.totals?.kind !== 'watch');
  const all = await summarise(plans);
  const shown = state ? all.filter((p) => p.state === state) : all;
  const tally = {};
  for (const p of all) tally[p.state] = (tally[p.state] || 0) + 1;
  const page = shown.slice(0, limit);
  // The next page starts after the last plan read, shown or not, so a page
  // filtered by state still moves on. Counts are of the 200 read.
  const more = shown.length > limit || plans.length === 200;
  const last = shown.length > limit ? page[page.length - 1] : plans[plans.length - 1];
  return {
    scans: page,
    counts: tally,
    more,
    next: more && last ? last.createdAt || last.created_at : null,
  };
}

/**
 * One plan with every account in it, for the radar and the table under it:
 * a scan, or a typed block or removal (`scan` false), which has no totals.
 * `words` and the plan's note are for someone who may write; a reader sees
 * what was done and not the words that asked for it, as in the DMs.
 */
export async function scan(code, { canWrite = false } = {}) {
  const plan = await findPlan(code);
  if (!plan) return null;
  const [rows, protectedRows, [summary]] = await Promise.all([
    selectAll('decision', {
      select:
        'did,band,trust,vouches,action,acted_at,undone_at,approved_via,triage,triage_quote,evidence_uri,engaged,already_listed,blocks_me',
      eq: { plan_id: plan.id },
      order: 'did.asc',
    }),
    selectAll('protected', { select: 'did', order: 'did.asc' }),
    summarise([plan]),
  ]);
  const vetoed = new Set(protectedRows.map((r) => r.did));
  return {
    ...summary,
    scan: Boolean(plan.totals),
    words: canWrite ? wordsOf(plan) : [],
    rows: rows.map((r) => ({
      did: r.did,
      band: r.band,
      trust: r.trust,
      vouches: r.vouches,
      kinds: Array.isArray(r.engaged) ? r.engaged : [],
      label: r.triage || null,
      quote: r.triage_quote || null,
      hasText: Boolean(r.evidence_uri),
      // Protected by the plan's band, or by the table as it stands now:
      // someone followed since the scan is not added whatever is approved.
      protected: r.band === 'PROTECTED' || vetoed.has(r.did),
      added: Boolean(r.action === 'list_add' && r.acted_at && !r.undone_at),
      undone: Boolean(r.undone_at),
      via: r.approved_via || null,
      listed: Boolean(r.already_listed),
      blocksYou: Boolean(r.blocks_me),
    })),
  };
}

// --- the log -------------------------------------------------------------------

/** An undo that only closed the adds of someone a removal took off. */
const FROM_REMOVAL = /^(unblock\b|list\s+remove\b|unblocked$)/i;

/**
 * The decision log as events, newest first: accounts added, accounts
 * removed, and adds taken back. One event per plan and kind, so a batch is a
 * line. `filter` is 'added', 'removed' or 'undone'.
 */
export async function activity({
  limit = 30,
  offset = 0,
  filter = null,
  canWrite = false,
} = {}) {
  const want = offset + limit + 1;
  const [acted, undone] = await Promise.all([
    filter === 'undone'
      ? []
      : rpc('panel_activity', {
          limit: want,
          action:
            filter === 'added'
              ? 'list_add'
              : filter === 'removed'
                ? 'list_remove'
                : null,
        }),
    filter && filter !== 'undone' ? [] : undoEvents(want),
  ]);
  const events = [
    ...acted.map((r) => ({
      kind: r.action === 'list_remove' ? 'removed' : 'added',
      planId: r.plan_id,
      at: r.last_at,
      firstAt: r.first_at,
      n: r.n,
      undone: r.undone,
      // A typed block of someone already on the list wrote nothing.
      already: r.already,
      via: r.approved_via || null,
      did: r.n === 1 ? r.did : null,
      band: r.band_low === r.band_high ? r.band_low : null,
    })),
    ...undone,
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const page = events.slice(offset, offset + limit);
  const ids = [...new Set(page.map((e) => e.planId))];
  const plans = ids.length
    ? await select('plan', {
        select: 'id,note,totals,created_at,list_uri',
        where: { id: { in: ids } },
      })
    : [];
  const byId = new Map((plans || []).map((p) => [p.id, p]));
  return {
    more: events.length > offset + limit,
    events: page.map(({ planId, ...e }) => {
      const plan = byId.get(planId);
      return {
        ...e,
        code: shortCode(planId),
        scan: Boolean(plan?.totals),
        uri: plan?.totals?.uri || null,
        list: plan?.list_uri || null,
        words: canWrite
          ? e.kind === 'undone'
            ? [e.reason].filter(Boolean)
            : wordsOf(plan)
          : [],
        reason: undefined,
      };
    }),
  };
}

async function undoEvents(limit) {
  // Grouped here rather than in SQL: an undo is a stamp on the rows it took
  // back, and the newest few thousand of those are enough for a page of log.
  const rows = await select('decision', {
    select: 'plan_id,did,band,undone_at,undo_reason,already_listed',
    eq: { action: 'list_add' },
    where: { undone_at: 'not.is.null', acted_at: 'not.is.null' },
    order: 'undone_at.desc',
    limit: Math.max(2000, limit * 50),
  });
  const groups = new Map();
  for (const r of rows || []) {
    if (r.already_listed || FROM_REMOVAL.test(String(r.undo_reason || ''))) continue;
    // One undo stamps all its rows in one pass; the minute keeps two undos of
    // the same plan apart.
    const key = `${r.plan_id}|${r.undo_reason || ''}|${String(r.undone_at).slice(0, 16)}`;
    const g = groups.get(key);
    if (g) {
      g.n += 1;
      g.did = null;
      if (g.band !== r.band) g.band = null;
      if (r.undone_at < g.firstAt) g.firstAt = r.undone_at;
    } else {
      groups.set(key, {
        kind: 'undone',
        planId: r.plan_id,
        at: r.undone_at,
        firstAt: r.undone_at,
        n: 1,
        undone: 0,
        already: 0,
        via: null,
        did: r.did,
        band: r.band,
        reason: r.undo_reason || null,
      });
    }
  }
  return [...groups.values()].slice(0, limit);
}

/** Everything the log holds about one account, newest first. */
export async function accountHistory(did, { canWrite = false } = {}) {
  const rows = await select('decision', {
    select:
      'plan_id,band,vouches,action,acted_at,undone_at,undo_reason,approved_via,triage,triage_quote,already_listed',
    eq: { did },
    order: 'acted_at.desc',
    limit: 100,
  });
  const ids = [...new Set((rows || []).map((r) => r.plan_id))];
  const plans = ids.length
    ? await select('plan', {
        select: 'id,note,totals,created_at,list_uri',
        where: { id: { in: ids } },
      })
    : [];
  const byId = new Map((plans || []).map((p) => [p.id, p]));
  const [kept] = (await select('review_keep', { eq: { did } })) || [];
  const [prot] = (await select('protected', { eq: { did } })) || [];
  return {
    protectedReason: prot?.reason || null,
    kept: kept ? { band: kept.band, at: kept.kept_at } : null,
    entries: (rows || [])
      .map((r) => {
        const plan = byId.get(r.plan_id);
        return {
          code: shortCode(r.plan_id),
          scan: Boolean(plan?.totals),
          uri: plan?.totals?.uri || null,
          list: plan?.list_uri || null,
          at: r.acted_at || plan?.created_at || null,
          band: r.band,
          vouches: r.vouches,
          action: r.acted_at ? r.action : null,
          already: Boolean(r.already_listed),
          via: r.approved_via || null,
          undoneAt: r.undone_at || null,
          undoReason: canWrite ? r.undo_reason || null : null,
          label: r.triage || null,
          quote: r.triage_quote || null,
          words: canWrite ? wordsOf(plan) : [],
        };
      })
      .sort((a, b) => String(b.at).localeCompare(String(a.at))),
  };
}

// --- the list ------------------------------------------------------------------

async function latestAudit() {
  const rows = await select('audit', {
    select: 'id,started_at,finished_at,total,scored',
    order: 'started_at.desc',
    limit: 6,
  });
  return (
    (rows || []).find((r) => r.finished_at) ||
    (rows || []).find((r) => r.scored > 0) ||
    null
  );
}

/** list -> { key, at, value }. One slot per list, so two lists do not evict each other. */
const listCache = new Map();
const LIST_CACHE_MS = 30_000;

/** Forget the held copies of the lists, after something changed one. */
export function forgetList() {
  listCache.clear();
}

/**
 * Plan id -> list, for every plan bound to a list by name. A plan with no
 * list_uri went to the main list (src/bot/planList.js), so only these need
 * reading to tell which list an add was on.
 */
async function boundPlans() {
  const rows = await selectAll('plan', {
    select: 'id,list_uri',
    where: { list_uri: 'not.is.null' },
    order: 'id.asc',
  });
  return new Map(rows.map((r) => [r.id, r.list_uri]));
}

/**
 * Everyone on the list, with what the last re-score said about them and how
 * the log says they got there.
 *
 * `members` is who is on the list by the bot's own repo, when the caller
 * could read it: { dids: string[], complete: boolean }. Without it the
 * re-score's accounts stand in, and failing that the adds still open in the
 * log. `source` says which.
 *
 * `list` and `primary` are for a bot with several lists: only the adds made
 * by plans on `list` count, and the weekly re-score, which reads the main
 * list alone, is used only when `list` is the main one. Another list shows
 * the band each account had when it was added. With no `list`, every add
 * counts, as when there is one list.
 */
export async function listIndex({
  members = null,
  list = null,
  primary = null,
  now = Date.now(),
} = {}) {
  const key = members ? `${members.dids.length}:${members.at || ''}` : 'none';
  const slot = list || '';
  const cached = listCache.get(slot);
  if (cached && cached.key === key && now - cached.at < LIST_CACHE_MS) {
    return cached.value;
  }
  const main = !list || list === primary;
  const audit = main ? await latestAudit() : null;
  const [items, everyAdd, keeps, bound] = await Promise.all([
    audit
      ? selectAll('audit_item', {
          select: 'did,handle,band,trust,vouches,followers,protected_reason',
          eq: { audit_id: audit.id },
          order: 'did.asc',
        })
      : [],
    selectAll('decision', {
      select: 'plan_id,did,band,acted_at,approved_via,triage,triage_quote',
      eq: { action: 'list_add' },
      where: { acted_at: 'not.is.null', undone_at: 'is.null' },
      order: 'acted_at.asc',
    }),
    selectAll('review_keep', { select: 'did,band,kept_at', order: 'did.asc' }),
    list ? boundPlans() : null,
  ]);
  const adds = list
    ? everyAdd.filter((a) => (bound.get(a.plan_id) || primary) === list)
    : everyAdd;
  const scored = new Map(items.map((i) => [i.did, i]));
  // The newest open add wins: it is the latest answer to "why are they here".
  const added = new Map(adds.map((a) => [a.did, a]));
  const kept = new Map(keeps.map((k) => [k.did, k]));
  const source = members ? 'repo' : audit ? 'rescore' : 'log';
  const dids = members
    ? members.dids
    : audit
      ? items.map((i) => i.did)
      : [...added.keys()];
  const rows = dids.map((did) => {
    const s = scored.get(did);
    const a = added.get(did);
    const k = kept.get(did);
    const band = s?.band || (a?.band && a.band !== 'UNSCORED' ? a.band : null);
    return {
      did,
      handle: s?.handle || null,
      band,
      // The band they were given when they were added, to say what moved.
      bandThen: a?.band && a.band !== 'UNSCORED' ? a.band : null,
      vouches: s?.vouches ?? null,
      followers: s?.followers ?? null,
      protectedReason: s?.protected_reason || null,
      rescored: Boolean(s),
      via: a?.approved_via || null,
      family: viaFamily(a?.approved_via),
      code: a ? shortCode(a.plan_id) : null,
      addedAt: a?.acted_at || null,
      keptBand: k?.band || null,
      // The tone label and the words it was given for, when the add came
      // from one.
      label: a?.triage || null,
      quote: a?.triage_quote || null,
    };
  });
  rows.sort(
    (x, y) =>
      closeness(x.band) - closeness(y.band) ||
      (y.vouches ?? -1) - (x.vouches ?? -1) ||
      String(x.handle || x.did).localeCompare(String(y.handle || y.did)),
  );
  const value = {
    source,
    complete: members ? Boolean(members.complete) : true,
    asOf: audit ? audit.finished_at || audit.started_at : null,
    total: rows.length,
    rows,
  };
  listCache.set(slot, { key, at: now, value });
  return value;
}

const bandCounts = (rows) => {
  const out = Object.fromEntries([...BANDS, 'UNSCORED'].map((b) => [b, 0]));
  for (const r of rows) out[r.band || 'UNSCORED'] += 1;
  return out;
};

/**
 * A page of the list. `band` and `q` narrow it; `q` matches part of a handle
 * or a whole DID.
 */
export async function listPage({
  members = null,
  list = null,
  primary = null,
  band = null,
  q = '',
  family = null,
  sort = 'closest',
  offset = 0,
  limit = 50,
} = {}) {
  const index = await listIndex({ members, list, primary });
  const needle = String(q || '').trim().toLowerCase().replace(/^@/, '');
  const rows =
    sort === 'recent'
      ? // Newest add first; someone the log has no add for goes last.
        [...index.rows].sort((x, y) => String(y.addedAt || '').localeCompare(String(x.addedAt || '')))
      : index.rows;
  const matched = rows.filter(
    (r) =>
      (!band || (r.band || 'UNSCORED') === band) &&
      (!family || r.family === family) &&
      (!needle ||
        r.did.toLowerCase() === needle ||
        String(r.handle || '').toLowerCase().includes(needle)),
  );
  return {
    source: index.source,
    complete: index.complete,
    asOf: index.asOf,
    total: index.total,
    counts: bandCounts(index.rows),
    matched: matched.length,
    rows: matched.slice(offset, offset + limit),
  };
}

/**
 * The list as the radar draws it: everyone who is not a stranger, one mark
 * each, and the strangers as a count per way of having been added.
 */
export async function listRadar({ members = null, list = null, primary = null } = {}) {
  const index = await listIndex({ members, list, primary });
  const near = [];
  const far = {};
  for (const r of index.rows) {
    if (r.band && r.band !== 'UNKNOWN') {
      near.push({
        did: r.did,
        handle: r.handle,
        band: r.band,
        vouches: r.vouches,
        followers: r.followers,
        family: r.family,
        kept: Boolean(r.keptBand),
      });
    } else {
      far[r.family] = (far[r.family] || 0) + 1;
    }
  }
  return {
    source: index.source,
    asOf: index.asOf,
    total: index.total,
    counts: bandCounts(index.rows),
    near,
    far,
  };
}

/**
 * The review queue: accounts on the list who are not strangers, closest
 * first. One the owner chose to keep stays out unless a later re-score put
 * them closer than they were when it was kept.
 *
 * With several lists this is the main list's queue: `list` and `primary`
 * are both that list, since the re-score that fills it reads no other.
 */
export async function queue({
  members = null,
  list = null,
  primary = null,
  band = null,
  offset = 0,
  limit = 30,
} = {}) {
  const index = await listIndex({ members, list, primary });
  const open = index.rows.filter(
    (r) =>
      CLOSE.includes(r.band) &&
      !(r.keptBand && closeness(r.band) >= closeness(r.keptBand)),
  );
  const counts = Object.fromEntries(CLOSE.map((b) => [b, 0]));
  for (const r of open) counts[r.band] += 1;
  const shown = band ? open.filter((r) => r.band === band) : open;
  return {
    asOf: index.asOf,
    total: open.length,
    counts,
    matched: shown.length,
    rows: shown.slice(offset, offset + limit).map((r) => ({
      ...r,
      // Why they are here: the re-score put them closer than when they were
      // added, or they were close already.
      reason: r.bandThen && closeness(r.band) < closeness(r.bandThen) ? 'closer' : 'close',
    })),
  };
}

/** Leave this account on the list, and out of the queue. */
export async function keep(did, { band, by = null, now = Date.now() } = {}) {
  await upsert('review_keep', [
    { did, band: CLOSE.includes(band) ? band : 'NOTABLE', kept_at: iso(now), kept_by: by },
  ]);
  forgetList();
}

/** Put a kept account back in the queue. */
export async function reopen(did) {
  await del('review_keep', { eq: { did } });
  forgetList();
}

// --- watches, protection, the graph, models -------------------------------------

/** Watches, live ones first. */
export async function watches({ now = Date.now(), limit = 30 } = {}) {
  const rows = await select('watch', {
    select:
      'id,uri,plan_id,mode,created_at,until,stopped_at,last_checked_at,last_digest_at,stats',
    order: 'created_at.desc',
    limit,
  });
  const out = (rows || []).map((w) => ({
    id: w.id,
    uri: w.uri,
    mode: w.mode,
    code: w.plan_id ? shortCode(w.plan_id) : null,
    createdAt: w.created_at,
    until: w.until,
    stoppedAt: w.stopped_at,
    lastCheckedAt: w.last_checked_at,
    lastDigestAt: w.last_digest_at,
    stats: w.stats || {},
    live: !w.stopped_at && Date.parse(w.until) > now,
  }));
  return {
    live: out.filter((w) => w.live),
    ended: out.filter((w) => !w.live),
  };
}

async function protectedCounts() {
  const rows = await rpc('panel_protected_counts');
  const out = { total: 0, follows: 0, lists: 0, manual: 0 };
  for (const r of rows) {
    out.total += r.n;
    if (r.source === 'manual') out.manual += r.n;
    else if (r.reason === 'you follow them') out.follows += r.n;
    else out.lists += r.n;
  }
  return out;
}

/** A page of the accounts no automated path may add. */
export async function protectedPage({ q = '', offset = 0, limit = 50 } = {}) {
  const needle = String(q || '').trim();
  const [counts, rows] = await Promise.all([
    protectedCounts(),
    select('protected', {
      select: 'did,reason,source,added_at',
      where: needle ? { did: `like.*${needle.replace(/[*%_]/g, '')}*` } : {},
      order: 'added_at.desc,did.asc',
      limit: limit + 1,
      offset,
    }),
  ]);
  return {
    counts,
    more: rows.length > limit,
    rows: rows.slice(0, limit).map((r) => ({
      did: r.did,
      reason: r.reason,
      source: r.source,
      addedAt: r.added_at,
    })),
  };
}

/** The follow-graph snapshot and the re-scores of the list. */
export async function graph({ now = Date.now() } = {}) {
  const [usable, [newest], audits] = await Promise.all([
    usableSnapshot(),
    select('circle', {
      select: 'taken_at,scoring',
      order: 'taken_at.desc',
      limit: 1,
    }),
    select('audit', {
      select: 'id,started_at,finished_at,total,scored',
      order: 'started_at.desc',
      limit: 6,
    }),
  ]);
  const takenAt = newest?.taken_at || null;
  const [circle, pending, unreadable, vouches] = takenAt
    ? await Promise.all([
        count('circle', { eq: { taken_at: takenAt } }),
        count('circle', {
          eq: { taken_at: takenAt },
          where: { follows_indexed_at: 'is.null' },
        }),
        count('circle', {
          eq: { taken_at: takenAt },
          where: { unreadable: 'not.is.null' },
        }),
        usable ? count('vouch', { eq: { taken_at: usable.takenAt } }) : 0,
      ])
    : [0, 0, 0, 0];
  const building =
    takenAt && newest.scoring !== 'simple' && (!usable || usable.takenAt !== takenAt);
  const audited = await Promise.all(
    (audits || []).map(async (a) => ({
      startedAt: a.started_at,
      finishedAt: a.finished_at,
      total: a.total,
      scored: a.scored,
      bands: Object.fromEntries(
        (await rpc('panel_band_counts', { audit: a.id })).map((r) => [r.band, r.n]),
      ),
    })),
  );
  return {
    snapshot: usable
      ? {
          takenAt: usable.takenAt,
          scoring: usable.scoring,
          ageDays: Math.floor((now - Date.parse(usable.takenAt)) / DAY),
          vouches,
        }
      : null,
    newest: takenAt
      ? { takenAt, scoring: newest.scoring, circle, pending, unreadable, building: Boolean(building) }
      : null,
    protected: await protectedCounts(),
    audits: audited,
  };
}

/**
 * Vouch counts from the snapshot scoring uses: for the accounts in `dids`, or
 * the `limit` most vouched with at least `min`. An account with none is left
 * out. With no usable snapshot, `takenAt` is null and there are none.
 */
export async function vouches({ dids = null, min = 1, limit = 1000 } = {}) {
  const usable = await usableSnapshot();
  if (!usable) return { takenAt: null, scoring: null, vouches: {} };
  const out = {};
  if (dids) {
    for (let i = 0; i < dids.length; i += 200) {
      const rows = await select('vouch', {
        select: 'did,vouches',
        eq: { taken_at: usable.takenAt },
        where: { did: { in: dids.slice(i, i + 200) } },
      });
      for (const r of rows || []) out[r.did] = r.vouches;
    }
  } else {
    const rows = await select('vouch', {
      select: 'did,vouches',
      eq: { taken_at: usable.takenAt },
      where: { vouches: `gte.${min}` },
      order: 'vouches.desc,did.asc',
      limit,
    });
    for (const r of rows || []) out[r.did] = r.vouches;
  }
  return { takenAt: usable.takenAt, scoring: usable.scoring, vouches: out };
}

/** Tokens spent on model calls over the last `days`, by day, kind and model. */
export async function usage({ days = 30, now = Date.now() } = {}) {
  const since = `${dayOf(now - (days - 1) * DAY)}T00:00:00.000Z`;
  const rows = await rpc('panel_usage', { since });
  const sum = (key) => {
    const out = new Map();
    for (const r of rows) {
      const k = r[key] || 'unknown';
      const cur = out.get(k) || { calls: 0, input: 0, output: 0 };
      cur.calls += r.calls;
      cur.input += r.input;
      cur.output += r.output;
      out.set(k, cur);
    }
    return [...out.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.input + b.output - (a.input + a.output));
  };
  const byDay = new Map(sum('day').map((d) => [d.name, d]));
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = dayOf(now - i * DAY);
    const d = byDay.get(day);
    series.push({ day, calls: d?.calls || 0, input: d?.input || 0, output: d?.output || 0 });
  }
  return {
    days: series,
    byKind: sum('kind'),
    byModel: sum('model'),
    total: series.reduce(
      (t, d) => ({ calls: t.calls + d.calls, input: t.input + d.input, output: t.output + d.output }),
      { calls: 0, input: 0, output: 0 },
    ),
  };
}

// --- the overview --------------------------------------------------------------

/** Points written against Bluesky's limits since `since`, from the log. */
async function pointsSince(since) {
  const { creates, deletes } = await rpc('panel_writes', { since });
  return creates * POINTS.create + deletes * POINTS.delete;
}

/**
 * The first screen: how big the list is and how it has moved, what is
 * waiting, what is running, and the newest changes.
 */
export async function overview({
  days = 30,
  now = Date.now(),
  members = null,
  list = null,
  primary = null,
  mainMembers = null,
  canWrite = false,
} = {}) {
  const span = Math.min(90, Math.max(7, Number(days) || 30));
  const since = `${dayOf(now - (span - 1) * DAY)}T00:00:00.000Z`;
  const [daily, index, waiting, adding, live, prot, usable, hour, day, log] =
    await Promise.all([
      rpc('panel_days', { since }),
      listIndex({ members, list, primary, now }),
      scans({ state: 'waiting', limit: 5, canWrite }),
      scans({ state: 'adding', limit: 5, canWrite }),
      watches({ now }),
      protectedCounts(),
      usableSnapshot(),
      pointsSince(iso(now - HOUR)),
      pointsSince(iso(now - DAY)),
      activity({ limit: 8, canWrite }),
    ]);
  const added = new Map(daily.added.map((r) => [r.day, r.n]));
  const removed = new Map(daily.removed.map((r) => [r.day, r.n]));
  const series = [];
  for (let i = span - 1; i >= 0; i -= 1) {
    const d = dayOf(now - i * DAY);
    series.push({ day: d, added: added.get(d) || 0, removed: removed.get(d) || 0 });
  }
  const total = (rows, key) => rows.reduce((n, r) => n + r[key], 0);
  const week = series.slice(-7);
  // The review queue is the main list's, whichever list is being shown.
  const mainIndex =
    list && list !== primary
      ? await listIndex({ members: mainMembers, list: primary, primary, now })
      : index;
  const open = mainIndex.rows.filter(
    (r) =>
      CLOSE.includes(r.band) &&
      !(r.keptBand && closeness(r.band) >= closeness(r.keptBand)),
  );
  return {
    now: iso(now),
    list: {
      total: index.total,
      source: index.source,
      complete: index.complete,
      asOf: index.asOf,
      counts: bandCounts(index.rows),
    },
    week: { added: total(week, 'added'), removed: total(week, 'removed') },
    span: { days: span, added: total(series, 'added'), removed: total(series, 'removed') },
    days: series,
    // When the main list was last re-scored, whichever list is shown.
    rescoredAt: mainIndex.asOf,
    waiting: { queue: open.length, scans: waiting.counts.waiting || 0 },
    protected: prot,
    snapshot: usable
      ? {
          takenAt: usable.takenAt,
          scoring: usable.scoring,
          ageDays: Math.floor((now - Date.parse(usable.takenAt)) / DAY),
        }
      : null,
    scans: waiting.scans,
    adding: adding.scans,
    budget: {
      hour: { used: hour, max: WRITE_LIMITS.hour },
      day: { used: day, max: WRITE_LIMITS.day },
    },
    // What is being watched is a writer's to see, as in the DMs.
    watches: canWrite ? live.live : [],
    changes: log.events,
  };
}
