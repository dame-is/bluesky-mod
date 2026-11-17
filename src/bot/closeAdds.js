// Closing the record when someone comes off the list.
//
// "undo last", recent activity and the write check all read a live `list_add`
// row as "on the list because of this". So every path that takes someone off
// closes the rows that put them on. Left open, "undo last" keeps choosing a
// plan whose accounts are already gone.
//
// Rows are stamped undone, never deleted, so "was I ever on this list" stays
// answerable.
//
// A plan that found someone already listed, when it was scanned or approved,
// marks them `already_listed` and skips them. Once they are off, that mark is
// cleared, so those plans can add them again.

import { selectAll, update, upsert } from './db.js';

/** DIDs per read, to keep each statement's `in (...)` list short. */
const CHUNK = 50;

/**
 * Stamp every live `list_add` decision for these accounts undone.
 *
 * With `plan`, only that plan's rows are closed and nothing else is touched:
 * for an undo that leaves someone on the list because another decision still
 * holds them there. Without it the accounts are off the list, every plan's
 * add is closed, and the `already_listed` marks are cleared.
 *
 * @param {string|string[]} dids
 * @param {string} reason  why they came off, in the words of whoever asked
 * @param {object} [opts]
 * @param {string} [opts.plan]  close only this plan's rows
 * @returns {Promise<number>} how many decision rows were closed
 */
export async function closeAdds(dids, reason, { plan = null } = {}) {
  const wanted = [...new Set([dids].flat().filter(Boolean))];
  const now = new Date().toISOString();
  let closed = 0;
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    const inChunk = { in: chunk };
    const live = await selectAll('decision', {
      select: 'plan_id,did,band,acted_at',
      eq: { action: 'list_add', ...(plan ? { plan_id: plan } : {}) },
      where: {
        did: inChunk,
        acted_at: 'not.is.null',
        undone_at: 'is.null',
      },
      order: 'plan_id.asc,did.asc',
    });
    if (!plan) {
      await update(
        'decision',
        {
          where: {
            did: inChunk,
            already_listed: 'is.true',
            acted_at: 'is.null',
          },
        },
        { already_listed: false },
      );
    }
    if (!live.length) continue;
    // The whole row, not only the two columns that change: SQLite checks NOT
    // NULL columns such as `band` before it resolves the conflict.
    await upsert(
      'decision',
      live.map((r) => ({
        plan_id: r.plan_id,
        did: r.did,
        band: r.band,
        action: 'list_add',
        acted_at: r.acted_at,
        undone_at: now,
        undo_reason: reason,
      })),
    );
    closed += live.length;
  }
  return closed;
}
