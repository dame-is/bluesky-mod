// One pass of the bot account's DM intake. src/index.js runs it on a timer.
//
// Two rules hold this together, and both are about blast radius:
//
//  1. Only senders on the roster are answered (src/lib/senders.js), and only
//     in one-to-one conversations, so the sender is the only one who reads
//     the reply; everyone else is skipped without a reply. Anyone can DM the
//     bot, and the model reads its input as instructions, so the sender check
//     is the security boundary, not the prompt.
//  2. In classic mode the analyst has no write tools. It looks and explains,
//     and acting goes through a typed command or a numbered menu, so a fully
//     prompt-injected turn cannot change the list. It can still write a wrong
//     paragraph, and its lookups can still carry what the turn holds to a
//     host the post names (see src/lib/agent.js).
//
// Agent mode (MOD_DM_MODE=agent) relaxes rule 2 on purpose: the model gets the
// write tools and is talked to in sentences. Rule 1 still decides who is
// answered and who may write, and the classic path is reached by a leading
// "!" or by answering a live classic menu. See src/bot/operator.js.
//
// At most once, on purpose. The cursor moves past each message before it is
// handled, so a message that crashes its turn is dropped rather than replayed,
// and a restart in the middle of a pass picks up at the message after it.
// Advancing after would turn one poisoned message into an endless loop of DMs.

import { generateText } from 'ai';
import { modelsEnabled } from '../models.js';

import { OWNER_DID } from '../constants.js';
import { rosterFromEnv } from '../lib/senders.js';
import { ownLinkFacets, postWebUrl } from '../lib/links.js';
import {
  authorOf,
  resolveActor,
  extractTargets,
} from '../lib/target.js';
import {
  answer,
  chunkForDm,
  historyFrom,
  untrusted,
  readRequest,
  pulseRequest,
  threadRequest,
  DEFAULT_MODEL,
} from '../lib/agent.js';
import {
  parseCommand,
  parseChoice,
  parseActor,
  parseQuick,
  parseCardWords,
  parseMemoryCommand,
  parseWatchCommand,
  isYes,
  isBareYes,
  isNo,
  bareEmoji,
  isWrite,
  readOnlyReply,
  facetLinks,
  facetMentions,
  offersFrom,
  followUpsFor,
  citationsIn,
  renderCitations,
  labelFor,
  pulseFromArgs,
  parseLookup,
  parsePostScan,
} from '../lib/command.js';
import {
  renderReport,
  actionsFor,
  helpText,
  renderPlanReport,
  planActions,
} from '../lib/report.js';
import {
  ackFor,
  nudge,
  parseOpeners,
  worthAcking,
} from '../lib/phrases.js';
import { select, upsert } from './db.js';
import { applyCommand } from './listWrite.js';
import { runTriage, reviewTriage, CONCURRENCY } from './triage.js';
import {
  proposePlan,
  findPlan,
  applyPlan,
  applyPlanToActors,
  applyPlanToTriage,
  reviewPlan,
  cancelPlan,
  undoPlan,
  lastChange,
  countDecisions,
  CLOSE_BANDS,
  HELD_BANDS,
  historyFor,
  shortCode,
} from './bulkPlan.js';
import { loadAgentConfig, clampLimits } from './agentConfig.js';
import { operate, fallbackText } from './operator.js';
import { shortModel, escalationEnabled } from './tiers.js';
import {
  REACTION,
  YES_REACTIONS,
  NO_REACTIONS,
  react,
  settle,
  savePending,
  readPending,
  clearPending,
  confirmLine,
  noteQuiet,
  takeDueSummaries,
  summaryText,
  renderCard,
  cardChoices,
} from './chatUx.js';
import {
  listNotes,
  remember,
  forget,
  recallText,
  notesBlock,
} from './memory.js';
import { startWatch, stopWatch, liveWatches, watchesText } from './watch.js';

/**
 * Which surface answers by default. Anything but "agent" is classic, so an
 * unset or misspelt value gets the mode where the model holds no write tools.
 */
export function normaliseMode(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase() === 'agent'
    ? 'agent'
    : 'classic';
}

/**
 * "!block @x" in agent mode runs the classic path for that one message.
 *
 * Only a "!" followed by something that could start a command, so "!!!" or a
 * lone "!" reads as a feeling rather than as a request for the parser.
 */
const CLASSIC_PREFIX = /^\s*!(?=\s*[\p{L}\p{N}@])/u;

/**
 * "^ what's going on in these replies" sends that one message straight to the
 * escalation model. The agent model never sees it.
 */
const STEP_UP_PREFIX = /^\s*\^\s*/;

/**
 * Where one message goes.
 *
 *   classic  the deterministic path, then the read-only analyst
 *   choice   a bare number: classic if the last reply offered a live menu,
 *            the agent otherwise
 *   agent    the agent, with write tools for a writer; `escalate` when the
 *            message asked for the escalation model
 *
 * Pure, so the routing rule is testable without a chat service.
 */
export function routeFor(text, { mode = 'classic' } = {}) {
  const t = String(text ?? '');
  if (mode !== 'agent') return { route: 'classic', text: t };
  if (CLASSIC_PREFIX.test(t)) {
    return { route: 'classic', text: t.replace(/^\s*!\s*/, '') };
  }
  if (STEP_UP_PREFIX.test(t) && t.replace(STEP_UP_PREFIX, '').trim()) {
    return {
      route: 'agent',
      escalate: true,
      text: t.replace(STEP_UP_PREFIX, ''),
    };
  }
  if (parseChoice(t)) return { route: 'choice', text: t };
  return { route: 'agent', text: t };
}

/**
 * The record attached to a message, if it was shared rather than pasted.
 *
 * Sharing a post into a DM from the Bluesky app puts no link in the text: the
 * post travels in `embed.record.uri`, so scanning the text alone misses it.
 */
function sharedRecordUri(message) {
  const uri = message?.embed?.record?.uri;
  return typeof uri === 'string' && uri.startsWith('at://') ? uri : null;
}

const POST_URI = /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/[^/?#]+$/;

/**
 * The post attached to a message. A shared list, starter pack or feed is not
 * one: scanning one of those would read its subscribers or members as people
 * who engaged with a post.
 */
export function sharedPostUri(message) {
  const uri = sharedRecordUri(message);
  return uri && POST_URI.test(uri) ? uri : null;
}

/**
 * What the model is asked: what the sender typed, plus the shared record, the
 * full links and the mentioned DIDs when there are any. Those lines are built
 * by code from the sender's own message, not copied from anyone else's
 * writing, so they are not untrusted input.
 */
export function composeMessage(message) {
  const text = message?.text || '';
  const extra = [];

  const uri = sharedRecordUri(message);
  if (uri) {
    const what = sharedPostUri(message) ? 'post' : 'record';
    extra.push(`The ${what} the owner shared: ${uri}`);
  }

  // A client truncates the visible text of a pasted link and keeps the whole
  // URI in the facet, so the text alone can hold "bsky.app/profile/stra...".
  const links = facetLinks(message).filter((l) => !text.includes(l));
  if (links.length)
    extra.push(`Full links in that message: ${links.join(' ')}`);

  const mentions = facetMentions(message);
  if (mentions.length) extra.push(`Accounts mentioned: ${mentions.join(' ')}`);

  if (!extra.length) return text;
  return `${text}\n\n[${extra.join('. ')}]`;
}

/**
 * How long a numbered menu, and a remembered post, stay live. A stale "1"
 * falls through to the analyst as a question instead of running a command
 * offered an hour ago.
 */
const CHOICE_TTL_MS = 30 * 60_000;

/** How far ahead of the clock a stored time may be and still count. */
const AHEAD_SLACK_MS = 5 * 60_000;

/**
 * True while `at` (an ISO time) is within the TTL. A missing time is stale,
 * and so is one more than a few minutes ahead, from a clock that ran fast:
 * it would otherwise stay live until the clock caught up.
 */
const fresh = (at, now = Date.now()) => {
  const age = now - Date.parse(at);
  return age >= -AHEAD_SLACK_MS && age <= CHOICE_TTL_MS;
};

/**
 * The stored options, if they are still live.
 *
 * Timed from when the options were offered, which each one carries, because
 * the row is also rewritten when a post is remembered, and that must not
 * renew a menu shown hours earlier.
 */
function liveOptions(row, now = Date.now()) {
  if (!row?.options?.length) return null;
  return fresh(row.options[0].offered_at, now) ? row.options : null;
}

async function offerChoices(convoId, options, lastPost) {
  if (!options?.length && !lastPost) return;
  const now = new Date().toISOString();
  const row = { convo_id: convoId };
  if (options?.length) {
    row.options = options.map((o) => ({ ...o, offered_at: now }));
  }
  if (lastPost) {
    row.last_post = lastPost;
    row.last_post_at = now;
  }
  await upsert('dm_choice', [row]).catch(() => {});
}

/**
 * Forget the menu. Every message the bot sends here does this first, so a
 * "2" answers only the menu on the bot's last message: after a reply with
 * none, such as an agent reply, a cancel or the analyst's prose, it reaches
 * the agent or the analyst rather than an option offered earlier.
 */
async function clearChoices(convoId) {
  await upsert('dm_choice', [{ convo_id: convoId, options: [] }]).catch(
    () => {},
  );
}

/**
 * The post last put in front of the bot in this conversation, while live.
 *
 * Lets "add likers" with no link mean the post just sent. Only ever written
 * from the sender's own message, so the target of a bulk action comes from
 * them rather than from anything the analyst read.
 */
async function lastPost(convoId) {
  const rows = await select('dm_choice', {
    select: 'last_post,last_post_at',
    eq: { convo_id: convoId },
  }).catch(() => []);
  const row = rows?.[0];
  if (!row?.last_post || !fresh(row.last_post_at)) return null;
  return row.last_post;
}

/**
 * Remember the post in the sender's message. Done on every route, so a post
 * attached to a question in words ("the quotes on this are toxic") is still
 * there for "add quoters" one message later.
 */
async function rememberPost(convoId, uri) {
  if (!uri) return;
  await upsert('dm_choice', [
    {
      convo_id: convoId,
      last_post: uri,
      last_post_at: new Date().toISOString(),
    },
  ]).catch(() => {});
}

/** The command behind a numbered reply, if it is still live. */
async function takeChoice(convoId, n) {
  const rows = await select('dm_choice', {
    select: 'options',
    eq: { convo_id: convoId },
  }).catch(() => []);
  return liveOptions(rows?.[0])?.[n - 1]?.command ?? null;
}

/** Render options as the numbered menu the owner picks from. */
function renderChoices(options) {
  return options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
}

/** A reply with its menu, as sent: the text, then the numbered options. */
function withMenu(text, options) {
  return options?.length
    ? `${text}\n\nACTIONS:\n${renderChoices(options)}`
    : text;
}

/**
 * An account as a reply names it: "@handle" while the handle verifies, and
 * otherwise `fallback`, normally the DID. "handle.invalid" is what the network
 * reports for a handle that no longer points back at its account, and it
 * resolves to nobody.
 */
const nameOf = (account, fallback) =>
  account?.handle && account.handle !== 'handle.invalid'
    ? `@${account.handle}`
    : fallback;

/** How many posts a triage run could not read, in either wave. */
const failedReadsOf = (out) =>
  (out?.failed || 0) + (out?.secondWave?.failed || 0);

/** "3 could not be read: <the reason>." */
const failedReadsLine = (n, error) =>
  `${n} could not be read${error ? `: ${error.replace(/\.$/, '')}` : ''}.`;

/** What anything past the commands gets when there is no model to read with. */
const NO_MODEL =
  'No AI model is set up for this bot, so I only understand commands. Send "help" for the list.';

/** What a request to sort by tone gets when there is no model to read with. */
const NO_MODEL_TO_SORT =
  'Sorting by tone needs an AI model, and this bot has none set up.';

/** Every band but PROTECTED. */
const ALL_BANDS = ['UNKNOWN', 'PERIPHERAL', 'NOTABLE', 'CONNECTED'];

/** "A", "A and B", "A, B and C". */
const andList = (items) =>
  items.length > 1
    ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
    : items.join('');

/**
 * The named accounts in a plan, and what the owner can do about them.
 *
 * The plan row carries no code, so it is derived from the id. "Add" covers
 * the whole set under review, not only the rows on screen: when some are past
 * the fold it approves every band the review asked for (all but UNKNOWN when
 * it named none), so an account below row 15 is not left out. Its label names
 * those bands rather than a count, since PROTECTED rows and accounts already
 * on the list are in the review and are never added.
 */
function renderReview(plan, review, { bands: asked = [] } = {}) {
  const code = shortCode(plan.id);
  const lines = [`Plan ${code}: ${review.total} need a look:`, ''];
  for (const r of review.rows) {
    const reach =
      r.followers != null ? `, ${r.followers.toLocaleString()} followers` : '';
    lines.push(`  @${r.handle}: ${r.band}, ${r.vouches ?? 0} vouches${reach}`);
  }
  const allShown = review.total <= review.shown;
  if (!allShown) {
    lines.push('', `(${review.total - review.shown} more)`);
  }
  const under = allShown
    ? review.rows.map((r) => r.band)
    : asked.length
      ? asked
      : ALL_BANDS.filter((b) => b !== 'UNKNOWN');
  const bands = ['CONNECTED', 'PERIPHERAL', 'NOTABLE', 'UNKNOWN'].filter((b) =>
    under.includes(b),
  );
  const options = [];
  if (bands.length) {
    options.push({
      label: `Add the ${andList(bands)} ones`,
      command: `approve ${code} ${bands.join(',')}`,
    });
  }
  options.push({ label: 'Do nothing', command: `cancel ${code}` });
  lines.push('', `Or name them: approve ${code} @handle @handle`);
  return { text: lines.join('\n'), options };
}

/**
 * The label on a receipt's undo option. `undo <code>` takes back every add of
 * the plan still on the list, so when earlier approvals of it added more than
 * this one did, the label says so rather than naming this approval's count.
 */
function undoLabel(
  code,
  added,
  live,
  { few = `Undo those ${added}`, all = 'Undo everything plan' } = {},
) {
  return live > added ? `${all} ${code} added (${live})` : few;
}

/** How many of a plan's adds are on the list, or null when unreadable. */
const liveAdds = (plan) =>
  countDecisions(plan, { state: 'live' }).catch(() => null);

/**
 * When the newest `label` on a plan was given, or null when no row carries a
 * time. A menu that offers to add a counted label carries it as "asof=", so
 * pressing it later adds what was counted and nothing a watch labelled while
 * the menu was live.
 */
async function newestLabelAt(plan, label) {
  const rows = await select('decision', {
    select: 'triage_at',
    eq: { plan_id: plan.id, triage: label },
    where: { triage_at: 'not.is.null' },
    order: 'triage_at.desc',
    limit: 1,
  });
  const at = Date.parse(rows?.[0]?.triage_at);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** " asof=<time>", or nothing when there is no time to bound by. */
const asOfToken = (at) => (at ? ` asof=${at}` : '');

/**
 * Text someone else wrote, on one line and with its double quotes made
 * single, so it cannot close the quote it sits in or start a line of its own.
 */
const oneQuotable = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/["“”]/g, "'");

/** One row of a label review: the band, then a stranger's words. */
const quoteRow = (band, quote) =>
  `${band} - "${oneQuotable(quote).slice(0, 160)}"`;

/**
 * quoteRow's output, in the bot's own messages read back as history. The
 * quote holds no double quote and no line break, so a stranger cannot end
 * the match early or write a row of their own.
 */
const QUOTE_ROW =
  /^(PROTECTED|CONNECTED|PERIPHERAL|NOTABLE|UNKNOWN) - "([^"\n]*)"$/gm;

/**
 * A `history` row with a plan note, in the bot's own messages read back as
 * history. The note holds no double quote (oneQuotable), so it runs to the
 * row's last character.
 */
const NOTE_ROW = /^(.+ · [0-9a-f]{8}(?: \(undone\))?, ")([^"\n]*)"$/gm;

