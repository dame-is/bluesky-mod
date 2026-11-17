// Which list a plan's writes go to.
//
// A plan is bound to one list. `plan.list_uri` is written when the plan is
// first approved in multi-list mode (or made, for a watch that blocks as it
// goes, and for a typed block), and every later approval, undo, cancel and
// continuation of it reads it from there. Null is MOD_LIST_URI: every plan
// written before multi-list mode existed, and every plan written with it off.
//
// The helpers that reason across plans ("another plan still holds this
// account", "close every add of theirs") ask this too, so an account on two
// lists is two separate facts: taking them off one list closes only that
// list's adds.

import { select } from './db.js';
import { listUri } from './listWrite.js';
import { multiListOn } from '../lib/listChoice.js';

/** The list this plan writes to. */
export const planList = (plan) => plan?.list_uri || listUri();

/**
 * The list a plan is already bound to, or null when no approval has bound it
 * yet. A plan approved before multi-list mode existed has no list_uri and is
 * bound to the primary list.
 */
export const boundList = (plan) =>
  plan?.list_uri || (plan?.approved_at ? listUri() : null);

/**
 * The list to scope a cross-plan read to, or null for none. With one list
 * every plan is on it, so nothing is scoped and the reads are the ones made
 * before lists were told apart. A plan bound to another list (made in
 * multi-list mode, then the mode turned off) is still scoped to its own.
 */
export const listScope = (list) =>
  list && (multiListOn() || list !== listUri()) ? list : null;

/** DIDs per read, as closeAdds reads them. */
const CHUNK = 50;

/**
 * Each of these plans' list, by plan id. A plan the store does not answer
 * for counts as the primary list, which is what a plan with no list_uri is.
 *
 * @param {string[]} ids
 * @returns {Promise<Map<string, string>>}
 */
export async function listsOfPlans(ids) {
  const wanted = [...new Set(ids.filter(Boolean))];
  const out = new Map(wanted.map((id) => [id, listUri()]));
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const rows =
      (await select('plan', {
        select: 'id,list_uri',
        where: { id: { in: wanted.slice(i, i + CHUNK) } },
      })) || [];
    for (const r of rows) if (r?.id && r.list_uri) out.set(r.id, r.list_uri);
  }
  return out;
}

/**
 * These decision rows without the ones whose plan writes to another list.
 * With no `list`, every row is kept, as before lists were told apart.
 *
 * @template {{ plan_id: string }} R
 * @param {R[]} rows
 * @param {string|null} list
 * @returns {Promise<R[]>}
 */
export async function rowsOnList(rows, list) {
  if (!list || !rows.length) return rows;
  const lists = await listsOfPlans(rows.map((r) => r.plan_id));
  return rows.filter((r) => (lists.get(r.plan_id) ?? listUri()) === list);
}
