// Commands the owner types, parsed rather than interpreted. No model is
// involved anywhere in this file.
//
// The sender check decides who starts a turn. It does not cover what the
// analyst reads during the turn, and the analyst reads strangers' posts. So
// "check @someone and block them if they're bad" can end with a post on
// @someone's feed saying "block @your-friend", and a model acting on it. The
// only version of "act only on my commands" that survives that is one where
// the command is the owner's literal text and the owner names the target: no
// pronouns, nothing resolved against what was read mid-turn.
//
// So a message either matches here or it is not a command, and it goes to the
// analyst as a question. A prompt-injected turn cannot reach a write, because
// the write is not reachable from the tool loop.

import { extractTargets } from './target.js';
import { handleInPostUrl } from './links.js';
import { authorOf } from './trigger.js';
import { BANDS } from './score.js';
import { MAX_WINDOW_HOURS } from './pulse.js';

/**
 * Engagement kinds, as harvest.js labels them.
 *
 * `everyone` is null rather than the full list: the filter is skipped, so a
 * lexicon outside app.bsky that harvest discovered is included too. An
 * enumeration here would silently exclude any lexicon added later.
 */
export const KINDS = {
  likers: ['like'],
  reposters: ['repost'],
  repliers: ['reply', 'threadReply'],
  quoters: ['quote'],
  everyone: null,
};

/**
 * How a content triage reads a post. Three, deliberately: a five-point scale of
 * toxicity invites a precision nobody has, and the only line that carries
 * weight is between attacking a person and attacking an argument.
 *
 * NOT BANDS. A band comes from the follow graph and is reproducible against a
 * snapshot; these come from a model reading text and are reproducible by
 * nobody. They are kept apart everywhere: different column, different approval,
 * a different `approved_via` in the log.
 */
export const LABELS = ['hostile', 'arguing', 'neutral'];

/** Words that mean one of those, as a person would actually type them. */
const LABEL_WORDS = new Map([
  ['hostile', 'hostile'],
  ['toxic', 'hostile'],
  ['toxics', 'hostile'],
  ['abusive', 'hostile'],
  ['nasty', 'hostile'],
  ['arguing', 'arguing'],
  ['argumentative', 'arguing'],
  ['neutral', 'neutral'],
]);

/** The label a word means, or null. */
export function parseLabel(token) {
  return LABEL_WORDS.get(String(token ?? '').toLowerCase()) ?? null;
}

