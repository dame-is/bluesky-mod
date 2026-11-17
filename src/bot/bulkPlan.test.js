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
    if (Array.isArray(raw?.in)) {
      if (!raw.in.includes(row[k])) return false;
      continue;
    }
    for (const v of [raw].flat()) {
      const val = row[k];
      if (v === 'not.is.null' && val == null) return false;
      if (v === 'is.null' && val != null) return false;
      if (v === 'is.true' && val !== true) return false;
      if (v === 'is.false' && val !== false) return false;
      // A comparison with a missing value is false, as in SQL.
      if (v.startsWith('gte.') && !(val != null && String(val) >= v.slice(4)))
        return false;
      if (v.startsWith('lte.') && !(val != null && String(val) <= v.slice(4)))
        return false;
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
  // Every term in turn, a missing value highest, as db.js orders null
  // (desc nulls first, asc nulls last).
  const terms = String(opts.order || '')
    .split(',')
    .filter(Boolean)
    .map((t) => t.split('.'));
  const cmp = (x, y) =>
    x == null ? (y == null ? 0 : 1) : y == null ? -1 : x < y ? -1 : x > y ? 1 : 0;
  if (terms.length) {
    rows = [...rows].sort((a, b) => {
      for (const [col, dir] of terms) {
        const c = cmp(a[col], b[col]) * (dir === 'desc' ? -1 : 1);
        if (c) return c;
      }
      return 0;
    });
  }
  const from = opts.offset || 0;
  return opts.limit ? rows.slice(from, from + opts.limit) : rows.slice(from);
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
// Accounts this process took off the list, which rkeysForWrite reports as
// off whatever the index still shows, as graphFacts.js does.
const unlisted = new Set();
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
  nextActedSeq: async () =>
    Math.max(0, ...db.decision.map((r) => r.acted_seq ?? 0)) + 1,
  ownerOf: (uri) => /^at:\/\/(did:[^/]+)\//.exec(String(uri ?? ''))?.[1] ?? null,
  // A row marked `live` is a follow made since the last snapshot: only the
  // AppView knows it, so it is found only when follows are asked for.
  protectedAmong: async (dids, { follows = true } = {}) => {
    if (veto.unreadable) throw new Error('could not read the protected set');
    return new Set(
      db.protected
        .filter((r) => follows || !r.live)
        .map((r) => r.did)
        .filter((did) => dids.includes(did)),
    );
  },
}));

const {
  applyPlan,
  applyPlanToActors,
  applyPlanToTriage,
  cancelPlan,
  countDecisions,
  undoPlan,
  lastChange,
  findPlan,
  historyFor,
  activitySince,
  stopWrites,
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
  db.watch = [];
  db.writes = [];
  db.reads = [];
  db.failStamp = null;
  veto.unreadable = false;
  constellation.clear();
  repo = new Map();
  for (const fn of Object.values(graph)) fn.mockReset();
  unlisted.clear();
  graph.rkeysForWrite.mockImplementation(async (list, did) =>
    unlisted.has(did) ? [] : (constellation.get(did) ?? []),
  );
  graph.noteUnlisted.mockImplementation((list, did) => unlisted.add(did));
  graph.noteListed.mockImplementation((list, did) => unlisted.delete(did));
  graph.isListed.mockReturnValue(null);
  graph.graphFacts.mockResolvedValue(null);
});

/**
 * The held copy of the list as graphFacts.js keeps it: the repo as it stood
 * at the first read, and after that only the writes this process notes. A
 * write's lookup adds the listitems this process noted to Constellation's
 * answer, as rkeysForWrite does.
 */
