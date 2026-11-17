// The shield's settings, read from the environment and checked. Pure, so the
// rules about what each setting accepts are tested without starting the bot.
//
// The shield watches who replies to, quotes and mentions the owner (the
// Spacedust stream, ownerActivity.js) and, past a threshold, closes replies
// or turns off quotes on the owner's posts. Attack mode does that to every
// recent post at once. See shield.js for what each one does.

/** What a threshold looks like: "12/15m", "40/30m", "6/1h", "0" or "off". */
const RATE = /^(\d{1,4})\s*\/\s*(\d{1,4})\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/i;

/**
 * A threshold: so many distinct accounts outside the owner's circle within a
 * window. null when it is turned off ("0", "off", "none"). `fallback` when
 * unset. Throws on anything else, so a typo is a refusal to start rather than
 * a trigger that never fires.
 *
 * @returns {{ count: number, windowMs: number } | null}
 */
export function parseRate(raw, fallback) {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  if (/^(0|off|none|no|false)$/i.test(text)) return null;
  const m = RATE.exec(text);
  if (!m) throw new Error(`"${text}" is not a threshold like 12/15m`);
  const count = Number(m[1]);
  const span = Number(m[2]);
  const minutes = /^h/i.test(m[3]) ? span * 60 : span;
  if (count < 1 || minutes < 1) {
    throw new Error(`"${text}" needs a count and a window above 0`);
  }
  // Longer than the stream keeps (ownerActivity.KEEP_MS), the window could
  // never fill.
  if (minutes > 6 * 60) {
    throw new Error(`"${text}" has a window longer than 6 hours`);
  }
  return { count, windowMs: minutes * 60_000 };
}

/** A rate as the owner would write it. */
export function rateText(rate) {
  if (!rate) return 'off';
  const m = rate.windowMs / 60_000;
  return `${rate.count}/${m % 60 === 0 ? `${m / 60}h` : `${m}m`}`;
}

/** Who may still reply once replies are closed, as the owner types it. */
export const REPLY_RULE_WORDS = new Map([
  ['following', 'following'],
  ['follows', 'following'],
  ['people i follow', 'following'],
  ['followers', 'followers'],
  ['my followers', 'followers'],
  ['mentioned', 'mentioned'],
  ['mentions', 'mentioned'],
  ['mention', 'mentioned'],
  ['nobody', 'nobody'],
  ['no one', 'nobody'],
  ['noone', 'nobody'],
  ['none', 'nobody'],
]);

/** The rule words in the order they are always written. */
const RULE_ORDER = ['following', 'followers', 'mentioned', 'nobody'];

/**
 * "following,mentioned" as the rule words it names, in a fixed order.
 * "nobody" alone means nobody; next to anything else it makes no sense and is
 * refused. Throws on a word it does not know.
 *
 * @returns {string[]} e.g. ['following', 'mentioned'], or ['nobody']
 */
export function parseReplyRule(raw, fallback = ['following', 'mentioned']) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!text) return fallback;
  const words = text
    .split(/\s*(?:,|\band\b|\bor\b|\+|&)\s*/)
    .map((w) => w.trim())
    .filter(Boolean);
  const out = new Set();
  for (const w of words) {
    const rule = REPLY_RULE_WORDS.get(w);
    if (!rule) {
      throw new Error(
        `"${w}" is not one of following, followers, mentioned or nobody`,
      );
    }
    out.add(rule);
  }
  if (out.has('nobody') && out.size > 1) {
    throw new Error('"nobody" cannot go with anyone else');
  }
  return RULE_ORDER.filter((r) => out.has(r));
}

const MODES = ['off', 'ask', 'auto'];

function mode(raw, fallback, name, problems) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!text) return fallback;
  if (MODES.includes(text)) return text;
  problems.push(`${name} must be off, ask or auto, not "${raw}"`);
  return fallback;
}

