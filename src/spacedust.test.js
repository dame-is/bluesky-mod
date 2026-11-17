import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connectSpacedust, spacedustUrl, kindOf, LINK_SOURCES, WORD_SOURCES } from './spacedust.js';

class FakeSocket {
  static made = [];
  constructor(url) {
    this.url = url;
    this.listeners = {};
    FakeSocket.made.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type, ev = {}) {
    for (const fn of this.listeners[type] || []) fn(ev);
  }
  close() {}
}

const OWNER = 'did:plc:owner0000000000000000000';
let stream;

beforeEach(() => {
  FakeSocket.made = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  stream?.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('spacedustUrl', () => {
  it('asks for each source and subject as its own parameter, and nothing instant', () => {
    const url = new URL(
      spacedustUrl({
        host: 'sd.example',
        subjectDids: [OWNER],
        subjects: ['at://did:plc:x/app.bsky.feed.post/1'],
      }),
    );
    expect(url.protocol).toBe('wss:');
    expect(url.searchParams.getAll('wantedSources')).toEqual(WORD_SOURCES);
    expect(url.searchParams.getAll('wantedSubjectDids')).toEqual([OWNER]);
    expect(url.searchParams.getAll('wantedSubjects')).toEqual([
      'at://did:plc:x/app.bsky.feed.post/1',
    ]);
    // The 21-second hold drops interactions undone at once; it stays on.
    expect(url.searchParams.has('instant')).toBe(false);
  });
});

describe('kindOf', () => {
  it('names the sources it asked for and nothing else', () => {
    expect(kindOf(LINK_SOURCES.reply)).toBe('reply');
    expect(kindOf(LINK_SOURCES.threadReply)).toBe('threadReply');
    expect(kindOf(LINK_SOURCES.quote)).toBe('quote');
    expect(kindOf(LINK_SOURCES.quoteWithMedia)).toBe('quote');
    expect(kindOf(LINK_SOURCES.mention)).toBe('mention');
    expect(kindOf('app.bsky.feed.like:subject.uri')).toBeNull();
    expect(kindOf('com.example.evil:subject')).toBeNull();
  });
});

describe('connectSpacedust', () => {
  it('passes each frame on, and says when a connection opens', async () => {
    const onLink = vi.fn();
    const onOpen = vi.fn();
    stream = connectSpacedust({ subjectDids: [OWNER], onLink, onOpen });
    const sock = FakeSocket.made[0];
    sock.fire('open');
    expect(onOpen).toHaveBeenCalledTimes(1);
    sock.fire('message', { data: JSON.stringify({ kind: 'link', link: { source: 'x' } }) });
    await vi.runOnlyPendingTimersAsync();
    expect(onLink).toHaveBeenCalledWith({ kind: 'link', link: { source: 'x' } });
  });

  it('reconnects with the new records when the set changes, and not otherwise', () => {
    let watched = ['at://did:plc:a/app.bsky.feed.post/1'];
    stream = connectSpacedust({ subjectDids: [OWNER], subjects: () => watched, onLink: () => {} });
    expect(FakeSocket.made).toHaveLength(1);
    stream.refresh();
    expect(FakeSocket.made).toHaveLength(1);
    watched = [...watched, 'at://did:plc:b/app.bsky.feed.post/2'];
    stream.refresh();
    expect(FakeSocket.made).toHaveLength(2);
    expect(new URL(FakeSocket.made[1].url).searchParams.getAll('wantedSubjects')).toEqual(watched);
  });

  it('ignores frames from a socket it has replaced', async () => {
    const onLink = vi.fn();
    let watched = [];
    stream = connectSpacedust({ subjectDids: [OWNER], subjects: () => watched, onLink });
    const old = FakeSocket.made[0];
    watched = ['at://did:plc:a/app.bsky.feed.post/1'];
    stream.refresh();
    old.fire('message', { data: JSON.stringify({ kind: 'link' }) });
    await vi.runOnlyPendingTimersAsync();
    expect(onLink).not.toHaveBeenCalled();
  });
});
