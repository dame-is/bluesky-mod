// Who a scan puts in a plan: everyone who engaged, except the owner, the bot
// and the person whose post it is. Against a stubbed harvest and scorer and
// an in-memory store.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { OWNER_DID } from '../constants.js';

const LIST = 'at://did:plc:bot/app.bsky.graph.list/3list';
const AUTHOR = 'did:plc:author';
const POST = `at://${AUTHOR}/app.bsky.feed.post/3post`;

const stored = { plan: [], decision: [] };
vi.mock('./db.js', () => ({
  select: vi.fn(async () => []),
  selectAll: vi.fn(async () => []),
  update: vi.fn(async () => null),
  count: vi.fn(async () => 0),
  upsert: vi.fn(async (table, rows) => {
    stored[table].push(...rows);
    return rows.length;
  }),
}));
vi.mock('./listWrite.js', () => ({
  listUri: () => LIST,
  ownerOf: (uri) => /^at:\/\/(did:[^/]+)\//.exec(String(uri ?? ''))?.[1] ?? null,
  protectedAmong: async () => new Set(),
}));
vi.mock('./reference.js', () => ({
  loadReference: async () => ({ ref: {}, takenAt: '2026-10-01T00:00:00Z' }),
}));
vi.mock('../lib/target.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    // An at:// URI resolves offline; anything else is the post.
    resolveTarget: async (link) =>
      String(link).startsWith('at://')
        ? real.resolveTarget(link)
        : { uri: POST, did: AUTHOR, collection: 'app.bsky.feed.post' },
    resolveActor: async (a) => a,
  };
});
const harvested = [];
const participants = [];
const unread = [];
const stopDuringHarvest = { controller: null };
vi.mock('../lib/harvest.js', () => ({
  harvestPost: async (uri) => {
    harvested.push(uri);
    // Stands in for a deadline that passes while the post is read: the
    // harvest returns what it had rather than throwing.
    stopDuringHarvest.controller?.abort(new Error('That took too long'));
    const engagements = {};
    for (const p of participants) {
      for (const [k, n] of Object.entries(p.engagements)) {
        engagements[k] = (engagements[k] || 0) + n;
      }
    }
    return {
      uri,
      harvestedAt: '2026-10-01T00:00:00Z',
      participants,
      totals: { participants: participants.length, engagements, records: 0 },
      truncated: unread.length > 0,
      unread: [...unread],
    };
  },
}));
vi.mock('../lib/score.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createScorer: () => ({
    score: async (dids) =>
      new Map(dids.map((did) => [did, { did, band: 'UNKNOWN', trust: 0 }])),
  }),
}));

process.env.MOD_LIST_URI = LIST;
const { proposePlan } = await import('./bulkPlan.js');

const engaged = (did, engagements) => ({ did, engagements, records: [] });

beforeEach(() => {
  stored.plan.length = 0;
  stored.decision.length = 0;
  participants.length = 0;
  harvested.length = 0;
  unread.length = 0;
  stopDuringHarvest.controller = null;
});

describe('who a scan puts in a plan', () => {
  it('leaves out the author, the owner and the bot, from the rows and the counts', async () => {
    participants.push(
      // The author limited replies and answered someone in their own thread.
      engaged(AUTHOR, { gate: 1, reply: 1 }),
      engaged(OWNER_DID, { like: 1 }),
      // The bot answered a mention in the thread.
      engaged('did:plc:bot', { reply: 1 }),
      engaged('did:plc:s1', { quote: 1 }),
      engaged('did:plc:s2', { quote: 1, like: 1 }),
    );

    const out = await proposePlan({ link: POST, kind: 'everyone' });

    expect(stored.decision.map((r) => r.did).sort()).toEqual([
      'did:plc:s1',
      'did:plc:s2',
    ]);
    expect(out).toMatchObject({ total: 2, byBand: { UNKNOWN: 2 } });
    expect(out.engagements).toEqual({ quote: 2, like: 1 });
    expect(stored.plan[0].totals).toMatchObject({ participants: 2 });
    // The author is still scored, for the card's own "author" choice.
    expect(out.author).toMatchObject({ did: AUTHOR });
  });
});

describe('what a scan reads', () => {
  it('refuses a list, a starter pack or a feed, and harvests nothing', async () => {
    for (const uri of [
      'at://did:plc:maker/app.bsky.graph.list/3abc',
      'at://did:plc:maker/app.bsky.graph.starterpack/3abc',
      'at://did:plc:maker/app.bsky.feed.generator/hot',
    ]) {
      await expect(
        proposePlan({ link: uri, kind: 'everyone' }),
        uri,
      ).rejects.toThrow('I scan posts, and that is not a post.');
    }
    expect(harvested).toEqual([]);
    expect(stored.plan).toEqual([]);
  });
});

describe('a scan the turn ran out of time for', () => {
  it('stores no plan from a harvest the signal cut short', async () => {
    participants.push(engaged('did:plc:s1', { quote: 1 }));
    stopDuringHarvest.controller = new AbortController();
    await expect(
      proposePlan({
        link: POST,
        kind: 'everyone',
        signal: stopDuringHarvest.controller.signal,
      }),
    ).rejects.toThrow('That took too long');
    expect(stored.plan).toEqual([]);
    expect(stored.decision).toEqual([]);
  });
});

describe('a scan that could not read everything', () => {
  it('says which kinds went unread, on the plan and in what it returns', async () => {
    participants.push(engaged('did:plc:s1', { quote: 1 }));
    unread.push({ kind: 'like', count: 900 });
    const out = await proposePlan({ link: POST, kind: 'everyone' });
    expect(out).toMatchObject({
      truncated: true,
      unread: [{ kind: 'like', count: 900 }],
    });
    expect(stored.plan[0].totals.unread).toEqual([
      { kind: 'like', count: 900 },
    ]);
  });
});
