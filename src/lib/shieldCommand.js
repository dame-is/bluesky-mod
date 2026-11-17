// What the owner types to the shield, parsed rather than interpreted. No
// model is involved: every one of these changes the owner's own posts, and
// the rule for the list holds here too. A command is the owner's literal text,
// and the post it acts on is one the owner put in the message (attached,
// pasted or typed) or the one they sent last.
//
// The phrasing is forgiving because these get typed in a hurry: "lock
// replies", "close the replies on this", "no quotes", "shields up for 12h",
// "all clear". Each one also has a canonical form, which is what menus and
// stored questions carry, so a "1" or a 👍 runs exactly what was shown.

import { extractTargets } from './target.js';
import { parseReplyRule } from './shieldConfig.js';

/** Politeness that changes nothing, in front of a command or after it. */
const LEAD = /^(?:(?:please|pls|plz|ok|okay|hey|yo|can you|could you|would you|go ahead and|just|now)\s+)+/i;
const TAIL = /\s+(?:please|pls|plz|now|thanks|thank you|asap)$/i;

/** How long, as typed: "for 12h", "for 2 days", "12 hours". */
const DURATION =
  /(?:\bfor\s+)?\b(\d{1,3})\s*(h|hr|hrs|hour|hours|d|day|days)\b/i;

