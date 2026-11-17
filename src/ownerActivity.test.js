import { describe, it, expect } from 'vitest';
import { createActivity, parseLink } from './ownerActivity.js';
import { LINK_SOURCES } from './spacedust.js';

const OWNER = 'did:plc:owner0000000000000000000';
const POST = `at://${OWNER}/app.bsky.feed.post/3kpost`;
const ROOT = `at://${OWNER}/app.bsky.feed.post/3kroot`;

const frame = (source, actor, rkey, subject, operation = 'create') => ({
  kind: 'link',
  origin: 'live',
  link: {
    operation,
    source,
    source_record: `at://${actor}/app.bsky.feed.post/${rkey}`,
    subject,
  },
});

describe('parseLink', () => {
  it('reads who wrote the linking record and which post it points at', () => {
    expect(parseLink(frame(LINK_SOURCES.quote, 'did:plc:aaa', 'r1', POST))).toEqual({
      kind: 'quote',
      actor: 'did:plc:aaa',
      record: 'at://did:plc:aaa/app.bsky.feed.post/r1',
      post: POST,
      deleted: false,
    });
  });

  it('keeps a mention, whose subject is the account rather than a post', () => {
    const l = parseLink(frame(LINK_SOURCES.mention, 'did:plc:aaa', 'r1', OWNER));
    expect(l.kind).toBe('mention');
    expect(l.post).toBeNull();
  });

  it('drops what it did not ask for, and authors that are not DIDs', () => {
    expect(parseLink({ kind: 'link', link: { source: 'app.bsky.feed.like:subject.uri' } })).toBeNull();
    expect(parseLink(frame(LINK_SOURCES.reply, 'not-a-did', 'r1', POST))).toBeNull();
    expect(parseLink({ kind: 'other' })).toBeNull();
    // A record outside posts claiming a post's source path.
    expect(
      parseLink({
        kind: 'link',
        link: { source: LINK_SOURCES.reply, source_record: 'at://did:plc:aaa/com.evil/1', subject: POST },
      }),
    ).toBeNull();
  });
});

describe('createActivity', () => {
  it('counts a direct reply once though it links as parent and as root', () => {
    let t = 1_000_000;
    const a = createActivity({ now: () => t });
    a.record(frame(LINK_SOURCES.threadReply, 'did:plc:aaa', 'r1', ROOT));
    a.record(frame(LINK_SOURCES.reply, 'did:plc:aaa', 'r1', ROOT));
    expect(a.size()).toBe(1);
    const [e] = a.events();
    expect(e.kind).toBe('reply');
    expect(a.byPost().get(ROOT).actors.size).toBe(1);
  });

  it('files a reply deep in a thread under the thread it is in', () => {
    const a = createActivity();
    a.record(frame(LINK_SOURCES.threadReply, 'did:plc:bbb', 'r2', ROOT));
    expect(a.byPost().get(ROOT).kinds).toEqual({ threadReply: 1 });
  });

  it('answers per post for a window, and by kind', () => {
    let t = 0;
    const a = createActivity({ now: () => t });
    a.record(frame(LINK_SOURCES.quote, 'did:plc:a1', 'q1', POST));
    t = 20 * 60_000;
    a.record(frame(LINK_SOURCES.quote, 'did:plc:a2', 'q2', POST));
    a.record(frame(LINK_SOURCES.reply, 'did:plc:a3', 'r3', POST));
    const last10 = a.byPost({ sinceMs: 10 * 60_000 }).get(POST);
    expect([...last10.actors].sort()).toEqual(['did:plc:a2', 'did:plc:a3']);
    expect(a.events({ kinds: ['quote'] })).toHaveLength(2);
    expect(a.events({ post: POST, sinceMs: 10 * 60_000, kinds: ['quote'] })).toHaveLength(1);
  });

  it('takes a deleted record back out', () => {
    const a = createActivity();
    a.record(frame(LINK_SOURCES.quote, 'did:plc:a1', 'q1', POST));
    a.record(frame(LINK_SOURCES.quote, 'did:plc:a1', 'q1', POST, 'delete'));
    expect(a.size()).toBe(0);
  });

  it('forgets what is older than it keeps, and holds no more than its cap', () => {
    let t = 0;
    const a = createActivity({ now: () => t, keepMs: 60_000, max: 3 });
    for (let i = 0; i < 5; i += 1) a.record(frame(LINK_SOURCES.reply, `did:plc:a${i}`, `r${i}`, POST));
    expect(a.size()).toBe(3);
    // Dropped for room while still fresh: the window no longer reaches back.
    expect(a.coversMs()).toBe(0);
    t = 120_000;
    a.record(frame(LINK_SOURCES.reply, 'did:plc:late', 'late', POST));
    expect(a.size()).toBe(1);
  });

  it('says how far back it covers, from the last gap', () => {
    let t = 0;
    const a = createActivity({ now: () => t });
    t = 30 * 60_000;
    expect(a.coversMs()).toBe(30 * 60_000);
    a.gap();
    t += 5 * 60_000;
    expect(a.coversMs()).toBe(5 * 60_000);
  });

  it('tells subscribers about each interaction as it lands', () => {
    const a = createActivity();
    const seen = [];
    const off = a.subscribe((e) => seen.push(e.actor));
    a.record(frame(LINK_SOURCES.quote, 'did:plc:a1', 'q1', POST));
    off();
    a.record(frame(LINK_SOURCES.quote, 'did:plc:a2', 'q2', POST));
    expect(seen).toEqual(['did:plc:a1']);
  });
});

describe('coverage', () => {
  const OTHER = 'at://did:plc:someone/app.bsky.feed.post/3kwatched';

  it('covers nothing until the stream first opens, when made for the bot', () => {
    let t = 0;
    const a = createActivity({ now: () => t, coveredFromStart: false, ownerDid: OWNER });
    t = 60 * 60_000;
    expect(a.coversMs()).toBe(0);
    expect(a.coveredSince(POST)).toBeNull();
    a.opened([]);
    t += 10 * 60_000;
    expect(a.coversMs()).toBe(10 * 60_000);
    expect(a.coveredSince(POST)).toBe(60 * 60_000);
  });

  it('holds through a reconnect inside the tolerance, and starts again after a longer one', () => {
    let t = 0;
    const a = createActivity({ now: () => t, coveredFromStart: false, ownerDid: OWNER });
    a.opened([]);
    t = 15 * 60_000;
    a.closed();
    t += 2_000;
    a.opened([]);
    expect(a.coversMs()).toBe(15 * 60_000 + 2_000);
    a.closed();
    t += 5 * 60_000;
    // Still down past the tolerance: nothing can be vouched for.
    expect(a.coversMs()).toBe(0);
    a.opened([]);
    t += 1_000;
    expect(a.coversMs()).toBe(1_000);
  });

  it("covers someone else's post only from the connection that asked for it", () => {
    let t = 0;
    const a = createActivity({ now: () => t, coveredFromStart: false, ownerDid: OWNER });
    a.opened([]);
    t = 10 * 60_000;
    expect(a.coveredSince(OTHER)).toBeNull();
    a.closed();
    t += 1_000;
    a.opened([OTHER]);
    expect(a.coveredSince(OTHER)).toBe(t);
    // The owner's posts kept their longer cover through the quick reconnect.
    expect(a.coveredSince(POST)).toBe(0);
    // Dropped from the subscription, it is no longer covered.
    a.opened([]);
    expect(a.coveredSince(OTHER)).toBeNull();
  });
});
