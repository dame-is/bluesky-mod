// What the database keeps, and for how long (the MOD_KEEP_* settings).
//
// Run once a day from index.js, and the audit part again after each weekly
// re-score. Snapshots are pruned where they are finalised (db.js), since that
// is the moment a new one takes over.
//
// Nothing here touches what the list's history rests on: a plan any change
// was written from is kept for good, so "why is this account on the list"
// and undo keep working however long ago it was.

import { config } from './config.js';
import { listUri } from './bot/listWrite.js';
import { del, select, selectAll, update } from './bot/db.js';

const DAY_MS = 86_400_000;
const BATCH = 50;

const before = (now, days) => new Date(now - days * DAY_MS).toISOString();

/**
 * Finished audits past the newest `keep.audits`, and unfinished ones a day
 * old (a run that was killed partway). An audit's items go with it.
 */
export async function pruneAudits({ now = Date.now(), keep = config.keep } = {}) {
  const finished = await selectAll('audit', {
    select: 'id',
    eq: { list_uri: listUri() },
    where: { finished_at: 'not.is.null' },
    order: 'started_at.desc',
  });
  const old = finished.slice(keep.audits).map((a) => a.id);
  const stale = await selectAll('audit', {
    select: 'id',
    where: { finished_at: 'is.null', started_at: `lt.${before(now, 1)}` },
    order: 'started_at.asc',
  });
  const gone = [...old, ...stale.map((a) => a.id)];
  for (let i = 0; i < gone.length; i += BATCH) {
    await del('audit', { where: { id: { in: gone.slice(i, i + BATCH) } } });
  }
  return gone.length;
}

/**
 * Scans that changed nothing, older than `keep.unapprovedDays`: plans no row
 * of which was ever written to the list, with every row in them. A plan a
 * live watch or a batch still in progress points at is left alone.
 */
export async function pruneUnapproved({ now = Date.now(), keep = config.keep } = {}) {
  if (!keep.unapprovedDays) return 0;
  const old = (
    await selectAll('plan', {
      select: 'id',
      where: { created_at: `lt.${before(now, keep.unapprovedDays)}` },
      order: 'created_at.asc',
    })
  ).map((p) => p.id);
  if (!old.length) return 0;

  const inUse = new Set([
    ...(await selectAll('continuation', { select: 'plan_id', order: 'plan_id.asc' })).map(
      (c) => c.plan_id,
    ),
    ...(
      await selectAll('watch', {
        select: 'plan_id',
        is: { stopped_at: 'null' },
        where: { until: `gt.${new Date(now).toISOString()}` },
        order: 'created_at.asc',
      })
    ).map((w) => w.plan_id),
  ]);

  let gone = 0;
  for (let i = 0; i < old.length; i += BATCH) {
    const ids = old.slice(i, i + BATCH).filter((id) => !inUse.has(id));
    if (!ids.length) continue;
    const acted = new Set(
      (
        await select('decision', {
          select: 'plan_id',
          where: { plan_id: { in: ids }, acted_at: 'not.is.null' },
        })
      ).map((d) => d.plan_id),
    );
    const idle = ids.filter((id) => !acted.has(id));
    if (!idle.length) continue;
    // The plan's rows go with it (on delete cascade).
    await del('plan', { where: { id: { in: idle } } });
    gone += idle.length;
  }
  return gone;
}

/**
 * The words kept beside a tone label, older than `keep.quotesDays`. The
 * label stays; history shows it without the quote.
 */
export async function pruneQuotes({ now = Date.now(), keep = config.keep } = {}) {
  if (!keep.quotesDays) return;
  await update(
    'decision',
    {
      where: {
        triage_quote: 'not.is.null',
        triage_at: `lt.${before(now, keep.quotesDays)}`,
      },
    },
    { triage_quote: null },
  );
}

/** Token counts older than `keep.usageDays`. */
export async function pruneUsage({ now = Date.now(), keep = config.keep } = {}) {
  if (!keep.usageDays) return;
  await del('llm_usage', { where: { at: `lt.${before(now, keep.usageDays)}` } });
}

/** Everything above, for the daily run. */
export async function pruneData({ now = Date.now(), keep = config.keep } = {}) {
  const audits = await pruneAudits({ now, keep });
  const plans = await pruneUnapproved({ now, keep });
  await pruneQuotes({ now, keep });
  await pruneUsage({ now, keep });
  return { audits, plans };
}