/**
 * The agent's reason inside a note, found as noteText in operator.js finds
 * it: a reason holds no "]", and a marker never closed runs to the end. A
 * model wrote it in a turn that read strangers' posts.
 */
const AGENT_REASON = / \[agent: ([^\]]*)\]?/g;

/**
 * The bot's own message, as a model reads it back: strangers' words that
 * code put in it are fenced as untrusted, the way a tool result fences them.
 * The sender sees no tags; only the history a model reads carries them.
 * Prose a model wrote cannot be told apart and is left as it is.
 */
export function fenceStrangers(text) {
  return String(text ?? '')
    .replace(
      QUOTE_ROW,
      (_, band, quote) => `${band} - ${untrusted('quote', quote)}`,
    )
    .replace(
      NOTE_ROW,
      (_, head, note) =>
        `${head}${note.replace(
          AGENT_REASON,
          (_m, why) => ` ${untrusted('agent-reason', why)}`,
        )}"`,
    );
}

/**
 * What a plan write did: 'done' when it put anyone on the list or took anyone
 * off, 'failed' when it could not run or every write failed, and null when
 * there was nothing to do.
 */
const planOutcome = (out, moved) =>
  moved > 0 ? 'done' : out?.ok === false || out?.failed > 0 ? 'failed' : null;

/**
 * How many accounts an approval put on the list or recorded there. A batch an
 * earlier approval sent and this one only found and recorded counts, so its
 * receipt offers the undo and reads as done.
 */
const addedOrRecorded = (out) => (out?.added || 0) + (out?.recorded || 0);

/**
 * Run one typed command and return what to say back.
 *
 * No branch asks a model what to do. The inputs are the sender's literal text
 * and what Constellation and score.js returned. Triage calls a model to label
 * posts, and adds nobody.
 *
 * The text carries no menu. The caller that stores `options` renders them
 * (withMenu), after leaving out what the sender may not run, so the numbers
 * on screen and the commands they run are the same list.
 *
 * `outcome` is what the command did, read from what the write returned and
 * never from the reply's words: 'done' when the list changed (a block of
 * someone already on it counts, as in the quick lane, and so does a cancel),
 * 'failed' when it could not be done, and null for an answer, a question, a
 * refusal or nothing to do.
 */
