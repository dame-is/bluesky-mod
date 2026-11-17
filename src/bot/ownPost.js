// The owner sends one of their own posts with no words: what is going on
// with it, and what the bot can do about it, as a numbered menu.
//
// Someone else's post gets the scan card (who engaged, by band), because the
// usual thing to do with it is block some of them. The owner's own post is a
// different question: who may reply to it and quote it, whether to keep an
// eye on it, and whether to have the shield step in by itself if strangers
// pile on. "Add the author" makes no sense on it at all.
//
// The card is cheap: one AppView read for the counts, the stream's memory for
// the last hour, the store for what the bot is already doing, and, with the
// owner's app password, two reads of the post's gates. The scan, which reads
// everyone who engaged, is an option rather than the default.
//
// Every option is a canonical command (the shield's, a watch, a scan), so a
// "1" runs exactly what was shown, through the same paths a typed command
// takes, owner-only checks and vetoes included. Nothing here writes.

import { OWNER_DID, APPVIEW } from '../constants.js';
import { fetchWithTimeout } from '../lib/atproto.js';
import { postWebUrl } from '../lib/links.js';
import { parsePostScan } from '../lib/command.js';
import { resolveTarget } from '../lib/target.js';
import { shieldCommandText } from '../lib/shieldCommand.js';
import { describeAllow, repliesLimited, quotesOff } from '../lib/gateRules.js';
import { activity as streamed } from '../ownerActivity.js';
import { liveGates, liveGuards, GUARD_HOURS, attackOn, readState } from '../shield.js';
import { liveWatches } from './watch.js';
import { shieldDeps } from './shieldDm.js';

const OWN_POST = `at://${OWNER_DID}/app.bsky.feed.post/`;
const STREAM_KINDS = ['reply', 'threadReply', 'quote'];
const HOUR = 3_600_000;

/** Is this at:// URI one of the owner's own posts? */
export const isOwnPost = (uri) => String(uri ?? '').startsWith(OWN_POST);

const link = (uri) => postWebUrl(uri) || uri;
const nf = (n) => Number(n || 0).toLocaleString('en-US');

/**
 * The owner's own post in this message, when the message is nothing but a
 * post (shared, pasted or typed, with the filler a scan allows). Null for
 * anything else, including someone else's post, which keeps its scan card.
 */
export async function ownPostIn(text, { embedUri = null, links = [] } = {}) {
  const post = parsePostScan(text, { embedUri, links });
  if (!post) return null;
  if (post.startsWith('at://')) return isOwnPost(post) ? post : null;
  try {
    const { uri } = await resolveTarget(post);
    return isOwnPost(uri) ? uri : null;
  } catch {
    // A link that does not resolve is the scan's to report.
    return null;
  }
}

