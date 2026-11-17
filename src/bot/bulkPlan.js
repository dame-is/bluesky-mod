// Bulk plans: everyone who engaged with a post, scored, and held until the
// owner approves.
//
//   add likers <post>          -> harvest, score, store an UNAPPROVED plan,
//                                 reply with the counts by band
//   approve <code> <bands>     -> create listitems for those bands only
//
// Two steps rather than one, so there is a moment between "do this" and
// "done" in which the owner sees who is close to them.
//
// Consent is per band, not per account, and `plan.approved_bands` records it.
// Approving UNKNOWN is a claim about a category the owner can defend;
// approving 400 people they never looked at is not.
//
// No model is called here. The post comes from the owner's message, the
// participants from Constellation and the bands from score.js. Writes happen
// only on an approval: the owner's typed code in classic mode (see
// src/lib/command.js), or agent mode and watches acting on what the owner
// asked, which `by` marks in the log.
//
// PROTECTED is never written, whatever is approved. The veto is checked here
// as well as in the parser, and again at the write against the `protected`
// table and the owner's follows as the AppView reports them then, because a
// plan's bands are as old as the plan.

import crypto from 'node:crypto';

import { APPVIEW, OWNER_DID } from '../constants.js';
import { fetchWithTimeout } from '../lib/atproto.js';
import { resolveActor, resolveTarget, TargetError } from '../lib/target.js';
import { harvestPost } from '../lib/harvest.js';
import { createScorer, summarise, BANDS } from '../lib/score.js';
import { KINDS } from '../lib/command.js';
import { select, selectAll, upsert, update, count } from './db.js';
import { loadReference } from './reference.js';
import { listUri, ownerOf, protectedAmong } from './listWrite.js';
import { evidenceUriFor } from './triage.js';
import { closeAdds } from './closeAdds.js';
import {
  graphFacts,
  isListed,
  noteListed,
  noteUnlisted,
  rkeysForWrite,
} from './graphFacts.js';

/**
 * How many listitems one `approve` will create.
 *
 * 500 creates is 1,500 points against a 5,000/hour ceiling, which leaves room
 * for the bot to also answer DMs and post replies in the same hour. Approving
 * again continues where it stopped, so the cap costs a second message rather
 * than a truncated result.
 */
const PER_APPROVAL = 500;

const BATCH = 50;

/** Short enough to retype in a DM, long enough not to collide. */
export const shortCode = (uuid) => uuid.replace(/-/g, '').slice(0, 8);

/**
 * The `approved_via` for a write, given who asked for it.
 *
 * `by` is null for a typed command, 'agent' when agent mode acted on the
 * owner's sentence, and 'watch' for a watch. Prefixed rather than replaced:
 * the basis still holds (a band is still a band), and the prefix says who
 * chose it. "agent:band" says both.
 */
const viaFor = (basis, by) => (by ? `${by}:${basis}` : basis);

/**
 * The plan's note with the words that asked for an approval added after it,
 * or null when there are none or the note already ends with them, as it does
 * when the same approval is sent again to continue.
 *
 * `reason` is the typed command, or the owner's message with the agent's
 * reason after it (noteFor in operator.js). It goes on the plan rather than
 * on each row because one plan can be approved several times; `approved_via`
 * on a row says which kind of approval added it.
 */
function noteWithReason(plan, reason) {
  const words = String(reason ?? '').trim();
  if (!words) return null;
  const add = `; approved: ${words}`;
  const note = String(plan.note || '');
  return note.endsWith(add) ? null : `${note}${add}`;
}

/** Does this participant match the requested engagement kind? */
function matchesKind(row, kind) {
  const wanted = KINDS[kind];
  if (!wanted) return true; // everyone
  return wanted.some((k) => (row.engagements || {})[k] > 0);
}

/** Did this stored decision row engage in any of these ways? */
function engagedAs(row, kinds) {
  if (!kinds?.length) return true;
  const engaged = Array.isArray(row.engaged) ? row.engaged : [];
  return kinds.some((kind) =>
    (KINDS[kind] || []).some((k) => engaged.includes(k)),
  );
}

const NOT_OURS = 'That list is not owned by this account.';

/**
 * Split rows into those to write and those already on the list, so an account
 * in two plans gets one listitem.
 *
 * Read from the held copy (graphFacts.js), which this process's own writes
 * keep current. If the list cannot be read, everything is written: a
 * duplicate is a cheaper mistake than a block that silently did not happen.
 */
async function splitListed(uri, rows) {
  const facts = await graphFacts({ list: uri }).catch(() => null);
  if (!facts?.listed) return { fresh: rows, listed: [] };
  const fresh = [];
  const listed = [];
  for (const r of rows) (isListed(uri, r.did) ? listed : fresh).push(r);
  return { fresh, listed };
}

/**
 * A harvest without these accounts, its totals counted again without them.
 *
 * The owner, the bot and the post's author can all show up among a post's
 * participants: the author by gating replies or answering in their own
 * thread, the bot by answering a mention there. None of them is one of the
 * people who engaged with the post. The author has a choice of their own on
 * the card, so a band approval never takes them along.
 */
function withoutSelves(harvest, dids) {
  const skip = new Set(dids.filter(Boolean));
  const participants = harvest.participants.filter((p) => !skip.has(p.did));
  const engagements = {};
  for (const p of participants) {
    for (const [k, n] of Object.entries(p.engagements || {})) {
      engagements[k] = (engagements[k] || 0) + n;
    }
  }
  return {
    ...harvest,
    participants,
    totals: {
      ...harvest.totals,
      participants: participants.length,
      engagements,
    },
  };
}

