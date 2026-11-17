// Approve, undo, "undo last" and history, against an in-memory decision log,
// a stubbed Constellation lookup and a fake repo.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const LIST = 'at://did:plc:bot/app.bsky.graph.list/3list';
const PLAN_A = '1c2d3e4f-0000-4000-8000-000000000001';
const PLAN_B = '9e8d7c6b-0000-4000-8000-000000000002';

const db = {
  plan: [],
  decision: [],
  protected: [],
  writes: [],
  reads: [],
  // When set, recording that a write happened fails, as a locked or full
  // database would.
  failStamp: null,
};

/** Enough of db.js's filter grammar for what bulkPlan.js sends. */
function matches(row, { eq = {}, where = {} } = {}) {
  for (const [k, v] of Object.entries(eq)) if (row[k] !== v) return false;
  for (const [k, raw] of Object.entries(where)) {
    for (const v of [raw].flat()) {
      const val = row[k];
      if (v === 'not.is.null' && val == null) return false;
      if (v === 'is.null' && val != null) return false;
      if (v === 'is.true' && val !== true) return false;
      if (v === 'is.false' && val !== false) return false;
      if (v.startsWith('gte.') && !(String(val) >= v.slice(4))) return false;
      if (v.startsWith('lte.') && !(String(val) <= v.slice(4))) return false;
      if (v.startsWith('in.(')) {
        const set = v
          .slice(4, -1)
          .split(',')
          .map((x) => x.replace(/"/g, ''));
        if (!set.includes(val)) return false;
      }
    }
  }
  return true;
}

function query(table, opts = {}) {
  db.reads.push({ table, opts });
  let rows = (db[table] || []).filter((r) => matches(r, opts));
  const [col, dir] = String(opts.order || '')
    .split(',')[0]
    .split('.');
  if (col) {
    rows = [...rows].sort((a, b) =>
      dir === 'desc'
        ? String(b[col]).localeCompare(String(a[col]))
        : String(a[col]).localeCompare(String(b[col])),
    );
  }
  return opts.limit ? rows.slice(0, opts.limit) : rows;
}

vi.mock('./db.js', () => ({
  select: vi.fn(async (table, opts) => query(table, opts)),
  selectAll: vi.fn(async (table, opts) => query(table, opts)),
  count: vi.fn(
    async (table, { eq = {}, not_null } = {}) =>
      query(table, { eq, where: not_null ? { [not_null]: 'not.is.null' } : {} })
        .length,
  ),
  update: vi.fn(async (table, match, patch) => {
    for (const row of query(table, match)) Object.assign(row, patch);
  }),
  upsert: vi.fn(async (table, rows) => {
    if (table === 'decision' && db.failStamp && rows.some((r) => r.acted_at)) {
      throw new Error(db.failStamp);
    }
    db.writes.push({ table, rows });
    const keys = rows.map((r) => `${r.plan_id}|${r.did}`);
    // One upsert should never name the same row twice.
    if (new Set(keys).size !== keys.length) {
      throw new Error('upsert names the same row twice');
    }
    for (const row of rows) {
      const list = (db[table] ||= []);
      const at = list.findIndex(
        (r) => r.plan_id === row.plan_id && r.did === row.did,
      );
      if (at === -1) list.push({ ...row });
      else list[at] = { ...list[at], ...row };
    }
    return rows.length;
  }),
}));

const constellation = new Map(); // did -> rkeys; absent means "none"
const graph = {
  rkeysForWrite: vi.fn(async (list, did) => constellation.get(did) ?? []),
  noteUnlisted: vi.fn(),
  noteListed: vi.fn(),
  isListed: vi.fn(() => null),
  graphFacts: vi.fn(async () => null),
};
vi.mock('./graphFacts.js', () => graph);
const veto = { unreadable: false };
vi.mock('./listWrite.js', () => ({
  listUri: () => LIST,
  ownerOf: (uri) => /^at:\/\/(did:[^/]+)\//.exec(String(uri ?? ''))?.[1] ?? null,
  protectedAmong: async (dids) => {
    if (veto.unreadable) throw new Error('could not read the protected set');
    return new Set(
      db.protected.map((r) => r.did).filter((did) => dids.includes(did)),
    );
  },
}));

const {
  applyPlan,
  applyPlanToActors,
  undoPlan,
  lastActedPlan,
  findPlan,
  historyFor,
} = await import('./bulkPlan.js');

/** The bot's repo: rkey -> subject. */
let repo;
function bot() {
  return {
    session: { did: 'did:plc:bot' },
    com: {
      atproto: {
        repo: {
          listRecords: vi.fn(async () => ({
            data: {
              records: [...repo].map(([rkey, subject]) => ({
                uri: `at://did:plc:bot/app.bsky.graph.listitem/${rkey}`,
                value: { list: LIST, subject },
              })),
            },
          })),
          applyWrites: vi.fn(async ({ writes }) => {
            const deletes = writes.filter((w) => w.$type.endsWith('#delete'));
            for (const w of deletes) {
              if (!repo.has(w.rkey)) throw new Error('Could not find record');
            }
            for (const w of deletes) repo.delete(w.rkey);
            const results = writes
              .filter((w) => w.$type.endsWith('#create'))
              .map((w) => {
                const rkey = `rk-new-${repo.size + 1}`;
                repo.set(rkey, w.value.subject);
                return {
                  uri: `at://did:plc:bot/app.bsky.graph.listitem/${rkey}`,
                };
              });
            return { data: { results } };
          }),
          deleteRecord: vi.fn(async ({ rkey }) => {
            if (!repo.has(rkey)) throw new Error('Could not locate record');
            repo.delete(rkey);
          }),
        },
      },
    },
  };
}

const added = (plan_id, did, acted_at, extra = {}) => ({
  plan_id,
  did,
  band: 'UNKNOWN',
  action: 'list_add',
  acted_at,
  undone_at: null,
  ...extra,
});
/** A scanned account in a plan, not yet acted on. */
const scanned = (plan_id, did, band) => ({
  plan_id,
  did,
  band,
  action: null,
  acted_at: null,
  undone_at: null,
  engaged: ['like'],
  already_listed: false,
});
const row = (plan_id, did) =>
  db.decision.find((r) => r.plan_id === plan_id && r.did === did);

beforeEach(() => {
  db.plan = [
    { id: PLAN_A, created_at: '2026-10-01T10:00:00Z', note: 'block @a.test' },
    { id: PLAN_B, created_at: '2026-10-01T11:00:00Z', note: 'block @b.test' },
  ];
  db.decision = [];
  db.protected = [];
  db.writes = [];
  db.reads = [];
  db.failStamp = null;
  veto.unreadable = false;
  constellation.clear();
  repo = new Map();
  for (const fn of Object.values(graph)) fn.mockReset();
  graph.rkeysForWrite.mockImplementation(
    async (list, did) => constellation.get(did) ?? [],
  );
  graph.isListed.mockReturnValue(null);
  graph.graphFacts.mockResolvedValue(null);
});

/** The held copy of the list reads the fake repo, as it would after a reload. */
function heldCopyReadsRepo() {
  graph.graphFacts.mockResolvedValue({ listed: new Map() });
  graph.isListed.mockImplementation((list, did) =>
    [...repo.values()].includes(did),
  );
}

/** A repo whose next applyWrites commits and then loses its reply. */
function losesReply(agent) {
  const write = agent.com.atproto.repo.applyWrites.getMockImplementation();
  agent.com.atproto.repo.applyWrites.mockImplementationOnce(async (args) => {
    await write(args);
    throw new Error('socket hang up');
  });
  return agent;
}

describe('finding a plan', () => {
  it('asks for the uuid range a code names, not for every plan', async () => {
    expect((await findPlan('9E8D7C6B')).id).toBe(PLAN_B);
    const read = db.reads.at(-1);
    expect(read.opts.limit).toBe(1);
    expect(read.opts.where.id).toEqual([
      'gte.9e8d7c6b-0000-0000-0000-000000000000',
      'lte.9e8d7c6b-ffff-ffff-ffff-ffffffffffff',
    ]);
  });

  it('answers null for something that is not a code, without asking', async () => {
    expect(await findPlan('nope')).toBe(null);
    expect(await findPlan(undefined)).toBe(null);
    expect(db.reads).toEqual([]);
  });
});

describe('approve', () => {
  it('checks the protected set at the write, not only the band in the plan', async () => {
    db.decision = [
      scanned(PLAN_A, 'did:plc:a', 'UNKNOWN'),
      scanned(PLAN_A, 'did:plc:f', 'UNKNOWN'),
    ];
    // Followed after the plan was made.
    db.protected = [{ did: 'did:plc:f', reason: 'you follow them' }];

    const out = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);

    expect(out).toMatchObject({ added: 1, remaining: 0 });
    expect(out.message).toMatch(/1 refused: PROTECTED/);
    expect([...repo.values()]).toEqual(['did:plc:a']);
    expect(row(PLAN_A, 'did:plc:f').acted_at).toBe(null);
  });

  it('writes nothing when the protected set cannot be read', async () => {
    db.decision = [scanned(PLAN_A, 'did:plc:a', 'UNKNOWN')];
    veto.unreadable = true;
    await expect(applyPlan(bot(), db.plan[0], ['UNKNOWN'])).rejects.toThrow(
      /protected set/,
    );
    expect(repo.size).toBe(0);
  });

  it('keeps every band approved in the plan record, rate limit or not', async () => {
    db.decision = [
      scanned(PLAN_A, 'did:plc:a', 'UNKNOWN'),
      scanned(PLAN_A, 'did:plc:n', 'NOTABLE'),
    ];
    await applyPlan(bot(), db.plan[0], ['UNKNOWN']);

    const limited = bot();
    limited.com.atproto.repo.applyWrites.mockRejectedValue(
      new Error('Rate Limit Exceeded'),
    );
    const out = await applyPlan(limited, await findPlan('1c2d3e4f'), [
      'NOTABLE',
    ]);

    expect(out).toMatchObject({ added: 0, remaining: 1 });
    expect(db.plan[0].approved_at).toBeTruthy();
    expect(db.plan[0].approved_bands).toEqual(['UNKNOWN', 'NOTABLE']);
  });

  it('records a batch the PDS took when the reply was lost, on the next approval, so undo finds it', async () => {
    heldCopyReadsRepo();
    db.decision = [
      scanned(PLAN_A, 'did:plc:a', 'UNKNOWN'),
      scanned(PLAN_A, 'did:plc:c', 'UNKNOWN'),
    ];

    const first = await applyPlan(losesReply(bot()), db.plan[0], ['UNKNOWN']);
    expect(first).toMatchObject({ added: 0, failed: 2 });
    expect(repo.size).toBe(2);

    const again = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
    expect(again).toMatchObject({ added: 2, already: 0 });
    // Not written a second time.
    expect(repo.size).toBe(2);
    expect(row(PLAN_A, 'did:plc:a')).toMatchObject({
      action: 'list_add',
      approved_via: 'band',
    });
    expect(row(PLAN_A, 'did:plc:a').acted_at).toBeTruthy();

    const undo = await undoPlan(bot(), db.plan[0]);
    expect(undo).toMatchObject({ removed: 2, remaining: 0 });
    expect(repo.size).toBe(0);
  });

  it('undoes a batch the PDS took when the reply was lost, without approving again', async () => {
    db.decision = [
      scanned(PLAN_A, 'did:plc:a', 'UNKNOWN'),
      scanned(PLAN_A, 'did:plc:c', 'UNKNOWN'),
    ];
    await applyPlan(losesReply(bot()), db.plan[0], ['UNKNOWN']);
    expect(repo.size).toBe(2);

    const undo = await undoPlan(bot(), db.plan[0], { reason: 'undo' });

    expect(undo).toMatchObject({ removed: 2, remaining: 0 });
    expect(repo.size).toBe(0);
    expect(row(PLAN_A, 'did:plc:a').undone_at).toBeTruthy();
  });

  it('counts a batch it wrote but could not record as added, stops there, and records it on the next approval', async () => {
    heldCopyReadsRepo();
    db.decision = Array.from({ length: 60 }, (_, i) =>
      scanned(PLAN_A, `did:plc:u${String(i).padStart(2, '0')}`, 'UNKNOWN'),
    );
    db.failStamp = 'database is locked';

    const first = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);

    expect(first).toMatchObject({ added: 50, failed: 0, remaining: 10 });
    expect(first.message).toMatch(/could not be recorded/);
    expect(first.message).toMatch(/database is locked/);
    // The second batch was not started.
    expect(repo.size).toBe(50);

    db.failStamp = null;
    const again = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
    expect(again).toMatchObject({ added: 60, already: 0, remaining: 0 });
    expect(repo.size).toBe(60);
    expect(db.decision.every((r) => r.acted_at)).toBe(true);

    const undo = await undoPlan(bot(), db.plan[0]);
    expect(undo).toMatchObject({ removed: 60, remaining: 0 });
    expect(repo.size).toBe(0);
  });

  it('writes nothing it could not first record as asked for', async () => {
    db.decision = [scanned(PLAN_A, 'did:plc:a', 'UNKNOWN')];
    const { upsert } = await import('./db.js');
    upsert.mockRejectedValueOnce(new Error('database is locked'));

    const out = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);

    expect(out).toMatchObject({ added: 0, remaining: 1 });
    expect(out.message).toMatch(/database is locked/);
    expect(repo.size).toBe(0);
  });

  it('writes an account named twice once, and refuses PROTECTED by name', async () => {
    db.decision = [
      scanned(PLAN_A, 'did:plc:a', 'UNKNOWN'),
      scanned(PLAN_A, 'did:plc:p', 'PROTECTED'),
    ];
    const out = await applyPlanToActors(bot(), db.plan[0], [
      'did:plc:a',
      '@did:plc:a',
      'did:plc:p',
      'did:plc:nobody',
    ]);
    expect(out.added).toBe(1);
    expect(repo.size).toBe(1);
    expect(out.message).toBe(
      'Added 1 by name. 1 refused: PROTECTED. Not in this plan: did:plc:nobody.',
    );
    expect(row(PLAN_A, 'did:plc:a').approved_via).toBe('individual');
  });
});

