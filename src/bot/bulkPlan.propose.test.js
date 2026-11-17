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
vi.mock('../lib/target.js', () => ({
  resolveTarget: async () => ({ uri: POST, did: AUTHOR }),
  resolveActor: async (a) => a,
}));
const participants = [];
vi.mock('../lib/harvest.js', () => ({
  harvestPost: async (uri) => {
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
      truncated: false,
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