/**
 * Harvest a post, score everyone on it, and store an unapproved plan.
 *
 * `signal` stops the harvest, and a plan cut short by it is not stored.
 *
 * @returns {Promise<{code, uri, kind, total, byBand, truncated, protectedCount}>}
 */
export async function proposePlan({ link, kind, signal }) {
  const target = await resolveTarget(link);
  // A list, starter pack or feed has members or subscribers, not people who
  // engaged with it, and a scan would read them as the second.
  if (target.collection !== 'app.bsky.feed.post') {
    throw new TargetError('I scan posts, and that is not a post.');
  }
  const harvest = withoutSelves(await harvestPost(target.uri, { signal }), [
    OWNER_DID,
    ownerOf(listUri()),
    target.did,
  ]);
  // An aborted harvest returns what it had, marked truncated, rather than
  // throwing.
  signal?.throwIfAborted();
  const { ref, takenAt } = await loadReference();
  const scorer = createScorer(ref);

  // The author is scored in the same call as the participants, so a post with
  // no engagement still says something about the person who wrote it.
  // summarise() maps over the harvest, so the extra entry in the score map
  // cannot leak into the plan's rows.
  const scores = await scorer.score([
    ...new Set([...harvest.participants.map((p) => p.did), target.did]),
  ]);
  signal?.throwIfAborted();
  const summary = summarise(harvest, scores);
  const author = scores.get(target.did) ?? null;

  // Filtered to the kind after scoring, so the plan's totals keep the whole
  // post's counts (participants, engagements) while its rows and band counts
  // cover only the slice asked for.
  const chosen = summary.rows.filter((r) => matchesKind(r, kind));

  const planId = crypto.randomUUID();
  const byBand = Object.fromEntries(BANDS.map((b) => [b, 0]));
  for (const r of chosen) byBand[r.band] = (byBand[r.band] || 0) + 1;
  const alreadyListed = chosen.filter((r) => r.alreadyListed).length;
  const blocksYou = chosen.filter((r) => r.blocksYou).length;
  // Who an approval could still add: not PROTECTED, not on the list already.
  // A post whose engagers are mostly listed should not offer "add everyone"
  // for the one account that is left.
  const freshRows = chosen.filter(
    (r) => !r.alreadyListed && r.band !== 'PROTECTED',
  );
  const fresh = {
    total: freshRows.length,
    byBand: Object.fromEntries(
      BANDS.map((b) => [b, freshRows.filter((r) => r.band === b).length]),
    ),
    likers: freshRows.filter((r) => (r.engagements || {}).like > 0).length,
  };

  await upsert('plan', [
    {
      id: planId,
      created_at: new Date().toISOString(),
      approved_at: null,
      approved_bands: null,
      totals: {
        ...summary.totals,
        // The post the plan came from, for triage and the agent's plan facts.
        uri: target.uri,
        kind,
        selected: chosen.length,
        byBand,
        alreadyListed,
        blocksYou,
        snapshot: takenAt,
        truncated: summary.truncated,
      },
      note: `bulk ${kind} from ${target.uri}`,
    },
  ]);

  // One decision row per account, with the inputs that produced the band: the
  // answer to "why am I on your list". Written before anything is approved,
  // so a plan that never is still records what was nearly done.
  await upsert(
    'decision',
    chosen.map((r) => ({
      plan_id: planId,
      did: r.did,
      band: r.band,
      trust: r.trust ?? null,
      distance: r.distance ?? null,
      vouches: r.vouches ?? null,
      action: null,
      // Where this account's words live, recorded now so a later triage does
      // not have to re-walk 60 pages of Constellation to find them again.
      evidence_uri: evidenceUriFor(r),
      // How they engaged, so "the likers" of a whole-post scan can be approved
      // without harvesting the post again.
      engaged: Object.keys(r.engagements || {}),
      already_listed: Boolean(r.alreadyListed),
      blocks_me: Boolean(r.blocksYou),
    })),
  );

  return {
    code: shortCode(planId),
    planId,
    uri: target.uri,
    author,
    // How many wrote something. Likes and reposts carry no words, so this is
    // the ceiling on what a content triage could ever say anything about.
    withText: chosen.filter((r) => evidenceUriFor(r)).length,
    kind,
    total: chosen.length,
    byBand,
    // Per-kind counts, so a scan can say "15 likes, 1 repost" rather than only
    // a participant total.
    engagements: summary.totals?.engagements || {},
    // Quoted before the approval, so a batch that would take hours says so up
    // front. Counts only who an approval could still add.
    cost: estimateWrites(fresh.total),
    truncated: summary.truncated,
    protectedCount: byBand.PROTECTED || 0,
    alreadyListed,
    blocksYou,
    fresh,
  };
}

const PLAN_COLUMNS = 'id,created_at,approved_at,approved_bands,totals,note';

/**
 * Find a plan by its short code.
 *
 * A code is the first eight hex digits of the plan's uuid, so every plan it
 * could name sits in one range of the primary key, and that range is what is
 * read.
 */
export async function findPlan(code) {
  const c = String(code ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(c)) return null;
  const rows = await select('plan', {
    select: PLAN_COLUMNS,
    where: {
      id: [
        `gte.${c}-0000-0000-0000-000000000000`,
        `lte.${c}-ffff-ffff-ffff-ffffffffffff`,
      ],
    },
    order: 'created_at.desc',
    limit: 1,
  });
  return rows?.[0] ?? null;
}

/**
 * Create listitems for the approved bands.
 *
 * Resumable and idempotent: rows already carrying `acted_at` are skipped, so
 * running `approve` again continues rather than duplicating. Stops at
 * PER_APPROVAL and says how many are left. `reason` is kept in the plan's
 * note (see noteWithReason).
 */
