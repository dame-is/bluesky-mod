// Starting a snapshot: the protected set is swapped without ever being empty,
// and a failure part way through leaves the old one and no new snapshot.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { circle: [], protected: [], writes: [] };
const fail = { protectedUpsert: false };

vi.mock('./bot/db.js', () => ({
  select: vi.fn(async () => []),
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
  count: vi.fn(async () => 0),
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
});
