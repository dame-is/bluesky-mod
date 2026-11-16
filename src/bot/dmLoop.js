// One pass of the bot account's DM intake. src/index.js runs it on a timer.
//
// Two rules hold this together, and both are about blast radius:
//
//  1. Only senders on the roster are answered (src/lib/senders.js); everyone
//     else is skipped without a reply. Anyone can DM the bot, and the model
//     reads its input as instructions, so the sender check is the security
//     boundary, not the prompt.
//  2. In classic mode the analyst has no write tools. It looks and explains,
//     and acting goes through a typed command or a numbered menu, so a fully
//     prompt-injected turn costs a wrong paragraph.
//
// Agent mode (MOD_DM_MODE=agent) relaxes rule 2 on purpose: the model gets the
// write tools and is talked to in sentences. Rule 1 still decides who is
// answered and who may write, and the classic path is reached by a leading
// "!" or by answering a live classic menu. See src/bot/operator.js.
//
// At most once, on purpose. The cursor advances before any reply is sent, so
// a message that crashes its turn is dropped rather than replayed. Advancing
// after would turn one poisoned message into an endless loop of DMs.

import { generateText } from 'ai';
import { modelsEnabled } from '../models.js';

import { OWNER_DID } from '../constants.js';
import { rosterFromEnv } from '../lib/senders.js';
import { ownLinkFacets, postWebUrl } from '../lib/links.js';
import {
  resolveActor,
  extractTargets,
} from '../lib/target.js';
import {
  answer,
  chunkForDm,
  historyFrom,
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
  isNo,
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
import { runTriage, reviewTriage } from './triage.js';
import {
  proposePlan,
  findPlan,
  applyPlan,
  applyPlanToActors,
  applyPlanToTriage,
  reviewPlan,
  cancelPlan,
  undoPlan,
  lastActedPlan,
  historyFor,
  shortCode,
} from './bulkPlan.js';
import { loadAgentConfig, clampLimits } from './agentConfig.js';
import { operate, fallbackText } from './operator.js';
import { shortModel } from './tiers.js';
import { authorOf } from '../lib/trigger.js';
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
 * The post attached to a message, if it was shared rather than pasted.
 *
 * Sharing a post into a DM from the Bluesky app puts no link in the text: the
 * post travels in `embed.record.uri`, so scanning the text alone misses it.
 */
export function sharedPostUri(message) {
  const uri = message?.embed?.record?.uri;
  return typeof uri === 'string' && uri.startsWith('at://') ? uri : null;
}

/**
 * What the model is asked: what the sender typed, plus the shared post, the
 * full links and the mentioned DIDs when there are any. Those lines are built
 * by code from the sender's own message, not copied from anyone else's
 * writing, so they are not untrusted input.
 */
export function composeMessage(message) {
  const text = message?.text || '';
  const extra = [];

  const uri = sharedPostUri(message);
  if (uri) extra.push(`The post the owner shared: ${uri}`);

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

/** True while `at` (an ISO time) is within the TTL. A missing time is stale. */
const fresh = (at, now = Date.now()) =>
  now - Date.parse(at) <= CHOICE_TTL_MS;

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
 * Forget the menu. An agent reply offers none, and a "2" sent after it must
 * reach the agent rather than an option an earlier classic reply offered.
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

/** The named accounts in a plan, and what the owner can do about them. */
function renderReview(plan, review) {
  const lines = [`Plan ${plan.code}: ${review.total} need a look:`, ''];
  for (const r of review.rows) {
    const reach =
      r.followers != null ? `, ${r.followers.toLocaleString()} followers` : '';
    lines.push(`  @${r.handle}: ${r.band}, ${r.vouches ?? 0} vouches${reach}`);
  }
  if (review.total > review.shown) {
    lines.push('', `(${review.total - review.shown} more)`);
  }
  const bands = [...new Set(review.rows.map((r) => r.band))].filter(
    (b) => b !== 'PROTECTED',
  );
  const options = [];
  if (bands.length) {
    options.push({
      label: `Add all ${review.total} of these`,
      command: `approve ${plan.code} ${bands.join(',')}`,
    });
  }
  options.push({ label: 'Do nothing', command: `cancel ${plan.code}` });
  lines.push(
    '',
    renderChoices(options),
    '',
    `Or name them: approve ${plan.code} @handle @handle`,
  );
  return { text: lines.join('\n'), options };
}

/** Every band but PROTECTED. */
const ALL_BANDS = ['UNKNOWN', 'PERIPHERAL', 'NOTABLE', 'CONNECTED'];

/**
 * Run one typed command and return what to say back.
 *
 * No branch asks a model what to do. The inputs are the sender's literal text
 * and what Constellation and score.js returned. Triage calls a model to label
 * posts, and adds nobody.
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
  const say = (text, options = null) => ({ text, options });

  // The gate, before any branch that could reach a repo. Checked here and not
  // only where menus are built, because a command can arrive as typed text.
  if (!canWrite && isWrite(cmd)) {
    return say(readOnlyReply(cmd));
  }

  // A verb with nothing to act on. Every branch asks rather than guesses.
  // `undo` lands here only when handed a token meant as a code that is not
  // one: the answer names the token instead of undoing a plan nobody named.
  if (cmd.needsTarget) {
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
    if (['approve', 'cancel', 'review'].includes(cmd.action)) {
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

  if (!writeAgent) return say('Commands are not wired up on this path.');

  if (cmd.action === 'plan') {
    const plan = await proposePlan({ link: cmd.target, kind: cmd.kind });
    const actions = planActions(plan);
    const head = cmd.remembered ? 'Using the post you sent earlier.\n\n' : '';
    return {
      text: `${head}${renderPlanReport(plan, { template })}\n\nACTIONS:\n${renderChoices(actions)}`,
      options: actions,
      lastPost: plan.uri,
    };
  }

  if (cmd.action === 'history') {
    const did = cmd.actor
      ? await resolveActor(cmd.actor).catch(() => null)
      : null;
    if (cmd.actor && !did) return say(`I could not resolve ${cmd.actor}.`);
    const h = await historyFor(did);
    if (!h.rows.length) {
      return say(
        cmd.actor ? 'Nothing recorded for them.' : 'Nothing done yet.',
      );
    }
    const lines = h.rows.map((r) => {
      const when = new Date(r.acted_at).toLocaleString();
      const verb = r.action === 'list_remove' ? 'removed' : 'added';
      const note = r.plan?.note ? `, "${r.plan.note}"` : '';
      const undone = r.undone_at ? ' (undone)' : '';
      return `${when} · ${verb} · ${r.band} · ${r.approved_via ?? '?'} · ${r.code}${undone}${note}`;
    });
    return say(
      `${h.total} actions on record, most recent first:\n\n${lines.join('\n')}`,
    );
  }

  if (cmd.action === 'undo') {
    const plan = cmd.last ? await lastActedPlan() : await findPlan(cmd.code);
    if (!plan) {
      return say(
        cmd.last ? 'Nothing to undo.' : `No plan with code ${cmd.code}.`,
      );
    }
    const out = await undoPlan(writeAgent, plan, {
      reason: cmd.raw,
    });
    return say(out.message, [
      { label: 'Show me what changed', command: `history` },
    ]);
  }

  if (['approve', 'cancel', 'review', 'triage'].includes(cmd.action)) {
    const plan = await findPlan(cmd.code);
    if (!plan) return say(`No plan with code ${cmd.code}.`);

    // Read what they wrote and bucket it. Labels only: nobody is added here,
    // and approving a bucket is a separate command on purpose.
    if (cmd.action === 'triage') {
      const out = await runTriage(plan, { generate, model, log });
      const { counts } = out;
      // How many were read as hostile and how many are not yet acted on can
      // differ, and a button can only be about the second.
      const left = out.pending || counts;
      const seen = (k) =>
        left[k] === counts[k]
          ? `${counts[k]}`
          : `${counts[k]} (${left[k]} new)`;
      const lines = [
        `Read ${out.total - out.noText - out.remaining} of the ${out.total} accounts on ${cmd.code}.`,
        '',
        `Hostile: ${seen('hostile')}  (aimed at a person)`,
        `Arguing: ${seen('arguing')}  (aimed at the argument)`,
        `Neutral: ${seen('neutral')}`,
        `No words: ${out.noText}  (likes and reposts carry nothing to read)`,
        ...(out.gone ? [`Deleted: ${out.gone}  (the post is gone)`] : []),
        ...(out.secondWave
          ? [
              `Second reader (${shortModel(out.secondWave.model)}): re-read ${out.secondWave.read} flagged as possibly hostile, changed ${out.secondWave.overturned}.`,
            ]
          : []),
      ];
      if (out.remaining) {
        lines.push(
          '',
          `${out.remaining} left. Send "triage ${cmd.code}" again.`,
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
          command: `approve ${cmd.code} hostile`,
        });
      }
      if (out.remaining) {
        choices.push({
          label: `Keep reading the other ${out.remaining}`,
          command: `triage ${cmd.code}`,
        });
      }
      choices.push({ label: 'Do nothing', command: `cancel ${cmd.code}` });
      return say(
        `${lines.join('\n')}\n\nACTIONS:\n${renderChoices(choices)}`,
        choices,
      );
    }

    if (cmd.action === 'cancel') {
      await cancelPlan(plan);
      return say(`Cancelled ${cmd.code}. Nothing was added.`);
    }

    // A label review prints the words: a label nobody can check is only a
    // model's opinion.
    if (cmd.action === 'review' && cmd.labels?.length) {
      const label = cmd.labels[0];
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
                { label: 'Take them back off', command: `undo ${cmd.code}` },
                record,
              ]
            : [record],
        );
      }
      const lines = out.rows.map(
        (r) =>
          `${r.band} - "${String(r.triage_quote).replace(/\s+/g, ' ').slice(0, 160)}"`,
      );
      // Hundreds of quotes do not get read in a DM. This is a spot check on
      // the labelling before a bulk action, and the header says so.
      const head =
        `${out.pending} read as ${label} and not yet on the list` +
        (out.added ? `, ${out.added} already added` : '') +
        `. Here are ${out.rows.length}, most connected first, as a spot check.`;
      const choices = [
        {
          label: `Add all ${out.pending}`,
          command: `approve ${cmd.code} ${label}`,
        },
        { label: 'Do nothing', command: `cancel ${cmd.code}` },
      ];
      return say(
        `${head}\n\n${lines.join('\n\n')}\n\nACTIONS:\n${renderChoices(choices)}`,
        choices,
      );
    }

    if (cmd.action === 'review') {
      const review = await reviewPlan(plan, { bands: cmd.bands });
      if (!review.total)
        return say('Nothing in this plan needs a look. It is all UNKNOWN.');
      return renderReview(plan, review);
    }

    // The personal path: named accounts the sender read and decided on.
    if (cmd.actors?.length) {
      const out = await applyPlanToActors(writeAgent, plan, cmd.actors);
      return say(out.message);
    }
    if (cmd.labels?.length) {
      const out = await applyPlanToTriage(writeAgent, plan, cmd.labels[0]);
      return say(
        out.message,
        out.added
          ? [
              { label: `Undo those ${out.added}`, command: `undo ${cmd.code}` },
              { label: 'Show me the record', command: 'history' },
            ]
          : null,
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
    });
    // Offer the way back with the receipt, while the code is still in front of
    // them. An undo you have to go and look up is one you will not use.
    return say(
      out.message,
      out.added
        ? [
            {
              label: `Undo those ${out.added}`,
              command: `undo ${shortCode(plan.id)}`,
            },
            { label: 'Show me the record', command: 'history' },
          ]
        : null,
    );
  }

  // Wording that might not mean the attached post's author. Name the author,
  // show what the gate knows about them, and let the sender choose, rather
  // than refuse or guess.
  if (cmd.fromPost && cmd.confirm) {
    const found = lookUp ? await lookUp(cmd.actor).catch(() => null) : null;
    if (!found) {
      return say('I could not resolve the author of that post.');
    }
    const handle = `@${found.handle || found.did}`;
    const choices = [
      ...(cmd.action === 'list_add' && !found.protectedReason
        ? [
            {
              label: `Add ${handle} to the list`,
              command: `list add ${handle}`,
            },
          ]
        : []),
      ...(cmd.action === 'list_remove'
        ? [
            {
              label: `Remove ${handle} from the list`,
              command: `list remove ${handle}`,
            },
          ]
        : []),
      {
        label: `Read ${handle}'s recent posts first`,
        command: `read ${handle}`,
      },
    ];
    const body = renderReport(found, { template: reportTemplate });
    return say(
      `That post is by ${handle}, but "${cmd.raw}" might mean someone else, so I have not acted.\n\n${body}\n\nACTIONS:\n${renderChoices(choices)}`,
      choices,
    );
  }

  // An actor taken from an attached post is a DID, which makes a receipt
  // nobody can check. Resolve it to a handle and say whose post it was, so a
  // sender who meant the author of a quoted post sees the mistake at once.
  let actor = cmd.actor;
  let preface = '';
  if (cmd.fromPost) {
    const account = lookUp ? await lookUp(actor).catch(() => null) : null;
    if (account?.handle) actor = account.handle;
    preface = `That post is by @${String(actor).replace(/^@/, '')}.\n\n`;
  }

  const out = await applyCommand(writeAgent, cmd.action, actor, {
    raw: cmd.raw,
    lookUp,
  });

  // The way back, and the way to look closer, offered with the receipt. A
  // single block is a plan of one, so "undo last" undoes exactly this.
  const at = `@${String(actor).replace(/^@/, '')}`;
  const after =
    out.ok && cmd.action === 'list_add'
      ? [
          { label: 'Undo that', command: 'undo last' },
          { label: `Read ${at}'s recent posts`, command: `read ${at}` },
        ]
      : null;
  return say(preface + out.message, after);
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
    return historyFrom(page.data.messages, {
      // The asker, who is not always the owner. Labelling a guest's own
      // messages as someone else's makes the model read the conversation as
      // one it watched rather than one it is in.
      selfDid: entry.message?.sender?.did ?? OWNER_DID,
      botDid,
      beforeId: entry.message.id,
      maxTurns: limits.maxTurns,
      maxAgeMs: limits.historyHours ? limits.historyHours * 3600_000 : null,
    });
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

  const [io, history, remembered, notes] = await Promise.all([
    getIo(),
    readHistory(chat, entry, { botDid, limits }),
    lastPost(entry.convoId),
    listNotes().catch(() => []),
  ]);

  // History is read as text, so a post shared three messages ago is gone from
  // it. Name the last one here, as derived fact from the sender's own
  // messages, so "add the quoters too" has something to point at.
  let message = composeMessage(entry.message);
  if (remembered && !message.includes(remembered)) {
    message += `\n\n[The post last sent in this conversation: ${remembered}]`;
  }

  const reply = await operate({
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
    notes: notesBlock(notes),
    convoId: entry.convoId,
    sendProgress: async (text) => {
      clearTimeout(timer);
      await spoke;
      spoke = send(text).catch(() => {});
      await spoke;
    },
    log,
  });
  clearTimeout(timer);
  await spoke;

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

  const sentIds = await send(text, { allow });
  await clearChoices(entry.convoId);
  if (asked.length) {
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
  const handle = (a?.handle || String(quick.actor)).replace(/^@/, '');
  log('Quick lane', {
    action: quick.action,
    actor: handle,
    ok: out.ok,
    changed: Boolean(out.changed),
    band: a?.band ?? '-',
  });
  if (!out.ok) {
    await send(out.message.replace(String(quick.actor), `@${handle}`));
    return { outcome: 'failed', quick: quick.action };
  }
  const adding = quick.action === 'list_add';
  if (adding && out.changed && a && LOUD_BANDS.has(a.band)) {
    const why = [
      a.band,
      a.vouches ? `followed by ${a.vouches} people you follow` : null,
      a.followers ? `${a.followers.toLocaleString('en-US')} followers` : null,
    ].filter(Boolean);
    await send(
      `Blocked @${handle}. Worth knowing: ${why.join(', ')}. "unblock @${handle}" takes it back.`,
    );
    return { outcome: 'done', quick: quick.action };
  }
  if (!adding && out.already) {
    await send(`@${handle} was not on the list.`);
    return { outcome: null, quick: quick.action };
  }
  noteQuiet(convoId, {
    action: quick.action,
    handle,
    already: Boolean(out.already),
    blocksYou: Boolean(a?.blocksYou),
  });
  return { outcome: 'done', quick: quick.action };
}

/**
 * "hostile" on a card: read the replies and quotes, then add the hostile.
 * Three rounds of triage at most; anything still unread is said, so the
 * counts are not taken for the whole post.
 */
async function runHostile(code, { writeAgent, generate, model, log }) {
  const plan = await findPlan(code);
  if (!plan) return { text: `No plan with code ${code}.`, failed: true };
  let out = null;
  for (let round = 0; round < 3; round += 1) {
    out = await runTriage(plan, { generate, model, log });
    if (!out.remaining) break;
  }
  const added = await applyPlanToTriage(writeAgent, plan, 'hostile');
  const c = out?.counts || {};
  const unread = out?.remaining
    ? ` ${out.remaining} not read yet; "triage ${code}" reads them.`
    : '';
  return {
    text:
      `Read the replies and quotes on ${code}: ${c.hostile || 0} hostile, ${c.arguing || 0} arguing, ${c.neutral || 0} neutral.${unread} ${added.message}`,
  };
}

/**
 * Run a stored question's commands, as a "yes" or a 👍 asked.
 *
 * Classic commands through runCommand, so the vetoes and the log are the ones
 * a typed command gets; "watch <post> [<n>h] [auto]" and "hostile <code>" are
 * the two that are not commands anyone types.
 */
async function runPending(
  pending,
  { writeAgent, getIo, convoId, generate, model, log },
) {
  const lines = [];
  let failed = false;
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
        failed ||= Boolean(out.failed);
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
      if (/^(That failed|I could not|No plan)/.test(reply.text)) failed = true;
    } catch (err) {
      lines.push(`That failed: ${String(err?.message || err).slice(0, 200)}`);
      failed = true;
    }
  }
  return { text: lines.join('\n\n'), failed };
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

    const memo = parseMemoryCommand(text);
    if (memo) {
      const out =
        memo.action === 'recall'
          ? { ok: true, message: recallText(await listNotes()) }
          : memo.action === 'remember'
            ? await remember(memo.text)
            : await forget(memo);
      await send(out.message);
      log('Memory', { action: memo.action, ok: out.ok });
      return {
        convoId,
        memory: memo.action,
        outcome: out.ok && memo.action !== 'recall' ? 'done' : null,
      };
    }

    const watching = parseWatchCommand(text, { embedUri, links: msgLinks });
    if (watching) {
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
            ? "I'll block what two models read as hostile in new quotes and replies, hold anyone CONNECTED or NOTABLE for you, and "
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
        await send(out.text);
        log('Answered a card', { keys: keys.join(','), ok: !out.failed });
        return {
          convoId,
          card: keys.join(','),
          outcome: out.failed ? 'failed' : 'done',
        };
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
 * How many waiting messages one pass answers. Past that the oldest are
 * skipped: after an outage, the latest messages are the ones worth answering.
 */
const MAX_BACKLOG = 30;

/** Pages of getLog a cold start will walk to reach the live tail. */
const COLD_START_MAX_PAGES = 50;

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
 * of seconds and almost never finds anything. The write happens before any
 * reply is sent, which is what makes a crashed turn a dropped message rather
 * than a replayed one.
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
 * Walk getLog to its end and remember where that was, answering nothing.
 *
 * getLog with no cursor replays the whole chat history from the beginning, so
 * without this the first run would answer messages sent weeks ago as though
 * they had just arrived. The Jetstream subscription starts from the live tail
 * for the same reason.
 */
async function seekToTail(chat, { log = () => {} } = {}) {
  let cursor = null;
  let seen = 0;
  for (let page = 0; page < COLD_START_MAX_PAGES; page += 1) {
    const res = await chat.chat.bsky.convo.getLog(cursor ? { cursor } : {});
    const entries = res.data.logs || [];
    seen += entries.length;
    if (res.data.cursor) cursor = res.data.cursor;
    if (!entries.length) break;
  }
  // An empty log can come back with no cursor. Store null for it, so the next
  // pass reads the log from the start and the first message anyone sends is
  // answered rather than skipped as history.
  if (cursor || !seen) await writeCursor(cursor);
  log('DM cursor initialised at the live tail', { cursor });
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
 *   A factory, not an object: building it loads the vouch snapshot, and a
 *   poll that finds nothing (almost every poll) must not pay for that. The
 *   same laziness lets the snapshot be released while idle.
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
  const entries = res.data.logs || [];

  // Never the bot's own messages, even if its DID is on the roster: answering
  // itself would loop forever.
  const inbound = entries.filter(
    (entry) =>
      entry.$type === 'chat.bsky.convo.defs#logCreateMessage' &&
      entry.message?.sender?.did !== botDid &&
      roster.answers(entry.message?.sender?.did) &&
      typeof entry.message?.text === 'string',
  );
  // A thumbs-up or thumbs-down from a writer, on one of the bot's own messages.
  // Only one that carries a stored question does anything.
  const reactions = entries.filter(
    (entry) =>
      entry.$type === 'chat.bsky.convo.defs#logAddReaction' &&
      entry.reaction?.sender?.did !== botDid &&
      roster.writes(entry.reaction?.sender?.did) &&
      entry.message?.sender?.did === botDid,
  );

  // Advance regardless of what we do with the contents: a message the bot will
  // not answer must not be replayed on every pass forever.
  if (res.data.cursor) await writeCursor(res.data.cursor);

  if (!inbound.length && !reactions.length) {
    await flushSummaries(chat, { log });
    return { answered: 0, scanned: entries.length, turns: [] };
  }

  // Only now is any of this worth loading. The config file is read per pass,
  // not cached, so an edit takes effect on the next message; one file read is
  // small next to a model call.
  const [io, config] = await Promise.all([getIo(), loadAgentConfig()]);
  const openers = parseOpeners(config?.openers);
  // The config file can move limits within the ranges in agentConfig.js,
  // never past them.
  const limits = config?.limits || clampLimits({});
  const activeModel = config?.model || model;

  /** Send to a convo, chunked, and hand back the message ids. */
  const sendTo =
    (convoId) =>
    async (text, { allow = [] } = {}) => {
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
  // its own: the cursor has moved, so a throw here would drop every message
  // below it unanswered.
  for (const r of reactions) {
    try {
      const value = r.reaction?.value;
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
      await send(out.text);
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

  for (const arrived of inbound.slice(-MAX_BACKLOG)) {
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
      // the conversation has moved on from.
      const said = entry.message.text || '';
      const pending = canWrite ? await readPending(entry.convoId) : null;
      if (pending) {
        await clearPending(entry.convoId);
        if (isYes(said)) {
          const out = await runPending(pending, {
            writeAgent,
            getIo,
            convoId: entry.convoId,
            generate,
            model: activeModel,
            log,
          });
          await send(out.text);
          log('Ran a confirmed change', {
            via: 'reply',
            commands: pending.commands.join(' | '),
            ok: !out.failed,
          });
          outcome = out.failed ? 'failed' : 'done';
          turns.push({ convoId: entry.convoId, pending: 'confirmed' });
          continue;
        }
        if (isNo(said)) {
          await send('Okay, nothing changed.');
          turns.push({ convoId: entry.convoId, pending: 'declined' });
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
            const actions = offerable(planActions(plan));
            const body = renderPlanReport(plan, {
              template: config?.postReport,
            });
            await send(
              actions.length
                ? `${body}\n\nACTIONS:\n${renderChoices(actions)}`
                : body,
            );
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
              const actions = offerable(actionsFor(account));
              const body = renderReport(account, { template: config?.report });
              // One line at the end for what a report cannot hold: every
              // decision recorded about them.
              const deeper = `\n\nFull record: history ${account.handle ? `@${account.handle}` : account.did}`;
              await send(
                actions.length
                  ? `${body}${deeper}\n\nACTIONS:\n${renderChoices(actions)}`
                  : `${body}${deeper}`,
              );
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
        if (account?.handle) reading = account.handle;
      }

      // Without a 👀, say something before slow work: a harvest or a model
      // call is seconds of silence that reads as broken. Only for work that
      // takes time, since an instant reply plus an ack is two messages for
      // one answer. A failed ack is swallowed so it cannot cost the answer.
      if (!acked && worthAcking(cmd)) {
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
          };
        }
        const options = offerable(reply.options);
        if (
          isWrite(cmd) &&
          !/failed|could not|PROTECTED|not on the list|No plan/i.test(
            reply.text,
          )
        ) {
          outcome = 'done';
        }
        await send(reply.text);
        await offerChoices(entry.convoId, options, reply.lastPost);
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
        await send(
          'No AI model is set up for this bot, so I only understand commands. Send "help" for the list.',
        );
        turns.push({ convoId: entry.convoId, command: 'no-model' });
        continue;
      }

      // Read the conversation back so a follow-up means something.
      let reply;
      try {
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
          surface: 'dm',
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
        log('The analyst failed', { convoId: entry.convoId, err: why });
        outcome = 'failed';
        turns.push({ convoId: entry.convoId, analyst: 'failed' });
        continue;
      }

      let text = reply.text || 'No answer produced.';
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

  await flushSummaries(chat, { log });
  return { answered: turns.length, scanned: entries.length, turns };
}