export async function applyPlan(
  agent,
  plan,
  bands,
  { by = null, kinds = null, reason = null } = {},
) {
  const uri = listUri();
  const bot = agent.session?.did;
  if (!uri.startsWith(`at://${bot}/`)) return { ok: false, message: NOT_OURS };

  // PROTECTED is dropped here as well as in the parser, so the veto holds for
  // every caller and not only the ones that parse.
  const wanted = bands.filter((b) => b !== 'PROTECTED' && BANDS.includes(b));
  if (!wanted.length) {
    return {
      ok: false,
      message: `Name the bands: ${BANDS.filter((b) => b !== 'PROTECTED').join(', ')}.`,
    };
  }

  const rows = await selectAll('decision', {
    select: 'did,band,action,acted_at,undone_at,engaged,already_listed',
    eq: { plan_id: plan.id },
    order: 'did.asc',
  });
  const asked = rows.filter(
    (r) => wanted.includes(r.band) && engagedAs(r, kinds),
  );
  const { rows: pending, refused } = await withoutProtected(
    asked.filter((r) => !r.acted_at && !r.already_listed),
  );
  if (!pending.length) {
    return {
      ok: true,
      added: 0,
      remaining: 0,
      message:
        'Nothing left to add for those bands.' +
        vetoNote(refused) +
        undoneNote(asked.filter((r) => r.undone_at).length),
    };
  }

  const again = `approve ${shortCode(plan.id)} ${[...wanted, ...(kinds || [])].join(',')}`;
  const slice = pending.slice(0, PER_APPROVAL);
  const { added, failed, rateLimited, already, vetoed, note } =
    await writeRows(agent, plan, slice, {
      uri,
      bot,
      via: viaFor('band', by),
    });

  // Recorded as soon as anything was attempted, rate limit or not. Bands
  // approved earlier stay in the record.
  const withReason = noteWithReason(plan, reason);
  await update(
    'plan',
    { eq: { id: plan.id } },
    {
      approved_at: plan.approved_at || new Date().toISOString(),
      approved_bands: [
        ...new Set([...(plan.approved_bands || []), ...wanted]),
      ],
      ...(withReason ? { note: withReason } : {}),
    },
  );
  const live = await liveCount(plan);

  if (rateLimited) {
    const left = pending.length - added - already - vetoed;
    return {
      ok: true,
      added,
      already,
      remaining: left,
      live,
      message: `Added ${added}. Hit the write rate limit. Send "${again}" again in an hour for the remaining ${left}.`,
    };
  }

  const remaining = pending.length - added - already - failed - vetoed;
  return {
    ok: true,
    added,
    failed,
    already,
    remaining,
    live,
    message:
      `Added ${added} to the list${failed ? `, ${failed} failed` : ''}.` +
      alreadyNote(already) +
      vetoNote(vetoed + refused) +
      note +
      (remaining
        ? ` ${remaining} left. Send "${again}" again to continue.`
        : ''),
  };
}

/** " 3 were already on it." when some were, nothing when none were. */
function alreadyNote(n) {
  if (!n) return '';
  return n === 1 ? ' 1 was already on it.' : ` ${n} were already on it.`;
}

/** " 2 refused: PROTECTED." when any were, nothing when none were. */
function vetoNote(n) {
  return n ? ` ${n} refused: PROTECTED.` : '';
}

/**
 * These rows without the ones the veto refuses at the time of the call, and
 * how many that was: the `protected` table and the owner's and the bot's own
 * accounts, read fresh rather than taken from when the plan was scored. Such
 * a row stays pending, since protection lapses when the owner unfollows, so
 * it is dropped here on every read. Kept in, it is counted as left to add,
 * and enough of them fill an approval's slice so that nothing behind them is
 * reached.
 *
 * Follows made since the last snapshot are only found by the check at the
 * write, which keeps a count free of AppView calls. Best effort: when the
 * table cannot be read nothing is dropped, and the write refuses on its own.
 */
async function withoutProtected(rows) {
  if (!rows.length) return { rows, refused: 0 };
  const veto = await protectedAmong(
    rows.map((r) => r.did),
    { follows: false },
  ).catch(() => null);
  if (!veto?.size) return { rows, refused: 0 };
  const kept = rows.filter((r) => !veto.has(r.did));
  return { rows: kept, refused: rows.length - kept.length };
}

/**
 * How many of this plan's adds an `undo <code>` takes back after this write,
 * every approval of the plan included, for a receipt's undo option to say.
 * Null when it cannot be read, since the write has happened by then.
 */
const liveCount = (plan) =>
  countDecisions(plan, { state: 'live' }).catch(() => null);

/**
 * Why an approval finds nothing to add when an undo took this plan's adds
 * back off. An undone row stays done for its own plan, so a fresh scan is the
 * way back.
 */
function undoneNote(n) {
  if (!n) return '';
  return ` ${n === 1 ? '1 was' : `${n} were`} taken off by an earlier undo; scan the post again to add them back.`;
}

/**
 * Set at shutdown, so no new batch is started while the process is on its way
 * out. A batch already sent is left to finish and be recorded.
 */
let stopping = false;
export function stopWrites() {
  stopping = true;
}

/** An error's message, short enough for a DM. */
const brief = (err) => String(err?.message || err).slice(0, 160);

/**
 * Create the listitems for a set of already-chosen rows.
 *
 * Every plan approval writes through here, so there is one place that knows
 * how a listitem is made and logged. `via` says why: "you were in a category
 * I approved", "I read your profile and decided" and "a model read what you
 * wrote and I approved that reading" are different answers to why someone is
 * on the list, and the log has to tell them apart.
 *
 * Rows are checked against the veto as it stands at the write (protectedAmong
 * in listWrite.js), since a plan's bands date from when it was made. That check
 * failing throws, so nothing is written.
 *
 * Each batch is marked as asked for (`action` set, `acted_at` not yet) before
 * it is sent, and stamped `acted_at` once the PDS has taken it. A batch whose
 * reply was lost, or whose stamp failed, is then found on the list by the
 * next approval or undo and recorded as this plan's add, rather than as
 * someone another plan put there. A stamp that fails stops the run, since
 * every batch after it would go unrecorded too.
 *
 * `note` is a sentence for the reply when the run stopped early for a reason
 * other than the rate limit.
 */