/** The post as the AppView has it: counts, and its threadgate. Null if unread. */
async function postView(uri, fetchImpl) {
  try {
    const res = await fetchImpl(
      `${APPVIEW}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return null;
    return (await res.json())?.posts?.[0] ?? null;
  } catch {
    return null;
  }
}

const hoursLeft = (until, now) =>
  Math.max(1, Math.round((Date.parse(until) - now) / HOUR));

/**
 * What is true of the post now, for the card and its menu.
 *
 * @returns {Promise<object>} everything ownPostCard and ownPostOptions read
 */
export async function postFacts(
  uri,
  { deps = shieldDeps(), fetchImpl = fetchWithTimeout, now = Date.now() } = {},
) {
  const gates = deps?.gates ?? null;
  const activity = deps?.activity ?? streamed;
  const [view, botGates, guards, watches, state] = await Promise.all([
    postView(uri, fetchImpl),
    liveGates({ post: uri }).catch(() => []),
    liveGuards({ now }).catch(() => new Map()),
    liveWatches({ now }).catch(() => []),
    readState().catch(() => ({})),
  ]);
  // A reply's threadgate does nothing, so replies on it cannot be limited.
  const root = view ? !view.record?.reply : true;
  // The gates as they are: read from the owner's repo when the bot can, the
  // threadgate from the AppView's view when it cannot, and the postgate not
  // at all then (the AppView only says whether quotes are off for whoever
  // asks, and the bot asks as nobody).
  let threadgate = view?.threadgate?.record ?? null;
  let postgate;
  if (gates) {
    [threadgate, postgate] = await Promise.all([
      gates.read('threadgate', uri).catch(() => threadgate),
      gates.read('postgate', uri).catch(() => undefined),
    ]);
  }
  let recent = null;
  if (activity?.live?.() && activity.coversMs() > 0) {
    const sinceMs = Math.min(HOUR, activity.coversMs());
    const events = activity.events({ post: uri, kinds: STREAM_KINDS, sinceMs });
    let outside = null;
    if (events.length && deps?.outsideAmong) {
      outside = await deps
        .outsideAmong([...new Set(events.map((e) => e.actor))])
        .then((s) => s.size)
        .catch(() => null);
    }
    recent = { count: events.length, outside, minutes: Math.round(sinceMs / 60_000) };
  }
  return {
    uri,
    view,
    root,
    threadgate,
    postgate,
    botThreadgate: botGates.some((g) => g.kind === 'threadgate'),
    botPostgate: botGates.some((g) => g.kind === 'postgate'),
    guard: guards.get(uri) ?? null,
    watch: watches.find((w) => w.uri === uri) ?? null,
    attack: attackOn(state, now),
    recent,
    gates: Boolean(gates),
    canWatch: Boolean(deps?.startWatch),
    canGuard: Boolean(deps?.cfg && (deps.cfg.replies || deps.cfg.quotes) && deps.streaming !== false),
    replyRule: deps?.cfg?.replyRule ?? ['following', 'mentioned'],
  };
}

/** The numbered options for the post, built from postFacts. */
export function ownPostOptions(f) {
  const { uri } = f;
  const out = [];
  if (f.canWatch && !f.watch) {
    out.push({
      label: 'Watch it for 24 hours, and ask before blocking anyone',
      command: shieldCommandText({ action: 'watch', post: uri }),
    });
  }
  if (f.canWatch && f.watch?.mode !== 'auto') {
    // Run as a stored question would be, so with several lists it asks which.
    const command = `watch ${uri} 24h auto`;
    out.push({
      label: f.watch
        ? 'Block the hostile ones as they come, too'
        : 'Watch it and block the hostile ones as they come',
      command,
      commands: [command],
    });
  }
  if (f.canGuard) {
    out.push(
      f.guard
        ? { label: 'Stop guarding it', command: shieldCommandText({ action: 'unguard', post: uri }) }
        : {
            label: f.gates
              ? `Guard it: close replies or quotes by itself if strangers pile on (${GUARD_HOURS / 24} days)`
              : `Guard it: tell me if strangers pile on (${GUARD_HOURS / 24} days)`,
            command: shieldCommandText({
              action: 'guard',
              post: uri,
              hours: GUARD_HOURS,
              mode: f.gates ? null : 'ask',
            }),
          },
    );
  }
  if (f.gates) {
    if (f.botThreadgate) {
      out.push({ label: 'Open replies again', command: shieldCommandText({ action: 'open', post: uri }) });
    } else if (f.root && !repliesLimited(f.threadgate)) {
      out.push({
        label: `Close replies now, to ${f.replyRule.join(' and ')}`,
        command: shieldCommandText({ action: 'close', post: uri }),
      });
    }
    if (f.botPostgate) {
      out.push({ label: 'Turn quotes back on', command: shieldCommandText({ action: 'quotesOn', post: uri }) });
    } else if (!quotesOff(f.postgate)) {
      out.push({ label: 'Turn quotes off now', command: shieldCommandText({ action: 'quotesOff', post: uri }) });
    }
  }
  out.push({ label: 'Who engaged: scan and score everyone', command: `add everyone ${uri}` });
  return out;
}

/** One line on who may reply, or null when the bot cannot tell. */
function repliesLine(f) {
  if (!f.root) return 'replies: it is a reply, so they cannot be limited';
  if (!repliesLimited(f.threadgate)) return f.view || f.gates ? 'replies: open to anyone' : null;
  const who = describeAllow(f.threadgate.allow);
  return `replies: ${who === 'nobody' ? 'closed' : `limited to ${who}`} (${f.botThreadgate ? 'by me' : 'by you'})`;
}

function quotesLine(f) {
  if (f.postgate === undefined) return null;
  return quotesOff(f.postgate)
    ? `quotes: off (${f.botPostgate ? 'by me' : 'by you'})`
    : 'quotes: on';
}

/**
 * The card for one of the owner's posts: what is going on with it, then the
 * numbered menu.
 *
 * @returns {Promise<{ text: string, options: object[], links: string[] }>}
 */
export async function ownPostCard(uri, opts = {}) {
  const now = opts.now ?? Date.now();
  const f = await postFacts(uri, { ...opts, now });
  const v = f.view;
  const lines = [`Your post ${link(uri)}`];
  if (v) {
    lines.push(
      `${nf(v.likeCount)} likes · ${nf(v.repostCount)} reposts · ${nf(v.replyCount)} replies · ${nf(v.quoteCount)} quotes`,
    );
  }
  if (f.recent) {
    const span = f.recent.minutes >= 60 ? 'last hour' : `last ${f.recent.minutes} min`;
    lines.push(
      f.recent.count
        ? `${span}: ${f.recent.count} ${f.recent.count === 1 ? 'reply or quote' : 'replies and quotes'}` +
            (f.recent.outside === null ? '' : `, ${f.recent.outside} from outside your circle`)
        : `${span}: no new replies or quotes`,
    );
  }
  const status = [repliesLine(f), quotesLine(f)].filter(Boolean);
  if (f.watch) {
    status.push(
      `watching: ${hoursLeft(f.watch.until, now)}h left, ${f.watch.mode === 'auto' ? 'blocking the hostile ones' : 'asking before blocking'}`,
    );
  }
  if (f.guard) {
    status.push(
      `guarded: ${hoursLeft(f.guard.until, now)}h left, ${f.guard.mode === 'auto' ? 'acts by itself' : 'tells you first'}`,
    );
  }
  if (f.attack) status.push('attack mode is on: every recent post is limited');
  if (status.length) lines.push('', ...status);
  if (!f.gates) {
    lines.push('', 'Closing replies or quotes needs MOD_OWNER_APP_PASSWORD; the rest works without it.');
  }
  return { text: lines.join('\n'), options: ownPostOptions(f), links: [postWebUrl(uri)] };
}
