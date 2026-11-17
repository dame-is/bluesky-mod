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

vi.mock('./bulkPlan.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    proposePlan: vi.fn(real.proposePlan),
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
  };
});

const { checkWatch, digestFor, startWatch, quietSinceLastRead, FULL_READ_EVERY_MS } =
  await import('./watch.js');
const { createActivity } = await import('../ownerActivity.js');
const { LINK_SOURCES } = await import('../spacedust.js');
const { harvestPost } = await import('../lib/harvest.js');
const { applyPlanToTriage, proposePlan } = await import('./bulkPlan.js');
const { runTriage } = await import('./triage.js');

const PLAN_ID = '1c2d3e4f-0000-4000-8000-000000000000';
/** The scan startWatch makes of everyone already there. */
const BASE_ID = '0a0b0c0d-0000-4000-8000-000000000000';
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
  plan_id: BASE_ID,
  did: `did:plc:${name}`,
  band: 'UNKNOWN',
  evidence_uri: `at://did:plc:${name}/app.bsky.feed.post/r-${name}`,
  triage: null,
  ...extra,
});

/** A newcomer an earlier check put on the watch's plan, still unread. */
const earlierRow = (name) => ({ ...baselineRow(name), plan_id: PLAN_ID });

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
    stats: { baseline: 4, baselinePlan: BASE_ID, ...stats },
  };
  db.watch.push(w);
  return w;
};