function heldCopy() {
  let held = null;
  const own = new Map();
  graph.graphFacts.mockImplementation(async () => {
    held ??= new Set(repo.values());
    return { listed: held };
  });
  graph.isListed.mockImplementation((list, did) =>
    held ? held.has(did) : null,
  );
  graph.rkeysForWrite.mockImplementation(async (list, did) =>
    unlisted.has(did)
      ? []
      : [
          ...new Set([
            ...(constellation.get(did) ?? []),
            ...(own.get(did) ?? []),
          ]),
        ],
  );
  graph.noteListed.mockImplementation((list, did, rkey) => {
    unlisted.delete(did);
    held?.add(did);
    if (rkey) own.set(did, [...(own.get(did) ?? []), rkey]);
  });
  graph.noteUnlisted.mockImplementation((list, did) => {
    unlisted.add(did);
    held?.delete(did);
    own.delete(did);
  });
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
    heldCopy();
    db.decision = [
      scanned(PLAN_A, 'did:plc:a', 'UNKNOWN'),
      scanned(PLAN_A, 'did:plc:c', 'UNKNOWN'),
    ];

    const first = await applyPlan(losesReply(bot()), db.plan[0], ['UNKNOWN']);
    expect(first).toMatchObject({ added: 0, failed: 2 });
    expect(repo.size).toBe(2);

    const again = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
    // Recorded, not added: this call wrote nothing, and the earlier one
    // already reported them.
    expect(again).toMatchObject({ added: 0, recorded: 2, already: 0 });
    expect(again.message).toBe(
      'Added 0 to the list. Recorded 2 that an earlier approval wrote.',
    );
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

  it('does not write a batch whose reply was lost a second time through another plan', async () => {
    heldCopy();
    db.decision = [
      scanned(PLAN_A, 'did:plc:a', 'UNKNOWN'),
      scanned(PLAN_B, 'did:plc:a', 'UNKNOWN'),
      scanned(PLAN_B, 'did:plc:b', 'UNKNOWN'),
    ];
    await applyPlan(losesReply(bot()), db.plan[0], ['UNKNOWN']);
    expect(repo.size).toBe(1);

    const other = await applyPlan(bot(), db.plan[1], ['UNKNOWN']);

    expect(other).toMatchObject({ added: 1, already: 1 });
    expect([...repo.values()].sort()).toEqual(['did:plc:a', 'did:plc:b']);
  });

  it('asks Constellation about a batch whose reply was lost when the repo cannot be read', async () => {
    heldCopy();
    db.decision = [
      scanned(PLAN_A, 'did:plc:a', 'UNKNOWN'),
      scanned(PLAN_A, 'did:plc:c', 'UNKNOWN'),
    ];
    await applyPlan(losesReply(bot()), db.plan[0], ['UNKNOWN']);
    // Constellation has indexed one of the two.
    const [rkey] = [...repo].find(([, did]) => did === 'did:plc:a');
    constellation.set('did:plc:a', [rkey]);
    const agent = bot();
    agent.com.atproto.repo.listRecords.mockRejectedValue(new Error('502'));

    const again = await applyPlan(agent, db.plan[0], ['UNKNOWN']);

    expect(agent.com.atproto.repo.listRecords).toHaveBeenCalled();
    // did:plc:a is recorded from Constellation's answer; did:plc:c, which it
    // has not indexed, is sent again.
    expect(again).toMatchObject({ added: 1, recorded: 1, already: 0 });
    expect([...repo.values()].filter((d) => d === 'did:plc:a')).toHaveLength(1);
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

  it('counts a batch it wrote but could not record as added, stops there, and records it on the next approval without counting it again', async () => {
    heldCopy();
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
    // The two receipts add up to the 60 accounts, not 110.
    expect(again).toMatchObject({
      added: 10,
      recorded: 50,
      already: 0,
      remaining: 0,
    });
    expect(again.message).toBe(
      'Added 10 to the list. Recorded 50 that an earlier approval wrote.',
    );
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

describe('a batch the PDS refused', () => {
  const refusing = (err) => {
    const agent = bot();
    agent.com.atproto.repo.applyWrites.mockRejectedValueOnce(err);
    return agent;
  };
  const refusals = [
    ['the rate limit', () => new Error('Rate Limit Exceeded')],
    ['a 400', () => Object.assign(new Error('Invalid request'), { status: 400 })],
  ];

  for (const [what, refusal] of refusals) {
    it(`after ${what}, is not claimed as this plan's add once another plan adds the account`, async () => {
      heldCopy();
      db.decision = [
        scanned(PLAN_A, 'did:plc:x1', 'UNKNOWN'),
        scanned(PLAN_A, 'did:plc:x2', 'UNKNOWN'),
        scanned(PLAN_B, 'did:plc:x1', 'UNKNOWN'),
      ];

      const first = await applyPlan(refusing(refusal()), db.plan[0], [
        'UNKNOWN',
      ]);
      expect(first.added).toBe(0);
      expect(repo.size).toBe(0);
      expect(row(PLAN_A, 'did:plc:x1').action).toBe(null);

      expect(await applyPlan(bot(), db.plan[1], ['UNKNOWN'])).toMatchObject({
        added: 1,
      });

      const again = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
      expect(again).toMatchObject({ added: 1, already: 1 });
      expect(again.message).toBe('Added 1 to the list. 1 was already on it.');
      expect(row(PLAN_A, 'did:plc:x1')).toMatchObject({
        action: null,
        acted_at: null,
        already_listed: true,
      });

      const undo = await undoPlan(bot(), db.plan[0]);
      expect(undo).toMatchObject({ removed: 1, remaining: 0 });
      expect([...repo.values()]).toEqual(['did:plc:x1']);
      expect(row(PLAN_B, 'did:plc:x1').undone_at).toBe(null);
    });
  }

  it('leaves nothing for an undo to look for when its only batch was refused', async () => {
    db.decision = [scanned(PLAN_A, 'did:plc:x1', 'UNKNOWN')];
    await applyPlan(
      refusing(new Error('Rate Limit Exceeded')),
      db.plan[0],
      ['UNKNOWN'],
    );
    const agent = bot();
    graph.rkeysForWrite.mockClear();

    const undo = await undoPlan(agent, db.plan[0]);

    expect(undo.message).toBe('Nothing from that plan is still on the list.');
    expect(agent.com.atproto.repo.listRecords).not.toHaveBeenCalled();
    expect(graph.rkeysForWrite).not.toHaveBeenCalled();
  });

  it('keeps the mark after a lost reply, but does not claim an account another plan has since added', async () => {
    heldCopy();
    db.decision = [
      scanned(PLAN_A, 'did:plc:x1', 'UNKNOWN'),
      scanned(PLAN_A, 'did:plc:x2', 'UNKNOWN'),
    ];
    await applyPlan(losesReply(bot()), db.plan[0], ['UNKNOWN']);
    expect(row(PLAN_A, 'did:plc:x1').action).toBe('list_add');
    // Plan B adds x1 again, through a check that could not see the lost
    // write.
    db.decision.push(
      added(PLAN_B, 'did:plc:x1', '2026-10-01T11:00:00Z', {
        approved_via: 'band',
      }),
    );
    repo.set('rk-b', 'did:plc:x1');

    const undo = await undoPlan(bot(), db.plan[0]);

    expect(undo).toMatchObject({ removed: 1, remaining: 0 });
    expect([...repo.values()]).toEqual(['did:plc:x1', 'did:plc:x1']);
    expect(row(PLAN_B, 'did:plc:x1').undone_at).toBe(null);
    expect(row(PLAN_A, 'did:plc:x1')).toMatchObject({
      action: null,
      acted_at: null,
    });

    // Plan B's undo takes every copy, the lost one included.
    await undoPlan(bot(), db.plan[1]);
    expect(repo.size).toBe(0);
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
    expect((await lastChange()).plan.id).toBe(PLAN_A);
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
    expect((await lastChange()).plan).toBe(null);
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
    expect((await lastChange()).plan.id).toBe(PLAN_B);
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

describe('a list longer than the held copy reads', () => {
  it('asks Constellation about an account the held copy cannot answer for, and writes no second listitem', async () => {
    // The walk stopped before the end, so the held copy answers neither yes
    // nor no for these two.
    graph.graphFacts.mockResolvedValue({ listed: new Map() });
    graph.isListed.mockReturnValue(null);
    constellation.set('did:plc:deep', ['rk-deep']);
    repo.set('rk-deep', 'did:plc:deep');
    db.decision = [
      scanned(PLAN_A, 'did:plc:deep', 'UNKNOWN'),
      scanned(PLAN_A, 'did:plc:new', 'UNKNOWN'),
    ];
    const out = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
    expect(out).toMatchObject({ added: 1, already: 1 });
    expect([...repo.values()].sort()).toEqual(['did:plc:deep', 'did:plc:new']);
  });

  it('finishes an undo past where the walk of the repo stops', async () => {
    const dids = Array.from(
      { length: 51 },
      (_, i) => `did:plc:w${String(i).padStart(2, '0')}`,
    );
    db.decision = dids.map((did) =>
      added(PLAN_A, did, '2026-10-01T10:00:00Z'),
    );
    // On the list and indexed, all but the last, which came off elsewhere.
    for (const did of dids.slice(0, 50)) {
      constellation.set(did, [`rk-${did}`]);
      repo.set(`rk-${did}`, did);
    }
    const agent = bot();
    // Every page of the walk holds someone else's listitem, so 400 pages
    // never reach the end.
    agent.com.atproto.repo.listRecords.mockImplementation(async () => ({
      data: {
        cursor: 'more',
        records: [
          {
            uri: 'at://did:plc:bot/app.bsky.graph.listitem/other',
            value: { list: LIST, subject: 'did:plc:someoneelse' },
          },
        ],
      },
    }));

    const out = await undoPlan(agent, db.plan[0]);

    expect(out).toMatchObject({ removed: 50, alreadyOff: 1, remaining: 0 });
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

  it('says when an account it added coming off is why a plan has nothing left to add', async () => {
    db.decision = [
      added(PLAN_A, 'did:plc:a', '2026-10-01T10:00:00Z', {
        engaged: ['like'],
        undone_at: '2026-10-01T12:00:00Z',
      }),
    ];

    const bands = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
    expect(bands.message).toBe(
      'Nothing left to add for those bands. 1 was added by this plan and has since come off the list; scan the post again to add them back.',
    );

    const named = await applyPlanToActors(bot(), db.plan[0], ['did:plc:a']);
    expect(named.message).toBe(
      'Added 0 by name. This plan added them and they have since come off the list: did:plc:a. Block them by name to add them back.',
    );
    expect(repo.size).toBe(0);
  });

  it('never calls an unblock an undo', async () => {
    db.decision = [
      added(PLAN_A, 'did:plc:a', '2026-10-01T10:00:00Z', { engaged: ['like'] }),
      added(PLAN_A, 'did:plc:h', '2026-10-01T10:00:00Z', {
        engaged: ['like'],
        triage: 'hostile',
      }),
    ];
    // What an unblock does to the record once the listitems are gone.
    const { closeAdds } = await import('./closeAdds.js');
    await closeAdds(['did:plc:a', 'did:plc:h'], 'unblock @a.test');

    const named = await applyPlanToActors(bot(), db.plan[0], ['did:plc:a']);
    const bands = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
    const label = await applyPlanToTriage(bot(), db.plan[0], 'hostile');

    for (const out of [named, bands, label]) {
      expect(out.message).not.toMatch(/undo/i);
      expect(out.message).toMatch(/since come off the list/);
    }
  });
});

describe('undo last', () => {
  it('reads one row, newest change first, and passes over undone adds and older removals', async () => {
    db.decision = [
      added(PLAN_B, 'did:plc:x', '2026-10-01T09:00:00Z', {
        action: 'list_remove',
      }),
      added(PLAN_A, 'did:plc:a', '2026-10-01T10:00:00Z'),
      added(PLAN_B, 'did:plc:b', '2026-10-01T11:00:00Z', {
        undone_at: '2026-10-01T12:00:00Z',
      }),
    ];
    expect((await lastChange()).plan.id).toBe(PLAN_A);
    const read = db.reads.find((r) => r.table === 'decision');
    expect(read.opts).toMatchObject({
      limit: 1,
      order: 'acted_seq.desc,acted_at.desc',
    });
  });

  it('goes by the order changes were made in, not by a clock that stepped back', async () => {
    // Plan B's add came second, written while the clock read an hour early.
    db.decision = [
      added(PLAN_A, 'did:plc:a', '2026-10-01T12:00:00Z', { acted_seq: 1 }),
      added(PLAN_B, 'did:plc:b', '2026-10-01T11:00:00Z', { acted_seq: 2 }),
    ];
    expect((await lastChange()).plan.id).toBe(PLAN_B);
  });

  it('numbers each batch it records, one number per write', async () => {
    db.decision = [
      added(PLAN_B, 'did:plc:old', '2026-10-01T09:00:00Z', { acted_seq: 4 }),
      scanned(PLAN_A, 'did:plc:u1', 'UNKNOWN'),
      scanned(PLAN_A, 'did:plc:u2', 'UNKNOWN'),
    ];
    await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
    expect(row(PLAN_A, 'did:plc:u1').acted_seq).toBe(5);
    expect(row(PLAN_A, 'did:plc:u2').acted_seq).toBe(5);
    expect((await lastChange()).plan.id).toBe(PLAN_A);
  });

  it('answers null when nothing is live', async () => {
    expect((await lastChange()).plan).toBe(null);
  });

  it('stops at a typed block that found the account already listed', async () => {
    db.decision = [
      added(PLAN_A, 'did:plc:x', '2026-10-01T10:00:00Z', {
        approved_via: 'band',
        acted_seq: 1,
      }),
      // "block @x", answered "was already on the list".
      added(PLAN_B, 'did:plc:x', '2026-10-01T11:00:00Z', {
        approved_via: 'command',
        already_listed: true,
        acted_seq: 2,
      }),
    ];
    constellation.set('did:plc:x', ['rk-x']);
    repo.set('rk-x', 'did:plc:x');

    // The block changed nothing, so a bare undo does not reach past it to
    // the batch that put them on.
    expect(await lastChange()).toEqual({
      plan: null,
      removed: null,
      unchanged: { did: 'did:plc:x', planId: PLAN_B },
    });

    // Undoing the plan that put them on still leaves them where the typed
    // block put them.
    const out = await undoPlan(
      bot(),
      db.plan.find((p) => p.id === PLAN_A),
    );
    expect(out).toMatchObject({ removed: 0, kept: 1 });
    expect([...repo.values()]).toEqual(['did:plc:x']);
  });

  it("names a batch whose newest rows found accounts already listed", async () => {
    db.decision = [
      added(PLAN_B, 'did:plc:b', '2026-10-01T09:00:00Z', { acted_seq: 1 }),
      added(PLAN_A, 'did:plc:b', '2026-10-01T10:00:00Z', {
        acted_seq: 2,
        already_listed: true,
      }),
      added(PLAN_A, 'did:plc:a', '2026-10-01T10:00:00Z', { acted_seq: 2 }),
    ];
    const last = await lastChange();
    expect(last.plan.id).toBe(PLAN_A);
    expect(last.unchanged).toBeUndefined();
  });

  it('does not reach past an unblock to an older add', async () => {
    db.decision = [
      // block @a, then unblock @b by mistake.
      added(PLAN_A, 'did:plc:a', '2026-10-01T10:00:00Z'),
      added(PLAN_B, 'did:plc:b', '2026-10-01T11:00:00Z', {
        action: 'list_remove',
      }),
    ];
    expect((await lastChange()).plan).toBe(null);
    expect(await lastChange()).toEqual({
      plan: null,
      removed: {
        did: 'did:plc:b',
        planId: PLAN_B,
        at: '2026-10-01T11:00:00Z',
      },
    });
  });

  it('names the plan when the newest change was an add', async () => {
    db.decision = [
      added(PLAN_B, 'did:plc:b', '2026-10-01T09:00:00Z', {
        action: 'list_remove',
      }),
      added(PLAN_A, 'did:plc:a', '2026-10-01T10:00:00Z'),
    ];
    const last = await lastChange();
    expect(last.plan.id).toBe(PLAN_A);
    expect(last.removed).toBe(null);
  });
});

describe('a batch written but never confirmed', () => {
  // Plan B was approved earlier and its add is still on the list.
  const old = () => {
    repo.set('rk-old', 'did:plc:old');
    constellation.set('did:plc:old', ['rk-old']);
    return added(PLAN_B, 'did:plc:old', '2026-10-01T09:00:00Z', {
      approved_via: 'band',
      acted_seq: 1,
    });
  };

  it('is the change a bare undo takes back when its record could not be written', async () => {
    db.decision = [old(), scanned(PLAN_A, 'did:plc:x', 'UNKNOWN')];
    db.failStamp = 'database is locked';
    const out = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
    expect(out.message).toMatch(/could not be recorded/);
    db.failStamp = null;

    expect((await lastChange()).plan.id).toBe(PLAN_A);
    expect(await countDecisions(db.plan[0], { state: 'live' })).toBe(1);

    const undo = await undoPlan(bot(), db.plan[0]);
    expect(undo).toMatchObject({ removed: 1, remaining: 0 });
    expect([...repo.values()]).toEqual(['did:plc:old']);
  });

  it('tries the record twice before it gives up', async () => {
    db.decision = [scanned(PLAN_A, 'did:plc:x', 'UNKNOWN')];
    const { upsert } = await import('./db.js');
    const real = upsert.getMockImplementation();
    let refused = 0;
    upsert.mockImplementation(async (table, rows) => {
      if (table === 'decision' && rows.some((r) => r.acted_at) && !refused) {
        refused += 1;
        throw new Error('database is locked');
      }
      return real(table, rows);
    });
    try {
      const out = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
      expect(out.message).toBe('Added 1 to the list.');
      expect(row(PLAN_A, 'did:plc:x').acted_at).toBeTruthy();
    } finally {
      upsert.mockImplementation(real);
    }
  });

  it('is told apart by a cancel, which offers the undo that looks for it', async () => {
    db.decision = [scanned(PLAN_A, 'did:plc:x', 'UNKNOWN')];
    await applyPlan(losesReply(bot()), db.plan[0], ['UNKNOWN']);

    const out = await cancelPlan(db.plan[0]);

    expect(out.live).toBe(1);
    expect(out.message).toBe(
      'Cancelled 1c2d3e4f. 1 it sent may be on the list but was never recorded; "undo 1c2d3e4f" looks for it and takes it off.',
    );
  });

  it('is passed over by the next bare undo once an undo finds it never reached the list', async () => {
    db.decision = [old(), scanned(PLAN_A, 'did:plc:x', 'UNKNOWN')];
    const agent = bot();
    // The connection drops before the PDS has the batch.
    agent.com.atproto.repo.applyWrites.mockRejectedValueOnce(
      new Error('socket hang up'),
    );
    await applyPlan(agent, db.plan[0], ['UNKNOWN']);
    expect((await lastChange()).plan.id).toBe(PLAN_A);

    const undo = await undoPlan(bot(), db.plan[0]);

    expect(undo.message).toBe('Nothing from that plan is still on the list.');
    expect(row(PLAN_A, 'did:plc:x').action).toBe(null);
    expect((await lastChange()).plan.id).toBe(PLAN_B);
  });

  it('does not shadow an older change when the PDS refused it', async () => {
    db.decision = [old(), scanned(PLAN_A, 'did:plc:x', 'UNKNOWN')];
    const agent = bot();
    agent.com.atproto.repo.applyWrites.mockRejectedValueOnce(
      new Error('Rate Limit Exceeded'),
    );
    await applyPlan(agent, db.plan[0], ['UNKNOWN']);
    expect((await lastChange()).plan.id).toBe(PLAN_B);
  });
});

describe('approving one plan twice', () => {
  it('says how many an undo of the plan takes off, earlier approvals included', async () => {
    db.decision = [
      scanned(PLAN_A, 'did:plc:u1', 'UNKNOWN'),
      scanned(PLAN_A, 'did:plc:u2', 'UNKNOWN'),
      scanned(PLAN_A, 'did:plc:n', 'NOTABLE'),
    ];
    const first = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
    expect(first).toMatchObject({ added: 2, live: 2 });

    const second = await applyPlan(bot(), db.plan[0], ['NOTABLE']);
    expect(second).toMatchObject({ added: 1, live: 3 });

    const undo = await undoPlan(bot(), db.plan[0]);
    expect(undo.removed).toBe(second.live);
  });

  it('counts the band approvals when a label is approved after them', async () => {
    db.decision = [
      scanned(PLAN_A, 'did:plc:u1', 'UNKNOWN'),
      { ...scanned(PLAN_A, 'did:plc:h', 'NOTABLE'), triage: 'hostile' },
    ];
    await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
    const out = await applyPlanToTriage(bot(), db.plan[0], 'hostile');
    expect(out).toMatchObject({ added: 1, live: 2 });
  });
});

describe('cancel', () => {
  it('keeps the bands already approved, and says what is still on the list', async () => {
    db.decision = [
      scanned(PLAN_A, 'did:plc:a', 'UNKNOWN'),
      scanned(PLAN_A, 'did:plc:c', 'UNKNOWN'),
    ];
    await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
    const approvedAt = db.plan[0].approved_at;

    const out = await cancelPlan(db.plan[0]);

    expect(db.plan[0]).toMatchObject({
      approved_at: approvedAt,
      approved_bands: ['UNKNOWN'],
      note: 'block @a.test (cancelled)',
    });
    expect(out.live).toBe(2);
    expect(out.message).toBe(
      'Cancelled 1c2d3e4f. 2 it added are still on the list; "undo 1c2d3e4f" takes them off.',
    );
  });

  it('says nothing was added when nothing was, and records no approval', async () => {
    db.decision = [scanned(PLAN_A, 'did:plc:a', 'UNKNOWN')];
    const out = await cancelPlan(db.plan[0]);
    expect(out).toMatchObject({
      live: 0,
      message: 'Cancelled 1c2d3e4f. Nothing was added.',
    });
    expect(db.plan[0].note).toBe('block @a.test (cancelled)');
    expect(db.plan[0].approved_bands).toBeUndefined();
  });

  it('says when a watch on the post is still adding to the plan', async () => {
    db.decision = [scanned(PLAN_A, 'did:plc:a', 'UNKNOWN')];
    db.watch = [
      {
        id: 'w1',
        plan_id: PLAN_A,
        mode: 'auto',
        until: new Date(Date.now() + 3_600_000).toISOString(),
        stopped_at: null,
      },
    ];
    const out = await cancelPlan(db.plan[0]);
    expect(out.watching).toBe(1);
    expect(out.message).toMatch(/watch on that post is still running/);

    db.watch[0].mode = 'ask';
    expect((await cancelPlan(db.plan[0])).watching).toBe(0);
  });
});

describe('rows the veto refuses at the write', () => {
  it('are not counted as left to add', async () => {
    db.decision = [
      scanned(PLAN_A, 'did:plc:a', 'UNKNOWN'),
      scanned(PLAN_A, 'did:plc:f', 'UNKNOWN'),
    ];
    // Followed, or put on a curation list, after the plan was made.
    db.protected = [{ did: 'did:plc:f', reason: 'you follow them' }];
    expect(await countDecisions(db.plan[0], { bands: ['UNKNOWN'] })).toBe(1);
    expect(await countDecisions(db.plan[0])).toBe(1);
  });

  it('leave nothing to add once only they are left', async () => {
    db.decision = [scanned(PLAN_A, 'did:plc:f', 'UNKNOWN')];
    db.protected = [{ did: 'did:plc:f', reason: 'you follow them' }];
    const out = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
    expect(out).toMatchObject({ added: 0, remaining: 0 });
    expect(out.message).toBe(
      'Nothing left to add for those bands. 1 refused: PROTECTED.',
    );
    expect(repo.size).toBe(0);
  });

  it('do not fill an approval and stop the rest being added', async () => {
    db.decision = [
      ...Array.from({ length: 500 }, (_, i) =>
        scanned(PLAN_A, `did:plc:f${String(i).padStart(3, '0')}`, 'UNKNOWN'),
      ),
      scanned(PLAN_A, 'did:plc:z', 'UNKNOWN'),
    ];
    db.protected = db.decision
      .filter((r) => r.did !== 'did:plc:z')
      .map((r) => ({ did: r.did, reason: 'on your list' }));
    const out = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
    expect(out).toMatchObject({ added: 1, remaining: 0 });
    expect(out.message).toMatch(/500 refused: PROTECTED/);
    expect([...repo.values()]).toEqual(['did:plc:z']);
  });

  it('are still refused when only the AppView knows the follow', async () => {
    db.decision = [
      scanned(PLAN_A, 'did:plc:a', 'UNKNOWN'),
      scanned(PLAN_A, 'did:plc:f', 'UNKNOWN'),
    ];
    db.protected = [{ did: 'did:plc:f', reason: 'you follow them', live: true }];
    const out = await applyPlan(bot(), db.plan[0], ['UNKNOWN']);
    expect(out).toMatchObject({ added: 1, remaining: 0 });
    expect(out.message).toMatch(/1 refused: PROTECTED/);
    expect([...repo.values()]).toEqual(['did:plc:a']);
  });
});

describe('a rate limit', () => {
  const limited = () => {
    const agent = bot();
    agent.com.atproto.repo.applyWrites.mockRejectedValue(
      new Error('Rate Limit Exceeded'),
    );
    return agent;
  };

  it('on a label approval says to send it again later, and keeps the rest pending', async () => {
    db.decision = [
      { ...scanned(PLAN_A, 'did:plc:h1', 'UNKNOWN'), triage: 'hostile' },
      { ...scanned(PLAN_A, 'did:plc:h2', 'UNKNOWN'), triage: 'hostile' },
    ];
    const out = await applyPlanToTriage(limited(), db.plan[0], 'hostile');
    expect(out).toMatchObject({ added: 0, remaining: 2 });
    expect(out.message).toBe(
      'Added 0 that a model read as hostile. Hit the write rate limit. Send "approve 1c2d3e4f hostile" again in an hour for the remaining 2.',
    );
  });

  it('does not count a batch it records from an earlier approval as left to add', async () => {
    heldCopy();
    db.decision = [
      { ...scanned(PLAN_A, 'did:plc:h1', 'UNKNOWN'), triage: 'hostile' },
      { ...scanned(PLAN_A, 'did:plc:h2', 'UNKNOWN'), triage: 'hostile' },
      { ...scanned(PLAN_A, 'did:plc:h3', 'UNKNOWN'), triage: 'hostile' },
    ];
    // An earlier approval sent did:plc:h1 and lost the reply.
    await applyPlanToActors(losesReply(bot()), db.plan[0], ['did:plc:h1']);
    expect(repo.size).toBe(1);

    const out = await applyPlanToTriage(limited(), db.plan[0], 'hostile');

    expect(out).toMatchObject({ added: 0, recorded: 1, remaining: 2 });
    expect(out.message).toBe(
      'Added 0 that a model read as hostile. Recorded 1 that an earlier approval wrote. Hit the write rate limit. Send "approve 1c2d3e4f hostile" again in an hour for the remaining 2.',
    );
  });

  it('on an approval by name says to send it again later', async () => {
    db.decision = [scanned(PLAN_A, 'did:plc:a', 'UNKNOWN')];
    const out = await applyPlanToActors(limited(), db.plan[0], ['did:plc:a']);
    expect(out).toMatchObject({ added: 0, remaining: 1 });
    expect(out.message).toBe(
      'Added 0 by name. Hit the write rate limit. Send "approve 1c2d3e4f did:plc:a" again in an hour for the remaining 1.',
    );
  });
});

describe('the words of an approval', () => {
  const POST = 'at://did:plc:op/app.bsky.feed.post/3post';
  beforeEach(() => {
    db.plan[0].note = `bulk quoters from ${POST}`;
  });

  it('are kept in the plan note for a band, a label and a name, so history shows them', async () => {
    db.decision = [
      scanned(PLAN_A, 'did:plc:u', 'UNKNOWN'),
      { ...scanned(PLAN_A, 'did:plc:h', 'PERIPHERAL'), triage: 'hostile' },
      scanned(PLAN_A, 'did:plc:n', 'NOTABLE'),
    ];
    await applyPlan(bot(), await findPlan('1c2d3e4f'), ['UNKNOWN'], {
      reason: 'approve 1c2d3e4f UNKNOWN',
    });
    await applyPlanToTriage(bot(), await findPlan('1c2d3e4f'), 'hostile', {
      by: 'agent',
      reason: 'block the hostile ones [agent: the owner asked for hostile quoters]',
    });
    await applyPlanToActors(bot(), await findPlan('1c2d3e4f'), ['did:plc:n'], {
      reason: 'approve 1c2d3e4f did:plc:n',
    });

    expect(db.plan[0].note).toBe(
      `bulk quoters from ${POST}` +
        '; approved: approve 1c2d3e4f UNKNOWN' +
        '; approved: block the hostile ones [agent: the owner asked for hostile quoters]' +
        '; approved: approve 1c2d3e4f did:plc:n',
    );
    const h = await historyFor('did:plc:h');
    expect(h.rows[0]).toMatchObject({
      approved_via: 'agent:triage:hostile',
      plan: { note: db.plan[0].note },
    });
  });

  it('are kept once when the same approval is sent again to continue', async () => {
    db.decision = [scanned(PLAN_A, 'did:plc:u', 'UNKNOWN')];
    const limited = bot();
    limited.com.atproto.repo.applyWrites.mockRejectedValueOnce(
      new Error('Rate Limit Exceeded'),
    );
    const words = { reason: 'approve 1c2d3e4f UNKNOWN' };
    await applyPlan(limited, await findPlan('1c2d3e4f'), ['UNKNOWN'], words);
    await applyPlan(limited, await findPlan('1c2d3e4f'), ['UNKNOWN'], words);

    expect(repo.size).toBe(1);
    expect(db.plan[0].note).toBe(
      `bulk quoters from ${POST}; approved: approve 1c2d3e4f UNKNOWN`,
    );
  });

  it('are not kept for an approval that had nothing to add', async () => {
    db.decision = [added(PLAN_A, 'did:plc:u', '2026-10-01T10:00:00Z')];
    await applyPlan(bot(), db.plan[0], ['UNKNOWN'], { reason: 'approve again' });
    await applyPlanToTriage(bot(), db.plan[0], 'hostile', {
      reason: 'approve again',
    });
    await applyPlanToActors(bot(), db.plan[0], ['did:plc:u'], {
      reason: 'approve again',
    });
    expect(db.plan[0].note).toBe(`bulk quoters from ${POST}`);
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

  describe('a typed block of someone already listed', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    beforeEach(() => {
      db.decision = [
        added(PLAN_A, 'did:plc:x', '2026-10-01T10:00:00Z', {
          approved_via: 'band',
        }),
        // "block @x", answered "was already on the list".
        added(PLAN_B, 'did:plc:x', '2026-10-01T11:00:00Z', {
          approved_via: 'command',
          already_listed: true,
        }),
      ];
    });

    it('is shown in history as asked again, not as a second add', async () => {
      const h = await historyFor('did:plc:x');
      expect(h.rows.map((r) => [r.code, r.already_listed])).toEqual([
        ['9e8d7c6b', true],
        ['1c2d3e4f', false],
      ]);
      // The fake returns every column, so the read is checked for it.
      const read = db.reads.find((r) => r.table === 'decision');
      expect(read.opts.select.split(',')).toContain('already_listed');
    });

    it('is not counted in recent activity as an add', async () => {
      const out = await activitySince(24, { now });
      expect(out.totals).toEqual({ added: 1, removed: 0, undone: 0 });
      expect(out.plans.map((p) => p.code)).toEqual(['1c2d3e4f']);
    });

    it('is not counted as undone when the account comes off', async () => {
      for (const r of db.decision) r.undone_at = '2026-10-01T11:30:00Z';
      const out = await activitySince(24, { now });
      expect(out.totals.undone).toBe(1);
    });
  });
});

describe('a label approval with bounds', () => {
  const labelled = (did, band, at) => ({
    ...scanned(PLAN_A, did, band),
    triage: 'hostile',
    triage_at: at,
  });

  it('adds only the bands it names and what was labelled by its time', async () => {
    // As a watch digest's 👍 sends it: the held bands, and the labels up to
    // the check the digest counted.
    db.decision = [
      labelled('did:plc:c1', 'CONNECTED', '2026-11-01T10:00:00.000Z'),
      labelled('did:plc:n1', 'NOTABLE', '2026-11-01T10:00:00.000Z'),
      labelled('did:plc:u1', 'UNKNOWN', '2026-11-01T10:00:00.000Z'),
      labelled('did:plc:c2', 'CONNECTED', '2026-11-01T11:00:00.000Z'),
    ];
    const bounds = {
      bands: ['CONNECTED', 'NOTABLE'],
      asOf: '2026-11-01T10:00:00.000Z',
    };
    expect(
      await countDecisions(db.plan[0], { label: 'hostile', ...bounds }),
    ).toBe(2);
    const out = await applyPlanToTriage(bot(), db.plan[0], 'hostile', bounds);
    expect(out).toMatchObject({ added: 2 });
    expect(new Set(repo.values())).toEqual(
      new Set(['did:plc:c1', 'did:plc:n1']),
    );
  });

  it('counts only what was labelled by its time', async () => {
    db.decision = [
      labelled('did:plc:a', 'UNKNOWN', '2026-11-01T10:00:00.000Z'),
      labelled('did:plc:b', 'UNKNOWN', '2026-11-01T10:05:00.000Z'),
    ];
    expect(
      await countDecisions(db.plan[0], {
        label: 'hostile',
        asOf: '2026-11-01T10:00:00.000Z',
      }),
    ).toBe(1);
    expect(await countDecisions(db.plan[0], { label: 'hostile' })).toBe(2);
  });

  it('repeats its bounds in the command to send again', async () => {
    db.decision = [labelled('did:plc:c1', 'CONNECTED', '2026-11-01T10:00:00Z')];
    const agent = bot();
    agent.com.atproto.repo.applyWrites.mockRejectedValue(
      new Error('Rate Limit Exceeded'),
    );
    const out = await applyPlanToTriage(agent, db.plan[0], 'hostile', {
      bands: ['CONNECTED'],
      asOf: '2026-11-01T10:00:00.000Z',
    });
    expect(out.message).toContain(
      'Send "approve 1c2d3e4f hostile CONNECTED asof=2026-11-01T10:00:00.000Z" again',
    );
  });
});

// Last in the file: stopWrites holds for the rest of the process.
describe('shutting down', () => {
  it('starts no new batch once the process is stopping, and records the one sent', async () => {
    db.decision = Array.from({ length: 60 }, (_, i) =>
      scanned(PLAN_A, `did:plc:u${String(i).padStart(2, '0')}`, 'UNKNOWN'),
    );
    const agent = bot();
    const write = agent.com.atproto.repo.applyWrites.getMockImplementation();
    agent.com.atproto.repo.applyWrites.mockImplementation(async (args) => {
      const out = await write(args);
      stopWrites();
      return out;
    });

    const out = await applyPlan(agent, db.plan[0], ['UNKNOWN']);

    expect(out).toMatchObject({ added: 50, remaining: 10 });
    expect(repo.size).toBe(50);
    expect(db.decision.filter((r) => r.acted_at)).toHaveLength(50);
  });
});
