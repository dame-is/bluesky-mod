// Re-score the list against today's graph, and say what moved.
//
// A bulk sweep knows the graph around one post at one moment. Someone blocked
// months ago as a stranger may have three vouches now, so this re-scores the
// list on a timer and DMs only the DELTAS. A weekly message restating
// thousands of unchanged rows is one that stops being read, which is the same
// failure as a batch nobody reviews.
//
// Scoring a list of several thousand accounts takes hundreds of AppView
// requests, so this runs in the background instead of in the path of a DM.

import crypto from 'node:crypto';

import { OWNER_DID } from './constants.js';
import { createScorer } from './lib/score.js';
import { loadReference } from './bot/reference.js';
import { listUri } from './bot/listWrite.js';
import { select, selectAll, update, upsert } from './bot/db.js';
import { chunkForDm } from './lib/agent.js';
import { config } from './config.js';
import { logger } from './logger.js';

/** "1 are gone" makes a machine sound like a machine. */
const plural = (n, one, many) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Bands that mean "this one is not a stranger any more". */
const NOT_A_STRANGER = new Set([
  'PROTECTED',
  'CONNECTED',
  'PERIPHERAL',
  'NOTABLE',
]);

/** The body recorded for a run that had nothing to say, and sent nothing. */
const NO_DRIFT = 'No drift.';

/**
 * listRecords pages to read before stopping: half a million listitems. A list
 * is re-scored in full up to there, since an account past a cut would never be
 * audited at all, and a cut is logged.
 */
const MAX_LIST_PAGES = 5000;

/** Every subject currently on the list, read from the repo that owns it. */
async function listMembers(agent) {
  const uri = listUri();
  const owner = /^at:\/\/(did:[^/]+)\//.exec(uri)?.[1];
  const subjects = [];
  let cursor;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const res = await agent.com.atproto.repo.listRecords({
      repo: owner,
      collection: 'app.bsky.graph.listitem',
      limit: 100,
      cursor,
    });
    for (const rec of res.data.records || []) {
      if (rec.value?.list === uri && rec.value?.subject) {
        subjects.push(rec.value.subject);
      }
    }
    cursor = res.data.cursor;
    if (!cursor || !(res.data.records || []).length) {
      return [...new Set(subjects)];
    }
  }
  logger.warn('The re-score read only part of the list', {
    pages: MAX_LIST_PAGES,
    accounts: new Set(subjects).size,
  });
  return [...new Set(subjects)];
}

/**
 * What each account was at the last audit of this list that FINISHED and
 * scored something: its band, and whether it was gone. An item with no handle
 * is one the AppView had no profile for.
 *
 * An audit is finished once its brief has gone out, or once it had nothing to
 * say (maybeRunDrift). A run writes its row before it scores anything, so one
 * killed partway would otherwise become the baseline, and the next brief would
 * call every account "added since the last audit". One whose brief was never
 * delivered would hide what that brief said for good.
 */
async function previousBands() {
  const [last] = await select('audit', {
    select: 'id',
    eq: { list_uri: listUri() },
    where: { finished_at: 'not.is.null', total: 'gt.0' },
    order: 'started_at.desc',
    limit: 1,
  });
  if (!last) return new Map();
  const items = await selectAll('audit_item', {
    select: 'did,band,handle',
    eq: { audit_id: last.id },
    order: 'did.asc',
  });
  return new Map(
    items.map((i) => [i.did, { band: i.band, missing: i.handle == null }]),
  );
}

/**
 * The band each of these accounts was added under, from the newest add of it
 * that still stands. An add typed with no score is logged as UNSCORED.
 */
async function bandsAtAdd(dids) {
  if (!dids.length) return new Map();
  const rows = await selectAll('decision', {
    select: 'did,band,acted_at',
    eq: { action: 'list_add' },
    where: {
      did: { in: dids },
      acted_at: 'not.is.null',
      undone_at: 'is.null',
    },
    order: 'acted_at.desc',
  });
  const out = new Map();
  for (const r of rows) if (!out.has(r.did)) out.set(r.did, r.band);
  return out;
}

/**
 * Score the list, store the audit, and return what changed.
 *
 * The audit is left unfinished, and so is not yet anyone's baseline, until
 * maybeRunDrift has delivered its brief.
 *
 * @returns {Promise<{scored:number, drifted:Array, gone:Array, added:number, auditId:string}>}
 */