beforeEach(() => {
  db.plan = [
    { id: PLAN_ID, created_at: '2026-11-01T00:00:00Z' },
    { id: BASE_ID, created_at: '2026-11-01T00:00:00Z' },
  ];
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

  it('never adds the baseline, even once another triage labels it', async () => {
    // As "triage <code>" or the agent's triage_plan leaves it, with no
    // limit on whom it reads.
    db.decision = ['ann', 'bob'].map((n) =>
      baselineRow(n, { triage: 'hostile', triage_at: '2026-11-01T01:00:00Z' }),
    );
    harvest.participants = [
      person('ann', 'go away'),
      person('bob', 'go away'),
      person('eve', 'go away'),
    ];
    const w = watchRow('auto');
    const out = await checkWatch(w, deps());
    expect(out).toMatchObject({ fresh: 1, added: 1, held: 0 });
    expect(db.decision.filter((r) => r.acted_at).map((r) => r.did)).toEqual([
      'did:plc:eve',
    ]);
    expect(db.decision.filter((r) => r.plan_id === PLAN_ID)).toHaveLength(1);
  });

  it("never reads or adds the post's author or the bot", async () => {
    // The author answering in their own thread, and the bot answering a
    // mention there, are not a pile-on.
    vi.stubEnv('MOD_LIST_URI', 'at://did:plc:bot/app.bsky.graph.list/3list');
    try {
      harvest.participants = [
        person('owner', 'thanks all'),
        person('bot', 'here is what I found'),
        person('eve', 'go away'),
      ];
      const out = await checkWatch(watchRow('auto'), deps());
      expect(out).toMatchObject({ fresh: 1, hostile: 1, added: 1 });
      expect(db.decision.map((r) => r.did)).toEqual(['did:plc:eve']);
    } finally {
      vi.unstubAllEnvs();
    }
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

  it('keeps what a check found when its add fails', async () => {
    harvest.participants = [person('eve', 'one'), person('fay', 'two')];
    const w = watchRow('auto');
    let fayFails = true;
    const generate = vi.fn(async (opts) => {
      if (fayFails && opts.messages[0].content.includes('two')) {
        throw new Error('429');
      }
      return allHostile(opts);
    });
    applyPlanToTriage.mockRejectedValueOnce(new Error('FOLLOWS_UNREADABLE'));
    const log = vi.fn();

    const first = await checkWatch(w, { ...deps(), generate, log });
    expect(first).toMatchObject({ fresh: 2, hostile: 1, added: 0 });
    expect(w.stats).toMatchObject({
      unread: ['did:plc:fay'],
      newTotal: 2,
      newSinceDigest: 2,
      hostileSinceDigest: 1,
    });
    expect(log).toHaveBeenCalledWith(
      'Watch add failed',
      expect.objectContaining({ err: 'FOLLOWS_UNREADABLE' }),
    );

    fayFails = false;
    const second = await checkWatch(w, { ...deps(), generate });
    expect(second).toMatchObject({ fresh: 0, hostile: 1, added: 2 });
    expect(w.stats).toMatchObject({ unread: [], newTotal: 2, addedTotal: 2 });
  });

  it('counts a batch it finds already written as added', async () => {
    // An earlier check's applyWrites reply was lost; this check finds the
    // batch on the list and records it rather than writing it again.
    harvest.participants = [person('eve', 'one')];
    const w = watchRow('auto');
    applyPlanToTriage.mockResolvedValueOnce({ ok: true, added: 0, recorded: 1 });

    const out = await checkWatch(w, deps());
    expect(out).toMatchObject({ hostile: 1, added: 1 });
    expect(w.stats).toMatchObject({ addedSinceDigest: 1, addedTotal: 1 });
  });

  it('counts a batch once when its stamp failed and a later check records it', async () => {
    harvest.participants = [person('eve', 'one')];
    const w = watchRow('auto');
    applyPlanToTriage.mockResolvedValueOnce({
      ok: true,
      added: 1,
      unstamped: 1,
      recorded: 0,
    });
    expect(await checkWatch(w, deps())).toMatchObject({ added: 0 });

    applyPlanToTriage.mockResolvedValueOnce({ ok: true, added: 0, recorded: 1 });
    harvest.participants = [person('eve', 'one'), person('fay', 'two')];
    await checkWatch(w, deps());
    expect(w.stats).toMatchObject({ addedTotal: 1 });
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

  it('reads one wave a check, the ones waiting longest first', async () => {
    // Twelve calls make a wave. Thirteen waited from earlier checks, and a
    // newcomer whose DID sorts first arrives now.
    const waiting = Array.from({ length: 13 }, (_, i) => `w${10 + i}`);
    for (const n of waiting) person(n, 'go away');
    db.decision = waiting.map((n) => earlierRow(n));
    harvest.participants = [
      ...waiting.map((n) => person(n, 'go away')),
      person('aaa', 'go away'),
    ];
    const w = watchRow('auto', {
      unread: waiting.map((n) => `did:plc:${n}`),
    });
    await checkWatch(w, { ...deps(), generate: allHostile });
    expect(firstReads()).toHaveLength(12);
    expect(w.stats.unread).toEqual(['did:plc:w22', 'did:plc:aaa']);
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

describe('starting a watch', () => {
  it('keeps the baseline on a scan of its own, apart from what the watch adds', async () => {
    harvest.participants = [person('ann', 'go away'), person('bob', 'go away')];
    proposePlan.mockImplementationOnce(async () => {
      db.decision.push(baselineRow('ann'), baselineRow('bob'));
      return { planId: BASE_ID, code: '0a0b0c0d', total: 2 };
    });
    const { watch, plan, code } = await startWatch({
      convoId: 'c1',
      target: POST,
      auto: true,
    });
    expect(plan).toMatchObject({ planId: BASE_ID, total: 2 });
    expect(watch.plan_id).not.toBe(BASE_ID);
    // The code handed back is the watch's, which holds what it adds.
    expect(code).toBe(watch.plan_id.replace(/-/g, '').slice(0, 8));
    expect(watch.stats).toMatchObject({ baseline: 2, baselinePlan: BASE_ID });
    expect(db.plan.find((p) => p.id === watch.plan_id)).toMatchObject({
      totals: { uri: POST },
    });

    // The owner reads what is already there with the code they were given.
    await runTriage({ id: plan.planId }, { generate: allHostile, model: 'm' });
    expect(db.decision.filter((r) => r.triage === 'hostile')).toHaveLength(2);

    const out = await checkWatch(watch, deps());
    expect(out).toEqual({ fresh: 0, hostile: 0, added: 0, held: 0, skipped: false });
    expect(db.decision.filter((r) => r.acted_at)).toEqual([]);
    expect(
      await digestFor(watch, { now: Date.now(), ending: true }),
    ).toMatchObject({ pending: null });
  });

  it('watches only a post, never a list', async () => {
    harvestPost.mockClear();
    await expect(
      startWatch({
        convoId: 'c1',
        target: 'at://did:plc:maker/app.bsky.graph.list/3abc',
      }),
    ).rejects.toThrow('I watch posts, and that is not a post.');
    expect(harvestPost).not.toHaveBeenCalled();
    expect(db.watch).toEqual([]);
  });

  it('hands the turn signal to the scan it starts', async () => {
    harvestPost.mockClear();
    const signal = AbortSignal.abort(new Error('That took too long'));
    await expect(
      startWatch({ convoId: 'c1', target: POST, signal }),
    ).rejects.toThrow('That took too long');
    expect(harvestPost.mock.calls[0][1]).toMatchObject({ signal });
    expect(db.watch).toEqual([]);
  });
});

describe('skipping a read the stream says is not needed', () => {
  const T0 = Date.parse('2026-11-17T12:00:00.000Z');
  const stream = (clock) => {
    const a = createActivity({ now: () => clock.t, coveredFromStart: false, ownerDid: 'did:plc:owner' });
    a.opened([]);
    return a;
  };
  const reply = (n) => ({
    kind: 'link',
    link: {
      operation: 'create',
      source: LINK_SOURCES.reply,
      source_record: `at://did:plc:late${n}/app.bsky.feed.post/r${n}`,
      subject: POST,
    },
  });

  it('skips only with unbroken cover since the last read and a recent full read', () => {
    const clock = { t: T0 };
    const a = stream(clock);
    clock.t = T0 + 10 * 60_000;
    const w = {
      uri: POST,
      last_checked_at: new Date(T0 + 5 * 60_000).toISOString(),
      stats: { lastReadAt: new Date(T0 + 5 * 60_000).toISOString() },
    };
    expect(quietSinceLastRead(w, a, { now: clock.t })).toBe(true);
    // Something arrived since the last read.
    a.record(reply(1));
    expect(quietSinceLastRead(w, a, { now: clock.t })).toBe(false);
  });

  it('reads when there is no stream, no full read yet, or the last one is old', () => {
    const clock = { t: T0 + 10 * 60_000 };
    const a = stream({ t: T0 });
    const base = { uri: POST, last_checked_at: new Date(T0 + 5 * 60_000).toISOString() };
    expect(quietSinceLastRead({ ...base, stats: { lastReadAt: base.last_checked_at } }, null, { now: clock.t })).toBe(false);
    expect(quietSinceLastRead({ ...base, stats: {} }, a, { now: clock.t })).toBe(false);
    expect(
      quietSinceLastRead(
        { ...base, stats: { lastReadAt: new Date(clock.t - FULL_READ_EVERY_MS).toISOString() } },
        a,
        { now: clock.t },
      ),
    ).toBe(false);
  });

  it("reads someone else's post the stream has not been asking about", () => {
    const clock = { t: T0 };
    const a = stream(clock);
    clock.t = T0 + 10 * 60_000;
    const other = 'at://did:plc:stranger/app.bsky.feed.post/3zzz';
    const w = {
      uri: other,
      last_checked_at: new Date(T0 + 5 * 60_000).toISOString(),
      stats: { lastReadAt: new Date(T0 + 5 * 60_000).toISOString() },
    };
    expect(quietSinceLastRead(w, a, { now: clock.t })).toBe(false);
  });

  it('checks without harvesting when quiet, and still reads what waits for a model', async () => {
    const clock = { t: T0 };
    const a = stream(clock);
    clock.t = T0 + 10 * 60_000;
    const w = watchRow('ask', {
      lastReadAt: new Date(T0 + 5 * 60_000).toISOString(),
      unread: ['did:plc:carl'],
    });
    w.last_checked_at = new Date(T0 + 5 * 60_000).toISOString();
    db.decision.push(earlierRow('carl'));
    TEXT['at://did:plc:carl/app.bsky.feed.post/r-carl'] = 'get lost';
    harvestPost.mockClear();
    const out = await checkWatch(w, { ...deps(), activity: a }, { now: clock.t });
    expect(harvestPost).not.toHaveBeenCalled();
    expect(out.skipped).toBe(true);
    expect(out.hostile).toBe(1);
    expect(w.stats.readsSkipped).toBe(1);
    expect(w.stats.lastReadAt).toBe(new Date(T0 + 5 * 60_000).toISOString());
  });
});
