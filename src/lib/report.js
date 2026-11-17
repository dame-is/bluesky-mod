// The account report, rendered rather than written.
//
// A lookup is a form with the same fields every time, so it is a template
// filled from what score.js already computed. A model would cost a call and
// give a different shape on every answer, and buy prose where a table is
// wanted.
//
// The template is editable in the config file; the values are not, and one of
// them is written by the account being looked at. A display name carrying a
// newline could forge a line such as "Band: PROTECTED" that reads exactly like
// a field this code produced. So every substituted value is flattened to one
// line and capped before it is used.

import { multiListOn } from './listChoice.js';
import { accountLine, rows, stack } from './stack.js';

/**
 * What a lookup looks like unless the owner changes it: the account, a
 * summary line, then one fact per row, for a narrow chat bubble.
 */
export const DEFAULT_REPORT_TEMPLATE = [
  '@{handle}',
  '{summary}',
  '',
  'name: "{displayName}"',
  'your circle: {vouches} follow them',
  'relationship: {relationship}',
  'distance: {distance}',
  'age: {ageDays} days',
  'posts: ~{postsPerDay}/day',
  'lists: {lists}',
].join('\n');

/** What an empty field shows. */
const EMPTY = '-';

/**
 * One line, bounded.
 *
 * A newline in a field can add a row that looks like this code wrote it.
 * \p{C} covers control and format characters together, which also catches the
 * bidi overrides that reorder a line without adding anything visible. The cap
 * keeps a 300-character display name from pushing the real fields out of a
 * chat bubble, and counts code points so a cut never lands inside a surrogate
 * pair.
 */