function whole(raw, fallback, name, { min, max }, problems) {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max}`);
    return fallback;
  }
  return n;
}

function flag(raw, fallback, name, problems) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!text) return fallback;
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  problems.push(`${name} must be true or false, not "${raw}"`);
  return fallback;
}

function rate(raw, fallback, name, problems) {
  try {
    return parseRate(raw, fallback);
  } catch (err) {
    problems.push(`${name}: ${err.message}`);
    return fallback;
  }
}

/** An app password: four groups of four, lowercase letters and digits. */
export const APP_PASSWORD = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;

/**
 * Everything the shield reads from the environment, and what is wrong with it.
 *
 * Defaults, and why:
 *   MOD_SHIELD=off          per-post triggers are opt-in. A dozen strangers
 *                           replying within a quarter hour is an ordinary
 *                           good day for a post that travels, and the
 *                           existing alert already says when one takes off.
 *   MOD_ATTACK=ask          a trip is rarer and costlier to miss (40 strangers
 *                           in half an hour, across everything). Ask changes
 *                           nothing by itself: it is one DM with a 👍. Auto
 *                           would lock every recent post without anyone
 *                           saying so, which is the owner's call to make.
 *   restore after 24h       a gate the bot put on by itself should not outlive
 *                           the pile-on that caused it. It waits for an hour
 *                           with no strangers on the post, and "keep closed"
 *                           makes it stay.
 *   hide replies off        hiding is visible to everyone reading the thread,
 *                           and a stranger defending the owner would be hidden
 *                           as readily as one attacking them. Closing replies
 *                           already stops new ones.
 *   detach quotes on        a dunk quote keeps the owner's post as its
 *                           payload; detaching is undone at stand-down.
 *
 * @returns {{ shield: object, problems: string[] }}
 */
export function readShieldConfig(env = process.env) {
  const problems = [];
  const password = String(env.MOD_OWNER_APP_PASSWORD ?? '').trim();
  if (password && !APP_PASSWORD.test(password)) {
    problems.push(
      'MOD_OWNER_APP_PASSWORD must be an app password (xxxx-xxxx-xxxx-xxxx) for your own account, never your account password',
    );
  }
  if (password && password === String(env.MOD_APP_PASSWORD ?? '').trim()) {
    problems.push(
      'MOD_OWNER_APP_PASSWORD is the same as MOD_APP_PASSWORD; it must be an app password for YOUR account, and MOD_APP_PASSWORD one for the bot',
    );
  }
  let replyRule;
  try {
    replyRule = parseReplyRule(env.MOD_SHIELD_REPLY_RULE);
  } catch (err) {
    problems.push(`MOD_SHIELD_REPLY_RULE: ${err.message}`);
    replyRule = ['following', 'mentioned'];
  }
  const shield = {
    /** Whether gates can be written at all: the owner gave an app password. */
    canGate: Boolean(password) && APP_PASSWORD.test(password),
    mode: mode(env.MOD_SHIELD, 'off', 'MOD_SHIELD', problems),
    replies: rate(
      env.MOD_SHIELD_REPLIES,
      { count: 12, windowMs: 15 * 60_000 },
      'MOD_SHIELD_REPLIES',
      problems,
    ),
    quotes: rate(
      env.MOD_SHIELD_QUOTES,
      { count: 6, windowMs: 15 * 60_000 },
      'MOD_SHIELD_QUOTES',
      problems,
    ),
    replyRule,
    restoreHours: whole(
      env.MOD_SHIELD_RESTORE_HOURS,
      24,
      'MOD_SHIELD_RESTORE_HOURS',
      { min: 0, max: 24 * 30 },
      problems,
    ),
    attack: {
      mode: mode(env.MOD_ATTACK, 'ask', 'MOD_ATTACK', problems),
      trip: rate(
        env.MOD_ATTACK_TRIP,
        { count: 40, windowMs: 30 * 60_000 },
        'MOD_ATTACK_TRIP',
        problems,
      ),
      hours: whole(
        env.MOD_ATTACK_HOURS,
        24,
        'MOD_ATTACK_HOURS',
        { min: 1, max: 24 * 14 },
        problems,
      ),
      days: whole(env.MOD_ATTACK_DAYS, 7, 'MOD_ATTACK_DAYS', { min: 1, max: 90 }, problems),
      maxPosts: whole(
        env.MOD_ATTACK_MAX_POSTS,
        100,
        'MOD_ATTACK_MAX_POSTS',
        { min: 1, max: 500 },
        problems,
      ),
      detachQuotes: flag(
        env.MOD_ATTACK_DETACH_QUOTES,
        true,
        'MOD_ATTACK_DETACH_QUOTES',
        problems,
      ),
      hideReplies: flag(
        env.MOD_ATTACK_HIDE_REPLIES,
        false,
        'MOD_ATTACK_HIDE_REPLIES',
        problems,
      ),
      watches: whole(
        env.MOD_ATTACK_WATCHES,
        3,
        'MOD_ATTACK_WATCHES',
        { min: 0, max: 10 },
        problems,
      ),
    },
  };
  return { shield, problems };
}