async function writeRows(agent, plan, rows, { uri, bot, via }) {
  let added = 0;
  let failed = 0;
  let note = '';
  const veto = await protectedAmong(rows.map((r) => r.did));
  const allowed = rows.filter((r) => !veto.has(r.did));
  const vetoed = rows.length - allowed.length;
  const { fresh, listed } = await splitListed(uri, allowed);
  const landed = listed.filter((r) => r.action === 'list_add' && !r.acted_at);
  const others = listed.filter((r) => !landed.includes(r));
  if (others.length) {
    await upsert(
      'decision',
      others.map((r) => ({
        plan_id: plan.id,
        did: r.did,
        band: r.band,
        already_listed: true,
      })),
    ).catch(() => {});
  }
  if (landed.length) {
    await upsert('decision', stampRows(plan, landed, via));
    added += landed.length;
  }
  const already = others.length;
  for (let i = 0; i < fresh.length && !stopping; i += BATCH) {
    const batch = fresh.slice(i, i + BATCH);
    try {
      await upsert(
        'decision',
        batch.map((r) => ({
          plan_id: plan.id,
          did: r.did,
          band: r.band,
          action: 'list_add',
          approved_via: via,
        })),
      );
    } catch (err) {
      note = ` Nothing more was written, because the approval could not be recorded first (${brief(err)}).`;
      break;
    }
    let res;
    try {
      res = await agent.com.atproto.repo.applyWrites({
        repo: bot,
        writes: batch.map((r) => ({
          $type: 'com.atproto.repo.applyWrites#create',
          collection: 'app.bsky.graph.listitem',
          value: {
            $type: 'app.bsky.graph.listitem',
            subject: r.did,
            list: uri,
            createdAt: new Date().toISOString(),
          },
        })),
      });
    } catch (err) {
      failed += batch.length;
      // A rate limit means stop, not retry. The remaining budget is gone and
      // approving again in an hour is the correct backoff.
      if (/rate ?limit/i.test(String(err?.message || err))) {
        return { added, failed, rateLimited: true, already, vetoed, note };
      }
      continue;
    }
    const created = res?.data?.results || [];
    batch.forEach((r, n) =>
      noteListed(
        uri,
        r.did,
        String(created[n]?.uri || '')
          .split('/')
          .pop(),
      ),
    );
    added += batch.length;
    try {
      await upsert('decision', stampRows(plan, batch, via));
    } catch (err) {
      note = ` ${batch.length} of them could not be recorded (${brief(err)}), so I stopped there. The same approval sent again records them.`;
      break;
    }
  }
  return { added, failed, rateLimited: false, already, vetoed, note };
}

/**
 * Decision rows saying these accounts were added by this plan, stamped with
 * the current time. Without `via`, each row keeps the one it was marked with
 * when it was sent.
 */
function stampRows(plan, rows, via = null) {
  const now = new Date().toISOString();
  return rows.map((r) => ({
    plan_id: plan.id,
    did: r.did,
    band: r.band,
    action: 'list_add',
    acted_at: now,
    ...(via ? { approved_via: via } : {}),
  }));
}

/**
 * Add the accounts a content triage gave this label.
 *
 * Recorded as `approved_via: triage:<label>`, never as a band. A band is
 * reproducible from the snapshot; this is a model reading that nobody can
 * reproduce, so the log says which one it was. `reason` is kept in the plan's
 * note (see noteWithReason).
 */
export async function applyPlanToTriage(
  agent,
  plan,
  label,
  { by = null, skipBands = [], reason = null } = {},
) {
  const uri = listUri();
  const bot = agent.session?.did;
  if (!uri.startsWith(`at://${bot}/`)) return { ok: false, message: NOT_OURS };

  const rows = await selectAll('decision', {
    select: 'did,band,triage,action,acted_at,undone_at,already_listed',
    eq: { plan_id: plan.id, triage: label },
    order: 'did.asc',
  });
  // skipBands is how a watch holds CONNECTED and NOTABLE back for a 👍 even
  // when it was asked to add the hostile ones on its own.
  const { rows: pending, refused } = await withoutProtected(
    rows.filter(
      (r) =>
        r.band !== 'PROTECTED' &&
        !skipBands.includes(r.band) &&
        !r.acted_at &&
        !r.already_listed,
    ),
  );
  if (!pending.length) {
    return {
      ok: true,
      added: 0,
      message:
        `Nothing left to add for ${label}.` +
        vetoNote(refused) +
        undoneNote(rows.filter((r) => r.undone_at).length),
    };
  }

  const again = `approve ${shortCode(plan.id)} ${label}`;
  const slice = pending.slice(0, PER_APPROVAL);
  const { added, failed, rateLimited, already, vetoed, note } =
    await writeRows(agent, plan, slice, {
      uri,
      bot,
      via: viaFor(`triage:${label}`, by),
    });
  const withReason = noteWithReason(plan, reason);
  if (withReason) {
    await update('plan', { eq: { id: plan.id } }, { note: withReason });
  }
  const live = await liveCount(plan);

  // The batch the limit stopped is still pending, so it is not taken off
  // what is left.
  if (rateLimited) {
    const left = pending.length - added - already - vetoed;
    return {
      ok: true,
      added,
      already,
      remaining: left,
      live,
      message: `Added ${added} that a model read as ${label}. Hit the write rate limit. Send "${again}" again in an hour for the remaining ${left}.`,
    };
  }

  const remaining = pending.length - added - already - failed - vetoed;
  return {
    ok: true,
    added,
    failed,
    already,
    remaining,
    live,
    message:
      `Added ${added} that a model read as ${label}${failed ? `, ${failed} failed` : ''}.` +
      alreadyNote(already) +
      vetoNote(vetoed + refused) +
      note +
      (remaining ? ` ${remaining} left, send "${again}" again.` : ''),
  };
}

