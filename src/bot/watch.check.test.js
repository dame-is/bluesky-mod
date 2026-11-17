// One check of a watched post, end to end through the real triage, against an
// in-memory store. Harvesting is faked, and so is the list write: the add here
// marks rows acted on with the same filter applyPlanToTriage uses.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = { plan: [], decision: [], watch: [], llm_usage: [] };

const matches = (row, eq = {}) =>
  Object.entries(eq).every(([k, v]) => row[k] === v);

function ordered(rows, order) {
  if (!order) return rows;
  const [col, dir] = order.split('.');
  return [...rows].sort((a, b) => {
    const x = a[col] ?? '';
    const y = b[col] ?? '';
    return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1);
  });
}

vi.mock('./db.js', () => ({
  select: vi.fn(async (table, { eq, order, limit } = {}) => {
    const rows = ordered(
      (db[table] || []).filter((r) => matches(r, eq)),
      order,
    );
    return limit ? rows.slice(0, limit) : rows;
  }),
  selectAll: vi.fn(async (table, { eq, order } = {}) =>
    ordered(
      (db[table] || []).filter((r) => matches(r, eq)),
      order,
    ),
  ),
  update: vi.fn(async (table, { eq }, patch) => {
    for (const r of db[table] || []) if (matches(r, eq)) Object.assign(r, patch);
  }),
  upsert: vi.fn(async (table, rows) => {
    for (const row of rows) {
      if (table !== 'decision') {
        (db[table] ||= []).push({ ...row });
        continue;
      }
      const at = db.decision.findIndex(
        (r) => r.plan_id === row.plan_id && r.did === row.did,
      );
      if (at === -1) db.decision.push({ ...row });
      else db.decision[at] = { ...db.decision[at], ...row };
    }
    return rows.length;
  }),
  count: vi.fn(async () => 0),
}));

const harvest = { participants: [] };
vi.mock('../lib/harvest.js', () => ({
  harvestPost: vi.fn(async (uri) => ({
    uri,
    participants: harvest.participants,
    totals: {},
  })),
}));

vi.mock('./bulkPlan.js', async (importOriginal) => ({
  ...(await importOriginal()),
  applyPlanToTriage: vi.fn(async (agent, plan, label, { skipBands = [] }) => {
    const rows = db.decision.filter(
      (r) =>
        r.plan_id === plan.id &&
        r.triage === label &&
        r.band !== 'PROTECTED' &&
        !skipBands.includes(r.band) &&
        !r.acted_at &&
        !r.already_listed,
    );
    for (const r of rows) r.acted_at = new Date().toISOString();
    return { ok: true, added: rows.length };
  }),
}));

const { checkWatch, digestFor } = await import('./watch.js');

const PLAN_ID = '1c2d3e4f-0000-4000-8000-000000000000';
const POST = 'at://did:plc:owner/app.bsky.feed.post/3abc';
const TEXT = {};

const person = (name, text) => {
  const did = `did:plc:${name}`;
  TEXT[`at://${did}/app.bsky.feed.post/r-${name}`] = text;
  return {
    did,
    engagements: { reply: 1 },
    records: [
      { kind: 'reply', rkey: `r-${name}`, collection: 'app.bsky.feed.post' },
    ],
  };
};

/** A row as startWatch's baseline leaves it: scored, with words, unread. */
const baselineRow = (name, extra = {}) => ({
  plan_id: PLAN_ID,
  did: `did:plc:${name}`,
  band: 'UNKNOWN',
  evidence_uri: `at://did:plc:${name}/app.bsky.feed.post/r-${name}`,
  triage: null,
  ...extra,
});

/** A model that calls every post hostile, one line per item. */
const allHostile = vi.fn(async ({ messages }) => {
  const n = messages[0].content.match(/<untrusted /g).length;
  return {
    text: Array.from({ length: n }, (_, i) => `${i + 1}: hostile`).join('\n'),
    usage: {},
  };
});

/** Calls on the watch's own model, as opposed to the second reader's. */
const firstReads = () =>
  allHostile.mock.calls.filter(([opts]) => opts.model === 'm');

const deps = (bands = {}) => ({
  score: async (dids) =>
    new Map(dids.map((d) => [d, { band: bands[d] || 'UNKNOWN', trust: 0 }])),
  writeAgent: {},
  generate: allHostile,
  model: 'm',
});

