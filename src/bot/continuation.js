// An approval too big for one message, carried on by itself.
//
// An approval writes at most PER_APPROVAL accounts per message, so a DM turn
// stays short on the one job queue. Past that, rather than ask the owner to
// say "go on" again and again, the command that continues it is stored here
// and a timer runs it in batches between DMs until it is done, waiting out
// Bluesky's write limit when it is reached. Kept in the database, so a
// restart picks up where it was. A cancel or an undo of the plan stops it.

import { del, select, update, upsert } from './db.js';

/** How long to wait after Bluesky's write limit, which resets hourly. */
export const RATE_LIMIT_WAIT_MS = 60 * 60_000;
/** How long to wait after a batch failed for another reason. */
export const RETRY_WAIT_MS = 10 * 60_000;
/** Failed batches in a row before it gives up and says so. */
export const MAX_FAILURES = 5;

const at = (ms) => new Date(ms).toISOString();

/**
 * Store or move on the continuation for a plan. `added` is what the batch
 * that just ran added, counted onto what earlier batches did.
 */
export async function continueLater(
  { planId, convoId, command, added = 0, rateLimited = false },
  { now = Date.now() } = {},
) {
  const [row] =
    (await select('continuation', {
      select: 'added',
      eq: { plan_id: planId },
    })) || [];
  await upsert('continuation', [
    {
      plan_id: planId,
      convo_id: convoId,
      command,
      next_at: at(now + (rateLimited ? RATE_LIMIT_WAIT_MS : 0)),
      added: (row?.added ?? 0) + added,
      failures: 0,
    },
  ]);
}

/** A batch failed: try again later, or give up after MAX_FAILURES. */
export async function retryLater(planId, { now = Date.now() } = {}) {
  const [row] =
    (await select('continuation', {
      select: 'failures',
      eq: { plan_id: planId },
    })) || [];
  const failures = (row?.failures ?? 0) + 1;
  if (failures >= MAX_FAILURES) {
    await stopContinuation(planId);
    return { gaveUp: true };
  }
  await update(
    'continuation',
    { eq: { plan_id: planId } },
    { failures, next_at: at(now + RETRY_WAIT_MS) },
  );
  return { gaveUp: false };
}

export async function stopContinuation(planId) {
  await del('continuation', { eq: { plan_id: planId } });
}

/** The continuation most overdue, or null. */
export async function dueContinuation({ now = Date.now() } = {}) {
  const [row] =
    (await select('continuation', {
      select: 'plan_id,convo_id,command,next_at,added,failures',
      where: { next_at: `lte.${at(now)}` },
      order: 'next_at.asc',
      limit: 1,
    })) || [];
  return row ?? null;
}

/** Whether a plan is being carried on, and how far it got. */
export async function continuationFor(planId) {
  const [row] =
    (await select('continuation', {
      select: 'plan_id,next_at,added',
      eq: { plan_id: planId },
    })) || [];
  return row ?? null;
}
