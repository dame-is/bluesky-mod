// How a DM turn feels, as opposed to what it does to the list. The common
// request is a quick "block" plus a shared post, often several in a row, so
// that path costs no extra messages and no model call.
//
//   REACTIONS, NOT ACKS. 👀 on the owner's message when it is picked up, ✅ when
//   something changed, ❌ when it failed. A plain block needs no reply at all.
//
//   THE BURST SUMMARY. Quiet blocks are collected, and once a minute passes
//   without another, one message lists them: who, how many were already on the
//   list, how many already block the owner, and how to take one back.
//
//   CONFIRMATIONS A 👍 CAN ANSWER. When the bot asks before changing something,
//   the exact change is stored with the message that asked. "yes" or a 👍 on
//   that message runs it as described, through the classic commands, with no
//   model in between; "no" or 👎 drops it. Anything else lets it lapse.
//
//   THE POST CARD. A post with no words gets one compact summary and answers to
//   words (author, likers, unknowns, everyone, hostile) instead of numbers.

import { unreadText } from '../lib/report.js';
import { select, upsert } from './db.js';

export const REACTION = { working: '👀', done: '✅', failed: '❌' };
/** Reactions on the bot's question that mean yes, and no. */
export const YES_REACTIONS = new Set(['👍', '✅', '👌']);
export const NO_REACTIONS = new Set(['👎', '❌']);

/** How long a stored question stays answerable. */
const PENDING_TTL_MS = 30 * 60_000;
/** How long a burst has to go quiet before it is summarised. */
const QUIET_MS = 60_000;

/**
 * React to a message. Never throws: a reaction that did not land is not a
 * reason to lose the answer behind it. Returns whether it landed, so a caller
 * can fall back to a text ack.
 */
export async function react(chat, convoId, messageId, value) {
  const convo = chat?.chat?.bsky?.convo;
  if (!convo?.addReaction || !messageId) return false;
  try {
    await convo.addReaction({ convoId, messageId, value });
    return true;
  } catch {
    return false;
  }
}

async function unreact(chat, convoId, messageId, value) {
  const convo = chat?.chat?.bsky?.convo;
  if (!convo?.removeReaction || !messageId) return false;
  try {
    await convo.removeReaction({ convoId, messageId, value });
    return true;
  } catch {
    return false;
  }
}

/** Swap 👀 for how it went: ✅, ❌, or nothing for an answer without a change. */
export async function settle(chat, convoId, messageId, outcome) {
  await unreact(chat, convoId, messageId, REACTION.working);
  if (outcome === 'done') await react(chat, convoId, messageId, REACTION.done);
  if (outcome === 'failed') {
    await react(chat, convoId, messageId, REACTION.failed);
  }
}

// --- confirmations -----------------------------------------------------------

/**
 * Store a question the bot just asked.
 *
 * `commands` are classic command strings ("list add @x", "approve 1c2d3e4f
 * UNKNOWN"), so a "yes" runs exactly what parseCommand reads, through the same
 * path a typed command takes, vetoes and all. `describe` is the code-written
 * sentence the owner was shown.
 *
 * `background` marks a question nobody was talking to the bot about: a watch
 * digest or an alert, sent on a timer. There is one question per convo, and
 * the timed loops ask only while none is open, so theirs never replaces
 * another (see say in watching.js).
 */
export async function savePending(
  convoId,
  { commands, describe, messageIds, background = false },
) {
  await upsert('dm_choice', [
    {
      convo_id: convoId,
      pending: {
        commands,
        describe,
        message_ids: messageIds || [],
        created_at: new Date().toISOString(),
        ...(background ? { background: true } : {}),
      },
    },
  ]);
}

/**
 * The live question for this convo, or null. A question whose age cannot be
 * read counts as expired: a "yes" should never run something stale.
 */
export async function readPending(convoId, { now = Date.now() } = {}) {
  const rows = await select('dm_choice', {
    select: 'pending',
    eq: { convo_id: convoId },
  }).catch(() => []);
  const p = rows?.[0]?.pending;
  if (!p?.commands?.length) return null;
  // A question dated more than a few minutes ahead was stored while the
  // clock ran fast, and counts as expired rather than live until it catches
  // up. NaN, an unreadable time, is expired too.
  const age = now - Date.parse(p.created_at);
  if (!(age >= -5 * 60_000 && age <= PENDING_TTL_MS)) return null;
  return p;
}

