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
import { select, selectAll, upsert } from './bot/db.js';
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

/** Every subject currently on the list, read from the repo that owns it. */
async function listMembers(agent) {
  const uri = listUri();
  const owner = /^at:\/\/(did:[^/]+)\//.exec(uri)?.[1];
  const subjects = [];
  let cursor;
  for (let page = 0; page < 400; page += 1) {
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
    if (!cursor || !(res.data.records || []).length) break;
  }
  return [...new Set(subjects)];
}

/**
 * The band each account had at the last audit of this list that FINISHED and
 * scored something. A run writes its row before it scores anything, so one
 * killed partway would otherwise become the baseline, and the next brief would
 * call every account "added since the last audit".
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
    select: 'did,band',
    eq: { audit_id: last.id },
    order: 'did.asc',
  });
  return new Map(items.map((i) => [i.did, i.band]));
}

/**
 * Score the list, store the audit, and return what changed.
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
    const scores = await scorer.score(batch);
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

      const was = before.get(did);
      if (was === undefined) added += 1;
      else if (was === 'UNKNOWN' && NOT_A_STRANGER.has(a.band)) {
        // The one that matters: a stranger who is not one any more.
        drifted.push({
          did,
          handle: a.handle,
          was,
          now: a.band,
          vouches: a.vouches,
        });
      }
      // `missing` means the AppView has no profile: deactivated, taken down, or
      // deleted. Dead weight on a list, and worth saying so.
      if (a.missing) gone.push({ did, handle: a.handle });
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
      finished_at: new Date().toISOString(),
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
 * Run if it is due, and tell the owner if anything moved. Silence is the
 * correct output most weeks.
 *
 * The brief is recorded before it is sent, and a failed record stops the run,
 * so a week's brief goes out at most once.
 */
export async function maybeRunDrift(agent, chat, convoId) {
  // Nowhere to send it: wait for the next check rather than spend the week's
  // run on a brief nobody receives.
  if (!convoId) return null;
  const [latest] = await select('brief', {
    select: 'for_date',
    order: 'for_date.desc',
    limit: 1,
  });
  const last = latest?.for_date ? Date.parse(latest.for_date) : 0;
  const dueAfter = config.driftEveryHours * 3600_000;
  if (Date.now() - last < dueAfter) return null;

  const result = await runDrift(agent);
  const body = renderBrief(result);

  await upsert('brief', [
    {
      id: crypto.randomUUID(),
      for_date: new Date().toISOString().slice(0, 10),
      body: body ?? 'No drift.',
      sent_at: body ? new Date().toISOString() : null,
    },
  ]);

  if (body) {
    for (const chunk of chunkForDm(body)) {
      await chat.chat.bsky.convo.sendMessage({
        convoId,
        message: { text: chunk },
      });
    }
  }
  return body;
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