/**
 * How many accounts a plan action would touch, counted the way the action
 * itself counts them: `pending` is what an approval would still add (never
 * PROTECTED, by the plan's band or by the protected table as it stands, never
 * anyone already acted on), `live` is what an undo would take back. Read
 * before a write so the check on it can see the size of it.
 */
export async function countDecisions(
  plan,
  { bands = null, label = null, state = 'pending', kinds = null } = {},
) {
  const rows = await selectAll('decision', {
    select: 'did,band,triage,action,acted_at,undone_at,engaged,already_listed',
    eq: { plan_id: plan.id },
    order: 'did.asc',
  });
  // This plan's recorded adds, the most an undo of it takes off. It takes
  // fewer when another plan also added someone by name.
  if (state === 'live') {
    return rows.filter(
      (r) => r.acted_at && r.action === 'list_add' && !r.undone_at,
    ).length;
  }
  const pending = rows.filter((r) => {
    if (r.acted_at || r.band === 'PROTECTED' || r.already_listed) return false;
    if (bands?.length && !bands.includes(r.band)) return false;
    if (label && r.triage !== label) return false;
    return engagedAs(r, kinds);
  });
  return (await withoutProtected(pending)).rows.length;
}

/** What a plan holds for these DIDs: band, triage label, whether acted on. */
export async function decisionsFor(plan, dids) {
  const wanted = new Set(dids.filter(Boolean));
  if (!wanted.size) return new Map();
  const rows = await selectAll('decision', {
    select: 'did,band,triage,acted_at,undone_at',
    eq: { plan_id: plan.id },
    order: 'did.asc',
  });
  return new Map(rows.filter((r) => wanted.has(r.did)).map((r) => [r.did, r]));
}

/**
 * Mark a plan as declined, so the log records the decision not to act.
 *
 * A cancel takes nobody off the list, so `approved_at` and `approved_bands`
 * are left as they are: they record what the owner consented to, and the
 * accounts added under it are still there. The reply says how many of them
 * are, and whether an auto watch is still adding to the plan, since a cancel
 * stops neither.
 *
 * @returns {Promise<{ live: number, watching: number, message: string }>}
 */
export async function cancelPlan(plan, { now = Date.now() } = {}) {
  const [live, watches] = await Promise.all([
    countDecisions(plan, { state: 'live' }),
    select('watch', {
      select: 'id,mode,until',
      eq: { plan_id: plan.id },
      where: { stopped_at: 'is.null' },
    }).catch(() => []),
  ]);
  await update(
    'plan',
    { eq: { id: plan.id } },
    { note: `${plan.note || ''} (cancelled)` },
  );
  const watching = (watches || []).filter(
    (w) => w.mode === 'auto' && Date.parse(w.until) > now,
  ).length;
  const code = shortCode(plan.id);
  const onList = live
    ? `${live} it added ${live === 1 ? 'is' : 'are'} still on the list; "undo ${code}" takes ${live === 1 ? 'it' : 'them'} off.`
    : 'Nothing was added.';
  return {
    live,
    watching,
    message:
      `Cancelled ${code}. ${onList}` +
      (watching
        ? ' The watch on that post is still running and adds the hostile ones as they come.'
        : ''),
  };
}

/** Handles for a page of DIDs, 25 at a time, best effort. */
export async function handlesFor(dids) {
  const out = new Map();
  for (let i = 0; i < dids.length; i += 25) {
    const q = dids
      .slice(i, i + 25)
      .map((d) => `actors=${encodeURIComponent(d)}`)
      .join('&');
    try {
      const res = await fetchWithTimeout(
        `${APPVIEW}/xrpc/app.bsky.actor.getProfiles?${q}`,
      );
      if (!res.ok) continue;
      const body = await res.json();
      for (const p of body?.profiles || []) {
        out.set(p.did, {
          handle: p.handle,
          followers: p.followersCount ?? null,
        });
      }
    } catch {
      // A profile we cannot fetch still has a DID and a band, which is the part
      // that matters. Reviewing with a DID instead of a handle is ugly, not
      // wrong.
    }
  }
  return out;
}

/**
 * The accounts in a plan that are worth a person's attention.
 *
 * Defaults to everything that is not UNKNOWN, sorted by trust, because that is
 * the review queue the whole system is built around: the accounts most embedded
 * in the owner's world read first, so if attention runs out it runs out in the
 * right place.
 *
 * DM ONLY. This prints handles and follower counts; the public reply path must
 * never reach it.
 */
export async function reviewPlan(plan, { bands = null, limit = 15 } = {}) {
  const rows = await selectAll('decision', {
    select: 'did,band,trust,vouches,acted_at',
    eq: { plan_id: plan.id },
    order: 'did.asc',
  });
  const wanted = bands?.length
    ? rows.filter((r) => bands.includes(r.band))
    : rows.filter((r) => r.band !== 'UNKNOWN');
  const sorted = wanted.sort((a, b) => (b.trust ?? 0) - (a.trust ?? 0));
  const page = sorted.slice(0, limit);
  const profiles = await handlesFor(page.map((r) => r.did));
  return {
    total: sorted.length,
    shown: page.length,
    rows: page.map((r) => ({
      ...r,
      handle: profiles.get(r.did)?.handle || r.did,
      followers: profiles.get(r.did)?.followers ?? null,
    })),
  };
}

