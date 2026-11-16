// Closing the record when someone comes off the list.
//
// "undo last", recent activity and the write check all read a live `list_add`
// row as "on the list because of this". So every path that takes someone off
// closes the rows that put them on. Left open, "undo last" keeps choosing a
// plan whose accounts are already gone.
//
// Rows are stamped undone, never deleted, so "was I ever on this list" stays
// answerable.

import { selectAll, upsert } from './db.js';

/** DIDs per read, to keep each statement's `in (...)` list short. */
const CHUNK = 50;

/**
 * Stamp every live `list_add` decision for these accounts undone.
 *
 * @param {string|string[]} dids
 * @param {string} reason  why they came off, in the words of whoever asked
 * @returns {Promise<number>} how many decision rows were closed
 */
export async function closeAdds(dids, reason) {
  const wanted = [...new Set([dids].flat().filter(Boolean))];
  const now = new Date().toISOString();
  let closed = 0;
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    const live = await selectAll('decision', {
      select: 'plan_id,did,band,acted_at',
      eq: { action: 'list_add' },
      where: {
        did: `in.(${chunk.map((d) => `"${d}"`).join(',')})`,
        acted_at: 'not.is.null',
        undone_at: 'is.null',
      },
      order: 'plan_id.asc,did.asc',
    });
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