export async function runDrift(agent) {
  const started = Date.now();
  const members = await listMembers(agent);
  if (!members.length) return { scored: 0, drifted: [], gone: [], added: 0 };

  const { ref, thresholds, takenAt } = await loadReference();
  const scorer = createScorer({ ...ref, thresholds });
  const before = await previousBands();

  const auditId = crypto.randomUUID();
  await upsert('audit', [
    {
      id: auditId,
      list_uri: listUri(),
      started_at: new Date().toISOString(),
      total: members.length,
      scored: 0,
    },
  ]);

  const drifted = [];
  const gone = [];
  let added = 0;
  let scored = 0;

  for (let i = 0; i < members.length; i += 200) {
    const batch = members.slice(i, i + 200);
    // Throws when the AppView cannot be read, which leaves this audit with no
    // finished_at and no brief: nothing goes out, it is never a baseline, and
    // the next check runs it again.
    const scores = await scorer.score(batch);
    const atAdd = await bandsAtAdd(batch.filter((did) => !before.has(did)));
    const rows = [];
    for (const did of batch) {
      const a = scores.get(did);
      if (!a) continue;
      rows.push({
        audit_id: auditId,
        did,
        handle: a.handle ?? null,
        band: a.band,
        trust: a.trust ?? null,
        vouches: a.vouches ?? null,
        followers: a.followers ?? null,
        protected_reason: a.protectedReason ?? null,
      });

      const prev = before.get(did);
      if (!prev) added += 1;
      // An account with no earlier audit is compared with the band it was
      // added under. One added with no score, or with no record of the add,
      // counts as a stranger.
      const at = prev ? prev.band : atAdd.get(did);
      const was = !at || at === 'UNSCORED' ? 'UNKNOWN' : at;
      if (
        // The one that matters: a stranger who is not one any more.
        (was === 'UNKNOWN' && NOT_A_STRANGER.has(a.band)) ||
        // Or one who has become PROTECTED, from any band. No automated path
        // may add them, so one on the list is always news.
        (a.band === 'PROTECTED' && was !== 'PROTECTED')
      ) {
        drifted.push({
          did,
          handle: a.handle,
          was,
          now: a.band,
          vouches: a.vouches,
        });
      }
      // `missing` means the AppView answered and has no profile for them:
      // deactivated, taken down, or deleted. Dead weight on a list, and worth
      // saying once, so one already gone at the last audit is left out.
      if (a.missing && !prev?.missing) gone.push({ did, handle: a.handle });
    }
    await upsert('audit_item', rows);
    scored += rows.length;
  }

  await upsert('audit', [
    {
      id: auditId,
      list_uri: listUri(),
      total: members.length,
      scored,
    },
  ]);

  logger.info('Drift audit complete', {
    scored,
    drifted: drifted.length,
    gone: gone.length,
    added,
    snapshot: takenAt,
    ms: Date.now() - started,
  });
  return { scored, drifted, gone, added, auditId };
}

/** The brief, or null when there is nothing worth saying. */
export function renderBrief({ scored, drifted, gone, added }) {
  if (!drifted.length && !gone.length) return null;

  const lines = [
    `Re-scored ${scored.toLocaleString()} accounts on the list.`,
    '',
  ];
  if (drifted.length) {
    lines.push(
      `${plural(drifted.length, 'account is', 'accounts are')} no longer a stranger:`,
      ...drifted
        .sort((a, b) => (b.vouches ?? 0) - (a.vouches ?? 0))
        .slice(0, 12)
        .map(
          (d) =>
            `  @${d.handle ?? d.did} is now ${d.now}, ${plural(d.vouches ?? 0, 'vouch', 'vouches')}`,
        ),
    );
    if (drifted.length > 12) lines.push(`  and ${drifted.length - 12} more`);
    lines.push('');
  }
  if (gone.length) {
    lines.push(
      `${plural(gone.length, 'account is', 'accounts are')} gone: deactivated, taken down, or deleted.`,
      '',
    );
  }
  if (added) {
    lines.push(
      `${plural(added, 'account', 'accounts')} added since the last audit.`,
      '',
    );
  }
  if (drifted.length) {
    lines.push('To take one off the list: unblock @handle');
  }
  return lines.join('\n').trim();
}