const VERBS = [
  {
    action: 'status',
    // "attack mode" alone turns it on (below); asked as a question, or with
    // "status", it is reported on.
    match: /^(?:shields?(?:\s+status)?\s*[?.!]*|attack\s+mode\s+status\s*[?.!]*|attack\s+mode\s*\?+)$/i,
  },
  {
    action: 'status',
    match: /^(?:is\s+the\s+shield\s+(?:on|up)|what(?:'s| is)\s+(?:locked|shielded|closed))\s*[?.!]*$/i,
  },
  // Before 'up', so "attack mode off" is not read as "attack mode".
  {
    action: 'down',
    match:
      /^(?:shields?\s+down|stand\s+down|all\s+clear|attack\s+mode\s+off|(?:end|lift|stop)\s+(?:the\s+)?lock\s*down|unlock\s+everything|reset\s+the\s+breaker)\b/i,
  },
  {
    action: 'up',
    match:
      /^(?:shields?\s+up|attack\s+mode(?:\s+on)?|(?:go\s+into\s+)?lock\s*down|lock\s+(?:it\s+all|everything)(?:\s+down)?|circuit\s+breaker|trip\s+the\s+breaker)\b/i,
  },
  {
    action: 'close',
    match:
      /^(?:close|lock|limit|restrict|turn\s+off|disable|shut(?:\s+off)?|stop)\s+(?:the\s+|my\s+)?replies\b/i,
  },
  {
    action: 'open',
    match:
      /^(?:open|re-?open|unlock|turn\s+on|enable|re-?enable|allow)\s+(?:the\s+|my\s+)?replies\b/i,
  },
  {
    action: 'quotesOff',
    match:
      /^(?:(?:disable|turn\s+off|stop|lock|no)\s+(?:the\s+|my\s+)?quote(?:s|\s+posts)?|quotes?\s+off)\b/i,
  },
  {
    action: 'quotesOn',
    match:
      /^(?:(?:enable|re-?enable|turn\s+on|allow|unlock|re-?open)\s+(?:the\s+|my\s+)?quote(?:s|\s+posts)?|quotes?\s+on)\b/i,
  },
  {
    action: 'keep',
    match: /^keep\s+(?:it\s+|them\s+|this\s+|that\s+)?(?:closed|locked|shut|off|limited)\b/i,
  },
  // Canonical only, for menus: start a watch on a post the shield named.
  { action: 'watch', match: /^shield\s+watch\b/i },
];

/** Words around a command that change nothing about it. */
const FILLER = new Set([
  'on', 'in', 'for', 'this', 'that', 'it', 'my', 'the', 'a', 'post', 'thread',
  'one', 'here', 'there', 'now', 'please', 'pls', 'everything', 'everywhere',
  'all', 'posts', 'again', 'mode',
]);

/** The actions that need a post. */
const NEEDS_POST = new Set(['close', 'open', 'quotesOff', 'quotesOn', 'keep', 'watch']);

/** The actions that change something, as opposed to reporting. */
const WRITES = new Set(['up', 'down', 'close', 'open', 'quotesOff', 'quotesOn', 'keep', 'watch']);

/**
 * Is this a shield command, and if so what, on which post?
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string|null} [opts.embedUri]  the post attached to the message
 * @param {string[]} [opts.links]        full URLs from the message's facets
 * @returns {null | {
 *   action: string, post: string|null, needsPost: boolean,
 *   rule: string[]|null, ruleError: string|null, hours: number|null,
 *   write: boolean, raw: string
 * }}
 *   `post` is the target as given (an at:// URI or a link), for the caller to
 *   resolve. Null with `needsPost` means the caller may fall back to the post
 *   last sent, and asks when there is none.
 */
export function parseShieldCommand(text, { embedUri = null, links = [] } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const said = raw.replace(LEAD, '').replace(TAIL, '').trim();
  const verb = VERBS.find((v) => v.match.test(said));
  if (!verb) return null;
  const rest = said.replace(verb.match, '').trim();

  const post =
    extractTargets(rest)[0] ||
    links.find((l) => extractTargets(l).length) ||
    embedUri ||
    null;

  // "close replies to followers": who may still reply. Only after "to" or
  // "except", so a word in a pasted link is never read as a rule.
  let rule = null;
  let ruleError = null;
  if (verb.action === 'close') {
    const words = rest.replace(/\S*(?:at:\/\/|https?:\/\/)\S*/g, ' ');
    const m = /\b(?:to|except(?:\s+for)?|only\s+for|but)\s+(.+)$/i.exec(words);
    if (m) {
      const who = m[1]
        .toLowerCase()
        .replace(/[.!?]+$/, '')
        .replace(/\b(?:people|accounts|those|folks)\s+i\s+follow\b/g, 'following')
        .replace(/\bi\s+follow\b/g, 'following')
        .replace(/\b(?:my|the|just|only|people|accounts|those)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      try {
        rule = parseReplyRule(who);
      } catch (err) {
        ruleError = err.message;
      }
    }
  }

  let hours = null;
  if (verb.action === 'up') {
    const d = DURATION.exec(rest);
    if (d) {
      const n = Number(d[1]);
      hours = /^d/i.test(d[2]) ? n * 24 : n;
    }
  }

  // Anything left that is not the post, who may reply, how long, or filler
  // means the message says more than this command does ("stop replies from
  // that guy"), so it is not one. It goes on to the list commands or the
  // model, rather than closing replies on a post nobody named.
  if (verb.action !== 'watch') {
    const left = rest
      .replace(/\S*(?:at:\/\/|https?:\/\/)\S*/g, ' ')
      .replace(verb.action === 'close' ? /\b(?:to|except(?:\s+for)?|only\s+for|but)\s+.+$/i : /$^/, ' ')
      .replace(verb.action === 'up' ? DURATION : /$^/, ' ')
      .toLowerCase()
      .split(/[\s,.!?]+/)
      .filter((w) => w && !FILLER.has(w));
    if (left.length) return null;
  }

  return {
    action: verb.action,
    post: NEEDS_POST.has(verb.action) ? post : null,
    needsPost: NEEDS_POST.has(verb.action) && !post,
    rule,
    ruleError,
    hours,
    write: WRITES.has(verb.action),
    raw,
  };
}

/**
 * The canonical text of a command, which parses back to the same thing. What
 * menus and stored 👍 questions carry.
 */
export function shieldCommandText({ action, post = null, rule = null, hours = null }) {
  switch (action) {
    case 'status':
      return 'shield status';
    case 'up':
      return hours ? `shields up for ${hours}h` : 'shields up';
    case 'down':
      return 'shields down';
    case 'close':
      return `close replies ${post}${rule?.length ? ` to ${rule.join(',')}` : ''}`;
    case 'open':
      return `open replies ${post}`;
    case 'quotesOff':
      return `disable quotes ${post}`;
    case 'quotesOn':
      return `enable quotes ${post}`;
    case 'keep':
      return `keep closed ${post}`;
    case 'watch':
      return `shield watch ${post}`;
    default:
      throw new Error(`no shield command ${action}`);
  }
}

/** Is this stored command one of the shield's? For a 👍 that runs it. */
export const isShieldCommand = (text) => Boolean(parseShieldCommand(text));
