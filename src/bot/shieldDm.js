// The shield in a DM: commands the owner types, the numbers they answer its
// menus with, the 👍 on its questions, and the messages its tick sends.
//
// None of this reaches a model. A command is the owner's literal text (see
// lib/shieldCommand.js), the post is one they put in the message or sent
// last, and a menu option is a canonical command this code wrote.
//
// OWNER ONLY. These change who may reply to the owner's own posts, which is
// not a power the roster's writers were given: they may change the list, not
// the owner's posts. Anyone on the roster may ask for the status.

import {
  parseShieldCommand,
  isShieldCommand,
  shieldCommandText,
} from '../lib/shieldCommand.js';
import { parseChoice } from '../lib/command.js';
import { resolveTarget } from '../lib/target.js';
import { chunkForDm } from '../lib/agent.js';
import { ownLinkFacets, postWebUrl } from '../lib/links.js';
import { OWNER_DID } from '../constants.js';
import { upsert } from './db.js';
import { savePending, confirmLine, readPending } from './chatUx.js';
import {
  statusText,
  shieldsUp,
  shieldsDown,
  shieldsUpText,
  standDownText,
  closeReplies,
  disableQuotes,
  reopen,
  keepClosed,
  NO_PASSWORD,
} from '../shield.js';

/**
 * What the shield runs on, set once by index.js: { cfg, gates, activity,
 * outsideAmong, postInfo, startWatch, dryRun, log }. Null until then, and in
 * tests that do not set it.
 */
let deps = null;

export function setShieldDeps(next) {
  deps = next;
}

export function shieldDeps() {
  return deps;
}

const link = (uri) => postWebUrl(uri) || uri;

/** A reply as sent: the text, then its numbered menu. */
export function menuText(text, options) {
  return options?.length
    ? `${text}\n\nreply with a number:\n${options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}`
    : text;
}

/**
 * Send one of the shield's own messages to a convo, with its menu stored so a
 * number answers it, and its question stored so a 👍 does, unless another
 * question is open there: that one wins, and this goes without its 👍 line.
 */
export async function sendNotice(chat, convoId, { text, options = null, pending = null, describe = null, links = [] }) {
  if (!convoId || !text) return [];
  const asks = Boolean(pending?.length) && !(await readPending(convoId));
  const body = `${menuText(text, options)}${asks ? `\n\n${confirmLine([describe])}` : ''}`;
  await upsert('dm_choice', [{ convo_id: convoId, options: [] }]).catch(() => {});
  const ids = [];
  for (const chunk of chunkForDm(body)) {
    const facets = ownLinkFacets(chunk, { allow: links.filter(Boolean) });
    const sent = await chat.chat.bsky.convo.sendMessage({
      convoId,
      message: facets.length ? { text: chunk, facets } : { text: chunk },
    });
    if (sent?.data?.id) ids.push(sent.data.id);
  }
  if (options?.length) {
    const at = new Date().toISOString();
    await upsert('dm_choice', [
      { convo_id: convoId, options: options.map((o) => ({ ...o, offered_at: at })) },
    ]).catch(() => {});
  }
  if (asks) {
    await savePending(convoId, { commands: pending, describe, messageIds: ids, background: true });
  }
  return ids;
}

/**
 * Is this message for the shield, and if so its answer.
 *
 * @param {object} opts
 * @param {string} opts.text           what the sender typed ("!" already off)
 * @param {string|null} opts.embedUri  the post attached
 * @param {string[]} opts.links        full URLs from the message's facets
 * @param {boolean} opts.isOwner
 * @param {(n: number) => Promise<string|null>} opts.choice  the command
 *   behind menu option n, while the menu is live
 * @param {() => Promise<string|null>} opts.lastPost  the post sent last
 * @param {string} opts.convoId
 * @returns {Promise<null | { text: string, options: object[]|null,
 *   outcome: 'done'|'failed'|null, links: string[] }>}
 */
export async function shieldTurn({ text, embedUri = null, links = [], isOwner, choice, lastPost, convoId }) {
  let cmd = parseShieldCommand(text, { embedUri, links });
  if (!cmd) {
    const n = parseChoice(text);
    const chosen = n ? await choice(n) : null;
    if (chosen && isShieldCommand(chosen)) cmd = parseShieldCommand(chosen);
  }
  if (!cmd) return null;
  return runShield(cmd, { isOwner, lastPost, convoId });
}

/**
 * A stored command a 👍 or a "yes" runs. Owner only, as typed ones are.
 */