/**
 * How far ahead of the clock a stored time may be before it is taken for one
 * written while the clock ran fast.
 */
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Move back the times stored while the clock ran fast. Left alone, a brief
 * dated a year ahead holds off every run for that year, and an audit dated
 * ahead stays the baseline over every audit after it.
 *
 * A brief's time says when the last run was, and one dated ahead cannot say,
 * so it is dated to make the next run due. Audits dated ahead are the newest
 * there are, so they are dated just before now, keeping their order.
 */
async function moveBackTimesAhead(dueAfter) {
  const now = Date.now();
  const ahead = `gt.${new Date(now + CLOCK_SKEW_MS).toISOString()}`;
  const [briefs, audits] = await Promise.all([
    select('brief', {
      select: 'for_date',
      where: { for_date: ahead },
      order: 'for_date.desc',
      limit: 1,
    }),
    selectAll('audit', {
      select: 'id,started_at',
      where: { started_at: ahead },
      order: 'started_at.asc',
    }),
  ]);
  const newest = briefs[0]?.for_date ?? audits.at(-1)?.started_at;
  if (!newest) return;
  logger.warn('Drift records were dated ahead of the clock; moved them back', {
    aheadHours: Number(((Date.parse(newest) - now) / 3_600_000).toFixed(1)),
    audits: audits.length,
  });
  if (briefs.length) {
    await update(
      'brief',
      { where: { for_date: ahead } },
      { for_date: new Date(now - dueAfter).toISOString() },
    );
  }
  for (const [i, { id }] of audits.entries()) {
    await update(
      'audit',
      { eq: { id } },
      { started_at: new Date(now - audits.length + i).toISOString() },
    );
  }
}

/** Make an audit the baseline for the next one. */
async function finishAudit(auditId) {
  await update(
    'audit',
    { eq: { id: auditId } },
    { finished_at: new Date().toISOString() },
  );
}

/**
 * Send a recorded brief, then stamp it sent and finish its audit. A send that
 * throws leaves both for the next check to try again; one that fails partway
 * sends the earlier parts a second time then.
 */
async function deliver(chat, convoId, brief) {
  for (const chunk of chunkForDm(brief.body)) {
    await chat.chat.bsky.convo.sendMessage({
      convoId,
      message: { text: chunk },
    });
  }
  await upsert('brief', [{ ...brief, sent_at: new Date().toISOString() }]);
  await finishAudit(brief.id);
  return brief.body;
}

/**
 * Run if it is due, and tell the owner if anything moved. Silence is the
 * correct output most weeks.
 *
 * A brief is recorded under its audit's id before it is sent, and stamped
 * sent once every part has gone. Until then each check tries it again, and
 * its audit stays out of the baseline, so a run that falls due meanwhile
 * compares with the audit before it and finds the same things.
 */
export async function maybeRunDrift(agent, chat, convoId) {
  // Nowhere to send it: wait for the next check rather than spend the week's
  // run on a brief nobody receives.
  if (!convoId) return null;
  const dueAfter = config.driftEveryHours * 3600_000;
  await moveBackTimesAhead(dueAfter);
  const [latest] = await select('brief', {
    select: 'id,for_date,body,sent_at',
    order: 'for_date.desc',
    limit: 1,
  });
  // `for_date` is the moment of the run, so a run every few hours is due
  // from then and not from the start of its day.
  const last = latest?.for_date ? Date.parse(latest.for_date) : 0;
  if (Date.now() - last < dueAfter) {
    if (latest && !latest.sent_at && latest.body !== NO_DRIFT) {
      return deliver(chat, convoId, latest);
    }
    return null;
  }

  const result = await runDrift(agent);
  const body = renderBrief(result);
  const brief = {
    id: result.auditId ?? crypto.randomUUID(),
    for_date: new Date().toISOString(),
    body: body ?? NO_DRIFT,
    sent_at: null,
  };
  await upsert('brief', [brief]);

  if (!body) {
    if (result.auditId) await finishAudit(result.auditId);
    return null;
  }
  return deliver(chat, convoId, brief);
}

/** The conversation to send a brief into: the owner's, or none. */
export async function ownerConvo(chat) {
  try {
    const res = await chat.chat.bsky.convo.getConvoForMembers({
      members: [OWNER_DID],
    });
    return res.data.convo?.id ?? null;
  } catch {
    return null;
  }
}