describe('undo', () => {
  it('takes one block back off with one lookup, not a walk of the repo', async () => {
    db.decision = [added(PLAN_B, 'did:plc:b', '2026-10-01T11:00:00Z')];
    constellation.set('did:plc:b', ['rk-b']);
    repo.set('rk-b', 'did:plc:b');
    const agent = bot();

    const out = await undoPlan(agent, { id: PLAN_B }, { reason: 'undo that' });

    expect(out).toMatchObject({ ok: true, removed: 1, remaining: 0 });
    expect(agent.com.atproto.repo.listRecords).not.toHaveBeenCalled();
    expect(repo.has('rk-b')).toBe(false);
    expect(row(PLAN_B, 'did:plc:b')).toMatchObject({
      undo_reason: 'undo that',
    });
    expect(row(PLAN_B, 'did:plc:b').undone_at).toBeTruthy();
    expect(graph.noteUnlisted).toHaveBeenCalledWith(LIST, 'did:plc:b');
  });

  it('closes an account that already came off another way, instead of asking again forever', async () => {
    // Taken off the list outside the bot, so the decision is still open.
    db.decision = [added(PLAN_B, 'did:plc:b', '2026-10-01T11:00:00Z')];
    const agent = bot();

    const out = await undoPlan(agent, { id: PLAN_B });

    expect(agent.com.atproto.repo.listRecords).toHaveBeenCalled();
    expect(out).toMatchObject({ removed: 0, remaining: 0, alreadyOff: 1 });
    expect(out.message).toMatch(/already come off/);
    expect(out.message).not.toMatch(/again/);
    expect(row(PLAN_B, 'did:plc:b')).toMatchObject({
      undo_reason: 'already off the list',
    });

    // And "undo last" moves on to the add before it.
    db.decision.push(added(PLAN_A, 'did:plc:a', '2026-10-01T10:00:00Z'));
    expect((await lastActedPlan()).id).toBe(PLAN_A);
  });

  it('does not close anyone on the strength of a lookup that found nothing', async () => {
    // Constellation has not indexed the add yet; the repo has it.
    db.decision = [added(PLAN_B, 'did:plc:b', '2026-10-01T11:00:00Z')];
    repo.set('rk-b', 'did:plc:b');
    const out = await undoPlan(bot(), { id: PLAN_B });
    expect(out).toMatchObject({ removed: 1, alreadyOff: 0 });
    expect(repo.size).toBe(0);
  });

  it('takes every copy of an account off and writes its row once', async () => {
    db.decision = [
      added(PLAN_A, 'did:plc:a', '2026-10-01T10:00:00Z'),
      added(PLAN_A, 'did:plc:c', '2026-10-01T10:00:00Z'),
    ];
    constellation.set('did:plc:a', ['rk-a1', 'rk-a2']);
    constellation.set('did:plc:c', ['rk-c']);
    repo.set('rk-a1', 'did:plc:a');
    repo.set('rk-a2', 'did:plc:a');
    repo.set('rk-c', 'did:plc:c');

    const out = await undoPlan(bot(), { id: PLAN_A });

    expect(out).toMatchObject({ removed: 2, remaining: 0 });
    expect(repo.size).toBe(0);
  });

  it('closes the add another plan made too, since every copy came off', async () => {
    db.decision = [
      added(PLAN_A, 'did:plc:a', '2026-10-01T10:00:00Z'),
      added(PLAN_B, 'did:plc:a', '2026-10-01T11:00:00Z'),
    ];
    constellation.set('did:plc:a', ['rk-a1', 'rk-a2']);
    repo.set('rk-a1', 'did:plc:a');
    repo.set('rk-a2', 'did:plc:a');

    await undoPlan(bot(), { id: PLAN_A }, { reason: 'undo 1c2d3e4f' });

    expect(repo.size).toBe(0);
    expect(row(PLAN_B, 'did:plc:a')).toMatchObject({
      undo_reason: 'undo 1c2d3e4f',
    });
    // Left open, "undo last" would pick plan B next for someone already gone.
    expect(await lastActedPlan()).toBe(null);
  });

  it('leaves on the list someone the owner also blocked by name, and closes only this plan', async () => {
    db.decision = [
      added(PLAN_A, 'did:plc:a', '2026-10-01T10:00:00Z', {
        approved_via: 'band',
      }),
      added(PLAN_A, 'did:plc:c', '2026-10-01T10:00:00Z', {
        approved_via: 'band',
      }),
      // "block @a, he is the worst", typed while they were already listed.
      added(PLAN_B, 'did:plc:a', '2026-10-01T11:00:00Z', {
        approved_via: 'command',
        already_listed: true,
      }),
    ];
    constellation.set('did:plc:a', ['rk-a']);
    constellation.set('did:plc:c', ['rk-c']);
    repo.set('rk-a', 'did:plc:a');
    repo.set('rk-c', 'did:plc:c');

    const out = await undoPlan(bot(), { id: PLAN_A }, { reason: 'too broad' });

    expect(out).toMatchObject({ removed: 1, remaining: 0, kept: 1 });
    expect(out.message).toMatch(/1 stays on the list/);
    expect([...repo.values()]).toEqual(['did:plc:a']);
    expect(row(PLAN_A, 'did:plc:a')).toMatchObject({ undo_reason: 'too broad' });
    expect(row(PLAN_B, 'did:plc:a').undone_at).toBe(null);
    expect((await lastActedPlan()).id).toBe(PLAN_B);
  });

  it("does not stamp a typed block undone when a band plan's duplicate comes off", async () => {
    db.decision = [
      added(PLAN_A, 'did:plc:y', '2026-10-01T10:00:00Z', {
        approved_via: 'command',
      }),
      // Written again while the held copy could not be read.
      added(PLAN_B, 'did:plc:y', '2026-10-01T11:00:00Z', {
        approved_via: 'band',
      }),
    ];
    constellation.set('did:plc:y', ['rk-y1', 'rk-y2']);
    repo.set('rk-y1', 'did:plc:y');
    repo.set('rk-y2', 'did:plc:y');

    await undoPlan(bot(), { id: PLAN_B });

    expect([...repo.values()]).toContain('did:plc:y');
    expect(row(PLAN_A, 'did:plc:y').undone_at).toBe(null);
    expect(row(PLAN_B, 'did:plc:y').undone_at).toBeTruthy();
  });

  it('walks the repo once when Constellation cannot answer, not once per account', async () => {
    db.decision = [
      added(PLAN_A, 'did:plc:a', '2026-10-01T10:00:00Z'),
      added(PLAN_A, 'did:plc:c', '2026-10-01T10:00:00Z'),
    ];
    graph.rkeysForWrite.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    repo.set('rk-a', 'did:plc:a');
    repo.set('rk-c', 'did:plc:c');
    const agent = bot();

    const out = await undoPlan(agent, { id: PLAN_A });

    expect(graph.rkeysForWrite).toHaveBeenCalledWith(LIST, 'did:plc:a', {
      walk: false,
    });
    expect(agent.com.atproto.repo.listRecords).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ removed: 2, remaining: 0 });
  });

  it('gets past a record Constellation still shows after it was deleted', async () => {
    db.decision = [
      added(PLAN_A, 'did:plc:a', '2026-10-01T10:00:00Z'),
      added(PLAN_A, 'did:plc:c', '2026-10-01T10:00:00Z'),
    ];
    constellation.set('did:plc:a', ['rk-a', 'rk-gone']);
    constellation.set('did:plc:c', ['rk-c']);
    repo.set('rk-a', 'did:plc:a');
    repo.set('rk-c', 'did:plc:c');
    const agent = bot();

    const out = await undoPlan(agent, { id: PLAN_A });

    expect(agent.com.atproto.repo.deleteRecord).toHaveBeenCalled();
    expect(out).toMatchObject({ removed: 2, remaining: 0 });
    expect(repo.size).toBe(0);
  });
});