export async function runShieldCommand(text, { isOwner, convoId }) {
  const cmd = parseShieldCommand(text);
  if (!cmd) return { text: `I could not run "${text}".`, options: null, outcome: 'failed', links: [] };
  return runShield(cmd, { isOwner, lastPost: async () => null, convoId });
}

const reply = (text, { options = null, outcome = null, links = [] } = {}) => ({
  text,
  options,
  outcome,
  links,
});

async function runShield(cmd, { isOwner, lastPost, convoId }) {
  const d = deps;
  if (!d) return reply('The shield is not running here.');
  if (cmd.write && !isOwner) {
    return reply('Only the account I work for can change who may reply to or quote their posts.');
  }
  if (cmd.ruleError) {
    return reply(`${cmd.ruleError}. Say who may still reply: following, followers, mentioned or nobody.`);
  }

  if (cmd.action === 'status') {
    const s = await statusText(d);
    return reply(s.text, { options: isOwner ? s.options : null });
  }

  try {
    if (cmd.action === 'up') {
      const out = await shieldsUp(withConvo(d, convoId), { why: 'manual', hours: cmd.hours });
      const msg = shieldsUpText(out);
      return reply(msg.text, { options: msg.options, outcome: 'done' });
    }
    if (cmd.action === 'down') {
      const out = await shieldsDown(d);
      const msg = standDownText(out);
      return reply(msg.text, { options: msg.options, outcome: out.was ? 'done' : null });
    }

    // Everything else is about one post, which must be the owner's own.
    // The post sent last may be a link with a handle in it; whose it is is
    // checked once it is resolved.
    const target = cmd.post || (await lastPost().catch(() => null));
    if (!target) {
      return reply('Which post? Share it with that, or paste its link.');
    }
    let uri;
    try {
      uri = (await resolveTarget(target)).uri;
    } catch (err) {
      return reply(`I could not read that post: ${String(err?.message || err).replace(/\.$/, '')}.`);
    }
    if (!uri.startsWith(`at://${OWNER_DID}/app.bsky.feed.post/`)) {
      return reply('That is not one of your posts. I can only change replies and quotes on your own.');
    }

    if (cmd.action === 'watch') {
      if (!d.startWatch) return reply('Watching a post needs a model, and none is set up.');
      await d.startWatch(uri, convoId);
      return reply(`Watching ${link(uri)} for 24h. I'll send an update each hour there's something new, and ask before blocking anyone.`, {
        outcome: 'done',
        links: [postWebUrl(uri)],
      });
    }
    if (cmd.action === 'keep') {
      const n = await keepClosed(uri);
      return reply(
        n ? `Keeping ${link(uri)} as it is. It won't open by itself; "open replies" or "enable quotes" with it undoes that.` : `I haven't limited anything on ${link(uri)}.`,
        { outcome: n ? 'done' : null, links: [postWebUrl(uri)] },
      );
    }

    if (!d.gates) {
      return reply(NO_PASSWORD, {
        options: d.startWatch ? [{ label: 'Watch it for 24 hours', command: shieldCommandText({ action: 'watch', post: uri }) }] : null,
      });
    }
    const out =
      cmd.action === 'close'
        ? await closeReplies(d, uri, { rule: cmd.rule, why: 'manual' })
        : cmd.action === 'quotesOff'
          ? await disableQuotes(d, uri, { why: 'manual' })
          : cmd.action === 'open'
            ? await reopen(d, uri, 'threadgate')
            : await reopen(d, uri, 'postgate');
    const undo =
      cmd.action === 'close'
        ? { label: 'Open replies again', command: shieldCommandText({ action: 'open', post: uri }) }
        : cmd.action === 'quotesOff'
          ? { label: 'Turn quotes back on', command: shieldCommandText({ action: 'quotesOn', post: uri }) }
          : null;
    return reply(out.text, {
      options: out.changed && undo ? [undo] : null,
      outcome: !out.ok ? 'failed' : out.changed ? 'done' : null,
      links: [postWebUrl(uri)],
    });
  } catch (err) {
    d.log?.('A shield command failed', { action: cmd.action, err: String(err?.message || err) });
    return reply(`That failed: ${String(err?.message || err).slice(0, 200)}`, { outcome: 'failed' });
  }
}

/** deps whose startWatch reports to this convo. */
function withConvo(d, convoId) {
  if (!d.startWatch) return d;
  return { ...d, startWatch: (uri) => d.startWatch(uri, convoId) };
}