/**
 * Act on named accounts inside a plan: the personal path.
 *
 * Recorded as approved_via 'individual' rather than 'band'. Both write the
 * same listitem; only one means the owner looked at the account, and the log
 * has to say which. `reason` is kept in the plan's note (see noteWithReason)
 * when there was anyone to add.
 */
export async function applyPlanToActors(
  agent,
  plan,
  actors,
  { by = null, reason = null } = {},
) {
  const uri = listUri();
  const bot = agent.session?.did;
  if (!uri.startsWith(`at://${bot}/`)) return { ok: false, message: NOT_OURS };

  const rows = await selectAll('decision', {
    select: 'did,band,action,acted_at,undone_at,already_listed',
    eq: { plan_id: plan.id },
    order: 'did.asc',
  });
  const byDid = new Map(rows.map((r) => [r.did, r]));

  // Keyed by DID, so one account named twice is written once.
  const resolved = new Map();
  const unknown = [];
  const undone = [];
  for (const a of actors) {
    let did;
    try {
      did = await resolveActor(a);
    } catch {
      unknown.push(a);
      continue;
    }
    const row = byDid.get(did);
    if (!row) {
      unknown.push(a);
      continue;
    }
    // An undo is final for its own plan, the same as for a band approval.
    if (row.undone_at && !resolved.has(did)) undone.push(a);
    resolved.set(did, row);
  }

  // Approving someone by name does not outrank the veto.
  const named = [...resolved.values()];
  const banned = named.filter((r) => r.band === 'PROTECTED').length;
  const toWrite = named.filter((r) => r.band !== 'PROTECTED' && !r.acted_at);
  const { added, failed, rateLimited, already, vetoed, note } =
    await writeRows(agent, plan, toWrite, {
      uri,
      bot,
      via: viaFor('individual', by),
    });
  const withReason = toWrite.length ? noteWithReason(plan, reason) : null;
  if (withReason) {
    await update('plan', { eq: { id: plan.id } }, { note: withReason });
  }

  // As for a band approval: the batch the limit stopped is still pending.
  const remaining = rateLimited
    ? toWrite.length - added - already - vetoed
    : 0;
  const parts = [
    rateLimited
      ? `Added ${added} by name. Hit the write rate limit. Send "approve ${shortCode(plan.id)} ${actors.join(' ')}" again in an hour for the remaining ${remaining}.`
      : `Added ${added} by name${failed ? `, ${failed} failed` : ''}.${alreadyNote(already)}${note}`,
  ];
  if (banned + vetoed) parts.push(`${banned + vetoed} refused: PROTECTED.`);
  if (unknown.length) parts.push(`Not in this plan: ${unknown.join(', ')}.`);
  if (undone.length) {
    parts.push(
      `Taken off by an earlier undo: ${undone.join(', ')}. Block them by name to add them back.`,
    );
  }
  return {
    ok: true,
    added,
    already,
    remaining,
    message: parts.join(' '),
  };
}

/**
 * Cost of a set of writes, in the units that actually bind.
 *
 * Two ceilings apply and the tighter one is usually not the one people quote.
 * A create is 3 points against 5,000/hour per account, but it is ALSO one repo
 * event against the relay's 2,600/hour for the whole PDS, shared with every
 * other account on it. Deletes are 1 point and still one event.
 */
export function estimateWrites(n, { kind = 'create' } = {}) {
  if (!n) return 'nothing to write';
  const points = n * (kind === 'create' ? 3 : 1);
  const byPoints = points / 5000;
  const byEvents = n / 2600;
  const hours = Math.max(byPoints, byEvents);
  const mins = Math.round(hours * 60);
  const time =
    mins < 2
      ? 'under a minute'
      : mins < 90
        ? `about ${mins} minutes`
        : `about ${hours.toFixed(1)} hours`;
  return `${n.toLocaleString()} writes, ${points.toLocaleString()} points, ${time}`;
}

/**
 * The newest change to the list, which is what a bare `undo` means.
 *
 * `plan` is the plan behind it when that change put someone on the list and
 * they are still there. When it took someone off, `removed` names them and
 * `plan` is null: undo only takes people off, so it has nothing to reverse,
 * and reaching past the removal to an older add would undo something else.
 * An add already undone is passed over, so undoing again steps back to the
 * change before it. One row from the database.
 *
 * @returns {Promise<{ plan: object|null,
 *   removed: { did: string, planId: string, at: string }|null }>}
 */
export async function lastChange() {
  const rows = await select('decision', {
    select: 'plan_id,did,action,acted_at',
    where: {
      action: 'in.(list_add,list_remove)',
      acted_at: 'not.is.null',
      undone_at: 'is.null',
    },
    order: 'acted_at.desc',
    limit: 1,
  });
  const last = rows?.[0];
  if (!last) return { plan: null, removed: null };
  if (last.action === 'list_remove') {
    return {
      plan: null,
      removed: { did: last.did, planId: last.plan_id, at: last.acted_at },
    };
  }
  const plans = await select('plan', {
    select: PLAN_COLUMNS,
    eq: { id: last.plan_id },
  });
  return { plan: plans?.[0] ?? null, removed: null };
}

/**
 * The plan a bare `undo` takes back: the newest change, when it was an add
 * still on the list. Null otherwise, including when the newest change was a
 * removal (see lastChange).
 */
export async function lastActedPlan() {
  return (await lastChange()).plan;
}

/**
 * Up to this many accounts, an undo asks Constellation where each one's
 * listitems are instead of walking the bot's whole repo, which costs a page per
 * hundred listitems to find even one record.
 */
