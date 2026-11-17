// A snapshot dated ahead of the clock, against the real store: written while
// the clock ran fast, it must not stop the next rebuild, or the protected set
// that is rebuilt with it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./lib/atproto.js', () => ({
  resolvePds: async () => 'https://pds.test',
}));
vi.mock('./lib/precompute.js', () => ({
  readCircle: async () => ['did:plc:friend', 'did:plc:newfriend'],
  readCurationMembers: async () => new Map(),
  // Every member read at once, each following one account.
  indexCircleFollows: async ({ pending, writeEdges, markDone }) => {
    await writeEdges(
      pending.map((member) => ({ member, target: 'did:plc:someone' })),
    );
    for (const member of pending) await markDone(member);
    return { unreadable: [] };
  },
}));

const { snapshotStep } = await import('./snapshot.js');
const { closeDb, upsert, select, count } = await import('./bot/db.js');

/** Taken and finalised while the clock ran a year fast. */
const AHEAD = '2027-11-16T00:00:00.000Z';

beforeEach(async () => {
  closeDb();
  await upsert('circle', [
    { taken_at: AHEAD, did: 'did:plc:friend', follows_indexed_at: AHEAD },
  ]);
  await upsert('vouch', [{ taken_at: AHEAD, did: 'did:plc:x', vouches: 1 }]);
  await upsert('protected', [
    { did: 'did:plc:friend', reason: 'you follow them', source: 'derived' },
  ]);
  vi.useFakeTimers({ toFake: ['Date'] });
  // The clock is put right, two weeks after the real date it ran fast on.
  vi.setSystemTime(new Date('2026-11-30T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const newestVouches = async () =>
  (await select('vouch', { select: 'taken_at', order: 'taken_at.desc', limit: 1 }))[0]
    ?.taken_at;

describe('a snapshot dated ahead of the clock', () => {
  it('is rebuilt, so someone the owner follows since is protected', async () => {
    const first = await snapshotStep();
    expect(first.state).not.toBe('idle');
    expect(first.started?.takenAt).toBe('2026-11-30T00:00:00.000Z');
    expect(
      (await select('protected', { select: 'did', order: 'did.asc' })).map(
        (r) => r.did,
      ),
    ).toContain('did:plc:newfriend');
  });

  it('is scored against until the new one is finalised, then dropped', async () => {
    const first = await snapshotStep();
    // Still there to score against while the new one is built.
    expect(await newestVouches()).toBe(AHEAD);

    // The next step goes on with the new snapshot rather than starting another.
    vi.setSystemTime(new Date('2026-11-30T00:01:00Z'));
    const next = await snapshotStep();
    expect(next.started ?? null).toBe(null);
    expect(next.snapshot).toBe(first.snapshot);
    expect(next.state).toBe('finalised');

    expect(await newestVouches()).toBe(first.snapshot);
    expect(await count('circle', { eq: { taken_at: AHEAD } })).toBe(0);
    expect(await count('vouch', { eq: { taken_at: AHEAD } })).toBe(0);
    expect((await snapshotStep()).state).toBe('idle');
  });

  it('is left alone when it is only a little ahead', async () => {
    closeDb();
    const soon = '2026-11-30T00:02:00.000Z';
    await upsert('circle', [
      { taken_at: soon, did: 'did:plc:friend', follows_indexed_at: soon },
    ]);
    await upsert('vouch', [{ taken_at: soon, did: 'did:plc:x', vouches: 1 }]);
    const out = await snapshotStep();
    expect(out.state).toBe('idle');
    expect(out.snapshot).toBe(soon);
  });
});
