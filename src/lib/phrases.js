// What the bot says when the model is not talking.
//
// Acknowledgements, nudges and receipts are written here rather than
// generated, because an ack has to arrive before the model does. A model call
// to say "on it" would cost the seconds the ack exists to fill.
//
// Openers are voice, and the owner can replace them in the config file.
// Clauses state what happens next and stay in code: an editable clause could
// say "Writing to the list" while the bot is harvesting, and that receipt
// would lie.
//
// No em dashes in anything here. phrases.test.js checks.

/** Openers. Overridden by `openers` in the config file. */
export const DEFAULT_OPENERS = [
  'Acknowledged.',
  'On it.',
  'On it, boss.',
  'Got it.',
  'Right.',
  'Heard you.',
  'Yep.',
];

/**
 * What is about to happen. Not editable: a false receipt is worse than a dull
 * one.
 */
export const ACK_CLAUSE = {
  plan: [
    'Harvesting and scoring that post.',
    'Pulling everyone who touched it and scoring them.',
    'Running the harvest now.',
  ],
  approve: [
    'Writing to the list.',
    'Adding them now.',
    'Putting those on the list.',
  ],
  review: [
    'Pulling the accounts that need a look.',
    'Fetching the ones worth reading.',
  ],
  cancel: ['Standing down.'],
  undo: ['Taking those back off the list.', 'Undoing that.'],
  history: ['Pulling the record.'],
  list_add: ['Checking the list.', 'Looking them up.'],
  list_remove: ['Checking the list.', 'Looking them up.'],
  think: ['Thinking.', 'Having a look.', 'Reading up.'],
  triage: [
    'Reading what they all wrote and sorting it.',
    'Going through the quotes and bucketing them by tone.',
    'Reading the replies and sorting them.',
  ],
  read: [
    'Reading their recent posts.',
    'Going through what they have been posting.',
    'Having a proper read of their feed.',
  ],
  thread: ['Reading that thread.', 'Pulling the replies and having a read.'],
  pulse: [
    'Reading what that slice has been posting.',
    'Pulling the window and having a read.',
    'Going through everyone in that slice.',
  ],
};

/**
 * Which commands are worth announcing. An ack fills five to twenty seconds of
 * silence. A lookup needs no model and arrives at once, so announcing it
 * would mean two messages for one answer.
 */
export const SLOW = new Set([
  'plan',
  'approve',
  'undo',
  'review',
  'think',
  // Reads a feed and then calls the model. A triage does that for hundreds
  // of accounts at once.
  'read',
  'triage',
  // A fan-out over a few hundred author feeds, then a model call over all of
  // it.
  'pulse',
  'thread',
]);

export function worthAcking(cmd) {
  return SLOW.has(cmd?.action ?? 'think');
}

/** Pick one. `rng` is injectable so tests are not flaky. */
export function pick(list, rng = Math.random) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!arr.length) return '';
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/**
 * Parse the editable openers: one per line, which is easier to write than a
 * JSON list of sentences. Blank input falls back to the defaults rather than
 * leaving the bot mute.
 */
export function parseOpeners(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines : DEFAULT_OPENERS;
}

/**
 * What to say the moment a message is picked up, before the work starts. A
 * harvest or a model call is five to twenty seconds of silence, which reads
 * as broken rather than busy.
 *
 * @param {object|null} cmd  the parsed command, or null for a question
 * @param {object} [opts]
 * @param {string[]} [opts.openers]
 * @param {Function} [opts.rng]
 */
export function ackFor(
  cmd,
  { openers = DEFAULT_OPENERS, rng = Math.random } = {},
) {
  const key = Object.hasOwn(ACK_CLAUSE, cmd?.action ?? '')
    ? cmd.action
    : 'think';
  return `${pick(openers, rng)} ${pick(ACK_CLAUSE[key], rng)}`.trim();
}

/** Nudges, when a command arrived without enough to act on. */
export const NUDGE = {
  actor: [
    'Name the account and I will do it. "block @handle", or a profile link. I will not work out who you meant from context; that is the one thing standing between a stranger\'s post and your block list.',
    'Give me the handle. "block @handle" or a profile link. I do not guess who "them" is, on purpose: a pronoun resolved against something I just read is a command from that post, not from you.',
  ],
  post: [
    'Attach the post or paste its link and I will harvest and score it.',
    'Send me the post, either attached or as a link, and I will run it.',
  ],
  // Its own wording, because the `post` nudge promises a harvest and a score,
  // and a thread read is neither.
  thread: [
    'Name the post and I will read the thread on it. Paste the link, attach it, or pick a number from a digest.',
    'Give me the post link and I will read what the replies are saying.',
  ],
  plan: [
    'Which plan? Send the code from the plan message, like "approve 3f9a2c1b UNKNOWN".',
    'I need the plan code. It is in the message with the band counts.',
  ],
  read: [
    'Name the account and I will read their recent posts. "read @handle", or a profile link.',
    'Who should I read? Give me the handle or a profile link.',
  ],
};

export function nudge(kind, rng = Math.random) {
  const list = Object.hasOwn(NUDGE, kind ?? '') ? NUDGE[kind] : NUDGE.actor;
  return pick(list, rng);
}