const LOOKUP_UNDER = 50;

/** A delete of something already gone. Constellation can lag a deletion. */
const ALREADY_GONE = /not ?found|could not (locate|find)/i;

/**
 * Where these accounts' listitems are, as did -> rkeys.
 *
 * `exhaustive` is true only when the repo walk ran to its end, which is the one
 * answer that can say an account missing from it is off the list. Constellation
 * cannot: "none" from it may be an add it has not indexed yet, so the lookup is
 * used only when it finds every account, and the walk is the fallback.
 */
async function listitemsFor(agent, { bot, uri, dids }) {
  if (dids.length <= LOOKUP_UNDER) {
    // No walk per account when Constellation cannot answer: the one walk
    // below covers all of them.
    const found = await Promise.all(
      dids.map((did) =>
        rkeysForWrite(uri, did, { walk: false }).catch(() => null),
      ),
    );
    if (found.every((rkeys) => rkeys?.length)) {
      return {
        byDid: new Map(dids.map((did, i) => [did, found[i]])),
        exhaustive: false,
      };
    }
  }

  const wanted = new Set(dids);
  const byDid = new Map();
  let cursor;
  for (let page = 0; page < 400; page += 1) {
    const res = await agent.com.atproto.repo.listRecords({
      repo: bot,
      collection: 'app.bsky.graph.listitem',
      limit: 100,
      cursor,
    });
    for (const rec of res.data.records || []) {
      const did = rec.value?.subject;
      if (rec.value?.list !== uri || !wanted.has(did)) continue;
      byDid.set(did, [...(byDid.get(did) || []), rec.uri.split('/').pop()]);
    }
    cursor = res.data.cursor;
    if (!cursor || !(res.data.records || []).length) {
      return { byDid, exhaustive: true };
    }
  }
  return { byDid, exhaustive: false };
}

/**
 * Delete listitems, in one applyWrites. That call is all or nothing, so one
 * record already gone fails the lot; the batch is then retried a record at a
 * time, which tolerates it.
 */
async function deleteListitems(agent, bot, rkeys) {
  try {
    await agent.com.atproto.repo.applyWrites({
      repo: bot,
      writes: rkeys.map((rkey) => ({
        $type: 'com.atproto.repo.applyWrites#delete',
        collection: 'app.bsky.graph.listitem',
        rkey,
      })),
    });
  } catch (err) {
    if (!ALREADY_GONE.test(String(err?.message || err))) throw err;
    for (const rkey of rkeys) {
      try {
        await agent.com.atproto.repo.deleteRecord({
          repo: bot,
          collection: 'app.bsky.graph.listitem',
          rkey,
        });
      } catch (one) {
        if (!ALREADY_GONE.test(String(one?.message || one))) throw one;
      }
    }
  }
}

/**
 * Was this add the owner choosing one account by name, rather than a
 * category: a typed block, agent mode adding a named account, or an approval
 * by name.
 */
const byName = (via) =>
  via === 'command' || via === 'agent' || /(^|:)individual$/.test(via || '');

/** Which of these accounts another plan added by name and still holds. */
async function heldByName(plan, dids) {
  const out = new Set();
  for (let i = 0; i < dids.length; i += 50) {
    const rows = await selectAll('decision', {
      select: 'plan_id,did,approved_via',
      eq: { action: 'list_add' },
      where: {
        did: `in.(${dids
          .slice(i, i + 50)
          .map((d) => `"${d}"`)
          .join(',')})`,
        acted_at: 'not.is.null',
        undone_at: 'is.null',
      },
      order: 'did.asc',
    });
    for (const r of rows) {
      if (r.plan_id !== plan.id && byName(r.approved_via)) out.add(r.did);
    }
  }
  return out;
}

/**
 * Take a plan's additions back off the list.
 *
 * The decision rows stay, stamped undone rather than deleted, so the log can
 * still answer "was I ever on this list". An append-only record that rewrites
 * itself is not a record.
 *
 * The listitem rkey is not stored, so it is looked up: one Constellation
 * request per account for a handful, one walk of the repo for more. Deletes
 * are 1 point rather than 3, so the cap is higher than an approval's, but it
 * is still capped and still resumable.
 *
 * An account already off the list is closed, not retried. When the walk has
 * seen the whole repo, an account it did not find is off the list (taken off
 * outside the bot, say), and the record says so. Left open, the plan would
 * stay live and every undo would answer "1 left, send undo again".
 *
 * An add this plan sent but never saw confirmed (see writeRows) is looked for
 * too, and if it is on the list it is recorded and taken off with the rest.
 *
 * An account the owner also added by name through another plan stays on the
 * list: undoing a batch takes back the batch, not their own choice. Only this
 * plan's row is closed.
 */