describe('approving after an undo', () => {
  it('adds through another plan the accounts an undo took off', async () => {
    db.decision = [
      added(PLAN_A, 'did:plc:q', '2026-10-01T10:00:00Z', {
        approved_via: 'triage:hostile',
      }),
      // Plan B scanned the same post while plan A had them on the list.
      { ...scanned(PLAN_B, 'did:plc:q', 'UNKNOWN'), already_listed: true },
    ];
    constellation.set('did:plc:q', ['rk-q']);
    repo.set('rk-q', 'did:plc:q');

    await undoPlan(bot(), { id: PLAN_A });
    expect(row(PLAN_B, 'did:plc:q').already_listed).toBe(false);

    const out = await applyPlan(bot(), db.plan[1], ['UNKNOWN']);
    expect(out).toMatchObject({ added: 1 });
    expect([...repo.values()]).toEqual(['did:plc:q']);
  });

  it('says when an undo is why a plan has nothing left to add', async () => {
    db.decision = [
      added(PLAN_A, 'did:plc:a', '2026-10-01T10:00:00Z', {
        engaged: ['like'],
        undone_at: '2026-10-01T12:00:00Z',
      }),
    ];

    const bands = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
    expect(bands.message).toMatch(/^Nothing left to add for those bands\./);
    expect(bands.message).toMatch(/1 was taken off by an earlier undo/);

    const named = await applyPlanToActors(bot(), db.plan[0], ['did:plc:a']);
    expect(named.message).toMatch(/Taken off by an earlier undo: did:plc:a\./);
    expect(repo.size).toBe(0);
  });
});