export async function runCommand(
  cmd,
  writeAgent,
  {
    template,
    reportTemplate,
    lookUp,
    canWrite = true,
    generate,
    model,
    log = () => {},
  } = {},
) {
  const say = (text, options = null, outcome = null) => ({
    text,
    options,
    outcome,
  });

  // The gate, before any branch that could reach a repo. Checked here and not
  // only where menus are built, because a command can arrive as typed text.
  if (!canWrite && isWrite(cmd)) {
    return say(readOnlyReply(cmd));
  }

  // A verb with nothing to act on. Every branch asks rather than guesses.
  // `undo` lands here only when handed a token meant as a code that is not
  // one: the answer names the token instead of undoing a plan nobody named.
  if (cmd.needsTarget) {
    // A command the parser could not read one way, an approval or a history
    // name: its sentence says what it refused.
    if (cmd.refusal) return say(cmd.refusal);
    if (cmd.action === 'plan') {
      return say(nudge('post'));
    }
    if (cmd.action === 'undo') {
      const token = cmd.raw.replace(/^undo\s*/i, '').trim();
      return say(
        `I do not recognise "${token}" as a plan code. Send "undo last" for the most recent one, or "history" to see the codes.`,
        [
          { label: 'Undo the last thing I did', command: 'undo last' },
          { label: 'Show me the record', command: 'history' },
        ],
      );
    }
    if (['approve', 'cancel', 'review', 'triage'].includes(cmd.action)) {
      return say(nudge('plan'));
    }
    return say(nudge('actor'));
  }
  // Before the writeAgent guard: asking what the thing does needs no session,
  // and a read-only sender is shown the read-only half.
  if (cmd.action === 'help') {
    // The label comes from the parse, like every other option's, so it cannot
    // drift from its command.
    const hasModel = modelsEnabled();
    return say(
      helpText({ canWrite, hasModel }),
      hasModel
        ? [{ label: labelFor(parseCommand('pulse')), command: 'pulse' }]
        : null,
    );
  }

  if (!writeAgent) {
    return say(
      'Commands are not wired up on this path.',
      null,
      isWrite(cmd) ? 'failed' : null,
    );
  }

  if (cmd.action === 'plan') {
    const plan = await proposePlan({ link: cmd.target, kind: cmd.kind });
    const actions = planActions(plan, { hasModel: modelsEnabled() });
    const head = cmd.remembered ? 'Using the post you sent earlier.\n\n' : '';
    return {
      text: `${head}${renderPlanReport(plan, { template })}`,
      options: actions,
      lastPost: plan.uri,
    };
  }

  if (cmd.action === 'history') {
    let did = null;
    if (cmd.actor) {
      try {
        did = await resolveActor(cmd.actor);
      } catch (err) {
        // The resolver's reason, so an AppView outage does not read as an
        // account that does not exist.
        return say(
          `I could not resolve ${cmd.actor}: ${String(err?.message || err).replace(/\.$/, '')}.`,
        );
      }
    }
    const h = await historyFor(did);
    if (!h.rows.length) {
      return say(
        cmd.actor ? 'Nothing recorded for them.' : 'Nothing done yet.',
      );
    }
    // A plan's note holds the words that asked for each change, which can be
    // what the owner would tell nobody else, so a sender who may not write
    // sees what was done and not why.
    const lines = h.rows.map((r) => {
      const when = new Date(r.acted_at).toLocaleString();
      const verb =
        r.action === 'list_remove'
          ? 'removed'
          : r.already_listed
            ? 'asked again, already on the list'
            : 'added';
      const note =
        canWrite && r.plan?.note ? `, "${oneQuotable(r.plan.note)}"` : '';
      const undone = r.undone_at ? ' (undone)' : '';
      return `${when} · ${verb} · ${r.band} · ${r.approved_via ?? '?'} · ${r.code}${undone}${note}`;
    });
    return say(
      `${h.total} actions on record, most recent first:\n\n${lines.join('\n')}`,
    );
  }

  if (cmd.action === 'undo') {
    const last = cmd.last ? await lastChange() : null;
    // The newest change took someone off the list. Undo only takes people
    // off, so it has nothing to reverse, and reaching past the removal to an
    // older add would undo something else.
    if (last?.removed) {
      const { did } = last.removed;
      const found = lookUp ? await lookUp(did).catch(() => null) : null;
      const who = nameOf(found, did);
      return say(
        `The last change took ${who} off the list. Undo only takes people off, so nothing was undone. "block ${who}" puts them back.`,
        [{ label: `Put ${who} back on the list`, command: `list add ${did}` }],
      );
    }
    // The newest change was a block of someone already listed, which wrote
    // nothing. Undoing it would take off someone it did not put there, and
    // reaching past it would take back an older batch instead.
    if (last?.unchanged) {
      const { did } = last.unchanged;
      const found = lookUp ? await lookUp(did).catch(() => null) : null;
      const who = nameOf(found, did);
      return say(
        `The last change was a block of ${who}, who was already on the list, so nothing was undone. "unblock ${who}" takes them off, and "undo <code>" takes back an earlier change ("history" shows the codes).`,
        [
          { label: `Take ${who} off the list`, command: `list remove ${did}` },
          { label: 'Show me what changed', command: 'history' },
        ],
      );
    }
    const plan = cmd.last ? last.plan : await findPlan(cmd.code);
    if (!plan) {
      return cmd.last
        ? say('Nothing to undo.')
        : say(`No plan with code ${cmd.code}.`, null, 'failed');
    }
    const out = await undoPlan(writeAgent, plan, {
      reason: cmd.raw,
    });
    return say(
      out.message,
      [{ label: 'Show me what changed', command: `history` }],
      planOutcome(out, out.removed),
    );
  }

  if (['approve', 'cancel', 'review', 'triage'].includes(cmd.action)) {
    if (cmd.action === 'triage' && !(modelsEnabled() && model)) {
      return say(NO_MODEL_TO_SORT);
    }
    const plan = await findPlan(cmd.code);
    if (!plan) return say(`No plan with code ${cmd.code}.`, null, 'failed');

    // Read what they wrote and bucket it. Labels only: nobody is added here,
    // and approving a bucket is a separate command on purpose.
    if (cmd.action === 'triage') {
      const out = await runTriage(plan, { generate, model, log });
      const { counts } = out;
      // Read after this run's labels are written, so the add below covers
      // them and nothing labelled later.
      const hostileAsOf = await newestLabelAt(plan, 'hostile');
      // How many were read as hostile and how many are not yet acted on can
      // differ, and a button can only be about the second.
      const left = out.pending || counts;
      const seen = (k) =>
        left[k] === counts[k]
          ? `${counts[k]}`
          : `${counts[k]} (${left[k]} new)`;
      // A quote or reply that came back with no text (`wordless`) has
      // nothing to read, like a like.
      const noWords = out.noText + (out.wordless ?? 0);
      const lines = [
        `Read ${out.total - noWords - out.remaining} of the ${out.total} accounts on ${cmd.code}.`,
        '',
        `Hostile: ${seen('hostile')}  (aimed at a person)`,
        `Arguing: ${seen('arguing')}  (aimed at the argument)`,
        `Neutral: ${seen('neutral')}`,
        `No words: ${noWords}  (likes, reposts and posts with no text carry nothing to read)`,
        ...(out.gone ? [`Deleted or hidden: ${out.gone}`] : []),
        ...(out.secondWave
          ? [
              `Second reader (${shortModel(out.secondWave.model)}): re-read ${out.secondWave.read} flagged as possibly hostile, changed ${out.secondWave.overturned}.`,
            ]
          : []),
      ];
      // Reads that failed are said apart from what is simply left, with the
      // reason, so an outage does not read as "send it again".
      const failedReads = failedReadsOf(out);
      if (failedReads) lines.push(failedReadsLine(failedReads, out.error));
      if (out.remaining) {
        lines.push(
          '',
          !out.labelled && out.failed
            ? `Nothing was read. Send "triage ${cmd.code}" again once that is fixed.`
            : `${out.remaining} left. Send "triage ${cmd.code}" again.`,
        );
      }
      lines.push(
        '',
        'This is a model reading posts, not a band. Their own words are kept next to each label, so read before you approve.',
        '',
        `Read them with their words: review ${cmd.code} hostile`,
      );
      const choices = [];
      if (left.hostile) {
        choices.push({
          label: `Show me some of the ${left.hostile} hostile ones and what they said`,
          command: `review ${cmd.code} hostile`,
        });
        choices.push({
          label: `Add the ${left.hostile} hostile ones`,
          command: `approve ${cmd.code} hostile${asOfToken(hostileAsOf)}`,
        });
      }
      if (out.remaining) {
        choices.push({
          label: `Keep reading the other ${out.remaining}`,
          command: `triage ${cmd.code}`,
        });
      }
      choices.push({ label: 'Do nothing', command: `cancel ${cmd.code}` });
      return say(lines.join('\n'), choices);
    }

    // A cancel takes nobody off the list. The reply says how many of the
    // plan's adds are still on it, and offers to take them back.
    if (cmd.action === 'cancel') {
      const out = await cancelPlan(plan);
      return say(
        out.message,
        out.live
          ? [
              {
                label: `Take the ${out.live} back off`,
                command: `undo ${cmd.code}`,
              },
            ]
          : null,
        'done',
      );
    }

    // A label review prints the words: a label nobody can check is only a
    // model's opinion.
    if (cmd.action === 'review' && cmd.labels?.length) {
      const label = cmd.labels[0];
      // Read before the review counts, so a label given after the count is
      // past the bound.
      const asOf = await newestLabelAt(plan, label);
      const out = await reviewTriage(plan, label);
      if (!out.total)
        return say(`Nothing in ${cmd.code} was read as ${label}.`);
      if (!out.pending) {
        // Not always "all added": PROTECTED rows are never added, and someone
        // already on the list through another plan, or taken back off, is not
        // added again by approving this.
        const record = { label: 'Show me the record', command: 'history' };
        return say(
          out.added === out.total
            ? `All ${out.added} read as ${label} are already on the list.`
            : `Nothing read as ${label} is left to add. ${out.added} of the ${out.total} are on the list through this plan; the rest are PROTECTED, were already on it, or were taken back off.`,
          out.added
            ? [
                {
                  label: undoLabel(cmd.code, out.added, await liveAdds(plan), {
                    few: 'Take them back off',
                    all: 'Take back everything plan',
                  }),
                  command: `undo ${cmd.code}`,
                },
                record,
              ]
            : [record],
        );
      }
      // A stranger's words, on one line and with their double quotes made
      // single, so a quote cannot close its row and write one that looks
      // like the bot's. Read back as history, each row's quote is fenced
      // (fenceStrangers).
      const lines = out.rows.map((r) => quoteRow(r.band, r.triage_quote));
      // Hundreds of quotes do not get read in a DM. This is a spot check on
      // the labelling before a bulk action, and the header says so.
      const head =
        `${out.pending} read as ${label} and not yet on the list` +
        (out.added ? `, ${out.added} already added` : '') +
        `. Here are ${out.rows.length}, most connected first, as a spot check.`;
      const choices = [
        {
          label: `Add all ${out.pending}`,
          command: `approve ${cmd.code} ${label}${asOfToken(asOf)}`,
        },
        { label: 'Do nothing', command: `cancel ${cmd.code}` },
      ];
      return say(`${head}\n\n${lines.join('\n\n')}`, choices);
    }

    if (cmd.action === 'review') {
      const review = await reviewPlan(plan, { bands: cmd.bands });
      if (!review.total)
        return say('Nothing in this plan needs a look. It is all UNKNOWN.');
      return renderReview(plan, review, { bands: cmd.bands });
    }

    // The personal path: named accounts the sender read and decided on.
    // Every approval keeps the words that asked for it in the plan's note.
    if (cmd.actors?.length) {
      const out = await applyPlanToActors(writeAgent, plan, cmd.actors, {
        reason: cmd.raw,
      });
      return say(out.message, null, planOutcome(out, addedOrRecorded(out)));
    }
    // Narrowed to the bands and the label time the command names, when it
    // names them: a watch digest's 👍 adds what the digest counted.
    if (cmd.labels?.length) {
      const out = await applyPlanToTriage(writeAgent, plan, cmd.labels[0], {
        bands: cmd.bands,
        asOf: cmd.asOf,
        reason: cmd.raw,
      });
      return say(
        out.message,
        addedOrRecorded(out)
          ? [
              {
                label: undoLabel(cmd.code, addedOrRecorded(out), out.live),
                command: `undo ${cmd.code}`,
              },
              { label: 'Show me the record', command: 'history' },
            ]
          : null,
        planOutcome(out, addedOrRecorded(out)),
      );
    }

    // An engagement kind on its own means every band but PROTECTED: "the
    // likers" is a claim about what they did, not about who they are.
    const bands = cmd.bands.length
      ? cmd.bands
      : cmd.kinds?.length
        ? ALL_BANDS
        : [];
    if (!bands.length) {
      return say(
        `Name the bands, like "approve ${cmd.code} UNKNOWN", or name the accounts. PROTECTED is never carried.`,
      );
    }
    const out = await applyPlan(writeAgent, plan, bands, {
      kinds: cmd.kinds?.length ? cmd.kinds : null,
      reason: cmd.raw,
    });
    // Offer the way back with the receipt, while the code is still in front of
    // them. An undo you have to go and look up is one you will not use.
    return say(
      out.message,
      addedOrRecorded(out)
        ? [
            {
              label: undoLabel(
                shortCode(plan.id),
                addedOrRecorded(out),
                out.live,
              ),
              command: `undo ${shortCode(plan.id)}`,
            },
            { label: 'Show me the record', command: 'history' },
          ]
        : null,
      planOutcome(out, addedOrRecorded(out)),
    );
  }

  // Wording that might not mean the attached post's author. Name the author,
  // show what the gate knows about them, and let the sender choose, rather
  // than refuse or guess. The writes on offer carry the DID read from the
  // post, so a handle that changes hands before the answer cannot redirect
  // them.
  if (cmd.fromPost && cmd.confirm) {
    // A lookup that failed (the AppView did not answer) is said as that, not
    // as an author who does not exist.
    let found = null;
    try {
      found = lookUp ? await lookUp(cmd.actor) : null;
    } catch (err) {
      return say(
        `That lookup failed: ${String(err?.message || err).slice(0, 200)}`,
        null,
        'failed',
      );
    }
    if (!found) {
      return say(
        'I could not resolve the author of that post.',
        null,
        'failed',
      );
    }
    const did = found.did || cmd.actor;
    const handle = nameOf(found, did);
    const choices = [
      ...(cmd.action === 'list_add' && !found.protectedReason
        ? [
            {
              label: `Add ${handle} to the list`,
              command: `list add ${did}`,
            },
          ]
        : []),
      ...(cmd.action === 'list_remove'
        ? [
            {
              label: `Remove ${handle} from the list`,
              command: `list remove ${did}`,
            },
          ]
        : []),
      // Reading needs a model, as help and the other menus say.
      ...(modelsEnabled()
        ? [
            {
              label: `Read ${handle}'s recent posts first`,
              command: `read ${handle}`,
            },
          ]
        : []),
    ];
    const body = renderReport(found, { template: reportTemplate });
    return say(
      `That post is by ${handle}, but "${cmd.raw}" might mean someone else, so I have not acted.\n\n${body}`,
      choices,
    );
  }

  // The write takes the actor as parsed. For an attached post that is the
  // DID in its URI, which a receipt nobody can check would show, so the reply
  // names the account by its handle and says whose post it was, and a sender
  // who meant the author of a quoted post sees the mistake at once. The
  // handle is for reading only: it can fail to verify or pass to someone
  // else, and the DID cannot.
  const byDid = /^did:/.test(String(cmd.actor));
  const account =
    cmd.fromPost && lookUp ? await lookUp(cmd.actor).catch(() => null) : null;

  const out = await applyCommand(writeAgent, cmd.action, cmd.actor, {
    raw: cmd.raw,
    lookUp,
  });

  const at = byDid
    ? nameOf(account || out.account, cmd.actor)
    : `@${String(cmd.actor).replace(/^@/, '')}`;
  const preface = cmd.fromPost ? `That post is by ${at}.\n\n` : '';
  const message = byDid
    ? out.message.replaceAll(cmd.actor, at)
    : out.message;

  // The way back, and the way to look closer, offered with the receipt. The
  // way back names this account by DID, so it takes off exactly this one
  // whatever else was added since, and it is offered only when the block put
  // them on the list.
  const after =
    out.ok && cmd.action === 'list_add'
      ? [
          ...(out.changed && out.did
            ? [{ label: 'Undo that', command: `list remove ${out.did}` }]
            : []),
          ...(modelsEnabled()
            ? [{ label: `Read ${at}'s recent posts`, command: `read ${at}` }]
            : []),
        ]
      : null;
  // A refusal by design (PROTECTED, or the owner's or the bot's own account)
  // changed nothing and did not fail. A block that went on the list counts as
  // done even when the log missed it.
  const refused =
    Boolean(out.vetoed) ||
    (cmd.action === 'list_add' &&
      [OWNER_DID, writeAgent.session?.did].includes(out.did));
  const outcome = out.ok
    ? out.changed || (out.already && cmd.action === 'list_add')
      ? 'done'
      : null
    : refused
      ? null
      : 'failed';
  return say(preface + message, after, outcome);
}

