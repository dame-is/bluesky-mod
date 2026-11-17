// Simple scoring, against the real store: a snapshot of the owner's follows
// alone, finalised in one step, scored with "follows you" as the sign of
// closeness, and what happens to a full snapshot when the mode changes.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.MOD_LIST_URI =
  'at://did:plc:bot00000000000000000000/app.bsky.graph.list/3list';

vi.mock('./lib/atproto.js', async (orig) => ({
  ...(await orig()),
  resolvePds: async () => 'https://pds.test',
}));
vi.mock('./lib/precompute.js', async (orig) => ({
  ...(await orig()),
  readCircle: async () => ['did:plc:friend', 'did:plc:pal'],
  readCurationMembers: async () => new Map([['did:plc:curated', 'list:Friends']]),
  indexCircleFollows: vi.fn(async () => {
    throw new Error('simple scoring reads no follow lists');
  }),
}));
vi.mock('./bot/graphFacts.js', () => ({
  graphFacts: async () => null,
  listedView: () => null,
  blockersView: () => null,
}));

const db = await import('./bot/db.js');
const { config } = await import('./config.js');
const { snapshotStep, usableSnapshot } = await import('./snapshot.js');
const { loadReference } = await import('./bot/reference.js');
const { assignBand } = await import('./lib/score.js');

const DAY = 86_400_000;

beforeEach(() => {
  db.closeDb();
  db.openDb(':memory:');
  config.scoring = 'simple';
});
afterEach(() => {
  config.scoring = 'full';
  vi.useRealTimers();
});

describe('a simple snapshot', () => {
  it('is read and finalised in one step, with no vouch counts', async () => {
    const res = await snapshotStep();
    expect(res.state).toBe('finalised');
    expect(await db.count('vouch', {})).toBe(0);
    expect(await db.count('circle', { is: { follows_indexed_at: 'null' } })).toBe(0);
    expect((await usableSnapshot()).scoring).toBe('simple');
    const protectedDids = (
      await db.selectAll('protected', { select: 'did', order: 'did.asc' })
    ).map((r) => r.did);
    expect(protectedDids).toEqual(['did:plc:curated', 'did:plc:friend', 'did:plc:pal']);
  });

  it('is left alone while fresh, and rebuilt once it is a week old', async () => {
    await snapshotStep();
    expect((await snapshotStep()).state).toBe('idle');
    vi.useFakeTimers({ now: Date.now() + 8 * DAY, toFake: ['Date'] });
    expect((await snapshotStep()).state).toBe('finalised');
    expect(
      (await db.selectAll('circle', { select: 'taken_at', order: 'taken_at.asc' }))
        .map((r) => r.taken_at)
        .filter((t, i, a) => a.indexOf(t) === i),
    ).toHaveLength(2);
  });

  it('is scored with "follows you" as connected and nothing peripheral', async () => {
    await snapshotStep();
    const { scoring, thresholds, ref } = await loadReference();
    expect(scoring).toBe('simple');
    expect(ref.vouches.size).toBe(0);
    expect(assignBand({ followsYou: true, followers: 40 }, thresholds)).toBe('CONNECTED');
    expect(assignBand({ followers: 40 }, thresholds)).toBe('UNKNOWN');
    expect(assignBand({ followers: 50_000 }, thresholds)).toBe('NOTABLE');
  });
});

describe('changing modes', () => {
  async function fullSnapshot(takenAt, { finalised = true } = {}) {
    await db.upsert('circle', [
      { taken_at: takenAt, did: 'did:plc:friend', follows_indexed_at: finalised ? takenAt : null },
    ]);
    if (finalised) {
      await db.upsert('vouch', [{ taken_at: takenAt, did: 'did:plc:fof', vouches: 4 }]);
    } else {
      await db.upsert('circle_follow', [
        { taken_at: takenAt, member_did: 'did:plc:friend', target_did: 'did:plc:fof' },
      ]);
    }
  }

  it('to simple drops the full snapshots and any half-read build', async () => {
    const old = new Date(Date.now() - 3 * DAY).toISOString();
    const building = new Date(Date.now() - DAY).toISOString();
    await fullSnapshot(old);
    await fullSnapshot(building, { finalised: false });

    await snapshotStep();
    expect(await db.count('vouch', {})).toBe(0);
    expect(await db.count('circle_follow', {})).toBe(0);
    expect(await db.count('circle', { eq: { scoring: 'full' } })).toBe(0);
    expect((await usableSnapshot()).scoring).toBe('simple');
  });

  it('to full starts a full build, and scores against the simple one meanwhile', async () => {
    await snapshotStep();
    config.scoring = 'full';
    // A snapshot is keyed by the time it was taken, so the next one is later.
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ['Date'] });
    const { indexCircleFollows } = await import('./lib/precompute.js');
    indexCircleFollows.mockImplementationOnce(async () => ({ unreadable: [] }));

    const res = await snapshotStep();
    expect(res.started).toBeTruthy();
    expect(await db.count('circle', { eq: { scoring: 'full' } })).toBe(2);
    expect((await usableSnapshot()).scoring).toBe('simple');
  });

  it('uses whichever finalised snapshot is newer', async () => {
    await snapshotStep();
    const later = new Date(Date.now() + 60_000).toISOString();
    await fullSnapshot(later);
    expect(await usableSnapshot()).toEqual({ takenAt: later, scoring: 'full' });
  });
});