export async function undoPlan(
  agent,
  plan,
  { max = 1000, reason = 'undo' } = {},
) {
  const uri = listUri();
  const bot = agent.session?.did;
  if (!uri.startsWith(`at://${bot}/`)) return { ok: false, message: NOT_OURS };

  const rows = await selectAll('decision', {
    select: 'did,band,acted_at,action,approved_via,undone_at',
    eq: { plan_id: plan.id },
    order: 'did.asc',
  });
  const open = rows.filter((r) => r.action === 'list_add' && !r.undone_at);
  const nothing = {
    ok: true,
    removed: 0,
    message: 'Nothing from that plan is still on the list.',
  };
  if (!open.length) return nothing;

  const { byDid, exhaustive } = await listitemsFor(agent, {
    bot,
    uri,
    dids: open.map((r) => r.did),
  });
  const landed = open.filter((r) => !r.acted_at && byDid.has(r.did));
  if (landed.length) {
    await upsert('decision', stampRows(plan, landed));
  }
  // An unconfirmed add not found on the list is left as it is: a later
  // approval writes it.
  const live = open.filter((r) => r.acted_at || landed.includes(r));
  if (!live.length) return nothing;

  let alreadyOff = 0;
  if (exhaustive) {
    const missing = live.map((r) => r.did).filter((did) => !byDid.has(did));
    if (missing.length) {
      await closeAdds(missing, 'already off the list');
      alreadyOff = missing.length;
    }
  }

  const held = await heldByName(plan, [...byDid.keys()]);
  if (held.size) {
    await closeAdds([...held], reason, { plan: plan.id });
    for (const did of held) byDid.delete(did);
  }

  // Batched by account, so every copy of one account (two plans added them)
  // comes off in the same applyWrites, and its rows are closed only once all
  // of them are gone.
  const batches = [];
  for (const [did, rkeys] of [...byDid].slice(0, max)) {
    const last = batches[batches.length - 1];
    if (last && last.rkeys.length + rkeys.length <= BATCH) {
      last.dids.push(did);
      last.rkeys.push(...rkeys);
    } else {
      batches.push({ dids: [did], rkeys: [...rkeys] });
    }
  }

  let removed = 0;
  for (const batch of batches) {
    try {
      await deleteListitems(agent, bot, batch.rkeys);
      for (const did of batch.dids) noteUnlisted(uri, did);
      // Every live add of theirs, not only this plan's: every copy came off,
      // including one another plan put there, and that plan's row left open
      // would count them as still on the list.
      await closeAdds(batch.dids, reason);
      removed += batch.dids.length;
    } catch (err) {
      const message = String(err?.message || err);
      if (/rate ?limit/i.test(message)) break;
      throw err;
    }
  }

  const kept = held.size;
  const remaining = live.length - removed - alreadyOff - kept;
  return {
    ok: true,
    removed,
    remaining,
    alreadyOff,
    kept,
    message:
      `Took ${removed} back off the list.` +
      (alreadyOff ? ` ${alreadyOff} had already come off another way.` : '') +
      (kept
        ? ` ${kept === 1 ? '1 stays' : `${kept} stay`} on the list, since you also added them by name.`
        : '') +
      (remaining
        ? ` ${remaining} left, send "undo ${shortCode(plan.id)}" again.`
        : ''),
  };
}

/**
 * What has been done lately, or to one account: the newest `limit` acted rows,
 * their plans in one read, and the total as a count.
 */
export async function historyFor(did = null, { limit = 8 } = {}) {
  const eq = did ? { did } : {};
  const [rows, total] = await Promise.all([
    select('decision', {
      select: 'plan_id,did,band,action,acted_at,approved_via,undone_at',
      eq,
      where: { acted_at: 'not.is.null' },
      order: 'acted_at.desc',
      limit,
    }),
    count('decision', { eq, not_null: 'acted_at' }).catch(() => null),
  ]);
  const acted = rows || [];
  const ids = [...new Set(acted.map((r) => r.plan_id))];
  const plans = ids.length
    ? await select('plan', {
        select: 'id,note,approved_bands,created_at',
        where: { id: `in.(${ids.join(',')})` },
      })
    : [];
  const byId = new Map((plans || []).map((p) => [p.id, p]));
  return {
    total: total ?? acted.length,
    rows: acted.map((row) => ({
      ...row,
      plan: byId.get(row.plan_id) ?? null,
      code: shortCode(row.plan_id),
    })),
  };
}

/**
 * What happened to the list in the last `hours`: adds, removals and undos,
 * grouped by plan, newest first. For "what did you do today?".
 *
 * Read from the decision log, so it covers every path that writes (typed
 * commands, the agent, approvals, watches) and says which one it was.
 */
export async function activitySince(hours = 24, { now = Date.now() } = {}) {
  const since = new Date(now - hours * 3_600_000).toISOString();
  const [acted, undone] = await Promise.all([
    selectAll('decision', {
      select: 'plan_id,did,action,acted_at,approved_via',
      where: { acted_at: `gte.${since}` },
      order: 'acted_at.desc',
    }),
    selectAll('decision', {
      select: 'plan_id,did,undone_at',
      where: { undone_at: `gte.${since}` },
      order: 'undone_at.desc',
    }),
  ]);
  const byPlan = new Map();
  const entry = (id) => {
    if (!byPlan.has(id)) {
      byPlan.set(id, {
        code: shortCode(id),
        added: 0,
        removed: 0,
        undone: 0,
        via: new Set(),
        at: null,
      });
    }
    return byPlan.get(id);
  };
  for (const r of acted) {
    const e = entry(r.plan_id);
    if (r.action === 'list_remove') e.removed += 1;
    else e.added += 1;
    if (r.approved_via) e.via.add(r.approved_via);
    if (!e.at || r.acted_at > e.at) e.at = r.acted_at;
  }
  for (const r of undone) {
    const e = entry(r.plan_id);
    e.undone += 1;
    if (!e.at || r.undone_at > e.at) e.at = r.undone_at;
  }
  const ids = [...byPlan.keys()];
  const notes = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const rows = await select('plan', {
      select: 'id,note',
      where: { id: `in.(${ids.slice(i, i + 50).join(',')})` },
    }).catch(() => []);
    for (const p of rows || []) notes.set(p.id, p.note);
  }
  const plans = ids
    .map((id) => ({
      ...byPlan.get(id),
      via: [...byPlan.get(id).via],
      note: notes.get(id) ?? null,
    }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return {
    since,
    hours,
    totals: {
      added: plans.reduce((n, p) => n + p.added, 0),
      removed: plans.reduce((n, p) => n + p.removed, 0),
      undone: plans.reduce((n, p) => n + p.undone, 0),
    },
    plans: plans.slice(0, 40),
  };
}
