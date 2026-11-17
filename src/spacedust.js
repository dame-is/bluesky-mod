// Links pointing AT the owner, as they happen, from Spacedust
// (https://spacedust.microcosm.blue), microcosm's filtered link firehose.
//
// Jetstream filters by a record's author, so it can follow the owner's own
// repo but not the replies, quotes and mentions other people write about them
// without reading the whole network. Spacedust filters by a link's SUBJECT:
// asking for the owner's DID returns every link whose subject is the owner or
// a record in the owner's repo, which is exactly "someone just replied to,
// quoted or mentioned you". A watched post someone else wrote is asked for by
// its URI.
//
// What arrives is a link, not a record: who wrote what kind of record, and
// what it points at. No text. Anything that needs the words reads them later,
// the way a scan does.
//
// NO CURSOR. Spacedust has no replay, so links written while the socket is
// down are not seen. Every consumer treats the stream as a fast signal with a
// fallback (a poll of the AppView or Constellation), never as the record.
//
// Spacedust holds each link for 21 seconds before sending it, so an
// interaction undone at once never arrives. That suits a harassment signal,
// and `instant` stays off.

import { config } from './config.js';
import { connectSocket } from './socket.js';

/** Link sources, by what they mean when the subject is the owner's. */
export const LINK_SOURCES = {
  // Someone answering the owner's post itself.
  reply: 'app.bsky.feed.post:reply.parent.uri',
  // Anyone anywhere in a thread the owner started.
  threadReply: 'app.bsky.feed.post:reply.root.uri',
  quote: 'app.bsky.feed.post:embed.record.uri',
  // A quote with media beside it.
  quoteWithMedia: 'app.bsky.feed.post:embed.record.record.uri',
  mention:
    'app.bsky.feed.post:facets[app.bsky.richtext.facet].features[app.bsky.richtext.facet#mention].did',
};

/** What the bot subscribes to: the links that carry words. */
export const WORD_SOURCES = Object.values(LINK_SOURCES);

/** The kind a source means, or null for one this code did not ask for. */
export function kindOf(source) {
  switch (source) {
    case LINK_SOURCES.reply:
      return 'reply';
    case LINK_SOURCES.threadReply:
      return 'threadReply';
    case LINK_SOURCES.quote:
    case LINK_SOURCES.quoteWithMedia:
      return 'quote';
    case LINK_SOURCES.mention:
      return 'mention';
    default:
      return null;
  }
}

/**
 * The subscription URL. Each filter is a repeated parameter, as Spacedust
 * expects.
 */
export function spacedustUrl({
  host = config.spacedustHost,
  sources = WORD_SOURCES,
  subjectDids = [],
  subjects = [],
} = {}) {
  const params = new URLSearchParams();
  for (const s of sources) params.append('wantedSources', s);
  for (const d of subjectDids) params.append('wantedSubjectDids', d);
  for (const s of subjects) params.append('wantedSubjects', s);
  return `wss://${host}/subscribe?${params}`;
}

/**
 * Subscribe to links pointing at these DIDs (anything in their repos, and the
 * DID itself) and at these records.
 *
 * `subjects` is read on every connect, so a caller whose set has changed
 * (a watch started or ended) calls `refresh()` and the next connection asks
 * for the new set.
 *
 * @param {object} opts
 * @param {string[]} opts.subjectDids
 * @param {() => string[]} [opts.subjects]
 * @param {(msg: object) => any} opts.onLink  each frame, as Spacedust sends it:
 *   { kind: 'link', link: { operation, source, source_record, subject } }
 * @param {() => any} [opts.onOpen]  each time a connection opens: what came
 *   before it may be missing
 * @returns {{ close(): void, refresh(): void }}
 */
export function connectSpacedust({
  subjectDids,
  subjects = () => [],
  onLink,
  onOpen = () => {},
}) {
  let asked = [];
  const sock = connectSocket({
    name: 'Spacedust',
    url: () => {
      asked = [...new Set(subjects())];
      return spacedustUrl({ subjectDids, subjects: asked });
    },
    onMessage: onLink,
    onOpen,
    describe: () => ({
      host: config.spacedustHost,
      dids: subjectDids.join(','),
      records: asked.length,
    }),
  });
  return {
    close: () => sock.close(),
    /** Reconnect when the set of records asked for has changed. */
    refresh() {
      const now = [...new Set(subjects())];
      const same =
        now.length === asked.length && now.every((s) => asked.includes(s));
      if (!same) sock.reconnect();
    },
  };
}