export async function clearPending(convoId) {
  await upsert('dm_choice', [{ convo_id: convoId, pending: null }]).catch(
    () => {},
  );
}

/** The line that tells the owner what a 👍 will do, written by code. */
export function confirmLine(items) {
  if (!items?.length) return '';
  if (items.length === 1) return `👍 or "yes" to: ${items[0]}`;
  return `👍 or "yes" to do all of this:\n${items.map((d, i) => `${i + 1}. ${d}`).join('\n')}`;
}

// --- the burst summary -------------------------------------------------------

const quiet = new Map();

/**
 * Remember a block that got only a ✅. `item` is { action, handle, already,
 * blocksYou }.
 */
export function noteQuiet(convoId, item, now = Date.now()) {
  const entry = quiet.get(convoId) || { items: [], firstAt: now, lastAt: now };
  entry.items.push(item);
  entry.lastAt = now;
  quiet.set(convoId, entry);
}

/**
 * Bursts that have gone quiet, taken out of the buffer. A burst of one is
 * dropped without a summary: its ✅ already said everything.
 */
export function takeDueSummaries({
  now = Date.now(),
  quietMs = QUIET_MS,
} = {}) {
  const out = [];
  for (const [convoId, entry] of quiet) {
    if (now - entry.lastAt < quietMs) continue;
    quiet.delete(convoId);
    if (entry.items.length >= 2) out.push({ convoId, ...entry });
  }
  return out;
}

/** For tests. */
export function resetQuiet() {
  quiet.clear();
}

const names = (items, max = 6) => {
  const handles = items.map((i) => `@${i.handle}`);
  return handles.length > max
    ? `${handles.slice(0, max).join(', ')} and ${handles.length - max} more`
    : handles.join(', ');
};

/** One message for a burst of quiet blocks. */
export function summaryText({ items, firstAt, lastAt }) {
  const added = items.filter((i) => i.action === 'list_add' && !i.already);
  const again = items.filter((i) => i.action === 'list_add' && i.already);
  const removed = items.filter((i) => i.action === 'list_remove' && !i.already);
  const minutes = Math.max(1, Math.round((lastAt - firstAt) / 60_000));
  const lines = [];
  if (added.length) {
    lines.push(
      `Blocked ${added.length} in the last ${minutes} min: ${names(added)}.`,
    );
  }
  if (again.length) {
    lines.push(
      `${again.length === 1 ? '1 was' : `${again.length} were`} already on the list: ${names(again, 4)}.`,
    );
  }
  if (removed.length)
    lines.push(`Unblocked ${removed.length}: ${names(removed, 4)}.`);
  const blockers = added.filter((i) => i.blocksYou).length;
  if (blockers) {
    lines.push(
      `${blockers === 1 ? '1 of them already blocks' : `${blockers} of them already block`} you, so they can't reply to or quote you; the list still covers your subscribers.`,
    );
  }
  if (added.length) lines.push('"unblock @handle" takes one back.');
  return lines.join('\n');
}

// --- the post card -----------------------------------------------------------

const nf = (n) => Number(n || 0).toLocaleString('en-US');
const plural = (n, one, many) => `${nf(n)} ${n === 1 ? one : many}`;

/**
 * What a bare post gets instead of the agent or a numbered menu.
 *
 * Counts only; no handles but the author's, so nothing a stranger wrote can
 * shape it. Built from proposePlan's return.
 */
