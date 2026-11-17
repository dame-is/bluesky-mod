import { describe, it, expect } from 'vitest';
import {
  allowRules,
  describeAllow,
  nextThreadgate,
  nextPostgate,
  sameRecord,
  repliesLimited,
  quotesOff,
  MAX_URIS,
} from './gateRules.js';

const POST = 'at://did:plc:owner/app.bsky.feed.post/3kpost';
const NOW = '2026-11-17T12:00:00.000Z';
const FOLLOWING = { $type: 'app.bsky.feed.threadgate#followingRule' };
const MENTION = { $type: 'app.bsky.feed.threadgate#mentionRule' };
const FOLLOWER = { $type: 'app.bsky.feed.threadgate#followerRule' };
const LIST = { $type: 'app.bsky.feed.threadgate#listRule', list: 'at://did:plc:owner/app.bsky.graph.list/x' };

describe('allowRules', () => {
  it('turns rule words into threadgate rules, and nobody into none', () => {
    expect(allowRules(['following', 'mentioned'])).toEqual([FOLLOWING, MENTION]);
    expect(allowRules(['nobody'])).toEqual([]);
  });

  it('says who may reply in words', () => {
    expect(describeAllow(undefined)).toBe('anyone');
    expect(describeAllow([])).toBe('nobody');
    expect(describeAllow([FOLLOWING, MENTION])).toBe('people you follow, people you mention');
  });
});

describe('nextThreadgate', () => {
  it('closes an open post', () => {
    const g = nextThreadgate(POST, null, { allow: [FOLLOWING, MENTION], now: NOW });
    expect(g).toEqual({
      $type: 'app.bsky.feed.threadgate',
      post: POST,
      createdAt: NOW,
      allow: [FOLLOWING, MENTION],
    });
    expect(repliesLimited(g)).toBe(true);
  });

  it('closes a post whose gate only hides replies', () => {
    const existing = { $type: 'app.bsky.feed.threadgate', post: POST, createdAt: NOW, hiddenReplies: ['at://x/app.bsky.feed.post/1'] };
    const g = nextThreadgate(POST, existing, { allow: [FOLLOWING] });
    expect(g.allow).toEqual([FOLLOWING]);
    expect(g.hiddenReplies).toEqual(['at://x/app.bsky.feed.post/1']);
  });

  it('never opens a post wider than the owner already limited it', () => {
    // Only a list may reply. "following, mentioned" would let in people the
    // list does not, so the owner's limit stands.
    const listOnly = { $type: 'app.bsky.feed.threadgate', post: POST, createdAt: NOW, allow: [LIST] };
    expect(nextThreadgate(POST, listOnly, { allow: [FOLLOWING, MENTION] })).toBeNull();
    // Nobody may reply: nothing is stricter.
    const nobody = { ...listOnly, allow: [] };
    expect(nextThreadgate(POST, nobody, { allow: [FOLLOWING] })).toBeNull();
    // Same groups: nothing to do.
    const same = { ...listOnly, allow: [FOLLOWING, MENTION] };
    expect(nextThreadgate(POST, same, { allow: [MENTION, FOLLOWING] })).toBeNull();
  });

  it('narrows to fewer of the same groups, or to nobody', () => {
    const wide = { $type: 'app.bsky.feed.threadgate', post: POST, createdAt: NOW, allow: [FOLLOWING, FOLLOWER, MENTION] };
    expect(nextThreadgate(POST, wide, { allow: [FOLLOWING, MENTION] }).allow).toEqual([FOLLOWING, MENTION]);
    expect(nextThreadgate(POST, wide, { allow: [] }).allow).toEqual([]);
  });

  it('adds hidden replies to the ones already hidden, up to the cap', () => {
    const existing = { $type: 'app.bsky.feed.threadgate', post: POST, createdAt: NOW, allow: [], hiddenReplies: ['a'] };
    const g = nextThreadgate(POST, existing, { hide: ['b', 'a'] });
    expect(g.hiddenReplies).toEqual(['a', 'b']);
    expect(g.allow).toEqual([]);
    const many = Array.from({ length: 80 }, (_, i) => `r${i}`);
    expect(nextThreadgate(POST, null, { allow: [], hide: many }).hiddenReplies).toHaveLength(MAX_URIS);
  });

  it('keeps fields it does not know', () => {
    const existing = { $type: 'app.bsky.feed.threadgate', post: POST, createdAt: NOW, futureField: 1 };
    expect(nextThreadgate(POST, existing, { allow: [] }).futureField).toBe(1);
  });

  it('writes nothing for a request that asks nothing', () => {
    expect(nextThreadgate(POST, null, {})).toBeNull();
  });
});

describe('nextPostgate', () => {
  it('turns quotes off, keeping what was detached', () => {
    const existing = { $type: 'app.bsky.feed.postgate', post: POST, createdAt: NOW, detachedEmbeddingUris: ['q1'] };
    const g = nextPostgate(POST, existing, { detach: ['q2'] });
    expect(quotesOff(g)).toBe(true);
    expect(g.detachedEmbeddingUris).toEqual(['q1', 'q2']);
  });

  it('leaves a post whose quotes are already off', () => {
    const off = nextPostgate(POST, null, { now: NOW });
    expect(nextPostgate(POST, off)).toBeNull();
  });

  it('can only detach, leaving quotes on', () => {
    const g = nextPostgate(POST, null, { disable: false, detach: ['q1'], now: NOW });
    expect(quotesOff(g)).toBe(false);
    expect(g.detachedEmbeddingUris).toEqual(['q1']);
  });
});

describe('sameRecord', () => {
  it('ignores key order', () => {
    expect(sameRecord({ a: 1, b: [{ x: 1, y: 2 }] }, { b: [{ y: 2, x: 1 }], a: 1 })).toBe(true);
    expect(sameRecord(null, undefined)).toBe(true);
    expect(sameRecord({ a: 1 }, { a: 2 })).toBe(false);
  });
});