const HANDLE = /^@?([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+)$/i;
const DID = /^did:[a-z]+:[a-zA-Z0-9._%-]+$/;
const PROFILE = /\/profile\/([^/?#\s]+)/;
const CODE = /^[0-9a-f]{4,36}$/;

/** A token without the punctuation a sentence leaves on it. */
const bare = (token) => String(token ?? '').replace(/[),.?!:;]+$/, '');

/**
 * A profile or post link as a client shortens it for display: the path cut
 * short and "..." added, as in "bsky.app/profile/jo.e...". A whole link never
 * has "..." after "/profile/", since neither a handle nor a DID holds two dots
 * in a row.
 */
const SHORTENED = /\/profile\/\S*(?:\.\.\.|…)/;

/**
 * The account one typed word names, or null.
 *
 * A shortened link is not read: once bare() strips its dots, what is left of
 * the handle ("jo.e") can have a handle's shape and would be taken for one.
 * The link facet holds the whole URL, and the callers read that instead.
 */
const typedActor = (token) =>
  SHORTENED.test(String(token ?? '')) ? null : parseActor(bare(token));

/**
 * The verbs, most specific first.
 *
 * Deliberately small. Each entry is a capability, and the list should read
 * like something someone chose.
 */
const VERBS = [
  // Bulk first: "list add likers" must not be read as adding an account called
  // "likers".
  {
    match:
      /^(?:list\s+)?add\s+(?:the\s+)?(likers|reposters|repliers|quoters|everyone)\b/i,
    action: 'plan',
  },
  { match: /^approve\b/i, action: 'approve' },
  { match: /^review\b/i, action: 'review' },
  { match: /^undo\b/i, action: 'undo' },
  { match: /^history\b/i, action: 'history' },
  // Reads an account's posts and reports. Not a write, so a read-only account
  // keeps it. It gives a model's opinion of a person rather than a graph fact,
  // which is why it is named for reading rather than for judging.
  { match: /^read\b/i, action: 'read' },
  // Reads what a plan's accounts wrote and buckets them by tone. The one bulk
  // path whose oracle is a model rather than the graph, which is why it labels
  // and never acts.
  { match: /^triage\b/i, action: 'triage' },
  // Reads a slice of the network. Like `read`, a canned question for the
  // analyst. It is a verb so that follow-ups to a digest are real commands a
  // menu number can resolve to.
  { match: /^(?:pulse|digest)\b/i, action: 'pulse' },
  // The other half of a digest: it says a thing was discussed, and this asks
  // what was said. Also a canned question, and a read.
  { match: /^(?:thread|discussion)\b/i, action: 'thread' },
  // Touches nothing. Anchored to the whole message, unlike the other verbs:
  // they take an argument and find it after a trailing `\b`, but a prefix
  // match here would answer "help me understand why they are connected" (a
  // real question) with a menu.
  { match: /^(?:help|commands|what can you do)[\s?!.]*$/i, action: 'help' },
  { match: /^cancel\b/i, action: 'cancel' },
  { match: /^list\s+add\b/i, action: 'list_add' },
  { match: /^list\s+remove\b/i, action: 'list_remove' },
  { match: /^block\b/i, action: 'list_add' },
  { match: /^unblock\b/i, action: 'list_remove' },
];

/** Ways of saying "the one you just did" that need no code. */
const UNDO_LAST = new Set(['last', 'it', 'that', 'this', 'them', 'those']);

const LINK_FEATURE = 'app.bsky.richtext.facet#link';
const MENTION_FEATURE = 'app.bsky.richtext.facet#mention';

/**
 * A pasted link as its truncated display text ("bsky.app/profile/stra...").
 * It is neither an account nor a word, and the facets carry what it was.
 */
const TRUNCATED = /(\.\.\.|…)|bsky\.app|\/profile\//;

/**
 * The full URLs behind a message's links.
 *
 * A client truncates a pasted URL in the text it stores, and the whole URL
 * lives only in the facet. Reading the text finds a mangled link that looks
 * like the owner pasting a broken one.
 *
 * Trusted input: these are facets on the owner's own message, not on anything
 * read from the network.
 */
export function facetLinks(message) {
  const out = [];
  for (const facet of message?.facets || []) {
    for (const feature of facet?.features || []) {
      if (feature?.$type === LINK_FEATURE && feature.uri) out.push(feature.uri);
    }
  }
  return out;
}

/** The DIDs behind a message's @mentions, which survive truncation entirely. */
export function facetMentions(message) {
  const out = [];
  for (const facet of message?.facets || []) {
    for (const feature of facet?.features || []) {
      if (feature?.$type === MENTION_FEATURE && feature.did)
        out.push(feature.did);
    }
  }
  return out;
}

/**
 * The one account a message's facets name, or null. Two candidates is the
 * same ambiguity as two typed handles, and is refused for the same reason.
 */
function oneFromFacets(links, mentions) {
  const named = [
    ...new Set([...mentions, ...links.map(parseActor).filter(Boolean)]),
  ];
  return named.length === 1 ? named[0] : null;
}

/** A handle, DID, or profile URL, as written by the owner, not as inferred. */
export function parseActor(token) {
  // "@did:..." is how the bot prints an account it has no handle for.
  const raw = String(token ?? '')
    .trim()
    .replace(/^@(?=did:)/, '');
  if (!raw) return null;
  if (DID.test(raw)) return raw;
  const url = raw.match(PROFILE);
  if (url) {
    // A stray "%" in a pasted URL makes decodeURIComponent throw, and this
    // runs on every word of every message.
    let actor;
    try {
      actor = decodeURIComponent(url[1]);
    } catch {
      return null;
    }
    if (DID.test(actor)) return actor;
    const m = actor.match(HANDLE);
    return m ? m[1].toLowerCase() : null;
  }
  const m = raw.match(HANDLE);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Is this message a command, and if so what and against whom?
 *
 * @returns {null | { action: string, actor: string|null, needsTarget: boolean, raw: string }}
 *   `null` means it is not a command: hand it to the analyst.
 *   `needsTarget` means the owner used a verb but named nobody, which is asked
 *   back rather than guessed. "block them" is precisely the case that must not
 *   work.
 */
export function parseCommand(
  text,
  { embedUri = null, links = [], mentions = [] } = {},
) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  const verb = VERBS.find((v) => v.match.test(raw));
  if (!verb) return null;

  const matched = raw.match(verb.match);
  const rest = raw.replace(verb.match, '').trim();

  // --- bulk: propose, then approve -----------------------------------------
  // A plan names a POST, and the post comes from the owner's own message: a
  // link they pasted, or the post they shared. Never from anything the analyst
  // read.
  if (verb.action === 'plan') {
    const kind = matched[1].toLowerCase();
    const target =
      extractTargets(raw)[0] ||
      links.find((l) => extractTargets(l).length) ||
      embedUri ||
      null;
    return { action: 'plan', kind, target, needsTarget: !target, raw };
  }

  // `thread` names a POST, and like `plan` the post comes from the owner's own
  // message: typed, pasted, attached, or picked from a menu this codebase
  // built. Never from anything the analyst read.
  if (verb.action === 'thread') {
    const url =
      rest.split(/\s+/).find((t) => /^https?:\/\//i.test(t)) ||
      links.find((l) => extractTargets(l).length) ||
      null;
    const target =
      extractTargets(raw)[0] ||
      extractTargets(url || '')[0] ||
      embedUri ||
      null;
    return {
      action: 'thread',
      target,
      url,
      handle: handleInPostUrl(url),
      needsTarget: !target,
      raw,
    };
  }

  if (verb.action === 'help') {
    return { action: 'help', needsTarget: false, raw };
  }

  // `pulse` names a slice, a window and how to cut it. Every part is optional
  // and matched literally, so a follow-up composed by `followUpsFor`
  // round-trips through this parser unchanged. That is what lets a menu number
  // resolve to one.
  if (verb.action === 'pulse') {
    const tokens = rest.split(/\s+/).filter(Boolean);
    let slice = null;
    let hours = null;
    let group = null;
    let more = false;
    let focus = null;

    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      const lower = t.toLowerCase();

      // Everything after `about` is the focus, spaces and all, so a phrase
      // survives. It is the last thing on the line by construction.
      if (lower === 'about' || lower === 'mentioning') {
        focus =
          tokens
            .slice(i + 1)
            .join(' ')
            .trim() || null;
        break;
      }
      if (/^(circle|follows|following)$/.test(lower)) {
        slice = 'circle';
        continue;
      }
      if (/^(at:\/\/|https?:\/\/)/i.test(t)) {
        slice = t;
        continue;
      }
      // A window, as a person types one: `72`, `72h`, `3d`, `2 days`.
      //
      // The unit may be in the NEXT token, because "2 days" splits in two, and
      // a bare "2" read as two hours is a window nobody meant. Clamped to what
      // a digest reads, so a menu never labels a window longer than the one
      // that ran.
      const win = lower.match(/^(\d{1,4})(h|hr|hrs|hour|hours|d|day|days)?$/);
      if (win) {
        const next = (tokens[i + 1] || '').toLowerCase();
        const unit =
          win[2] ||
          (/^(h|hr|hrs|hour|hours|d|day|days)$/.test(next) ? next : '');
        if (!win[2] && unit) i += 1;
        const n = Number(win[1]);
        hours = Math.min(MAX_WINDOW_HOURS, /^d/.test(unit) ? n * 24 : n);
        continue;
      }
      if (/^(said|wrote|written|writing)$/.test(lower)) {
        group = 'said';
        continue;
      }
      if (/^(amplified|reposted|shared|boosted)$/.test(lower)) {
        group = 'amplified';
        continue;
      }
      if (lower === 'more' || lower === 'deeper') {
        more = true;
        continue;
      }
    }

    return {
      action: 'pulse',
      slice: slice || 'circle',
      hours: hours || null,
      group,
      // One level, not a counter. A DM caps at 1000 graphemes however many
      // posts the model read, so a second "more" buys nothing.
      more,
      focus,
      needsTarget: false,
      raw,
    };
  }

  // `history` names an account or nothing at all, so it never needs a code.
  // A name it cannot read is asked back. History rows do not name accounts,
  // so the whole record under that name would read as theirs.
  if (verb.action === 'history') {
    const tokens = rest.split(/\s+/).filter((t) => bare(t));
    if (!tokens.length) {
      return { action: 'history', actor: null, needsTarget: false, raw };
    }
    const actor =
      (tokens.length === 1 ? typedActor(tokens[0]) : null) ??
      oneFromFacets(links, mentions);
    const refusal = actor
      ? null
      : `I could not read "${rest.slice(0, 40)}" as an account. ` +
        'Send "history" with a full handle, a DID or a profile link, ' +
        'or "history" alone for everything.';
    return { action: 'history', actor, refusal, needsTarget: !actor, raw };
  }

  // Bare `undo` means the most recent addition still on the list, one block or
  // a whole batch. Undo is the one verb that may default to a target nobody
  // named: every other verb adds someone to a block list, where guessing is
  // the failure that matters, while undo only removes people, who can be added
  // again.
  //
  // A token meant as a code is not defaulted, though. Undoing the most recent
  // plan over a typo would act on a batch the owner did not name.
  if (verb.action === 'undo') {
    const token = bare(rest.split(/\s+/).filter(Boolean)[0]).toLowerCase();
    const code = CODE.test(token) ? token : null;
    const last = !code && (!token || UNDO_LAST.has(token));
    return { action: 'undo', code, last, needsTarget: !last && !code, raw };
  }

  if (
    verb.action === 'approve' ||
    verb.action === 'cancel' ||
    verb.action === 'review' ||
    verb.action === 'triage'
  ) {
    const words = rest
      .split(/[\s,]+/)
      .map((typed) => ({ typed, token: bare(typed) }))
      .filter((w) => w.token);
    const code = (words.shift()?.token || '').toLowerCase();
    const tokens = words.map((w) => w.token);
    const valid = CODE.test(code);
    const bands = tokens
      .map((t) => t.toUpperCase())
      .filter((t) => BANDS.includes(t));
    // "approve <code> toxic" is a different kind of approval from
    // "approve <code> UNKNOWN" and is carried separately all the way down, so
    // the log can say which of the two put someone on the list.
    const labels = [...new Set(tokens.map(parseLabel).filter(Boolean))];
    // Approving named accounts is the personal path: the owner read these and
    // decided. It is recorded differently from a band approval, because "you
    // were in a category I approved" and "I looked at your account" are
    // different answers to "why am I on your list".
    const actors = words.map((w) => typedActor(w.typed)).filter(Boolean);
    // "approve <code> likers": only the accounts that engaged that way, out of
    // a scan of everyone. Read from each row's recorded engagement.
    const kinds = [
      ...new Set(
        tokens
          .map((t) => t.toLowerCase())
          .filter((t) => t !== 'everyone' && Object.hasOwn(KINDS, t)),
      ),
    ];
    // "asof=<time>": only labels given by then. A watch's digest puts it on
    // the approval its 👍 runs, so the 👍 adds what the digest counted and
    // not what later checks labelled.
    const stamps = tokens
      .map((t) => t.match(/^asof=(.+)$/i)?.[1])
      .filter(Boolean)
      .map(Date.parse);
    const asOf =
      stamps.length === 1 && Number.isFinite(stamps[0])
        ? new Date(stamps[0]).toISOString()
        : null;
    const refusal =
      verb.action === 'approve' && valid
        ? approvalRefusal(code, {
            words,
            bands,
            labels,
            actors,
            kinds,
            asOf,
          })
        : null;
    return {
      action: verb.action,
      code: valid ? code : null,
      kinds,
      // PROTECTED is never carried, whatever is typed. The veto is not a
      // default that an approval can talk its way past.
      bands: bands.filter((b) => b !== 'PROTECTED'),
      labels,
      actors,
      asOf,
      // Said back instead of acting. Set with needsTarget, so a caller that
      // only checks needsTarget still adds nobody.
      refusal,
      needsTarget: !valid || Boolean(refusal),
      raw,
    };
  }

  // Exactly one token after the verb. A command naming two accounts is
  // ambiguous, and the safe reading of an ambiguous block is to refuse it.
  const tokens = rest.split(/\s+/).filter(Boolean);
  let actor = tokens.length === 1 ? typedActor(tokens[0]) : null;

  // The token came out of the display text, so a pasted profile link arrives
  // truncated and unresolvable. The facets carry the real thing.
  if (!actor) actor = oneFromFacets(links, mentions);

  // An attached post names its author. The owner put the record in this
  // message and code reads the author out of its URI, so it has the same
  // provenance as a typed handle. That is what separates it from "block them",
  // where a pronoun would be resolved against something the analyst read. It
  // is the rule `add likers` follows too.
  //
  // The wording decides between acting and asking. "block" or "block this guy"
  // acts. "block whoever is in the replies" might mean someone else, so it
  // comes back naming the author and asking. A phrasing POINTER does not know
  // costs one extra tap, never a guess.
  let fromPost = false;
  let confirm = false;
  if (!actor && embedUri) {
    const did = authorOf(embedUri);
    if (did) {
      actor = did;
      fromPost = true;
      confirm = rest
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => t.toLowerCase().replace(/[^a-z]/g, ''))
        .some((w) => w && !POINTER.has(w));
    }
  }

  return {
    action: verb.action,
    actor,
    // So the reply can name who that turned out to be. Acting on an inference
    // without showing it hides a post that was really a quote of somebody
    // else's.
    fromPost,
    // The words did not clearly point at the attached post's author, so show
    // who that is and let the owner say.
    confirm,
    needsTarget: !actor,
    raw,
  };
}

/** Words an approval can carry that change nothing about who it adds. */
const APPROVE_FILLER = new Set([
  'and',
  'the',
  'only',
  'ones',
  'accounts',
  'please',
  '&',
  '+',
]);

/**
 * Why an approval cannot be read one way, said back to the sender, or null.
 *
 * An approval names accounts or a group. A group is bands and engagement
 * kinds ("UNKNOWN likers"), or one tone label, which may be narrowed to bands
 * ("hostile UNKNOWN" is the hostile ones in UNKNOWN). Anything else is refused
 * rather than half read: a word with no place may be an exception ("hostile
 * except @friend"), and dropping it adds the opposite of what was asked. So is
 * a group whose only band is PROTECTED, which would otherwise widen to every
 * band.
 */
function approvalRefusal(code, { words, bands, labels, actors, kinds, asOf }) {
  // PROTECTED is dropped from the bands an approval carries, and no bands
  // means no narrowing, so "hostile PROTECTED" would add the hostile ones in
  // every other band.
  if (bands.length && bands.every((b) => b === 'PROTECTED')) {
    return (
      'PROTECTED is never added, so I have not added anyone. ' +
      `Name another band, like "approve ${code} UNKNOWN", or name the accounts.`
    );
  }
  const unplaced = words.find(({ typed, token }) => {
    const lower = token.toLowerCase();
    return !(
      BANDS.includes(token.toUpperCase()) ||
      parseLabel(token) ||
      Object.hasOwn(KINDS, lower) ||
      typedActor(typed) ||
      (asOf && /^asof=/i.test(token)) ||
      APPROVE_FILLER.has(lower)
    );
  });
  const group = bands.length || labels.length || kinds.length || asOf;
  const why = unplaced
    ? `I do not know what "${unplaced.typed.slice(0, 40)}" means in an approval`
    : actors.length && group
      ? 'That names accounts and a group together'
      : labels.length > 1
        ? 'That names more than one tone label'
        : labels.length && kinds.length
          ? 'A tone label does not combine with likers, reposters, repliers or quoters'
          : asOf && !labels.length
            ? '"asof=" goes only with a tone label'
            : null;
  if (!why) return null;
  return (
    `${why}, so I have not added anyone. Send one kind at a time: ` +
    `"approve ${code} @handle @handle", "approve ${code} UNKNOWN" or "approve ${code} hostile".`
  );
}

/**
 * The verbs that change something the owner owns.
 *
 * `list_add`, `list_remove`, `approve` and `undo` write list items; `cancel`
 * stamps a plan as declined. Everything else only reads and reports, so a
 * read-only account on the roster keeps it.
 *
 * `plan` writes rows to `plan` and `decision` but adds nobody. An unapproved
 * plan is a record of what was nearly done, and a bare shared post runs the
 * same scan, so refusing `plan` would draw a line the sender cannot see.
 * `triage` writes labels and adds nobody; approving what it found is a
 * separate command.
 */
const WRITE_ACTIONS = new Set([
  'list_add',
  'list_remove',
  'approve',
  'undo',
  'cancel',
]);

/** Would running this change the list? */
export function isWrite(cmd) {
  return WRITE_ACTIONS.has(cmd?.action);
}

/**
 * What a read-only account is told when it types one of those.
 *
 * Says what they CAN do rather than only what they cannot, so nobody has to
 * guess which half of the surface still works.
 */
export function readOnlyReply(cmd) {
  const verb =
    String(cmd?.raw ?? '')
      .trim()
      .match(/^(?:list\s+\S+|\S+)/)?.[0] ?? '';
  return (
    `"${verb}" changes the list, and this account is read-only here. ` +
    'Everything that reads still works: paste a handle or a post, or send ' +
    '"review <code>" or "history".'
  );
}

/**
 * A reply that is just a choice: "2", "b", "option 3".
 *
 * A number resolves only against a menu that code built and stored: one behind
 * a plan, a review or a digest, or commands `offersFrom` lifted and relabelled
 * from their parse. A number that appears only in the analyst's prose is not
 * stored and does not resolve, because "2" would then run whatever a model
 * decided while reading a stranger's posts.
 *
 * @returns {number|null} a 1-based index
 */
export function parseChoice(text) {
  const raw = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/^(option|choice)\s+/, '')
    .replace(/[.)\]]+$/, '');
  if (/^[1-9][0-9]?$/.test(raw)) return Number(raw);
  if (/^[a-z]$/.test(raw)) return raw.charCodeAt(0) - 96;
  return null;
}