export function renderCard(plan, { choices = cardChoices(plan) } = {}) {
  const a = plan.author;
  const lines = [];
  if (a) {
    const facts = [a.band];
    if (a.followers != null) facts.push(`${nf(a.followers)} followers`);
    if (a.blocksYou) facts.push('blocks you');
    if (a.alreadyListed) facts.push('already on the list');
    if (a.protectedReason) facts.push(`PROTECTED: ${a.protectedReason}`);
    lines.push(`@${a.handle || a.did} (${facts.join(', ')}) wrote this.`);
  }
  const e = plan.engagements || {};
  // A direct reply to a thread's first post links to it as both parent and
  // root, so it is counted under `reply` and `threadReply`. On a first post
  // every reply has it as root; on a post deeper in a thread none do. The
  // larger count is the number of replies either way.
  const replies = Math.max(e.reply || 0, e.threadReply || 0);
  const parts = [
    e.like && plural(e.like, 'like', 'likes'),
    e.repost && plural(e.repost, 'repost', 'reposts'),
    e.quote && plural(e.quote, 'quote', 'quotes'),
    replies && plural(replies, 'reply', 'replies'),
  ].filter(Boolean);
  // A card that leaves out "likers" because the likes could not be read
  // says why, and any cut harvest says the counts are partial.
  const missing = unreadText(plan.unread);
  if (plan.total) {
    lines.push(
      `${plural(plan.total, 'account', 'accounts')} engaged${parts.length ? `: ${parts.join(', ')}` : ''}.`,
    );
    if (missing) {
      lines.push(
        `Could not read ${missing}, so these counts cover part of the post. Send it again to retry.`,
      );
    } else if (plan.truncated) {
      lines.push(
        'Not every engagement was read, so these counts cover part of the post.',
      );
    }
    const b = plan.byBand || {};
    const bands = ['UNKNOWN', 'PERIPHERAL', 'NOTABLE', 'CONNECTED', 'PROTECTED']
      .filter((k) => b[k])
      .map((k) => `${nf(b[k])} ${k.toLowerCase()}`);
    if (bands.length) lines.push(`By band: ${bands.join(', ')}.`);
    const known = [
      plan.alreadyListed && `${nf(plan.alreadyListed)} already on the list`,
      plan.blocksYou && `${nf(plan.blocksYou)} already block you`,
    ].filter(Boolean);
    if (known.length) lines.push(`${known.join(', ')}.`);
  } else if (missing) {
    lines.push(`Could not read ${missing}. Send it again to retry.`);
  } else if (plan.truncated) {
    lines.push('Not every engagement was read. Send it again to retry.');
  } else {
    lines.push('Nobody has engaged with it yet.');
  }
  const keys = choices.map((o) => o.key);
  if (keys.length) lines.push('', `Reply with: ${keys.join(' · ')}`);
  return lines.join('\n');
}

/**
 * The words the card answers to, each with the classic command it runs.
 * Only words that would do something: no "likers" on a post nobody liked.
 */
export function cardChoices(plan) {
  const out = [];
  const a = plan.author;
  // Counts of who an approval could still ADD: an engager already on the
  // list is no reason to offer "everyone".
  const b = plan.fresh?.byBand || plan.byBand || {};
  const e = plan.fresh
    ? { ...plan.engagements, like: plan.fresh.likers }
    : plan.engagements || {};
  // Written by DID: the card is answered up to 30 minutes later, and a handle
  // resolved then can belong to someone else. The handle names them only
  // while it verifies.
  if (a && !a.protectedReason && !a.alreadyListed) {
    const name =
      a.handle && a.handle !== 'handle.invalid' ? `@${a.handle}` : a.did;
    out.push({
      key: 'author',
      label: `Add the author ${name}`,
      command: `list add ${a.did}`,
    });
  }
  if (e.like) {
    out.push({
      key: 'likers',
      label: 'Add everyone who liked it',
      command: `approve ${plan.code} likers`,
    });
  }
  if (b.UNKNOWN) {
    out.push({
      key: 'unknowns',
      label: `Add the ${b.UNKNOWN} UNKNOWN accounts`,
      command: `approve ${plan.code} UNKNOWN`,
    });
  }
  const bands = ['UNKNOWN', 'PERIPHERAL', 'NOTABLE', 'CONNECTED'].filter(
    (k) => b[k],
  );
  if (bands.length > 1 || (bands.length === 1 && bands[0] !== 'UNKNOWN')) {
    out.push({
      key: 'everyone',
      label: 'Add everyone, every band but PROTECTED',
      command: `approve ${plan.code} ${bands.join(',')}`,
    });
  }
  if (plan.withText) {
    out.push({
      key: 'hostile',
      label: 'Read the replies and quotes, add the hostile ones',
      command: `hostile ${plan.code}`,
    });
  }
  return out;
}