/**
 * The conversation so far, as model turns. Bluesky stores it already, so this
 * needs no state of our own, and it is per convo so two threads do not bleed
 * into each other.
 */
async function readHistory(chat, entry, { botDid, limits }) {
  try {
    const page = await chat.chat.bsky.convo.getMessages({
      convoId: entry.convoId,
      limit: 40,
    });
    // The asker, who is not always the owner. Labelling a guest's own
    // messages as someone else's makes the model read the conversation as
    // one it watched rather than one it is in.
    const asker = entry.message?.sender?.did ?? OWNER_DID;
    // The asker's messages as composeMessage gives them to the model, so a
    // post shared as an embed in an earlier turn is still named in history.
    const messages = (page.data.messages || []).map((m) =>
      m?.sender?.did === asker && typeof m.text === 'string'
        ? { ...m, text: composeMessage(m) }
        : m,
    );
    const turns = historyFrom(messages, {
      selfDid: asker,
      botDid,
      beforeId: entry.message.id,
      maxTurns: limits.maxTurns,
      maxAgeMs: limits.historyHours ? limits.historyHours * 3600_000 : null,
    });
    // The bot's messages come back in its own role, so what strangers wrote
    // in them is fenced here, before any model reads them as its own words.
    return turns.map((t) =>
      t.role === 'assistant' ? { ...t, content: fenceStrangers(t.content) } : t,
    );
  } catch {
    // A conversation we cannot read is still a question we can answer,
    // without context. A reply that misses a reference beats silence.
    return [];
  }
}