export function sanitiseField(value, { max = 64 } = {}) {
  if (value === null || value === undefined || value === '') return EMPTY;
  const flat = String(value)
    .replace(/\p{C}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return EMPTY;
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

/** How this account stands to the owner, in words rather than three booleans. */
export function relationshipOf(a) {
  // First, because it settles the rest: someone who blocks you cannot reply to
  // or quote you while the block stands.
  if (a.blocksYou) return 'they block you';
  if (a.mutual) return 'mutual';
  if (a.youFollow) return 'you follow them';
  if (a.followsYou) return 'they follow you';
  return 'none';
}

/** Which of the owner's lists already hold them. */
export function listsOf(a) {
  const on = [];
  if (a.alreadyListed) on.push('moderation list');
  if (a.protectedReason) on.push(`protected (${a.protectedReason})`);
  return on.length ? on.join(', ') : 'none';
}

/** Every variable a template may use. */
function variablesFor(account) {
  const num = (n) =>
    typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : EMPTY;
  return {
    handle: account.handle || account.did,
    summary: accountLine(account),
    did: account.did,
    displayName: account.displayName || '',
    band: account.band,
    trust: account.trust,
    distance: account.distance,
    vouches: account.vouches ?? 0,
    followers: num(account.followers),
    follows: num(account.follows),
    posts: num(account.posts),
    ageDays: num(account.ageDays),
    postsPerDay:
      typeof account.postsPerDay === 'number'
        ? account.postsPerDay.toFixed(0)
        : EMPTY,
    relationship: relationshipOf(account),
    lists: listsOf(account),
    protectedReason: account.protectedReason || '',
  };
}

/**
 * Fill `template` from `vars`.
 *
 * An unknown {placeholder} is left alone rather than blanked, so a typo in the
 * config file shows up in the output instead of silently deleting a line. A
 * blank template falls back to the default, since an empty report helps
 * nobody.
 */
function fill(template, fallback, vars, max) {
  return String(template || fallback).replace(/\{(\w+)\}/g, (whole, key) =>
    Object.hasOwn(vars, key) ? sanitiseField(vars[key], { max }) : whole,
  );
}

/** Fill the account report template. */
export function renderReport(account, { template } = {}) {
  return fill(template, DEFAULT_REPORT_TEMPLATE, variablesFor(account), 64);
}

/**
 * What this bot can do, said out loud by code rather than by a model. A model
 * asked what it can do reads the same prompt whether or not a tool is wired
 * up behind it, and answers confidently either way.
 *
 * Writes are left out for a read-only sender rather than listed and refused,
 * the same rule the menus follow: a menu of buttons that reject you teaches
 * you to stop reading the menu. For the same reason, commands that need a
 * model are left out when none is set up.
 */
export function helpText({ canWrite = true, hasModel = true } = {}) {
  const network = [
    'what the network is saying',
    '  pulse                     what your circle is talking about, last 24h',
    '  pulse 3d                  same, over three days (or 72, or 168)',
    '  pulse amplified           only what they reposted, and who passed it on',
    '  pulse about atproto       only posts mentioning that',
    '  pulse <feed or list link> any custom feed or list, same window',
    '  thread <post link>        what a cited post is actually arguing about',
    '  Or just ask: "what are the people I follow talking about today?"',
    '  A digest numbers what it names, links each one, and takes a number back.',
    '',
  ];
  const reads = [
    ...(hasModel ? network : []),
    'one account',
    '  @handle                   band, vouches, reach, tenure',
    ...(hasModel
      ? ['  read @handle              what they actually post about']
      : []),
    '  history @handle           every decision recorded about them',
    '',
    'one post',
    '  <paste a link>            score everyone who engaged with it',
  ];
  const writes = [
    '',
    'changing the list',
    '  add likers <post>         harvest, score, propose a batch',
    '  review <code>             the accounts in it that need a look',
    '  approve <code> UNKNOWN    add that band only',
    '  block @handle             add one account to the list',
    '  unblock @handle           take them back off',
    '  undo                      take back the last change when it was an add',
  ];
  // The owner's own posts. Only the owner may run these; the shield says so
  // to a writer who tries.
  const shield = [
    '',
    'your own posts',
    '  shield                    what is on, and what I have limited',
    '  close replies <post>      only people you follow and mention can reply',
    '  no quotes <post>          turn quote posts off (open / enable undo them)',
    '  shields up / shields down lock every recent post, then put it all back',
  ];
  // Multi-list mode only: with one list there is nothing to choose.
  const lists = [
    '',
    'your lists',
    '  lists                     your lists, numbered',
    '  new list <name>           make another moderation list',
    '  block @handle to spam     name the list, by name or number',
    '  A block or approval that names none asks "Which list?"; answer 1, 2, 3.',
  ];
  const tail = [
    '',
    'Replies that end in a numbered menu take a number instead of retyping.',
  ];
  const listing = multiListOn()
    ? canWrite
      ? lists
      : lists.slice(0, 3)
    : [];
  return [
    ...reads,
    ...(canWrite ? [...writes, ...shield] : []),
    ...listing,
    ...tail,
  ].join('\n');
}

/**
 * How a menu names an account. A missing handle, or one that does not verify
 * ("handle.invalid"), cannot be resolved, so those use the bare DID.
 */
function actorRef(a) {
  return a.handle && a.handle !== 'handle.invalid' ? `@${a.handle}` : a.did;
}

/**
 * How a write in a menu names an account: by DID. A menu is pressed up to 30
 * minutes after it is shown, and a handle resolved then can point at someone
 * else by that time.
 */
const writeRef = (a) => a.did || actorRef(a);

/**
 * What the owner can do about this account, as parseable commands.
 *
 * PROTECTED gets no add option. The write would refuse it anyway, and a button
 * that exists to be rejected is worse than no button. For the same reason the
 * read is left out when no model is set up, as helpText leaves it out.
 */
export function actionsFor(account, { hasModel = true } = {}) {
  const at = actorRef(account);
  const did = writeRef(account);
  const out = [];
  if (!account.protectedReason) {
    out.push({ label: `Add ${at} to the list`, command: `list add ${did}` });
  }
  out.push({
    label: `Remove ${at} from the list`,
    command: `list remove ${did}`,
  });
  // A way to learn something before acting. The band answers "who would notice
  // if I blocked them" and says nothing about conduct, which is usually the
  // question being asked. Offering the read beside the act keeps the band from
  // being taken as a verdict.
  if (hasModel) {
    out.push({
      label: `Read ${at}'s recent posts first`,
      command: `read ${at}`,
    });
  }
  return out;
}

/**
 * A post-scan template for the config file's `postReport`. The scan report
 * itself is laid out by code (stackedPlan), which leaves out empty rows, a
 * thing a template with no conditionals cannot do.
 */
export const DEFAULT_PLAN_TEMPLATE = [
  'post by @{author}',
  '{authorSummary}',
  '',
  'engagers: {participants}',
  '',
  'unknown: {UNKNOWN}',
  'peripheral: {PERIPHERAL}',
  'notable: {NOTABLE}',
  'connected: {CONNECTED}',
  'protected: {PROTECTED}',
  '',
  'plan: {code}',
  'adding all: {cost}',
].join('\n');

/**
 * What a cut harvest means for the numbers above it. The harvest is cut when
 * a source hits the page cap, never answers, or is one of too many unfamiliar
 * kinds to page.
 */
const CUT_SHORT =
  'not every engagement was read, so these counts cover part of the post';

/** Engagement kinds as a reply names them, one and many. */
const KIND_NAMES = {
  like: ['like', 'likes'],
  repost: ['repost', 'reposts'],
  reply: ['reply', 'replies'],
  threadReply: ['reply in the thread', 'replies in the thread'],
  quote: ['quote', 'quotes'],
  gate: ['reply setting', 'reply settings'],
  other: ['other engagement', 'other engagements'],
};

/**
 * What a harvest could not read, as words: "900 likes, 12 other
 * engagements". Empty when it read everything it found.
 */
export function unreadText(unread) {
  return (unread || [])
    .map(({ kind, count }) => {
      const [one, many] = KIND_NAMES[kind] || KIND_NAMES.other;
      return `${Number(count || 0).toLocaleString('en-US')} ${count === 1 ? one : many}`;
    })
    .join(', ');
}

/** Why a scan is cut short, with what went unread when that is known. */
function cutShort(plan) {
  const missing = unreadText(plan.unread);
  return missing
    ? `not every engagement was read (${missing} could not be), so these counts cover part of the post`
    : CUT_SHORT;
}

/** Every variable a post-scan template may use. */
function planVariablesFor(plan) {
  const byBand = plan.byBand || {};
  const needsLook = Object.entries(byBand)
    .filter(([b, n]) => b !== 'UNKNOWN' && n)
    .map(([b, n]) => `${n} ${b}`)
    .join(', ');
  const engagements = Object.entries(plan.engagements || {})
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
  return {
    uri: plan.uri,
    code: plan.code,
    kind: plan.kind,
    author: plan.author?.handle || plan.author?.did || 'unknown',
    withText: plan.withText ?? 0,
    authorBand: plan.author?.band || 'UNSCORED',
    authorVouches: plan.author?.vouches ?? 0,
    authorFollowers: plan.author?.followers ?? null,
    authorSummary: plan.author ? accountLine(plan.author) : '',
    participants: plan.total,
    engagements: engagements || EMPTY,
    needsLook: needsLook || 'none',
    truncated: plan.truncated ? `yes, ${cutShort(plan)}` : 'no',
    cost: plan.cost || '',
    ...byBand,
  };
}

/**
 * Fill the post-scan template.
 *
 * A cut harvest gets a line of its own, because "UNKNOWN: 5,800" from a
 * viral post otherwise reads as everyone who engaged. The template has no
 * conditionals and "Cut short: no" on every scan is a line nobody reads, so
 * the line is added only when it is true, unless the template places
 * {truncated} itself.
 */
export function renderPlanReport(plan, { template } = {}) {
  if (!template) return stackedPlan(plan);
  const body = fill(template, DEFAULT_PLAN_TEMPLATE, planVariablesFor(plan), 120);
  if (!plan.truncated || String(template).includes('{truncated}')) return body;
  return `${body}\n\nCut short: ${cutShort(plan)}.`;
}

/**
 * The scan report as code lays it out: the author, who engaged and how, by
 * band, what is already done, then the plan and what adding everyone costs.
 * Every value is a count or written by code, apart from the author's handle,
 * which cannot hold a space or a line break.
 */
function stackedPlan(plan) {
  const e = plan.engagements || {};
  const b = plan.byBand || {};
  const a = plan.author;
  return stack(
    a
      ? [`post by @${a.handle || a.did}`, accountLine(a)]
          .filter(Boolean)
          .join('\n')
      : 'post',
    rows([
      ['engagers', plan.total],
      ['likers', e.like],
      ['reposters', e.repost],
      ['quoters', e.quote],
      ['repliers', Math.max(e.reply || 0, e.threadReply || 0)],
    ]),
    plan.truncated ? cutShort(plan) : null,
    rows(
      ['unknown', 'peripheral', 'notable', 'connected', 'protected'].map(
        (k) => [k, b[k.toUpperCase()]],
      ),
    ),
    rows([
      ['already on list', plan.alreadyListed],
      ['block you', plan.blocksYou],
    ]),
    rows([
      ['plan', plan.code],
      ['adding all', plan.cost],
    ]),
  );
}

/**
 * What the owner can do about a scanned post.
 *
 * Bands with nothing in them get no option: an approval that would carry zero
 * accounts is a button that does nothing, and a menu of those teaches you to
 * stop reading the menu. Reading and sorting by tone need a model, so they are
 * left out when there is none.
 */
export function planActions(plan, { hasModel = true } = {}) {
  const byBand = plan.byBand || {};
  const out = [];

  // The author leads. When nobody engaged with a post every band is zero, and
  // the account in front of the owner is still the one who wrote it.
  // PROTECTED gets no add option here, as in actionsFor.
  const author = plan.author;
  const at = author ? actorRef(author) : null;
  if (at && !author.protectedReason) {
    out.push({
      label: `Add the author ${at} to the list`,
      command: `list add ${writeRef(author)}`,
    });
  }
  if (at && hasModel) {
    out.push({
      label: `Read ${at}'s recent posts first`,
      command: `read ${at}`,
    });
  }

  // Bands say who would notice. On a post with hundreds of quotes that is
  // mostly UNKNOWN, with no way to tell an insult from an argument about a
  // policy. So when there are words to read, offer to read them before
  // offering to add everyone.
  if (plan.withText && hasModel) {
    out.push({
      label: `Sort the ${plan.withText} who wrote something by tone`,
      command: `triage ${plan.code}`,
    });
  }

  // An add is counted by who it could still add, as the card counts it. The
  // write skips anyone already on the list, so on a second scan of a post
  // "Add the 300" would add 10. The review shows every scored account in the
  // plan, listed or not, so its count stays the whole plan's.
  const canAdd = plan.fresh?.byBand || byBand;
  const addTotal = plan.fresh?.total ?? plan.total - (byBand.PROTECTED || 0);
  const namedIn = (counts) =>
    Object.entries(counts)
      .filter(([b, n]) => b !== 'UNKNOWN' && b !== 'PROTECTED' && n)
      .reduce((t, [, n]) => t + n, 0);

  if (canAdd.UNKNOWN) {
    out.push({
      label: `Add the ${canAdd.UNKNOWN} UNKNOWN accounts`,
      command: `approve ${plan.code} UNKNOWN`,
    });
  }
  const named = namedIn(byBand);
  if (named) {
    out.push({
      label: `Show me the ${named} that need a look`,
      command: `review ${plan.code}`,
    });
  }
  // Without a named band left to add, "Add all" is the UNKNOWN option again.
  if (namedIn(canAdd)) {
    out.push({
      label: `Add all ${addTotal}, every band`,
      command: `approve ${plan.code} ${Object.keys(canAdd)
        .filter((b) => b !== 'PROTECTED' && canAdd[b])
        .join(',')}`,
    });
  }
  out.push({ label: 'Do nothing', command: `cancel ${plan.code}` });
  return out;
}
