// Choosing which list a write goes to, in multi-list mode. Shared by the
// classic commands, the quick lane, stored questions and agent mode, so every
// path asks the same question the same way.
//
// THE RULE: a write that names no list is not done. The owner is asked
// "Which list?" with a numbered menu built here, each option the same write
// with `list:<rkey>` on the end, and answers "1", "2" or "3". With one list
// nothing is asked. A list word that names none of the bot's lists is not
// guessed at either: it is said back, with the same menu.
//
// Taking someone off is the exception: the bot looks for them first. On one
// list, that is where they come off; on several, the menu adds "every list".
//
// Plans are bound to one list (planList.js), so an approval of a plan already
// bound goes where the plan went, and one naming another list is refused.

import {
  botLists,
  resolveList,
  listMenu,
  listName,
  multiListOn,
} from './lists.js';
import { boundList, planList } from './planList.js';
import { rkeysForWrite } from './graphFacts.js';
import { update } from './db.js';
import { findPlan, shortCode } from './bulkPlan.js';
import { parseCommand } from '../lib/command.js';
import { splitListChoice, withListToken } from '../lib/listChoice.js';

export const rkeyOf = (uri) => String(uri ?? '').split('/').pop();

/** The canonical token for a list, by URI. */
export const listToken = (uri) => `list:${rkeyOf(uri)}`;

/** The question, as a reply runCommand can return. */
function menu(text, lists, commandsFor, opts) {
  return {
    text,
    options: listMenu(lists, commandsFor, opts),
    outcome: null,
  };
}

/**
 * The list a write goes to: the one named, the only one there is, or a
 * question.
 *
 * @param {string|null} word  the list as the owner typed it
 * @param {object} opts
 * @param {(list: object) => string[]} opts.commandsFor  what each option runs
 * @param {string} [opts.question]
 * @param {boolean} [opts.conflict]  the text named two lists
 * @returns {Promise<{ list?: object, reply?: object }>}
 */
export async function pickList(
  word,
  { commandsFor, question = 'Which list?', conflict = false },
) {
  const lists = await botLists();
  if (conflict) {
    return { reply: menu(`That names two lists. ${question}`, lists, commandsFor) };
  }
  if (word) {
    const r = resolveList(word, lists);
    if (r.list) return { list: r.list };
    return { reply: menu(`${r.error} ${question}`, lists, commandsFor) };
  }
  if (lists.length === 1) return { list: lists[0] };
  return { reply: menu(question, lists, commandsFor) };
}

/**
 * The lists to take an account off: the one named, every list ("all"), or
 * wherever they are. Constellation is asked per list; a list it cannot answer
 * for is offered rather than skipped.
 *
 * @returns {Promise<{ lists?: object[], none?: true, reply?: object }>}
 */
export async function pickRemoval(
  did,
  word,
  { commandsFor, who = 'they', conflict = false },
) {
  const lists = await botLists();
  const everyList = (among) =>
    among.length > 1 ? { all: among.flatMap(commandsFor) } : {};
  if (conflict) {
    return {
      reply: menu(
        `That names two lists. Which should ${who} come off?`,
        lists,
        commandsFor,
        everyList(lists),
      ),
    };
  }
  if (word) {
    const r = resolveList(word, lists, { allowAll: true });
    if (r.list) return { lists: [r.list] };
    if (r.all) return { lists };
    return {
      reply: menu(
        `${r.error} Which should ${who} come off?`,
        lists,
        commandsFor,
        everyList(lists),
      ),
    };
  }
  if (lists.length === 1) return { lists };
  const found = await Promise.all(
    lists.map((l) =>
      rkeysForWrite(l.uri, did, { walk: false }).catch(() => null),
    ),
  );
  const on = lists.filter((_, i) => found[i]?.length);
  const unsure = lists.filter((_, i) => found[i] === null);
  if (!on.length && !unsure.length) return { none: true };
  if (on.length === 1 && !unsure.length) return { lists: on };
  const candidates = lists.filter((l) => on.includes(l) || unsure.includes(l));
  const lead =
    on.length > 1
      ? `${who} is on ${on.length} of your lists.`
      : `I could not tell which of your lists ${who} is on.`;
  return {
    reply: menu(
      `${lead} Which should they come off?`,
      candidates,
      commandsFor,
      everyList(candidates),
    ),
  };
}

/** Bind a plan to a list, in the store and on the row in hand. */
export async function bindPlan(plan, list) {
  if (!multiListOn() || plan.list_uri === list.uri) return;
  await update('plan', { eq: { id: plan.id } }, { list_uri: list.uri });
  plan.list_uri = list.uri;
}