/** Markdown emphasis and headings, removed. */
export function plainText(text) {
  return String(text ?? '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '');
}

/**
 * Send the reply to a change that went through.
 *
 * A send that fails is logged rather than thrown, so the message still gets
 * its ✅: the list moved, and a ❌ with no reply invites the same command
 * again, which for a bare "undo" takes off the batch before.
 *
 * @returns {Promise<string[]|null>} the sent message ids, or null when the
 *   reply did not go, so a menu it carried is not stored
 */
async function sendReceipt(send, text, { allow, log = () => {} } = {}) {
  try {
    return await send(text, { allow });
  } catch (err) {
    log('A change went through but its reply was not sent', {
      err: String(err?.message || err),
    });
    return null;
  }
}

/** How long an agent turn runs before it says it is working on it. */
const AGENT_ACK_AFTER_MS = 5000;

/**
 * One message, answered by the agent.
 *
 * The 👀 on the sender's message is the ack. The text ack on a timer is only
 * for when that reaction did not land, so a long turn does not read as broken
 * and a short one costs no extra message.
 *
 * @returns {Promise<object>} the turn record, with `outcome`: 'done' when the
 *   list changed, 'failed' when the turn failed, null for an answer.
 */
async function answerAsAgent({
  entry,
  chat,
  send,
  getIo,
  extraTools,
  config,
  limits,
  model,
  triageModel,
  writeAgent,
  canWrite,
  botDid,
  roster,
  generate,
  openers,
  escalate = false,
  acked = false,
  log,
}) {
  const sender = entry.message?.sender?.did;
  const began = Date.now();
  let spoke = null;
  const timer = acked
    ? null
    : setTimeout(() => {
        spoke = send(ackFor({ action: 'think' }, { openers })).catch(() => {});
      }, AGENT_ACK_AFTER_MS);
  if (timer?.unref) timer.unref();

  // The timer is cleared however the turn ends, and an ack already on its
  // way goes before anything else is sent, a failure's reply included.
  let reply;
  try {
    // Notes steer writes, and they can hold what the owner would tell nobody
    // else, so a read-only guest's turn goes without them.
    const [io, history, remembered, notes] = await Promise.all([
      getIo(),
      readHistory(chat, entry, { botDid, limits }),
      lastPost(entry.convoId),
      canWrite ? listNotes().catch(() => []) : [],
    ]);

    // History is read as text, so a post shared three messages ago is gone
    // from it. Name the last one here, as derived fact from the sender's own
    // messages, so "add the quoters too" has something to point at.
    let message = composeMessage(entry.message);
    if (remembered && !message.includes(remembered)) {
      message += `\n\n[The post last sent in this conversation: ${remembered}]`;
    }

    reply = await operate({
      generate,
      message,
      io,
      history,
      model,
      triageModel,
      extraTools,
      canWrite,
      writeAgent,
      asker:
        sender === roster.owner
          ? 'the owner, who owns the list'
          : `${sender}, a ${canWrite ? 'guest who may change the list' : 'read-only guest'}`,
      voice: config?.style,
      guidance: config?.guidance,
      raw: entry.message.text,
      reviewRows: limits.reviewRows,
      escalate,
      notes: notesBlock(notes, { owner: roster.owner }),
      convoId: entry.convoId,
      sendProgress: async (text) => {
        clearTimeout(timer);
        await spoke;
        spoke = send(text).catch(() => {});
        await spoke;
      },
      log,
    });
  } finally {
    clearTimeout(timer);
    await spoke;
  }

  // A DM renders no markdown, and some models write it anyway. Emphasis and
  // headings are removed; anything else is left as written.
  let text = plainText(reply.text) || fallbackText(reply);
  // Said only when the escalation model answered because something went
  // wrong (a stall, a failure, an empty answer). A hand-off the first model
  // chose, or a "^" the sender typed, needs no footnote.
  if (reply.escalated?.kind === 'failure') {
    text += `\n\n(${shortModel(reply.escalated.model)} answered this: ${reply.escalated.reason})`;
  }
  // A question a thumbs-up can answer: the line is written by code from what
  // was stored, so what the sender agrees to is what runs.
  const asked = reply.pending || [];
  if (asked.length) {
    text += `\n\n${confirmLine(asked.map((p) => p.describe))}`;
  }
  const allow = [...reply.links];
  // A digest's markers become links here, exactly as on the classic path, so
  // a post the model invented resolves to nothing. No follow-up menu: this
  // mode does not offer numbered options.
  const ranPulse = reply.pulses?.[reply.pulses.length - 1] ?? null;
  if (ranPulse && reply.text) {
    const resolved = citationsIn(text, ranPulse.sample ?? []);
    text = resolved.text;
    allow.push(...resolved.cited.map((c) => c.url));
    if (resolved.cited.length) {
      text += `\n\n${renderCitations(resolved.cited)}`;
    }
  }

  // A turn that changed the list keeps its ✅ when only the reply failed. A
  // question that was not sent is not stored, so no "yes" can answer it.
  const sentIds = reply.actions.length
    ? await sendReceipt(send, text, { allow, log })
    : await send(text, { allow });
  if (asked.length && sentIds) {
    await savePending(entry.convoId, {
      commands: asked.flatMap((p) => p.commands),
      describe: asked.map((p) => p.describe).join('; '),
      messageIds: sentIds,
    }).catch((err) =>
      log('Could not store the question', { err: String(err?.message || err) }),
    );
  }

  // One row per model and kind (first wave, escalation, write check), so
  // spend can be told apart by model.
  const usageRows = (reply.usages || [])
    .filter((u) => u.inputTokens || u.outputTokens)
    .map((u) => ({
      kind: u.kind,
      model: u.model,
      input_tokens: u.inputTokens ?? null,
      output_tokens: u.outputTokens ?? null,
    }));
  if (usageRows.length) await upsert('llm_usage', usageRows).catch(() => {});

  const tookMs = Date.now() - began;
  log(reply.ok ? 'Answered as the agent' : 'Agent turn failed', {
    convoId: entry.convoId,
    steps: reply.steps,
    secs: Math.round(tookMs / 1000),
    ...(reply.escalated
      ? { steppedUp: `${reply.escalated.model}: ${reply.escalated.reason}` }
      : {}),
    // Step by step, only when there is something to explain. The first
    // wave's own steps are on the "Stepping up" line.
    ...(tookMs > 30_000 || !reply.ok || reply.escalated
      ? { trace: reply.trace?.join(' › ') || 'no steps' }
      : {}),
    checks: reply.checks?.length
      ? reply.checks
          .map(
            (c) =>
              `${c.allow ? 'ok' : 'stopped'}@${c.p == null ? '-' : c.p.toFixed(2)}`,
          )
          .join(' ')
      : 'none',
    actions: reply.actions.length ? reply.actions.join('; ') : 'none',
    ...(asked.length ? { asked: asked.map((p) => p.describe).join('; ') } : {}),
    ...(reply.ok ? {} : { err: String(reply.error?.message || reply.error) }),
  });
  return {
    convoId: entry.convoId,
    agent: true,
    steps: reply.steps,
    actions: reply.actions.length,
    outcome: !reply.ok ? 'failed' : reply.actions.length ? 'done' : null,
  };
}

/** Keyed options a card offered, while they are live, or null. */
async function readCardChoices(convoId) {
  const rows = await select('dm_choice', {
    select: 'options',
    eq: { convo_id: convoId },
  }).catch(() => []);
  const row = rows?.[0];
  if (!row?.options?.length || !row.options.every((o) => o.key)) return null;
  return liveOptions(row);
}

/** Bands a quick block calls out rather than doing quietly. */
const LOUD_BANDS = new Set(['CONNECTED', 'NOTABLE']);

/**
 * The quick lane: "block" or "unblock" with one target, no model.
 *
 * Quiet when there is nothing to say: a ✅ on the sender's message and a line
 * in the burst summary. Out loud when there is: PROTECTED, a CONNECTED or
 * NOTABLE account (done, but worth knowing), an unblock of someone who was
 * not on the list, or a failure.
 */
async function runQuick(quick, { writeAgent, getIo, convoId, send, log }) {
  let out;
  try {
    out = await applyCommand(writeAgent, quick.action, quick.actor, {
      raw: quick.raw,
      lookUp: async (a) => (await getIo()).lookUp(a),
      via: 'command',
    });
  } catch (err) {
    await send(`That failed: ${String(err?.message || err).slice(0, 200)}`);
    return { outcome: 'failed', quick: quick.action };
  }
  const a = out.account;
  // How the replies name the account, and the "unblock" they suggest: by
  // handle while it verifies, by DID otherwise.
  const at = nameOf(a, String(quick.actor));
  log('Quick lane', {
    action: quick.action,
    actor: at,
    ok: out.ok,
    changed: Boolean(out.changed),
    band: a?.band ?? '-',
  });
  if (!out.ok) {
    await send(out.message.replace(String(quick.actor), at));
    return { outcome: 'failed', quick: quick.action };
  }
  // Done, but the decision log missed it, so undo and history will not find
  // it. Said out loud with the way back, not left to a ✅.
  if (out.changed && out.logged === false) {
    await sendReceipt(send, out.message.split(String(quick.actor)).join(at), {
      log,
    });
    return { outcome: 'done', quick: quick.action };
  }
  const adding = quick.action === 'list_add';
  if (adding && out.changed && a && LOUD_BANDS.has(a.band)) {
    const why = [
      a.band,
      a.vouches ? `followed by ${a.vouches} people you follow` : null,
      a.followers ? `${a.followers.toLocaleString('en-US')} followers` : null,
    ].filter(Boolean);
    await sendReceipt(
      send,
      `Blocked ${at}. Worth knowing: ${why.join(', ')}. "unblock ${at}" takes it back.`,
      { log },
    );
    return { outcome: 'done', quick: quick.action };
  }
  if (!adding && out.already) {
    await send(`${at} was not on the list.`);
    return { outcome: null, quick: quick.action };
  }
  noteQuiet(convoId, {
    action: quick.action,
    handle: at.replace(/^@/, ''),
    already: Boolean(out.already),
    blocksYou: Boolean(a?.blocksYou),
  });
  return { outcome: 'done', quick: quick.action };
}

/**
 * Posts per round of a card's "hostile": one wave of single-post calls, so a
 * round holds the shared job queue no longer than one batched wave does.
 */
const HOSTILE_PER_ROUND = CONCURRENCY;

/**
 * "hostile" on a card: read the replies and quotes, then add the hostile.
 *
 * Nobody reads the quotes before this adds, so each post gets a model call of
 * its own, as on an auto watch, and a post that talks to the model can sway no
 * label but its own. Three rounds at most; anything still unread is said, so
 * the counts are not taken for the whole post. Anyone CONNECTED or NOTABLE is
 * held, as a watch holds them, and `ask` puts them to the owner as a 👍.
 */
async function runHostile(code, { writeAgent, generate, model, log }) {
  if (!(modelsEnabled() && model)) {
    return { text: NO_MODEL_TO_SORT, outcome: 'failed' };
  }
  const plan = await findPlan(code);
  if (!plan) return { text: `No plan with code ${code}.`, outcome: 'failed' };
  let out = null;
  // A round that labels nothing is failing, and another would fail the same.
  for (let round = 0; round < 3; round += 1) {
    out = await runTriage(plan, {
      generate,
      model,
      log,
      perCall: 1,
      perRun: HOSTILE_PER_ROUND,
    });
    if (!out.remaining || !out.labelled) break;
  }
  // From the last round only. A round reads the lowest unlabelled posts, so
  // it reads again every post the round before could not, and its count and
  // reason are the posts still unread after all of them.
  const failedReads = failedReadsOf(out);
  const added = await applyPlanToTriage(writeAgent, plan, 'hostile', {
    reason: `hostile ${code}`,
    skipBands: HELD_BANDS,
  });
  const held = await heldFor(plan, code);
  const c = out?.counts || {};
  const unread = out?.remaining
    ? ` ${out.remaining} not read yet; "triage ${code}" reads them.`
    : '';
  const failedLine = failedReads
    ? ` ${failedReadsLine(failedReads, out?.error)}`
    : '';
  return {
    text:
      `Read the replies and quotes on ${code}: ${c.hostile || 0} hostile, ${c.arguing || 0} arguing, ${c.neutral || 0} neutral.${failedLine}${unread} ${added.message}${held?.line ?? ''}`,
    // Reads that failed with nobody added is a failure, not nothing to do.
    outcome:
      planOutcome(added, addedOrRecorded(added)) ??
      (failedReads ? 'failed' : null),
    ask: held?.ask ?? null,
  };
}

/**
 * The accounts read as hostile that a label approval held back, as a line
 * for the reply and a 👍 question bounded to what was counted, or null.
 */
async function heldFor(plan, code) {
  const held = await countDecisions(plan, {
    label: 'hostile',
    bands: CLOSE_BANDS,
  });
  if (!held) return null;
  const asOf = await newestLabelAt(plan, 'hostile');
  return {
    line: ` Held ${held} close to you (connected or notable) for your OK.`,
    ask: {
      commands: [
        `approve ${code} hostile ${CLOSE_BANDS.join(',')}${asOfToken(asOf)}`,
      ],
      describe: `add the ${held} close to you read as hostile from plan ${code}`,
    },
  };
}

/**
 * Run a stored question's commands, as a "yes" or a 👍 asked.
 *
 * Classic commands through runCommand, so the vetoes and the log are the ones
 * a typed command gets; "watch <post> [<n>h] [auto]" and "hostile <code>" are
 * the two that are not commands anyone types.
 *
 * `failed` when any command failed or could not be read (a stored approval
 * the parser refuses is one), and `changed` when any changed something, each
 * from what the command returned rather than its words.
 */
async function runPending(
  pending,
  { writeAgent, getIo, convoId, generate, model, log },
) {
  const lines = [];
  const asks = [];
  let failed = false;
  let changed = false;
  for (const command of pending.commands || []) {
    try {
      const watch = /^watch\s+(\S+)(?:\s+(\d+)h)?(\s+auto)?\s*$/i.exec(command);
      if (watch) {
        const hours = Number(watch[2] || 24);
        const auto = Boolean(watch[3]);
        const out = await startWatch({
          convoId,
          target: watch[1],
          hours,
          auto,
        });
        lines.push(
          `${out.extended ? 'Still watching' : 'Watching'} it for ${hours}h${auto ? ', blocking the hostile ones as they come' : ''}. I'll send an update each hour there's something new.`,
        );
        changed = true;
        continue;
      }
      const hostile = /^hostile\s+([0-9a-f]{8})$/i.exec(command);
      if (hostile) {
        const out = await runHostile(hostile[1], {
          writeAgent,
          generate,
          model,
          log,
        });
        lines.push(out.text);
        if (out.ask) asks.push(out.ask);
        failed ||= out.outcome === 'failed';
        changed ||= out.outcome === 'done';
        continue;
      }
      const cmd = parseCommand(command);
      if (!cmd) {
        lines.push(`I could not run "${command}".`);
        failed = true;
        continue;
      }
      const reply = await runCommand(cmd, writeAgent, {
        lookUp: async (a) => (await getIo()).lookUp(a),
        canWrite: true,
        generate,
        model,
        log,
      });
      lines.push(reply.text);
      failed ||= Boolean(cmd.needsTarget) || reply.outcome === 'failed';
      changed ||= reply.outcome === 'done';
    } catch (err) {
      lines.push(`That failed: ${String(err?.message || err).slice(0, 200)}`);
      failed = true;
    }
  }
  return { text: lines.join('\n\n'), failed, changed, asks };
}

/** The reaction a run of stored commands earns: a failure outranks a change. */
const pendingOutcome = (out) =>
  out.failed ? 'failed' : out.changed ? 'done' : null;

/**
 * Send what a run of stored commands said, as a receipt when it changed the
 * list, with any question it raised written by code and stored against the
 * message, so a 👍 on it runs exactly that.
 */
async function sendRun(send, convoId, out, { log }) {
  const asks = out.asks || [];
  const text = asks.length
    ? `${out.text}\n\n${confirmLine(asks.map((a) => a.describe))}`
    : out.text;
  const ids =
    pendingOutcome(out) === 'done'
      ? await sendReceipt(send, text, { log })
      : await send(text);
  if (asks.length && ids) {
    await savePending(convoId, {
      commands: asks.flatMap((a) => a.commands),
      describe: asks.map((a) => a.describe).join('; '),
      messageIds: ids,
    }).catch((err) =>
      log('Could not store the question', { err: String(err?.message || err) }),
    );
  }
}

/** What a yes gets when no question is open. */
const NOTHING_TO_CONFIRM =
  'Nothing is waiting for a yes. A question lapses after 30 minutes, or once you send something else, so say what you want done.';

/** What classic mode says to a memory command. */
const NOTES_NEED_AGENT_MODE =
  'Notes only work in agent mode (MOD_DM_MODE=agent). In classic mode nothing reads them, so I have not saved or changed anything.';

/** What classic mode says to a watch asked to block. */
const AUTO_WATCH_NEEDS_AGENT_MODE =
  'A watch that blocks as it goes runs only in agent mode (MOD_DM_MODE=agent), so I have not started one. "watch this" on its own reads new quotes and replies and reports what came in.';

/**
 * Memory and watch commands from a sender who may write, in either mode.
 *
 * Classic mode answers two of them in code instead of running them, rather
 * than letting the analyst claim it did: notes, which only the agent reads,
 * and a watch that blocks as it goes, which would add people on a model's
 * reading with no approval typed in classic. "!" in agent mode is agent mode,
 * so both run there. With no model no watch starts, in either mode: nothing
 * would read the post, so it would never report.
 *
 * @returns {Promise<object|null>} the turn record, or null when the message
 *   is neither
 */
async function standingCommand({
  text,
  entry,
  embedUri,
  msgLinks,
  mode,
  hasModel,
  owner,
  send,
  log,
}) {
  const convoId = entry.convoId;

  const memo = parseMemoryCommand(text);
  if (memo) {
    if (mode !== 'agent') {
      await send(NOTES_NEED_AGENT_MODE);
      return { convoId, memory: memo.action, outcome: null };
    }
    const out =
      memo.action === 'recall'
        ? { ok: true, message: recallText(await listNotes(), { owner }) }
        : memo.action === 'remember'
          ? await remember(memo.text, {
              author: entry.message?.sender?.did,
              owner,
            })
          : await forget(memo);
    await send(out.message);
    log('Memory', { action: memo.action, ok: out.ok });
    return {
      convoId,
      memory: memo.action,
      outcome: out.ok && memo.action !== 'recall' ? 'done' : null,
    };
  }

  // The shared record of any kind, not only a post: "stop watching" with a
  // list or a feed attached then matches no watch, where dropping it would
  // stop the newest one. "watch" still takes only a post.
  const watching = parseWatchCommand(text, {
    embedUri: sharedRecordUri(entry.message) || embedUri,
    links: msgLinks,
  });
  if (!watching) return null;
  if (watching.action === 'watches') {
    const live = await liveWatches();
    await send(watchesText(live), {
      allow: live.map((w) => postWebUrl(w.uri)),
    });
    return { convoId, watch: 'list', outcome: null };
  }
  if (watching.action === 'unwatch') {
    const stopped = await stopWatch({ target: watching.target });
    await send(
      stopped
        ? `Stopped watching ${postWebUrl(stopped.uri) || stopped.uri}.`
        : 'I was not watching that.',
      { allow: stopped ? [postWebUrl(stopped.uri)] : [] },
    );
    return { convoId, watch: 'stop', outcome: stopped ? 'done' : null };
  }
  if (!hasModel) {
    await send(NO_MODEL);
    return { convoId, watch: 'no-model', outcome: null };
  }
  if (watching.auto && mode !== 'agent') {
    await send(AUTO_WATCH_NEEDS_AGENT_MODE);
    return { convoId, watch: 'refused', outcome: null };
  }
  const target = watching.target || (await lastPost(convoId));
  if (!target) {
    await send('Which post? Send it with "watch this", or paste its link.');
    return { convoId, watch: 'ask', outcome: null };
  }
  const out = await startWatch({
    convoId,
    target,
    hours: watching.hours,
    auto: watching.auto,
  });
  await send(
    `${out.extended ? 'Still watching' : 'Watching'} it for ${watching.hours}h. ` +
      (watching.auto
        ? `I'll block what ${escalationEnabled() ? 'two models read' : 'the model reads'} as hostile in new quotes and replies, hold anyone CONNECTED or NOTABLE for you, and `
        : "I'll read new quotes and replies as they come and ") +
      'send an update each hour there is something new. "stop watching" ends it.',
  );
  log('Started a watch', {
    uri: out.watch.uri,
    hours: watching.hours,
    auto: watching.auto,
  });
  return { convoId, watch: 'start', outcome: 'done' };
}

/**
 * Everything agent mode answers without a model: the quick lane, memory, watch
 * commands, a card's words, and a bare post. null means the agent's.
 */
async function withoutModel({
  text,
  entry,
  embedUri,
  msgLinks,
  mentions,
  canWrite,
  owner,
  config,
  send,
  writeAgent,
  getIo,
  generate,
  model,
  log,
}) {
  const convoId = entry.convoId;
  const ctx = { writeAgent, getIo, convoId, send, generate, model, log };

  if (canWrite && writeAgent) {
    const quick = parseQuick(text, {
      embedUri,
      links: msgLinks,
      mentions,
    });
    if (quick) return { convoId, ...(await runQuick(quick, ctx)) };

    const standing = await standingCommand({
      text,
      entry,
      embedUri,
      msgLinks,
      mode: 'agent',
      hasModel: Boolean(model) && modelsEnabled(),
      owner,
      send,
      log,
    });
    if (standing) return standing;

    const offered = await readCardChoices(convoId);
    if (offered) {
      const keys = parseCardWords(
        text,
        offered.map((o) => o.key),
      );
      if (keys) {
        const picked = keys.map((k) => offered.find((o) => o.key === k));
        await clearChoices(convoId);
        const out = await runPending(
          { commands: picked.map((o) => o.command) },
          ctx,
        );
        const outcome = pendingOutcome(out);
        await sendRun(send, convoId, out, { log });
        log('Answered a card', { keys: keys.join(','), ok: !out.failed });
        return { convoId, card: keys.join(','), outcome };
      }
    }
  }

  // A post with no words. The card, or (with "barePost": "author" in the
  // config file) a block of whoever wrote it, through the quick lane.
  const post = parsePostScan(text, { embedUri, links: msgLinks });
  if (post) {
    if (config?.barePost === 'author' && canWrite && writeAgent) {
      const actor = post.startsWith('at://')
        ? authorOf(post)
        : parseActor(post);
      if (actor) {
        return {
          convoId,
          ...(await runQuick(
            {
              action: 'list_add',
              actor,
              fromPost: true,
              raw: text || '(post)',
            },
            ctx,
          )),
        };
      }
    }
    try {
      const plan = await proposePlan({ link: post, kind: 'everyone' });
      const options = canWrite ? cardChoices(plan) : [];
      await send(renderCard(plan, { choices: options }));
      await offerChoices(convoId, options, plan.uri);
      log('Sent a post card', { uri: plan.uri, code: plan.code });
      return { convoId, card: plan.code, outcome: null };
    } catch (err) {
      await send(
        `That scan failed: ${String(err?.message || err).slice(0, 200)}`,
      );
      return { convoId, card: 'failed', outcome: 'failed' };
    }
  }
  return null;
}

/** Send the summaries of bursts that have gone quiet. */
async function flushSummaries(chat, { log = () => {} } = {}) {
  for (const burst of takeDueSummaries()) {
    try {
      await clearChoices(burst.convoId);
      await chat.chat.bsky.convo.sendMessage({
        convoId: burst.convoId,
        message: { text: summaryText(burst) },
      });
      log('Sent a burst summary', {
        convoId: burst.convoId,
        items: burst.items.length,
      });
    } catch (err) {
      log('Could not send a burst summary', {
        err: String(err?.message || err),
      });
    }
  }
}

/**
 * Whether each conversation is one to one, by convo id. A conversation never
 * changes kind, so each one is asked about once per process.
 */
const convoKinds = new Map();

/**
 * How long a conversation that cannot be read holds up the pass. Past this
 * its messages are passed over, so one conversation the chat service will not
 * describe cannot keep the bot from answering every other one for good.
 */
const UNREAD_HOLD_MS = 10 * 60_000;

/** When each conversation that cannot be read first failed, by convo id. */
const unreadSince = new Map();

/** For tests. */
export function resetConvoKinds() {
  convoKinds.clear();
  unreadSince.clear();
}

/**
 * The conversations among these log entries that the bot answers in: one to
 * one only.
 *
 * Everything a conversation holds (the menu, a stored question, the post last
 * sent, the history a model reads) is kept per conversation, not per member,
 * and every member of a group reads every reply. In a group, one member could
 * answer or steer for another, and members off the roster would read what
 * the bot says about the owner's graph. A server that leaves out the kind is
 * taken at its member count.
 *
 * A conversation that cannot be read is `held`: the pass stops before its
 * first message and the next pass asks again, so a request in it is not
 * passed over. After UNREAD_HOLD_MS of failing it is no longer held, and its
 * messages go unanswered.
 *
 * @returns {Promise<{ direct: Set<string>, held: Set<string> }>}
 */
async function directConvos(chat, entries, { log = () => {} } = {}) {
  const out = new Set();
  const held = new Set();
  for (const convoId of new Set(entries.map((e) => e.convoId))) {
    if (!convoKinds.has(convoId)) {
      try {
        const res = await chat.chat.bsky.convo.getConvo({ convoId });
        const convo = res?.data?.convo;
        if (!convo) throw new Error('the reply held no conversation');
        const kind = convo.kind?.$type;
        const direct = kind
          ? kind === 'chat.bsky.convo.defs#directConvo'
          : convo.members?.length === 2;
        convoKinds.set(convoId, direct);
        unreadSince.delete(convoId);
        if (!direct) log('Not answering a group conversation', { convoId });
      } catch (err) {
        // Logged when the wait starts and when it ends, not on every poll.
        const fields = { convoId, err: String(err?.message || err) };
        if (!unreadSince.has(convoId)) {
          unreadSince.set(convoId, Date.now());
          log(
            'Could not read a conversation; its messages wait until it can be',
            fields,
          );
        }
        if (Date.now() - unreadSince.get(convoId) < UNREAD_HOLD_MS) {
          held.add(convoId);
        } else {
          // A later failure in this conversation waits afresh.
          unreadSince.delete(convoId);
          log(
            'Gave up waiting to read a conversation, so its messages are not answered',
            fields,
          );
        }
        continue;
      }
    }
    if (convoKinds.get(convoId)) out.add(convoId);
  }
  return { direct: out, held };
}

/**
 * How many waiting messages one pass answers. Past that the oldest are
 * skipped, and the conversation is told: after an outage, the latest messages
 * are the ones worth answering.
 */
const MAX_BACKLOG = 30;

/** Pages of getLog a cold start reads looking for the end of the log. */
const COLD_START_MAX_PAGES = 50;

/**
 * Set when a cold start stopped at COLD_START_MAX_PAGES before the end of the
 * log. A message sent before then is history, not a request, whichever pass
 * reads it. Held for this process only.
 */
let historyBefore = null;

/** How many skipped messages the notice quotes back. */
const SKIPPED_QUOTED = 10;

/**
 * What the bot says when a backlog was cut at MAX_BACKLOG: the start of each
 * message it skipped, so the sender can tell which to send again. Their own
 * words, in their own one-to-one conversation.
 */
function skippedText(messages) {
  const quote = (m) => {
    const t = String(m.text ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return sharedPostUri(m) ? '(a shared post)' : '(no text)';
    return `"${t.length > 80 ? `${t.slice(0, 80)}…` : t}"`;
  };
  const n = messages.length;
  const lines = messages.slice(0, SKIPPED_QUOTED).map(quote);
  if (n > SKIPPED_QUOTED) lines.push(`and ${n - SKIPPED_QUOTED} more`);
  return [
    `Too many messages were waiting, so I skipped the oldest ${n === 1 ? 'one' : n}:`,
    ...lines,
    'Send again any that still matter.',
  ].join('\n');
}

/**
 * Where the last pass got to: a cursor, null when the log was empty at cold
 * start (so read it from the beginning), or undefined before any pass.
 */
async function readCursor() {
  const rows = await select('dm_cursor', { select: 'cursor', eq: { id: 1 } });
  return rows?.length ? (rows[0].cursor ?? null) : undefined;
}

/**
 * Store the resume point, only when it has moved: the poll runs every couple
 * of seconds and almost never finds anything. The write happens before the
 * message it moves past is handled, which is what makes a crashed turn a
 * dropped message rather than a replayed one.
 */
let lastWritten;

async function writeCursor(cursor) {
  if (cursor === lastWritten) return;
  await upsert('dm_cursor', [
    { id: 1, cursor, updated_at: new Date().toISOString() },
  ]);
  lastWritten = cursor;
}

/**
 * Walk getLog until a page comes back empty and remember where that was,
 * answering nothing.
 *
 * Without this the first run could answer messages sent weeks ago as though
 * they had just arrived. A walk that stops at COLD_START_MAX_PAGES has not
 * reached the end, so it says so, and anything sent before it began is
 * skipped as history when a later pass reads it.
 */
async function seekToTail(chat, { log = () => {} } = {}) {
  const began = Date.now();
  let cursor = null;
  let seen = 0;
  let atEnd = false;
  for (let page = 0; page < COLD_START_MAX_PAGES && !atEnd; page += 1) {
    const res = await chat.chat.bsky.convo.getLog(cursor ? { cursor } : {});
    const entries = res.data.logs || [];
    seen += entries.length;
    if (res.data.cursor) cursor = res.data.cursor;
    atEnd = !entries.length;
  }
  // An empty log can come back with no cursor. Store null for it, so the next
  // pass reads the log from the start and the first message anyone sends is
  // answered rather than skipped as history.
  if (cursor || !seen) await writeCursor(cursor);
  historyBefore = atEnd ? null : began;
  if (atEnd) {
    log('DM cursor initialised at the live tail', { cursor });
  } else {
    log(
      'The DM log is longer than a cold start reads; messages sent before now are skipped as history',
      { cursor, pages: COLD_START_MAX_PAGES },
    );
  }
  return cursor;
}

/**
 * Answer everything roster senders have sent since the stored cursor.
 *
 * @param {object} opts
 * @param {object} opts.chat      an agent proxied to the chat service
 * @param {object} [opts.writeAgent] the unproxied agent, for list commands.
 *   Repo writes must not go through the chat proxy; without this agent,
 *   commands are unavailable rather than misrouted.
 * @param {Function} opts.getIo   async () => tool backends, from makeIo().
 *   A factory, not an object: building it loads the vouch snapshot, and
 *   neither a poll that finds nothing (almost every poll) nor a message that
 *   needs no scores may pay for that, or fail when there is no snapshot yet.
 *   The same laziness lets the snapshot be released while idle.
 * @param {string} [opts.model]
 * @param {string} opts.botDid    the bot account's DID
 * @param {Function} [opts.generate]  injected for tests
 * @returns {Promise<{ answered: number, scanned: number, turns: Array }>}
 */
export async function runDmPass({
  chat,
  writeAgent,
  getIo,
  model = DEFAULT_MODEL,
  botDid,
  roster = rosterFromEnv(process.env, OWNER_DID),
  generate = generateText,
  extraTools = {},
  mode = normaliseMode(process.env.MOD_DM_MODE),
  log = () => {},
}) {
  const cursor = await readCursor();
  if (cursor === undefined) {
    await seekToTail(chat, { log });
    return { answered: 0, scanned: 0, turns: [], coldStart: true };
  }

  const res = await chat.chat.bsky.convo.getLog(cursor ? { cursor } : {});
  // A message moves the cursor to its own rev, so an entry whose rev is the
  // cursor was read before, whether or not the chat service sends it again.
  const entries = (res.data.logs || []).filter(
    (entry) => !(cursor && entry.rev === cursor),
  );

  // A message the bot picked up carries its reaction from then on. When the
  // cursor is behind such a message again, as after a restored backup, a
  // reaction of the bot's on the same page marks it as answered already.
  const pickedUp = new Set(
    entries
      .filter(
        (entry) =>
          entry.$type === 'chat.bsky.convo.defs#logAddReaction' &&
          entry.reaction?.sender?.did === botDid,
      )
      .map((entry) => entry.message?.id),
  );
  const isHistory = (entry) =>
    historyBefore !== null &&
    Date.parse(entry.message?.sentAt) < historyBefore;

  // Never the bot's own messages, even if its DID is on the roster: answering
  // itself would loop forever.
  const fromRoster = entries.filter(
    (entry) =>
      entry.$type === 'chat.bsky.convo.defs#logCreateMessage' &&
      entry.message?.sender?.did !== botDid &&
      roster.answers(entry.message?.sender?.did) &&
      typeof entry.message?.text === 'string',
  );
  const unseen = fromRoster.filter(
    (entry) => !pickedUp.has(entry.message.id) && !isHistory(entry),
  );
  if (unseen.length < fromRoster.length) {
    log('Skipped messages already answered or sent before the DM log was read', {
      answered: fromRoster.filter((e) => pickedUp.has(e.message.id)).length,
      history: fromRoster.filter(isHistory).length,
    });
  }
  // A thumbs-up or thumbs-down from a writer, on one of the bot's own messages.
  // Only one that carries a stored question does anything.
  const rosterReactions = entries.filter(
    (entry) =>
      entry.$type === 'chat.bsky.convo.defs#logAddReaction' &&
      entry.reaction?.sender?.did !== botDid &&
      roster.writes(entry.reaction?.sender?.did) &&
      entry.message?.sender?.did === botDid,
  );

  // One-to-one conversations only, so the roster check above also decides
  // who reads the reply.
  const asked = [...unseen, ...rosterReactions];
  const { direct, held } = await directConvos(chat, asked, { log });
  // The pass stops before the first message in a conversation that could not
  // be read, and the cursor goes no further than the entry before it, so the
  // next pass reads that message again.
  const stop = entries.findIndex(
    (e) => held.has(e.convoId) && asked.includes(e),
  );
  const page = new Set(stop === -1 ? entries : entries.slice(0, stop));
  const end =
    stop === -1 ? res.data.cursor : stop > 0 ? entries[stop - 1].rev : null;
  const inbound = unseen.filter((e) => page.has(e) && direct.has(e.convoId));
  const reactions = rosterReactions.filter(
    (e) => page.has(e) && direct.has(e.convoId),
  );

  // Advance to `end` once the page is done with, past every message answered
  // or not: a message the bot will not answer must not be replayed on every
  // pass forever. Each message answered below moves the cursor past itself
  // first.
  if (!inbound.length && !reactions.length) {
    if (end) await writeCursor(end);
    await flushSummaries(chat, { log });
    return { answered: 0, scanned: entries.length, turns: [] };
  }

  // Only now is any of this worth loading. The config file is read per pass,
  // not cached, so an edit takes effect on the next message; one file read is
  // small next to a model call. The tool backends are loaded by the message
  // that needs them: until the first snapshot exists they cannot load, and
  // "help", the menus and the list commands still answer while the message
  // that needed scores says why it could not.
  const config = await loadAgentConfig();
  const openers = parseOpeners(config?.openers);
  // The config file can move limits within the ranges in agentConfig.js,
  // never past them.
  const limits = config?.limits || clampLimits({});
  const activeModel = config?.model || model;

  /**
   * Send to a convo, chunked, and hand back the message ids.
   *
   * The stored menu is cleared before anything goes, so it is never older
   * than the bot's last message, even when a send fails part way. A reply
   * that has a menu stores it with offerChoices once it is sent.
   */
  const sendTo =
    (convoId) =>
    async (text, { allow = [] } = {}) => {
      await clearChoices(convoId);
      const ids = [];
      for (const chunk of chunkForDm(text)) {
        // Facets only for links this codebase built. A facet range is
        // computed per chunk, and chunkForDm splits on whitespace before it
        // splits a word, so a link of about 70 characters never straddles
        // two chunks of 950.
        const facets = ownLinkFacets(chunk, { allow });
        const sent = await chat.chat.bsky.convo.sendMessage({
          convoId,
          message: facets.length ? { text: chunk, facets } : { text: chunk },
        });
        if (sent?.data?.id) ids.push(sent.data.id);
      }
      return ids;
    };

  const turns = [];

  // A 👍 or 👎 on a question the bot asked runs or drops exactly what it
  // described. Nothing else about a reaction is read. Each one is caught on
  // its own, so a throw here cannot cost the messages below it an answer.
  // Read again after a restart, a reaction does nothing: its question is
  // cleared before it runs.
  for (const r of reactions) {
    try {
      // A skin tone or the emoji selector does not change what a thumb means.
      const value = bareEmoji(r.reaction?.value);
      if (!YES_REACTIONS.has(value) && !NO_REACTIONS.has(value)) continue;
      const pending = await readPending(r.convoId);
      if (!pending?.message_ids?.includes(r.message?.id)) continue;
      await clearPending(r.convoId);
      const send = sendTo(r.convoId);
      if (NO_REACTIONS.has(value)) {
        await send('Okay, nothing changed.');
        turns.push({ convoId: r.convoId, pending: 'declined' });
        continue;
      }
      const out = await runPending(pending, {
        writeAgent,
        getIo,
        convoId: r.convoId,
        generate,
        model: activeModel,
        log,
      });
      await sendRun(send, r.convoId, out, { log });
      log('Ran a confirmed change', {
        via: 'reaction',
        commands: pending.commands.join(' | '),
        ok: !out.failed,
      });
      turns.push({ convoId: r.convoId, pending: 'confirmed' });
    } catch (err) {
      log('A reaction failed', {
        convoId: r.convoId,
        err: String(err?.message || err),
      });
    }
  }

  // Past MAX_BACKLOG the oldest go unanswered. Each conversation they came
  // from is told, so a block among them is not lost without a trace.
  const skipped = inbound.slice(0, -MAX_BACKLOG);
  if (skipped.length) {
    const byConvo = new Map();
    for (const e of skipped) {
      byConvo.set(e.convoId, [...(byConvo.get(e.convoId) || []), e.message]);
    }
    log('Skipped the oldest waiting messages', {
      skipped: skipped.length,
      convos: byConvo.size,
    });
    for (const [convoId, messages] of byConvo) {
      await sendTo(convoId)(skippedText(messages)).catch((err) =>
        log('Could not say what was skipped', {
          convoId,
          err: String(err?.message || err),
        }),
      );
    }
  }

  for (const arrived of inbound.slice(-MAX_BACKLOG)) {
    // At most once: the cursor moves past this message before anything is
    // done with it, so a crash or a restart in the middle of its turn drops
    // it, and the messages after it are read again by the next pass.
    const resume = arrived.rev || end;
    if (resume) await writeCursor(resume);

    // "!" is stripped before anything parses the text, so "!block @x" is
    // exactly "block @x" to the classic path. Facets are read for their URIs
    // and DIDs only, never their byte ranges, so the shift does not matter.
    const routed = routeFor(arrived.message.text, { mode });
    const entry =
      routed.text === arrived.message.text
        ? arrived
        : { ...arrived, message: { ...arrived.message, text: routed.text } };

    const send = sendTo(entry.convoId);

    // What this sender may do, decided once per message. The roster is the
    // only thing consulted; nothing downstream re-derives it from the text.
    const canWrite = roster.writes(entry.message?.sender?.did);

    // Options a read-only sender could only be refused are left out. Each
    // command is re-parsed rather than matched on its label, so the menu and
    // the gate in runCommand agree on what counts as a write.
    const offerable = (options) =>
      canWrite
        ? options
        : (options || []).filter((o) => !isWrite(parseCommand(o.command)));

    const embedUri = sharedPostUri(entry.message);
    const msgLinks = facetLinks(entry.message);
    const mentions = facetMentions(entry.message);

    // Before any routing decision, so every route leaves the post remembered.
    await rememberPost(
      entry.convoId,
      embedUri ||
        msgLinks.find((l) => extractTargets(l).length) ||
        extractTargets(entry.message.text || '')[0] ||
        null,
    );

    // 👀 before any work, so the sender can see it was picked up. It is
    // swapped for ✅ or ❌, or taken away, when the message is done with.
    const acked = await react(
      chat,
      entry.convoId,
      entry.message.id,
      REACTION.working,
    );
    let outcome = null;
    try {
      // An answer to a question the bot asked. Anything that is not a yes or
      // a no lets the question lapse, so a later "yes" cannot run something
      // the conversation has moved on from. A message that brings its own
      // target (a shared post or other record, a link to an account or post,
      // a mention) is about that target, so "block them" with a post attached
      // blocks its author rather than answering the question.
      //
      // A question a watch digest or an alert stored on a timer is not
      // answered by a message written before it: that message is read as if
      // nothing were asked, and the question stays for its own answer. The
      // two times come from different clocks (the chat service's and this
      // host's), and a message whose time cannot be read counts as earlier.
      const said = entry.message.text || '';
      const ownTarget = Boolean(
        sharedRecordUri(entry.message) ||
          mentions.length ||
          msgLinks.some((l) => extractTargets(l).length),
      );
      const stored = canWrite ? await readPending(entry.convoId) : null;
      const pending =
        stored?.background &&
        !(Date.parse(entry.message.sentAt) >= Date.parse(stored.created_at))
          ? null
          : stored;
      if (pending) await clearPending(entry.convoId);
      if (pending && !ownTarget) {
        if (isYes(said)) {
          const out = await runPending(pending, {
            writeAgent,
            getIo,
            convoId: entry.convoId,
            generate,
            model: activeModel,
            log,
          });
          outcome = pendingOutcome(out);
          await sendRun(send, entry.convoId, out, { log });
          log('Ran a confirmed change', {
            via: 'reply',
            commands: pending.commands.join(' | '),
            ok: !out.failed,
          });
          turns.push({ convoId: entry.convoId, pending: 'confirmed' });
          continue;
        }
        if (isNo(said)) {
          await send('Okay, nothing changed.');
          turns.push({ convoId: entry.convoId, pending: 'declined' });
          continue;
        }
      }
      // A bare yes or no with nothing open is answered here, never by a
      // model: the question it meant has lapsed or was never stored, and a
      // model would take the bot's previous message as what was agreed to.
      if (!pending && canWrite && !ownTarget) {
        if (isBareYes(said)) {
          await send(NOTHING_TO_CONFIRM);
          turns.push({ convoId: entry.convoId, pending: 'none' });
          continue;
        }
        if (isNo(said)) {
          await send('Okay, nothing changed.');
          turns.push({ convoId: entry.convoId, pending: 'none' });
          continue;
        }
      }

      // Agent mode's lanes that need no model: "block" with one target,
      // memory and watch commands, a card's words, a bare post.
      if (mode === 'agent' && routed.route !== 'classic' && !routed.escalate) {
        const handled = await withoutModel({
          text: said,
          entry,
          embedUri,
          msgLinks,
          mentions,
          canWrite,
          owner: roster.owner,
          config,
          send,
          writeAgent,
          getIo,
          generate,
          model: activeModel,
          log,
        });
        if (handled) {
          outcome = handled.outcome ?? null;
          turns.push(handled);
          continue;
        }
      }

      // Agent mode. A bare number stays classic only while the menu it answers
      // is live; after an agent reply there is none, so it reaches the agent.
      const toAgent =
        routed.route === 'agent' ||
        (routed.route === 'choice' &&
          !(await takeChoice(entry.convoId, parseChoice(entry.message.text))));
      if (toAgent) {
        const turn = await answerAsAgent({
          entry,
          chat,
          send,
          getIo,
          extraTools,
          config,
          limits,
          model: activeModel,
          triageModel: activeModel,
          writeAgent,
          canWrite,
          botDid,
          roster,
          generate,
          openers,
          escalate: Boolean(routed.escalate),
          acked,
          log,
        });
        outcome = turn.outcome ?? null;
        turns.push(turn);
        continue;
      }

      // The classic path. Commands never reach a model: they are matched on
      // the sender's literal text, run directly and answered with a receipt.
      // With no path from the analyst's tool loop to a write, a captured turn
      // has nothing to capture. See src/lib/command.js.
      if (canWrite) {
        const standing = await standingCommand({
          text: said,
          entry,
          embedUri,
          msgLinks,
          mode,
          hasModel: Boolean(activeModel) && modelsEnabled(),
          owner: roster.owner,
          send,
          log,
        });
        if (standing) {
          outcome = standing.outcome ?? null;
          turns.push(standing);
          continue;
        }
      }

      let cmd = parseCommand(entry.message.text, {
        embedUri,
        links: msgLinks,
        mentions,
      });

      // "add likers" with no post attached means the one they just sent.
      if (cmd?.action === 'plan' && cmd.needsTarget) {
        const remembered = await lastPost(entry.convoId);
        if (remembered) {
          cmd = {
            ...cmd,
            target: remembered,
            needsTarget: false,
            remembered: true,
          };
        }
      }

      // A bare "2" runs option 2 of the last menu offered here, while it is
      // live. Menus behind a plan, a lookup or a digest are written by code.
      // Options lifted from the analyst's prose are parsed and labelled from
      // the parse, so they are only as safe as the sender reading the label
      // (see offersFrom). Either way the PROTECTED veto applies at the write.
      if (!cmd) {
        const choice = parseChoice(entry.message.text);
        if (choice) {
          const chosen = await takeChoice(entry.convoId, choice);
          if (chosen) cmd = parseCommand(chosen, { embedUri });
        }
      }

      // A shared post is a form too. Scanning it stores a plan, so the code is
      // in hand when the sender picks an option, with no need to resend the
      // post.
      if (!cmd) {
        const post = parsePostScan(entry.message.text, {
          embedUri,
          links: msgLinks,
        });
        if (post) {
          if (!acked)
            await send(ackFor({ action: 'plan' }, { openers })).catch(() => {});
          try {
            const plan = await proposePlan({ link: post, kind: 'everyone' });
            const actions = offerable(
              planActions(plan, { hasModel: modelsEnabled() }),
            );
            const body = renderPlanReport(plan, {
              template: config?.postReport,
            });
            await send(withMenu(body, actions));
            await offerChoices(entry.convoId, actions, plan.uri);
            log('Scanned a post', { uri: plan.uri, code: plan.code });
            turns.push({ convoId: entry.convoId, scan: plan.code });
            continue;
          } catch (err) {
            await send(
              `That scan failed: ${String(err?.message || err).slice(0, 200)}`,
            );
            turns.push({ convoId: entry.convoId, scan: 'failed' });
            continue;
          }
        }
      }

      // A lookup is a form, not a question. Rendered from what score.js
      // already computed, with no model call: instant, free, and the same
      // shape every time.
      if (!cmd) {
        const actor = parseLookup(entry.message.text, {
          links: msgLinks,
          mentions,
        });
        if (actor) {
          try {
            const io = await getIo();
            const account = await io.lookUp(actor);
            if (account) {
              const actions = offerable(
                actionsFor(account, { hasModel: modelsEnabled() }),
              );
              const body = renderReport(account, { template: config?.report });
              // One line at the end for what a report cannot hold: every
              // decision recorded about them.
              const deeper = `\n\nFull record: history ${nameOf(account, account.did)}`;
              await send(withMenu(`${body}${deeper}`, actions));
              await offerChoices(entry.convoId, actions);
              log('Rendered a lookup', { actor, band: account.band });
              turns.push({ convoId: entry.convoId, lookup: actor });
              continue;
            }
            await send(`I could not resolve ${actor}.`);
            turns.push({ convoId: entry.convoId, lookup: actor });
            continue;
          } catch (err) {
            await send(
              `That lookup failed: ${String(err?.message || err).slice(0, 200)}`,
            );
            turns.push({ convoId: entry.convoId, lookup: actor });
            continue;
          }
        }
      }

      // `read`, `pulse` and `thread` are canned questions for the analyst
      // rather than branches of their own. That path already has the model,
      // the tools, the untrusted fencing and the chunking, and a second copy
      // would be a second place to forget the fencing. The wording is fixed
      // in src/lib/agent.js (readRequest, pulseRequest, threadRequest) rather
      // than taken from what the sender typed.
      let reading =
        cmd?.action === 'read' && !cmd.needsTarget ? cmd.actor : null;
      const pulsing = cmd?.action === 'pulse' ? cmd : null;
      const threading =
        cmd?.action === 'thread' && !cmd.needsTarget
          ? cmd.url || cmd.target
          : null;
      // Resolved from an attached post, so it is a DID. The read prompt names
      // the account back to the sender, and a DID in that sentence is
      // unreadable.
      if (reading && cmd.fromPost) {
        const account = await (await getIo()).lookUp(reading).catch(() => null);
        reading = nameOf(account, reading).replace(/^@/, '');
      }

      // Without a 👀, say something before slow work: a harvest or a model
      // call is seconds of silence that reads as broken. Only for work that
      // takes time, since an instant reply plus an ack is two messages for
      // one answer, and a refusal or a nudge is instant. A failed ack is
      // swallowed so it cannot cost the answer.
      if (!acked && worthAcking(cmd) && !cmd?.needsTarget) {
        await send(ackFor(cmd, { openers })).catch(() => {});
      }

      if (cmd?.action === 'read' && cmd.needsTarget) {
        await send(nudge('read'));
        turns.push({ convoId: entry.convoId, command: 'read' });
        continue;
      }

      if (cmd?.action === 'thread' && cmd.needsTarget) {
        await send(nudge('thread'));
        turns.push({ convoId: entry.convoId, command: 'thread' });
        continue;
      }

      if (cmd && !reading && !pulsing && !threading) {
        let reply;
        try {
          reply = await runCommand(cmd, writeAgent, {
            template: config?.postReport,
            reportTemplate: config?.report,
            lookUp: async (a) => (await getIo()).lookUp(a),
            canWrite,
            generate,
            model: activeModel,
            log,
          });
        } catch (err) {
          reply = {
            text: `That failed: ${String(err?.message || err).slice(0, 300)}`,
            options: null,
            outcome: 'failed',
          };
        }
        const options = offerable(reply.options);
        // What the command did, as runCommand read it from the write, so a
        // refusal or a nudge gets no ✅ whatever its words, and a change goes
        // through sendReceipt whatever its words.
        outcome = reply.outcome ?? null;
        const text = withMenu(reply.text, options);
        const shown =
          outcome === 'done'
            ? await sendReceipt(send, text, { log })
            : await send(text);
        if (shown) await offerChoices(entry.convoId, options, reply.lastPost);
        log('Ran a command', {
          action: cmd.action,
          actor: cmd.actor ?? cmd.target ?? cmd.code ?? '(none)',
          options: options?.length ?? 0,
        });
        turns.push({ convoId: entry.convoId, command: cmd.action });
        continue;
      }

      // With no model provider or no model id, everything past the commands is
      // out of reach. Say so, rather than fail on a call that cannot be made.
      if (!activeModel || !modelsEnabled()) {
        await send(NO_MODEL);
        turns.push({ convoId: entry.convoId, command: 'no-model' });
        continue;
      }

      // Read the conversation back so a follow-up means something.
      let reply;
      let io;
      try {
        io = await getIo();
        const history = await readHistory(chat, entry, { botDid, limits });
        reply = await answer({
          generate,
          message: reading
            ? readRequest(reading)
            : pulsing
              ? pulseRequest(pulsing)
              : threading
                ? threadRequest(threading)
                : composeMessage(entry.message),
          io,
          history,
          model: activeModel,
          extraTools,
          voice: config?.style,
          guidance: config?.guidance,
          maxSteps: limits.maxSteps,
          reviewRows: limits.reviewRows,
        });
      } catch (err) {
        // Said out loud, so a timeout or a gateway error does not look like a
        // deliberate non-answer once the 👀 is taken away.
        const why = String(err?.message || err);
        await send(
          /abort|timeout/i.test(why)
            ? 'That took too long and I stopped.'
            : `That failed: ${why.slice(0, 200)}`,
        ).catch(() => {});
        // What the model calls that came back spent, before it failed.
        if (err?.usage) {
          await upsert('llm_usage', [
            {
              kind: 'dm',
              model: activeModel,
              input_tokens: err.usage.inputTokens ?? null,
              output_tokens: err.usage.outputTokens ?? null,
            },
          ]).catch(() => {});
        }
        log('The analyst failed', { convoId: entry.convoId, err: why });
        outcome = 'failed';
        turns.push({ convoId: entry.convoId, analyst: 'failed' });
        continue;
      }

      let text = reply.text || 'No answer produced.';
      if (reply.cutOff) {
        text +=
          '\n\n(I ran out of steps before finishing, so this may be incomplete.)';
      }
      // The analyst quotes commands in backticks. Lift them into a menu so the
      // sender can answer "2" instead of retyping one. Parsed, not copied: see
      // offersFrom for what that does and does not guarantee.
      let offers = offerable(offersFrom(text));
      // After a read, offer the decision it was for, built from the scored
      // account rather than the model's prose, and without the read just done.
      if (reading) {
        const account = await io.lookUp(reading).catch(() => null);
        if (account) {
          offers = offerable(actionsFor(account)).filter(
            (o) => parseCommand(o.command)?.action !== 'read',
          );
        }
      }

      // A digest's follow-ups are composed by code from the arguments the
      // digest ran with, not lifted from the prose, so pressing 2 runs a
      // request this codebase wrote. They follow the tool call rather than the
      // typed words because, asked in words, the model picks the window, and
      // the menu should match what was actually read.
      const ranPulse = reply.pulses?.[reply.pulses.length - 1] ?? null;
      // URLs this reply may render as links: only a digest's, which point at
      // posts this code fetched.
      let allow = [];
      if (pulsing || ranPulse) {
        const from = pulsing ?? pulseFromArgs(ranPulse.args);
        // Markers first: the link list and the menu are both built from what
        // survived resolution, so a post the analyst invented reaches neither.
        const resolved = citationsIn(text, ranPulse?.sample ?? []);
        text = resolved.text;
        allow = resolved.cited.map((c) => c.url);
        if (resolved.cited.length) {
          text += `\n\n${renderCitations(resolved.cited)}`;
        }
        offers = offerable(
          followUpsFor(from, {
            terms: ranPulse?.focusTerms ?? [],
            posts: resolved.cited,
          }),
        );
      }
      if (offers.length) text += `\n\n${renderChoices(offers)}`;
      // Counted on the text as sent, links and menu included, so the log
      // reports what went out rather than what the model wrote.
      const chunks = chunkForDm(text);
      await send(text, { allow });
      await offerChoices(entry.convoId, offers);

      // The reply is already sent and the cursor already advanced, so a failure
      // to record the spend must not throw away the rest of the pass.
      await upsert('llm_usage', [
        {
          kind: 'dm',
          model: activeModel,
          input_tokens: reply.usage?.inputTokens ?? null,
          output_tokens: reply.usage?.outputTokens ?? null,
        },
      ]).catch(() => {});

      log('Answered a DM', {
        convoId: entry.convoId,
        chunks: chunks.length,
        steps: reply.steps,
      });
      turns.push({
        convoId: entry.convoId,
        chunks: chunks.length,
        steps: reply.steps,
      });
    } catch (err) {
      // A failure nothing above caught. The cursor is already past this
      // message, so it is dropped either way; catching it here keeps the rest
      // of the batch answered and puts a ❌ on the message.
      log('A DM turn failed', {
        convoId: entry.convoId,
        err: String(err?.message || err),
      });
      outcome = 'failed';
      await send(
        `That failed: ${String(err?.message || err).slice(0, 200)}`,
      ).catch(() => {});
      turns.push({ convoId: entry.convoId, failed: true });
    } finally {
      await settle(chat, entry.convoId, entry.message.id, outcome);
    }
  }

  if (end) await writeCursor(end);
  await flushSummaries(chat, { log });
  return { answered: turns.length, scanned: entries.length, turns };
}