/**
 * A pulse command, rendered canonically.
 *
 * Round-trips: `parseCommand(pulseCommand(x))` gives back `x`. That property is
 * what makes a follow-up menu safe to build in code: the option the owner
 * presses is re-parsed by the same parser their typing goes through, so there
 * is no second grammar that could drift from the first.
 */
export function pulseCommand({
  slice = 'circle',
  hours = null,
  group = null,
  more = false,
  focus = null,
} = {}) {
  const parts = ['pulse', slice || 'circle'];
  if (hours) parts.push(String(hours));
  if (group) parts.push(group);
  if (more) parts.push('more');
  // Last, because everything after `about` is the focus.
  if (focus) parts.push('about', focus);
  return parts.join(' ');
}

/** A window as a person says it. */
function windowWords(hours) {
  const h = hours || 24;
  if (h < 48) return `last ${h}h`;
  const days = Math.round(h / 24);
  return `last ${days} days`;
}

/** Where a slice is, said in words rather than in a URI. */
function sliceWords(slice) {
  if (!slice || slice === 'circle') return 'your circle';
  return 'that feed';
}

/**
 * A term safe to put in a menu label and in a command.
 *
 * Domains come from links other people posted, so the suggestion behind
 * "narrow to github.com" is attacker-controlled. Bounded to a domain shape (no
 * spaces, newlines or backticks, nothing that reads as prose or closes a
 * fence), because the menu promises that the label names the filter and
 * pressing it runs exactly the command shown. The worst a hostile value buys
 * is a read that matches nothing.
 */
