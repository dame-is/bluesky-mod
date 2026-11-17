// The snapshot's steps: when one is started, finalised or left alone, and how
// the protected set is swapped without ever being empty.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = {
  circle: [],
  protected: [],
  writes: [],
  takenAt: null,
  counts: {},
  pending: [],
};
const fail = { protectedUpsert: false };

vi.mock('./bot/db.js', () => ({
  // Only the newest snapshot's timestamp is ever read back here.
  select: vi.fn(async (table, { select } = {}) => {
    if (table === 'circle' && select === 'taken_at' && db.takenAt) {
      return [{ taken_at: db.takenAt }];
    }
    // Members still waiting for their follow list.
    if (table === 'circle' && select === 'did,attempts') return db.pending;
    return [];
  }),
  selectAll: vi.fn(async (table, { eq = {} } = {}) =>
    (db[table] || []).filter((r) =>
      Object.entries(eq).every(([k, v]) => r[k] === v),
    ),
  ),
  upsert: vi.fn(async (table, rows) => {
    if (table === 'protected' && fail.protectedUpsert) {
      throw new Error('mod db POST protected failed: 503');
    }
    db.writes.push(table);
    for (const row of rows) {
      const list = (db[table] ||= []);
      const at =
        table === 'protected' ? list.findIndex((r) => r.did === row.did) : -1;
      if (at === -1) list.push({ ...row });
      else list[at] = { ...list[at], ...row };
    }
    return rows.length;
  }),
  del: vi.fn(async (table, { eq = {}, where = {} }) => {
    db.writes.push(`del ${table}`);
    const ids = where.did
      ? where.did
          .slice(4, -1)
          .split(',')
          .map((d) => d.replace(/"/g, ''))
      : null;
    db[table] = db[table].filter(
      (r) =>
        !(
          Object.entries(eq).every(([k, v]) => r[k] === v) &&
          (!ids || ids.includes(r.did))
        ),
    );
  }),
  update: vi.fn(async () => {}),
  rpc: vi.fn(async () => 0),
  count: vi.fn(async (table) => db.counts[table] ?? 0),
}));

vi.mock('./lib/atproto.js', () => ({
  resolvePds: async () => 'https://pds.test',
}));
vi.mock('./lib/precompute.js', () => ({
  readCircle: async () => ['did:plc:friend', 'did:plc:newfriend'],
  readCurationMembers: async () => new Map([['did:plc:curated', 'on a list']]),
  indexCircleFollows: vi.fn(async () => ({ unreadable: [] })),
}));

const { snapshotStep } = await import('./snapshot.js');
const { indexCircleFollows } = await import('./lib/precompute.js');
const { update } = await import('./bot/db.js');

beforeEach(() => {
  fail.protectedUpsert = false;
  db.circle = [];
  db.writes = [];
  db.takenAt = null;
  db.counts = {};
  db.pending = [];
  indexCircleFollows.mockClear();
  update.mockClear();
  db.protected = [
    { did: 'did:plc:friend', reason: 'you follow them', source: 'derived' },
    { did: 'did:plc:unfollowed', reason: 'you follow them', source: 'derived' },
    { did: 'did:plc:byhand', reason: 'added by hand', source: 'manual' },
  ];
});

describe('starting a snapshot', () => {
  it('writes the new protected set before taking the old one out, then the circle', async () => {
    await snapshotStep({ restart: true });
    expect(db.protected.map((r) => r.did).sort()).toEqual([
      'did:plc:byhand',
      'did:plc:curated',
      'did:plc:friend',
      'did:plc:newfriend',
    ]);
    expect(db.writes).toEqual(['protected', 'del protected', 'circle']);
  });

  it('leaves the old set and no new snapshot when the write fails', async () => {
    fail.protectedUpsert = true;
    await expect(snapshotStep({ restart: true })).rejects.toThrow(/503/);
    // Still protected: nobody lost the veto because a write failed.
    expect(db.protected.map((r) => r.did)).toContain('did:plc:friend');
    // And no circle rows, so the next step starts the snapshot again.
    expect(db.circle).toEqual([]);
  });

  it('keeps an entry added by hand as one, even for someone the owner follows', async () => {
    db.protected.push({
      did: 'did:plc:newfriend',
      reason: 'added by hand',
      source: 'manual',
    });
    await snapshotStep({ restart: true });
    expect(
      db.protected.find((r) => r.did === 'did:plc:newfriend'),
    ).toMatchObject({ source: 'manual', reason: 'added by hand' });
  });
});

describe('a snapshot already there', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

  it('is left alone while it is complete and fresh', async () => {
    db.takenAt = daysAgo(2);
    db.counts.vouch = 10;
    expect((await snapshotStep()).state).toBe('idle');
    expect(db.writes).toEqual([]);
  });

  it('is rebuilt once it is older than the maximum age', async () => {
    db.takenAt = daysAgo(8);
    db.counts.vouch = 10;
    await snapshotStep();
    expect(db.writes).toContain('circle');
  });

  it('is finalised, not rebuilt, while edges wait to be aggregated', async () => {
    db.takenAt = daysAgo(2);
    db.counts.circle_follow = 40;
    expect((await snapshotStep()).state).toBe('finalised');
    expect(db.writes).toEqual([]);
  });

  it('is finalised again while it is fresh, even with no vouches', async () => {
    db.takenAt = daysAgo(0.1);
    expect((await snapshotStep()).state).toBe('finalised');
    expect(db.writes).toEqual([]);
  });

  it('is rebuilt after a day when it came to no vouches', async () => {
    db.takenAt = daysAgo(2);
    await snapshotStep();
    expect(db.writes).toContain('circle');
  });
});

describe('a member that cannot be read for now', () => {
  const FLAKY = 'did:plc:flaky';
  const start = Date.parse('2026-11-10T00:00:00.000Z');
  const failing = {
    indexed: 0,
    remaining: 0,
    edges: 0,
    partial: [],
    unreadable: [{ member: FLAKY, permanent: false }],
  };
  const attemptsWritten = () =>
    update.mock.calls
      .filter(([, { eq }]) => eq.did === FLAKY)
      .map(([, , patch]) => patch);

  it('is asked again only after a pause, so a short outage cannot write it off', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    try {
      db.takenAt = new Date(start - 3_600_000).toISOString();
      db.counts.circle = 1;
      indexCircleFollows.mockResolvedValue(failing);

      db.pending = [{ did: FLAKY, attempts: 0 }];
      expect((await snapshotStep()).state).toBe('collecting');
      expect(attemptsWritten()).toEqual([{ attempts: 1 }]);

      // The next step comes a moment later. Asking again now would spend a
      // second attempt on the same outage.
      db.pending = [{ did: FLAKY, attempts: 1 }];
      vi.setSystemTime(start + 1000);
      expect((await snapshotStep()).state).toBe('waiting');
      expect(indexCircleFollows).toHaveBeenCalledTimes(1);
      expect(attemptsWritten()).toHaveLength(1);

      // After the pause it is asked again, and the ceiling still holds.
      vi.setSystemTime(start + 11 * 60_000);
      await snapshotStep();
      expect(indexCircleFollows).toHaveBeenCalledTimes(2);
      db.pending = [{ did: FLAKY, attempts: 2 }];
      vi.setSystemTime(start + 22 * 60_000);
      await snapshotStep();
      expect(attemptsWritten().at(-1)).toMatchObject({
        attempts: 3,
        unreadable: 'unreadable after 3 attempts',
      });
    } finally {
      vi.useRealTimers();
      indexCircleFollows.mockReset();
      indexCircleFollows.mockImplementation(async () => ({ unreadable: [] }));
    }
  });
});