describe('undo last', () => {
  it('reads one row, newest live add first, and ignores removals and undone adds', async () => {
    db.decision = [
      added(PLAN_A, 'did:plc:a', '2026-10-01T10:00:00Z'),
      added(PLAN_B, 'did:plc:b', '2026-10-01T11:00:00Z', {
        undone_at: '2026-10-01T12:00:00Z',
      }),
      added(PLAN_B, 'did:plc:x', '2026-10-01T13:00:00Z', {
        action: 'list_remove',
      }),
    ];
    expect((await lastActedPlan()).id).toBe(PLAN_A);
    const read = db.reads.find((r) => r.table === 'decision');
    expect(read.opts).toMatchObject({ limit: 1, order: 'acted_at.desc' });
  });

  it('answers null when nothing is live', async () => {
    expect(await lastActedPlan()).toBe(null);
  });
});

describe('history', () => {
  it('reads the newest few, counts the rest, and fetches their plans in one go', async () => {
    db.decision = [
      added(PLAN_A, 'did:plc:a', '2026-10-01T10:00:00Z'),
      added(PLAN_B, 'did:plc:b', '2026-10-01T11:00:00Z'),
      added(PLAN_B, 'did:plc:c', null),
    ];
    const h = await historyFor(null, { limit: 1 });
    expect(h.total).toBe(2);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({
      did: 'did:plc:b',
      code: '9e8d7c6b',
      plan: { note: 'block @b.test' },
    });
    expect(db.reads.filter((r) => r.table === 'plan')).toHaveLength(1);
  });
});