const SAFE_TERM = /^[a-z0-9][a-z0-9.-]{1,40}$/i;

export function safeTerm(term) {
  const t = String(term ?? '').trim();
  return SAFE_TERM.test(t) ? t.toLowerCase() : null;
}

/**
 * A focus phrase safe to render into a command and a label.
 *
 * Wider than SAFE_TERM because a focus is a subject, not a domain: "trans
 * athletes" and "feed generators" are the normal case, and rejecting them would
 * drop the focus from the menu under a digest that was filtered by it. Still
 * no newlines, backticks or angle brackets, and bounded, because the model
 * reads it back on the next turn.
 */
const SAFE_PHRASE = /^[a-z0-9][a-z0-9 .\-_']{0,60}$/i;

export function safePhrase(phrase) {
  const t = String(phrase ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  return SAFE_PHRASE.test(t) ? t : null;
}

/**
 * The arguments a digest ran with, as the shape `followUpsFor` takes.
 *
 * When the owner asks in words, the model chooses the source and the window,
 * so the menu has to describe THAT and not what they might have meant. Each
 * value is validated rather than trusted: it is rendered back into a command
 * string and from there into a prompt, so a source is held to URL characters
 * with no quotes or brackets, and the window is clamped to what a digest
 * reads. Anything unrecognised falls back to the circle, which is what an
 * unqualified question means anyway.
 */
export function pulseFromArgs(args = {}) {
  const raw = String(args.source ?? '').trim();
  const slice = /^(at:\/\/|https?:\/\/)[^\s"'`<>]+$/i.test(raw)
    ? raw
    : 'circle';
  const hours = Number(args.hours);
  return {
    action: 'pulse',
    slice,
    hours:
      Number.isFinite(hours) && hours > 0
        ? Math.min(MAX_WINDOW_HOURS, Math.max(1, Math.round(hours)))
        : 24,
    group: null,
    more: false,
    focus: safePhrase(args.focus),
    needsTarget: false,
    raw: '',
  };
}

/**
 * The posts an answer cited, resolved against the ones the digest returned.
 *
 * The model writes `[7]`; what `[7]` means is decided here, by indexing a table
 * the tool built. So the analyst chooses which post it points at but cannot
 * point at a post the digest never saw. That is what makes the resulting link
 * safe to render as tappable, which this account otherwise never does for a
 * URL it did not construct.
 *
 * A marker with no entry behind it is stripped, with the space before it,
 * rather than left standing: a dangling `[12]` reads as a bug.
 *
 * @returns {{ text: string, cited: Array<{n: number, url: string}> }}
 */
export function citationsIn(text, sample = []) {
  const byN = new Map(
    (sample || [])
      .filter((r) => r && Number.isInteger(r.n) && typeof r.url === 'string')
      .map((r) => [r.n, r.url]),
  );
  const cited = [];
  const seen = new Set();
  const out = String(text ?? '').replace(
    /[ \t]*\[(\d{1,3})\]/g,
    (whole, digits) => {
      const n = Number(digits);
      const url = byN.get(n);
      if (!url) return '';
      if (!seen.has(n)) {
        seen.add(n);
        cited.push({ n, url });
      }
      return whole;
    },
  );
  cited.sort((a, b) => a.n - b.n);
  return { text: out, cited };
}

/** The cited posts as the numbered link list that follows an answer. */
export function renderCitations(cited) {
  return cited.map((c) => `[${c.n}] ${c.url}`).join('\n');
}

/**
 * The follow-ups to a digest, composed by code.
 *
 * Not lifted from the analyst's prose. `offersFrom` covers the case where
 * there is nothing better, and it is only as safe as the owner reading the
 * label. Here the whole menu is a function of the arguments the digest ran
 * with, so pressing 2 runs a read this file wrote, the same standing as the
 * menu behind a plan.
 *
 * Ordered by what is usually wanted next: the cited posts, a bigger sample,
 * the half of the answer that was not shown, a wider window, a narrower topic.
 */
export function followUpsFor(cmd, { terms = [], posts = [], max = null } = {}) {
  // Six options when there are posts to open, four otherwise, so the cited
  // posts do not crowd out the digest variants.
  const cap = max ?? (posts.length ? 6 : 4);
  const base = {
    slice: cmd?.slice || 'circle',
    hours: cmd?.hours || 24,
    group: cmd?.group || null,
    more: Boolean(cmd?.more),
    focus: cmd?.focus || null,
  };
  const out = [];
  const options = [];
  const seen = new Set();

  // Cited posts first: a digest that says a thing was discussed makes you want
  // to read it.
  for (const post of posts.slice(0, 3)) {
    const url = String(post?.url ?? '');
    if (!/^https:\/\/bsky\.app\/profile\/[^/\s]+\/post\/[^/?#\s]+$/.test(url)) {
      continue;
    }
    const command = `thread ${url}`;
    if (seen.has(command)) continue;
    seen.add(command);
    // The marker is appended to the label rather than taken from the parse.
    // Without it, two posts by one account give two identical options, and
    // the number ties each option to the link printed above it. It is safe
    // for the same reason the URL is: both come from the validated citation
    // record, not from prose.
    const label = labelFor(parseCommand(command));
    const n = Number.isInteger(post?.n) ? post.n : null;
    options.push({ label: n ? `${label} [${n}]` : label, command });
  }

  if (!base.more) out.push({ ...base, more: true });
  if (base.group !== 'amplified') {
    out.push({ ...base, group: 'amplified', more: false });
  }
  if (base.group) out.push({ ...base, group: null, more: false });

  const wider =
    base.hours < 72
      ? 72
      : base.hours < MAX_WINDOW_HOURS
        ? MAX_WINDOW_HOURS
        : null;
  if (wider) out.push({ ...base, hours: wider, more: false });

  if (base.focus) {
    out.push({ ...base, focus: null, more: false });
  } else {
    for (const term of terms) {
      const safe = safeTerm(term);
      if (safe) out.push({ ...base, focus: safe, more: false });
    }
  }

  // Deduped on the rendered command, so two paths that arrive at the same
  // digest are one option rather than two identical buttons.
  for (const o of out) {
    const command = pulseCommand(o);
    if (seen.has(command)) continue;
    seen.add(command);
    // The label comes from RE-PARSING the string, never from the object that
    // built it. If the two ever disagree, the label is wrong about what will
    // run, and this is the line that would catch it.
    options.push({ label: labelFor(parseCommand(command)), command });
    if (options.length >= cap) break;
  }
  return options;
}

/** A label from the PARSED command, so the owner reads what will run. */
export function labelFor(cmd) {
  const who = cmd.actor ? `@${String(cmd.actor).replace(/^@/, '')}` : '';
  switch (cmd.action) {
    case 'list_add':
      return `Add ${who} to the list`;
    case 'list_remove':
      return `Remove ${who} from the list`;
    case 'plan':
      return `Scan the ${cmd.kind} of that post`;
    case 'review':
      return cmd.labels?.length
        ? `Show the ${cmd.labels[0]} ones in ${cmd.code}, with their words`
        : `Show the accounts in ${cmd.code} that need a look`;
    case 'approve': {
      if (cmd.actors?.length) {
        const names = cmd.actors.map((a) => `@${a}`).join(', ');
        return `Approve ${names} in ${cmd.code}`;
      }
      // The same precedence as the approval itself: named accounts, then a
      // triage label (with the bands it is narrowed to), then bands and
      // engagement kinds.
      const what = cmd.labels?.length
        ? cmd.bands?.length
          ? `the ${cmd.bands.join(', ')} ones read as ${cmd.labels[0]}`
          : `the ${cmd.labels[0]} ones`
        : [cmd.bands?.join(', '), cmd.kinds?.join(', ')]
            .filter(Boolean)
            .join(' ');
      return what ? `Approve ${what} in ${cmd.code}` : cmd.raw;
    }
    case 'cancel':
      return `Cancel ${cmd.code}`;
    case 'read':
      return `Read ${who}'s recent posts`;
    case 'help':
      return 'What you can ask me';
    case 'thread':
      return cmd.handle
        ? `Read the thread on @${cmd.handle}'s post`
        : 'Read that thread';
    case 'pulse': {
      const where = sliceWords(cmd.slice);
      const when = windowWords(cmd.hours);
      // The focus rides on the verb rather than being appended, or an
      // unfocused label ("talking about") and a focused one collide into
      // "talking about, about github.com".
      const about = cmd.focus ? ` about ${cmd.focus}` : '';
      const verb =
        cmd.group === 'amplified'
          ? `Only what ${where} amplified${about}`
          : cmd.group === 'said'
            ? `Only what ${where} wrote${about}`
            : about
              ? `What ${where} is saying${about}`
              : `What ${where} is talking about`;
      const deeper = cmd.more ? ', deeper sample' : '';
      return `${verb}, ${when}${deeper}`;
    }
    default:
      return cmd.raw;
  }
}

/**
 * Turn the commands the analyst quoted into a menu.
 *
 * The analyst writes its suggestions in backticks. This lifts them out,
 * PARSES EACH ONE, and keeps only what the parser accepts with a target it can
 * name. The label is generated from the parse rather than copied from the
 * prose, so what the owner reads is what will run.
 *
 * What this does and does not buy: a menu behind a plan is safe because the
 * options came from deterministic code. A menu behind PROSE is only as safe as
 * the owner reading the label, because a captured turn could suggest blocking
 * the wrong account and the owner could press 1 without looking. What it does
 * guarantee is that the label names the account, and that pressing 1 runs
 * exactly the command shown.
 *
 * Deduped on the label, so `block @x` and `list add @x`, which are the same
 * operation, are one option rather than two that look identical.
 */
export function offersFrom(text, { max = 4 } = {}) {
  const spans = [...String(text || '').matchAll(/`([^`\n]{2,120})`/g)].map(
    (m) => m[1].trim(),
  );
  const seen = new Set();
  const out = [];
  for (const span of spans) {
    const cmd = parseCommand(span);
    if (!cmd || cmd.needsTarget) continue;
    const label = labelFor(cmd);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, command: span });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Words that clearly mean "whoever wrote the thing I just attached".
 *
 * Not a safety boundary: a word missing from here costs a confirmation, not a
 * wrong block, which is why it can be a plain list. Swearing is in because
 * people swear when they block somebody.
 */
const POINTER = new Set([
  'them',
  'em',
  'they',
  'him',
  'her',
  'it',
  'this',
  'that',
  'these',
  'those',
  'the',
  'a',
  'an',
  'one',
  'guy',
  'gal',
  'dude',
  'person',
  'poster',
  'author',
  'op',
  'account',
  'user',
  'profile',
  'asshole',
  'idiot',
  'creep',
  'troll',
  'please',
  'now',
  'too',
  'also',
]);

/** Words that can surround a handle without turning it into a question. */
const FILLER = new Set([
  'is',
  'this',
  'the',
  'a',
  'an',
  'user',
  'username',
  'account',
  'handle',
  'them',
  'they',
  'it',
  'profile',
  'who',
  'look',
  'lookup',
  'score',
  'check',
  'up',
  'at',
  'about',
  'please',
  'info',
  'on',
]);

/**
 * Is this message just naming an account?
 *
 * A lookup is a form, not a question, and answering it from a template costs no
 * model call. But the trigger has to be narrow or it eats real questions: "what
 * has @x been posting about" must reach the analyst, and "@x" must not.
 *
 * So: exactly one account named, and every other word is filler. Anything
 * carrying its own verb falls through to the analyst, which is the safe
 * direction to be wrong in. A question answered as a report is a worse failure
 * than a report answered as a question.
 *
 * @returns {string|null} the actor, or null if this is not a lookup
 */
export function parseLookup(text, { links = [], mentions = [] } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  const tokens = raw.split(/\s+/).filter(Boolean);
  const actors = [];
  const rest = [];
  for (const token of tokens) {
    const actor = typedActor(token);
    if (actor) actors.push(actor);
    // A truncated link is skipped so the facets can say what it was, instead
    // of the client's display choice refusing the lookup.
    else if (TRUNCATED.test(token)) continue;
    else rest.push(token.toLowerCase().replace(/[^a-z]/g, ''));
  }

  const fromFacets = [
    ...new Set([...mentions, ...links.map(parseActor).filter(Boolean)]),
  ];
  const named = actors.length ? [...new Set(actors)] : fromFacets;
  if (named.length !== 1) return null;

  // Every remaining word has to be filler. A truncated handle leaves a token
  // that is not filler and not an actor, which correctly refuses rather than
  // reporting on whatever the facets happened to contain.
  const leftovers = rest.filter((w) => w && !FILLER.has(w));
  if (leftovers.length) return null;

  return named[0];
}

/**
 * Is this message just putting a post in front of the bot?
 *
 * Same narrow rule as parseLookup, for the same reason. Sharing a post should
 * scan it (a scan is a form and costs no model call), but "what is the
 * sentiment of the replies to this" carries its own verb and belongs to the
 * analyst.
 *
 * @returns {string|null} the post reference, or null
 */
export function parsePostScan(text, { embedUri = null, links = [] } = {}) {
  const raw = String(text ?? '').trim();

  const target = postTargetIn(raw, { embedUri, links });
  if (!target) return null;

  const leftovers = raw
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !extractTargets(t).length && !TRUNCATED.test(t))
    .map((t) => t.toLowerCase().replace(/[^a-z]/g, ''))
    .filter((w) => w && !FILLER.has(w) && !SCAN_FILLER.has(w));

  return leftovers.length ? null : target;
}

/** An at:// URI of a post. A link of the /post/ form is always a post. */
const AT_POST = /^at:\/\/[^/]+\/app\.bsky\.feed\.post\//;
const isPostTarget = (t) => !/^at:\/\//.test(t) || AT_POST.test(t);

/**
 * The post a scan or a watch acts on: the first post in the text, a link, or
 * the shared post. A list, a starter pack or a feed is skipped, since reading
 * one as a post would take its members or subscribers for people who engaged
 * with it.
 */
function postTargetIn(raw, { embedUri = null, links = [] } = {}) {
  return (
    extractTargets(raw).find(isPostTarget) ||
    links.find((l) => extractTargets(l).some(isPostTarget)) ||
    (embedUri && isPostTarget(embedUri) ? embedUri : null)
  );
}

/** Words that can sit beside a pasted post without making it a question. */
const SCAN_FILLER = new Set([
  'post',
  'this',
  'that',
  'here',
  'scan',
  'preflight',
  'thoughts',
  'one',
]);

// --- the quick lane -----------------------------------------------------------

/** Words that can ride along with "block" without changing what it means. */
const QUICK_FILLER = new Set([
  ...POINTER,
  'pls',
  'plz',
  'asap',
  'thanks',
  'thx',
  'ty',
  'jerk',
  'bot',
  'spam',
  'spammer',
]);

const QUICK_VERBS = new Map([
  ['block', 'list_add'],
  ['unblock', 'list_remove'],
]);

/**
 * "block" with one target and nothing else to it: the quick lane.
 *
 * The most common message is a shared post and the word "block", and it needs
 * no model. One verb (block or unblock), exactly one account (a typed handle, a
 * pasted profile or post link, or the author of the attached post), and every
 * other word filler. Anything more (two accounts, "and everyone who liked it",
 * a reason with its own verb) returns null and goes to the agent, which is the
 * safe direction to be wrong in.
 *
 * A typed account AND an attached post is ambiguous (block the poster, or
 * someone in their replies?) and is the agent's to sort out.
 *
 * @returns {null | { action: 'list_add'|'list_remove', actor: string, fromPost: boolean, raw: string }}
 */
export function parseQuick(
  text,
  { embedUri = null, links = [], mentions = [] } = {},
) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  let action = null;
  const typed = [];
  for (const token of raw.split(/\s+/).filter(Boolean)) {
    const word = token.toLowerCase().replace(/[^a-z]/g, '');
    if (!action && QUICK_VERBS.has(word)) {
      action = QUICK_VERBS.get(word);
      continue;
    }
    const actor = typedActor(token);
    if (actor) {
      typed.push(actor);
      continue;
    }
    if (TRUNCATED.test(token)) continue;
    if (word && !QUICK_FILLER.has(word)) return null;
  }
  if (!action) return null;

  const fromFacets = [
    ...new Set([...mentions, ...links.map(parseActor).filter(Boolean)]),
  ];
  const named = [...new Set(typed.length ? typed : fromFacets)];
  if (named.length > 1) return null;
  if (named.length === 1) {
    if (embedUri) return null;
    return { action, actor: named[0], fromPost: false, raw };
  }
  const author = embedUri ? authorOf(embedUri) : null;
  return author ? { action, actor: author, fromPost: true, raw } : null;
}

/** "yes", "go ahead", 👍: a reply to a question the bot just asked. */
const YES =
  /^(y|ya|yes|yep|yeah|yup|ok|okay|k|sure|confirm|confirmed|do it|go|go ahead|go for it|please|please do|yes please|yes do it|do both|both|all of them|add them|block them|👍|✅|👌)[\s.!]*$/iu;
/** "no", "leave it", 👎. Phones type "don’t" with a curly apostrophe. */
const NO =
  /^(n|no|nope|nah|cancel|stop|don['’]?t|do not|never ?mind|nvm|leave it|skip|skip it|no thanks|👎|❌)[\s.!]*$/iu;

/**
 * Text or a reaction without skin tones or the emoji presentation selector,
 * so 👍🏽 and 👍️ read as 👍. A keyboard set to a skin tone sends one with
 * every thumb.
 */
export const bareEmoji = (text) =>
  String(text ?? '').replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}]/gu, '');

export const isYes = (text) => YES.test(bareEmoji(text).trim());
export const isNo = (text) => NO.test(bareEmoji(text).trim());

/**
 * The words a post card answers to, as typed: "likers", "author and likers",
 * "unknowns, hostile". Every word has to be one of `keys` or a joiner, or this
 * is not an answer to the card and the agent gets it.
 *
 * @returns {string[]|null} the keys, in the order typed
 */
export function parseCardWords(text, keys) {
  const raw = String(text ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  const SYNONYM = {
    op: 'author',
    poster: 'author',
    likes: 'likers',
    liked: 'likers',
    unknown: 'unknowns',
    randos: 'unknowns',
    all: 'everyone',
    everybody: 'everyone',
    toxic: 'hostile',
    nasty: 'hostile',
  };
  const JOIN = new Set(['and', 'the', 'too', 'also', 'plus', 'please', 'both']);
  const picked = [];
  for (const token of raw.split(/[\s,+&]+/).filter(Boolean)) {
    const word = token.replace(/[^a-z]/g, '');
    if (!word || JOIN.has(word)) continue;
    const key = SYNONYM[word] || word;
    if (!keys.includes(key)) return null;
    if (!picked.includes(key)) picked.push(key);
  }
  return picked.length ? picked : null;
}

/**
 * remember / forget / what do you remember. Only ever from the owner's literal
 * words: a note in memory is an instruction the agent reads every turn, so the
 * model never writes one, however a post it read was worded.
 *
 * @returns {null | { action: 'remember', text: string }
 *                 | { action: 'forget', index: number|null, text: string|null }
 *                 | { action: 'recall' }}
 */
export function parseMemoryCommand(text) {
  const raw = String(text ?? '').trim();
  if (
    /^(what do you remember|what have i (told|asked) you to remember|what['’]?s in your memory|memory|memories|notes)[\s?!.]*$/i.test(
      raw,
    )
  ) {
    return { action: 'recall' };
  }
  const remember = raw.match(/^remember\b[\s:,-]*(?:that\s+)?([\s\S]+)$/i);
  // "remember when we blocked them?" and "remember the post I sent? add the
  // quoters" are for the agent, not notes. "remember:" with a colon is a note
  // whatever it holds.
  const asked = /\?/.test(raw) && !/^remember\s*:/i.test(raw);
  if (remember && remember[1].trim().length >= 3 && !asked) {
    return { action: 'remember', text: remember[1].trim().slice(0, 500) };
  }
  const forget = raw.match(/^forget\b[\s:,-]*(?:that\s+|about\s+)?([\s\S]*)$/i);
  if (forget) {
    const rest = forget[1].trim().replace(/^#/, '');
    if (/^\d{1,3}$/.test(rest)) {
      return { action: 'forget', index: Number(rest), text: null };
    }
    // "forget that" and "forget about it" mean never mind. Read as a search,
    // "that" matches any note with the word in it.
    const pointsBack = rest
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z]/g, ''))
      .every((w) => !w || FORGET_POINTER.has(w));
    if (rest.length >= 3 && !pointsBack) {
      return { action: 'forget', index: null, text: rest };
    }
  }
  return null;
}

/** Words that point back at the conversation rather than at a note. */
const FORGET_POINTER = new Set([
  'that',
  'this',
  'it',
  'them',
  'those',
  'these',
  'one',
  'ones',
  'all',
  'of',
  'about',
  'the',
  'last',
  'everything',
]);

/**
 * watch this / stop watching / what are you watching.
 *
 * "watch this", "watch this for 12h", "watch this for 2 days and block the
 * hostile ones", "keep an eye on this". The post comes from the message, as
 * every bulk target does. `auto` only when the words say to block, never by
 * default: a watch that adds people on its own has to have been asked to.
 *
 * @returns {null | { action: 'watch', target: string|null, hours: number, auto: boolean }
 *                 | { action: 'unwatch', target: string|null }
 *                 | { action: 'watches' }}
 */
export function parseWatchCommand(text, { embedUri = null, links = [] } = {}) {
  const raw = String(text ?? '').trim();
  const lower = raw.toLowerCase();
  if (
    /^(what are you watching|what(['’]?s| is) being watched|watches|watching)[\s?!.]*$/.test(
      lower,
    )
  ) {
    return { action: 'watches' };
  }
  // Stopping keeps a target of any kind. A list or a feed is never watched,
  // so it matches no watch, where dropping it would stop the newest one.
  if (/^(stop watching|unwatch|stop watch|done watching)\b/.test(lower)) {
    const named =
      extractTargets(raw)[0] ||
      links.find((l) => extractTargets(l).length) ||
      embedUri ||
      null;
    return { action: 'unwatch', target: named };
  }
  const target = postTargetIn(raw, { embedUri, links });
  // "watch this", "watch https://...", "keep an eye on it", but not "watch
  // out, this one is nasty", which is a warning with a post attached.
  if (
    !/^(?:watch|monitor|keep (?:an eye on|watching))(?:\s+(?:this|that|it|the|my|bsky\.app|https?:\/\/|at:\/\/)|\s*[.!]*$)/.test(
      lower,
    )
  ) {
    return null;
  }
  let hours = 24;
  const span = lower.match(
    /\bfor\s+(?:the\s+next\s+)?(\d{1,3})\s*(h|hr|hrs|hours?|d|days?)\b/,
  );
  if (span) {
    const n = Number(span[1]);
    hours = /^d/.test(span[2]) ? n * 24 : n;
  } else if (/\bfor\s+(?:a|one)\s+day\b/.test(lower)) {
    hours = 24;
  } else if (/\b(tonight|overnight)\b/.test(lower)) {
    hours = 12;
  }
  hours = Math.min(168, Math.max(1, hours));
  // "don't want you to block anyone" names the verb too, so a negation up to
  // four words before it, in the same clause, turns `auto` off. Erring this way
  // costs a watch that only reports.
  const negated =
    /\b(?:don['’]?t|won['’]?t|not|never|no|without)\s+(?:[^\s.?!,;]+\s+){0,4}?(?:block|add|auto)/.test(
      lower,
    );
  const auto =
    !negated &&
    (/\b(block|add)\b[^.?!]*\b(hostile|toxic|nasty|abusive|them|anyone|those)\b/.test(
      lower,
    ) ||
      /\bauto(matically)?\b/.test(lower));
  return { action: 'watch', target, hours, auto };
}
