// What a threadgate or postgate should become, given the one already there.
// Pure: no network, no store. shield.js reads the current records, asks this
// what to write, and records both.
//
// NEVER LOOSER. A post the owner already limited (in their client, or by an
// earlier trigger) is never opened wider than it was. Allow rules are a union
// of groups who may reply, so a set of rules that is a subset of the current
// ones lets in no one new; any other change could. Hidden replies and
// detached quotes already there are kept, and so is any field this code does
// not know.
//
// Threadgate: `allow` missing means anyone may reply, `allow: []` means
// nobody. Postgate: a disableRule in `embeddingRules` means nobody may quote.

export const THREADGATE = 'app.bsky.feed.threadgate';
export const POSTGATE = 'app.bsky.feed.postgate';

/** The lexicon caps hiddenReplies and detachedEmbeddingUris at 50 each. */
export const MAX_URIS = 50;

const RULE_TYPES = {
  following: 'app.bsky.feed.threadgate#followingRule',
  followers: 'app.bsky.feed.threadgate#followerRule',
  mentioned: 'app.bsky.feed.threadgate#mentionRule',
};
const LIST_RULE = 'app.bsky.feed.threadgate#listRule';
const DISABLE = 'app.bsky.feed.postgate#disableRule';

/** Rule words (shieldConfig.parseReplyRule) as threadgate allow rules. */
export function allowRules(words) {
  if (words.includes('nobody')) return [];
  return words
    .filter((w) => RULE_TYPES[w])
    .map((w) => ({ $type: RULE_TYPES[w] }));
}

/** Who a threadgate's allow rules let reply, in words for a DM. */
export function describeAllow(allow) {
  if (!Array.isArray(allow)) return 'anyone';
  if (!allow.length) return 'nobody';
  const names = allow.map((r) => {
    if (r?.$type === RULE_TYPES.following) return 'people you follow';
    if (r?.$type === RULE_TYPES.followers) return 'your followers';
    if (r?.$type === RULE_TYPES.mentioned) return 'people you mention';
    if (r?.$type === LIST_RULE) return 'people on a list';
    return 'others';
  });
  return [...new Set(names)].join(', ');
}

/** A rule as a comparable key: its type, and its list for a list rule. */
const ruleKey = (r) => `${r?.$type}|${r?.list ?? ''}`;

/**
 * JSON with keys sorted, so two records written in a different key order
 * compare equal. A PDS hands back what was written, but not necessarily in
 * the same key order.
 */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Do two records say the same thing? Two absent records do. */
export const sameRecord = (a, b) =>
  canonical(a ?? null) === canonical(b ?? null);

const union = (a = [], b = []) => [...new Set([...a, ...b])].slice(0, MAX_URIS);

/**
 * The threadgate to write on `post`, or null when the one there already does
 * the job.
 *
 * @param {string} post           the post's at:// URI
 * @param {object|null} existing  the threadgate record there now
 * @param {object} want
 * @param {object[]} [want.allow] allow rules (allowRules); left out, who may
 *   reply stays as it is
 * @param {string[]} [want.hide]  reply URIs to hide
 * @param {string} [want.now]
 * @returns {object|null}
 */
export function nextThreadgate(
  post,
  existing,
  { allow, hide = [], now = new Date().toISOString() } = {},
) {
  const base = existing
    ? { ...existing }
    : { $type: THREADGATE, post, createdAt: now };
  base.$type = THREADGATE;
  base.post = post;

  if (allow !== undefined) {
    const current = existing?.allow;
    if (!Array.isArray(current)) {
      // Open now: any rule is a narrowing.
      base.allow = allow;
    } else {
      const have = new Set(current.map(ruleKey));
      const subset = allow.every((r) => have.has(ruleKey(r)));
      // Fewer of the same groups, or nobody, lets in no one new. Anything
      // else could, so the limit already there stands.
      if (subset && allow.length < current.length) base.allow = allow;
    }
  }
  if (hide.length) {
    const hidden = union(existing?.hiddenReplies, hide);
    if (hidden.length) base.hiddenReplies = hidden;
  }
  if (!existing && base.allow === undefined && !base.hiddenReplies) return null;
  return existing && sameRecord(base, existing) ? null : base;
}

/** Does this threadgate stop anyone from replying? */
export const repliesLimited = (gate) => Array.isArray(gate?.allow);

/** Does this postgate stop quotes? */
export const quotesOff = (gate) =>
  Array.isArray(gate?.embeddingRules) &&
  gate.embeddingRules.some((r) => r?.$type === DISABLE);

/**
 * The postgate to write on `post`, or null when the one there already does
 * the job. `disable` turns quotes off; `detach` lists quote posts to unhook
 * from it.
 *
 * @returns {object|null}
 */
export function nextPostgate(
  post,
  existing,
  { disable = true, detach = [], now = new Date().toISOString() } = {},
) {
  const base = existing
    ? { ...existing }
    : { $type: POSTGATE, post, createdAt: now };
  base.$type = POSTGATE;
  base.post = post;
  if (disable && !quotesOff(existing)) {
    base.embeddingRules = [
      ...(existing?.embeddingRules || []),
      { $type: DISABLE },
    ];
  }
  if (detach.length) {
    const detached = union(existing?.detachedEmbeddingUris, detach);
    if (detached.length) base.detachedEmbeddingUris = detached;
  }
  if (!existing && !base.embeddingRules && !base.detachedEmbeddingUris) {
    return null;
  }
  return existing && sameRecord(base, existing) ? null : base;
}
