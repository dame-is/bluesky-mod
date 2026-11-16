// The snapshot's steps: when one is started, finalised or left alone, and how
// the protected set is swapped without ever being empty.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { circle: [], protected: [], writes: [], takenAt: null, counts: {} };
const fail = { protectedUpsert: false };

vi.mock('./bot/db.js', () => ({
  // Only the newest snapshot's timestamp is ever read back here.
  select: vi.fn(async (table, { select } = {}) =>
    table === 'circle' && select === 'taken_at' && db.takenAt
      ? [{ taken_at: db.takenAt }]
      : [],
  ),
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
  indexCircleFollows: async () => ({ unreadable: [] }),
}));

const { snapshotStep } = await import('./snapshot.js');

beforeEach(() => {
  fail.protectedUpsert = false;
  db.circle = [];
  db.writes = [];
  db.takenAt = null;
  db.counts = {};
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