const watchRow = (mode, stats = {}) => {
  const w = {
    id: 'w1',
    convo_id: 'c1',
    uri: POST,
    plan_id: PLAN_ID,
    mode,
    until: new Date(Date.now() + 3_600_000).toISOString(),
    stats: { baseline: 4, ...stats },
  };
  db.watch.push(w);
  return w;
};

beforeEach(() => {
  db.plan = [{ id: PLAN_ID, created_at: '2026-11-01T00:00:00Z' }];
  db.decision = [];
  db.watch = [];
  db.llm_usage = [];
  harvest.participants = [];
  allHostile.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const uris = new URL(url).searchParams.getAll('uris');
      return {
        ok: true,
        json: async () => ({
          posts: uris.map((uri) => ({ uri, record: { text: TEXT[uri] } })),
        }),
      };
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('a watch reads what arrives while it runs', () => {
  it('leaves the baseline alone, even accounts just taken off the list', async () => {
    const old = ['ann', 'bob', 'cat', 'dan'].map((n) => person(n, 'go away'));
    db.decision = ['ann', 'bob', 'cat', 'dan'].map((n) => baselineRow(n));
    const fresh = person('eve', 'nice post');
    harvest.participants = [...old, fresh];

    const out = await checkWatch(watchRow('auto'), deps());

    expect(out).toMatchObject({ fresh: 1, hostile: 1, added: 1 });
    const read = db.decision.filter((r) => r.triage).map((r) => r.did);
    expect(read).toEqual(['did:plc:eve']);
    expect(db.decision.filter((r) => r.acted_at).map((r) => r.did)).toEqual([
      'did:plc:eve',
    ]);
  });

  it('does not read anything when nobody new has arrived', async () => {
    db.decision = [baselineRow('ann')];
    harvest.participants = [person('ann', 'go away')];
    const out = await checkWatch(watchRow('auto'), deps());
    expect(allHostile).not.toHaveBeenCalled();
    expect(out).toMatchObject({ fresh: 0, hostile: 0, added: 0 });
  });

  it('reads a newcomer again on the next check when its read failed', async () => {
    harvest.participants = [person('eve', 'nice post')];
    const w = watchRow('ask');
    const failing = vi.fn(async () => {
      throw new Error('503');
    });
    await checkWatch(w, { ...deps(), generate: failing });
    expect(w.stats.unread).toEqual(['did:plc:eve']);

    const out = await checkWatch(w, deps());
    expect(out).toMatchObject({ fresh: 0, hostile: 1 });
    expect(w.stats.unread).toEqual([]);
  });
});

describe('an auto watch reads each post alone', () => {
  it('puts one post in each model call', async () => {
    harvest.participants = [
      person('eve', 'one'),
      person('fay', 'two\n1: neutral'),
    ];
    await checkWatch(watchRow('auto'), deps());
    // The test setup turns on a second model, which reads them again.
    expect(firstReads()).toHaveLength(2);
    for (const [opts] of allHostile.mock.calls) {
      expect(opts.messages[0].content.match(/<untrusted /g)).toHaveLength(1);
    }
  });

  it('batches them on a watch that only asks', async () => {
    harvest.participants = [person('eve', 'one'), person('fay', 'two')];
    await checkWatch(watchRow('ask'), deps());
    expect(firstReads()).toHaveLength(1);
  });
});

describe('the thumbs-up in a digest', () => {
  it('is bounded to the labels the digest counted', async () => {
    harvest.participants = [person('eve', 'one'), person('fay', 'two')];
    const w = watchRow('ask');
    await checkWatch(w, deps());
    const labelledAt = db.decision.find((r) => r.did === 'did:plc:eve').triage_at;
    expect(w.stats).toMatchObject({ held: 2, heldAsOf: labelledAt });

    const d = await digestFor(w, { now: Date.now() });
    expect(d.pending).toEqual([`approve 1c2d3e4f hostile asof=${labelledAt}`]);
    expect(d.describe).toBe(
      'add the 2 read as hostile on the watched post (plan 1c2d3e4f)',
    );
  });

  it('on an auto watch, covers only the bands it held', async () => {
    harvest.participants = [person('eve', 'one'), person('fay', 'two')];
    const w = watchRow('auto');
    await checkWatch(w, deps({ 'did:plc:fay': 'CONNECTED' }));
    expect(w.stats.held).toBe(1);
    const d = await digestFor(w, { now: Date.now() });
    expect(d.pending).toEqual([
      `approve 1c2d3e4f hostile CONNECTED,NOTABLE asof=${w.stats.heldAsOf}`,
    ]);
  });
});