/**
 * The list an approval of `plan` goes to: the plan's, when an earlier
 * approval bound it, or the one named, the only one, or a question; bound
 * once chosen. `refuse` when the words name a different list from the one the
 * plan is bound to.
 *
 * @returns {Promise<{ list?: object, reply?: object, refuse?: string }>}
 */
export async function pickPlanList(
  plan,
  word,
  { commandsFor, conflict = false },
) {
  const code = shortCode(plan.id);
  const bound = boundList(plan);
  if (bound) {
    const lists = await botLists();
    const mine = lists.find((l) => l.uri === bound) || {
      uri: bound,
      rkey: rkeyOf(bound),
      name: listName(bound),
    };
    if (!word && !conflict) return { list: mine };
    const r = conflict ? { error: 'That names two lists.' } : resolveList(word, lists);
    if (r.list?.uri === bound) return { list: mine };
    if (r.list) {
      return {
        refuse: `Plan ${code} adds to ${mine.name}, so it cannot add to ${r.list.name} as well. Scan the post again and approve that scan to ${r.list.name}.`,
      };
    }
    return { refuse: `${r.error} Plan ${code} adds to ${mine.name}; I changed nothing.` };
  }
  const pick = await pickList(word, {
    commandsFor,
    conflict,
    question: `Which list should plan ${code} add to?`,
  });
  if (pick.list) await bindPlan(plan, pick.list);
  return pick;
}

/**
 * Does this stored command write to a list without saying which? A watch
 * that blocks as it goes, a block, and an approval or a card's "hostile" of a
 * plan no approval has bound yet. Everything else (an unblock, an undo, a
 * cancel) knows its list or finds it.
 */
export async function needsList(command) {
  if (!multiListOn()) return false;
  const choice = splitListChoice(command);
  if (choice.list || choice.conflict) return false;
  const text = choice.text;
  if (/^watch\s+\S+(?:\s+\d+h)?\s+auto\s*$/i.test(text)) return true;
  const hostile = /^hostile\s+([0-9a-f]{8})$/i.exec(text);
  if (hostile) {
    const plan = await findPlan(hostile[1]).catch(() => null);
    return Boolean(plan) && !boundList(plan);
  }
  const cmd = parseCommand(text);
  if (cmd?.action === 'list_add') return Boolean(cmd.actor);
  if (cmd?.action === 'approve' && cmd.code && !cmd.needsTarget) {
    const plan = await findPlan(cmd.code).catch(() => null);
    return Boolean(plan) && !boundList(plan);
  }
  return false;
}

/**
 * One "Which list?" for a set of stored commands (a card's words, a 👍), or
 * null when none of them needs one. Each option runs every command, with the
 * list on the ones that need it, so "author and likers" asks once.
 */
export async function askListFor(commands) {
  if (!multiListOn() || !commands?.length) return null;
  const flags = await Promise.all(commands.map(needsList));
  if (!flags.some(Boolean)) return null;
  const lists = await botLists();
  if (lists.length === 1) return null;
  return menu('Which list?', lists, (l) =>
    commands.map((c, i) => (flags[i] ? withListToken(c, l.rkey) : c)),
  );
}

/**
 * Commands a stored option runs with the list named in words alongside them,
 * as "likers to spam" names it for a card: put on each one that needs a list.
 */
export async function withNamedList(commands, word) {
  if (!word || !multiListOn()) return commands;
  const flags = await Promise.all(commands.map(needsList));
  return commands.map((c, i) => (flags[i] ? withListToken(c, word) : c));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Did these words name this list? Its name as a phrase (case and the space or
 * hyphen between its words ignored), its number after "list" or "#" or "to",
 * or its canonical token. For agent mode, which acts on a list only when the
 * owner named it: a list the model chose by itself is asked about instead.
 */
export function namedIn(text, list) {
  const t = String(text ?? '');
  if (!t || !list) return false;
  if (new RegExp(`\\blist[:=]${escapeRe(list.rkey)}\\b`, 'i').test(t)) {
    return true;
  }
  if (
    new RegExp(
      `(?:\\blist\\s*#?|#|\\b(?:to|on|onto|into)\\s+(?:list\\s*)?#?)${list.n}(?!\\d)`,
      'i',
    ).test(t)
  ) {
    return true;
  }
  const words = String(list.name)
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .map(escapeRe);
  if (!words.length) return false;
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${words.join('[\\s\\-_]*')}(?=$|[^\\p{L}\\p{N}])`,
    'iu',
  ).test(t);
}

/** "on Spam" for a reply in multi-list mode; nothing with one list. */
export const onListText = (uri) =>
  multiListOn() ? ` on ${listName(uri)}` : '';

export { planList };
