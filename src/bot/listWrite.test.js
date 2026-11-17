import { describe, it, expect, vi, beforeEach } from 'vitest';

const protectedRows = new Map();
// Protected rows added by hand (source 'manual'). Every other row is one a
// snapshot derived.
const manual = new Set();
// The snapshot's circle rows. A snapshot writes them once it has filled the
// protected set.
const circle = [];
const veto = { unreadable: false };
const decisions = [];
// Plan ids the log was asked to write, and how many of those writes fail, as
// a locked or full database would.
const plans = { ids: [], failing: 0 };
vi.mock('./db.js', () => ({
  select: vi.fn(async (table, { eq = {}, where = {}, limit } = {}) => {
    if (table === 'circle') return limit ? circle.slice(0, limit) : circle;
    if (table !== 'protected') return [];
    if (veto.unreadable) throw new Error('no such table: protected');
    let rows = [...protectedRows].map(([did, reason]) => ({
      did,
      reason,
      source: manual.has(did) ? 'manual' : 'derived',
    }));
    if (eq.did) rows = rows.filter((r) => r.did === eq.did);
    if (eq.source) rows = rows.filter((r) => r.source === eq.source);
    if (where.did) rows = rows.filter((r) => where.did.in.includes(r.did));
    return limit ? rows.slice(0, limit) : rows;
  }),
  selectAll: vi.fn(async (table, { eq = {}, where = {} }) =>
    table === 'decision'
      ? decisions.filter(
          (r) =>
            r.action === eq.action &&
            where.did.in.includes(r.did) &&
            r.acted_at &&
            !r.undone_at,
        )
      : [],
  ),
  update: vi.fn(async () => null),
  upsert: vi.fn(async (table, rows) => {
    if (table === 'plan') {
      plans.ids.push(...rows.map((r) => r.id));
      if (plans.failing > 0) {
        plans.failing -= 1;
        throw new Error('database is locked');
      }
    }
    if (table === 'decision') {
      for (const row of rows) {
        const at = decisions.findIndex(
          (r) => r.plan_id === row.plan_id && r.did === row.did,
        );
        if (at === -1) decisions.push({ ...row });
        else decisions[at] = { ...decisions[at], ...row };
      }
    }
    return rows.length;
  }),
}));
// Who the owner follows right now, as the AppView's getRelationships answers.
const live = { follows: new Set(), unreadable: false, asked: [] };
vi.mock('../lib/atproto.js', () => ({
  fetchWithTimeout: vi.fn(async (url) => {
    const q = new URL(url).searchParams;
    live.asked.push(q.getAll('others'));
    if (live.unreadable) return { ok: false, json: async () => ({}) };
    return {
      ok: true,
      json: async () => ({
        relationships: q.getAll('others').map((did) => ({
          did,
          ...(live.follows.has(did)
            ? { following: `at://owner/app.bsky.graph.follow/${did}` }
            : {}),
        })),
      }),
    };
  }),
}));
const graph = {
  rkeysForWrite: vi.fn(),
  noteListed: vi.fn(),
  noteUnlisted: vi.fn(),
};
vi.mock('./graphFacts.js', () => graph);
vi.mock('../lib/target.js', () => ({
  resolveActor: vi.fn(async (a) =>
    a.startsWith('did:') ? a : `did:plc:${a.replace(/\W/g, '')}`,
  ),
}));

const { applyCommand, protectedAmong } = await import('./listWrite.js');
const { resolveActor } = await import('../lib/target.js');
const { OWNER_DID } = await import('../constants.js');

process.env.MOD_LIST_URI = 'at://did:plc:bot/app.bsky.graph.list/3list';

function agent() {
  return {
    session: { did: 'did:plc:bot' },
    com: {
      atproto: {
        repo: {
          createRecord: vi.fn(async () => ({
            data: { uri: 'at://did:plc:bot/app.bsky.graph.listitem/rNew' },
          })),
          deleteRecord: vi.fn(async () => ({})),
          listRecords: vi.fn(() => {
            throw new Error('the repo walk is the fallback, not the path');
          }),
        },
      },
    },
  };
}

beforeEach(() => {
  protectedRows.clear();
  manual.clear();
  circle.length = 0;
  // A snapshot has run, so the protected set holds the owner's follows.
  protectedRows.set('did:plc:oldfollow', 'you follow them');
  veto.unreadable = false;
  live.follows.clear();
  live.unreadable = false;
  live.asked.length = 0;
  decisions.length = 0;
  plans.ids.length = 0;
  plans.failing = 0;
  graph.rkeysForWrite.mockReset();
  graph.noteListed.mockReset();
  graph.noteUnlisted.mockReset();
});

describe('one block', () => {
  it('checks membership once, scores alongside, and records the write', async () => {
    graph.rkeysForWrite.mockResolvedValue([]);
    const a = agent();
    const lookUp = vi.fn(async () => ({
      band: 'UNKNOWN',
      handle: 'x.test',
      blocksYou: true,
    }));
    const out = await applyCommand(a, 'list_add', 'x.test', { lookUp });
    expect(out).toMatchObject({
      ok: true,
      changed: true,
      account: { handle: 'x.test', blocksYou: true },
    });
    expect(a.com.atproto.repo.createRecord).toHaveBeenCalledTimes(1);
    expect(graph.noteListed).toHaveBeenCalledWith(
      process.env.MOD_LIST_URI,
      'did:plc:xtest',
      'rNew',
    );
  });

  it('writes nothing for someone already on the list', async () => {
    graph.rkeysForWrite.mockResolvedValue(['r1']);
    const a = agent();
    const out = await applyCommand(a, 'list_add', 'x.test');
    expect(out).toMatchObject({ ok: true, already: true, changed: false });
    expect(a.com.atproto.repo.createRecord).not.toHaveBeenCalled();
  });

  it('refuses a PROTECTED account', async () => {
    graph.rkeysForWrite.mockResolvedValue([]);
    protectedRows.set('did:plc:friendtest', 'you follow them');
    const a = agent();
    const out = await applyCommand(a, 'list_add', 'friend.test');
    expect(out).toMatchObject({ ok: false, vetoed: 'you follow them' });
    expect(a.com.atproto.repo.createRecord).not.toHaveBeenCalled();
  });

  it('refuses when the protected set cannot be read', async () => {
    graph.rkeysForWrite.mockResolvedValue([]);
    veto.unreadable = true;
    const a = agent();
    await expect(applyCommand(a, 'list_add', 'x.test')).rejects.toThrow(
      /protected set/,
    );
    expect(a.com.atproto.repo.createRecord).not.toHaveBeenCalled();
  });

  it('refuses someone the owner followed since the last snapshot', async () => {
    graph.rkeysForWrite.mockResolvedValue([]);
    live.follows.add('did:plc:friendtest');
    const a = agent();
    const out = await applyCommand(a, 'list_add', 'friend.test');
    expect(out).toMatchObject({ ok: false, vetoed: 'you follow them' });
    expect(a.com.atproto.repo.createRecord).not.toHaveBeenCalled();
  });

  it('refuses someone the lookup just scored PROTECTED', async () => {
    graph.rkeysForWrite.mockResolvedValue([]);
    const lookUp = vi.fn(async () => ({
      band: 'PROTECTED',
      protectedReason: 'in your circle snapshot',
    }));
    const a = agent();
    const out = await applyCommand(a, 'list_add', 'x.test', { lookUp });
    expect(out).toMatchObject({
      ok: false,
      vetoed: 'in your circle snapshot',
    });
    expect(a.com.atproto.repo.createRecord).not.toHaveBeenCalled();
  });

  it('refuses when who the owner follows cannot be checked', async () => {
    graph.rkeysForWrite.mockResolvedValue([]);
    live.unreadable = true;
    const a = agent();
    await expect(applyCommand(a, 'list_add', 'x.test')).rejects.toThrow(
      /who you follow/,
    );
    expect(a.com.atproto.repo.createRecord).not.toHaveBeenCalled();
  });

  it('adds nobody before the first snapshot has filled the protected set', async () => {
    graph.rkeysForWrite.mockResolvedValue([]);
    protectedRows.clear();
    const a = agent();
    await expect(applyCommand(a, 'list_add', 'x.test')).rejects.toThrow(
      /not built yet/,
    );
    expect(a.com.atproto.repo.createRecord).not.toHaveBeenCalled();
  });

  it('adds nobody when the only protected rows were added by hand before any snapshot', async () => {
    graph.rkeysForWrite.mockResolvedValue([]);
    protectedRows.clear();
    protectedRows.set('did:plc:sister', 'added by hand');
    manual.add('did:plc:sister');
    const a = agent();
    await expect(applyCommand(a, 'list_add', 'x.test')).rejects.toThrow(
      /not built yet/,
    );
    await expect(protectedAmong(['did:plc:curated'])).rejects.toThrow(
      /not built yet/,
    );
    expect(a.com.atproto.repo.createRecord).not.toHaveBeenCalled();
  });

  it("refuses the owner's own account and the bot's", async () => {
    graph.rkeysForWrite.mockResolvedValue([]);
    const a = agent();
    const own = await applyCommand(a, 'list_add', OWNER_DID);
    expect(own).toMatchObject({ ok: false, did: OWNER_DID });
    expect(own.message).toMatch(/your own account/);
    const bot = await applyCommand(a, 'list_add', 'did:plc:bot');
    expect(bot).toMatchObject({ ok: false, did: 'did:plc:bot' });
    expect(a.com.atproto.repo.createRecord).not.toHaveBeenCalled();
    expect(decisions).toEqual([]);
  });

  it('records a block of someone already on the list, so a batch undo leaves them', async () => {
    graph.rkeysForWrite.mockResolvedValue(['r1']);
    const a = agent();
    const out = await applyCommand(a, 'list_add', 'x.test', {
      raw: 'block @x.test, he is the worst',
    });
    expect(out).toMatchObject({ ok: true, already: true, changed: false });
    expect(a.com.atproto.repo.createRecord).not.toHaveBeenCalled();
    expect(decisions).toEqual([
      expect.objectContaining({
        did: 'did:plc:xtest',
        action: 'list_add',
        approved_via: 'command',
        already_listed: true,
      }),
    ]);
    expect(decisions[0].acted_at).toBeTruthy();
  });

  it('says so when the write could not be recorded, and how to take it back', async () => {
    graph.rkeysForWrite.mockResolvedValue([]);
    plans.failing = 2;
    const a = agent();
    const out = await applyCommand(a, 'list_add', 'x.test');
    expect(a.com.atproto.repo.createRecord).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, changed: true, logged: false });
    expect(out.message).toBe(
      'Added x.test to the list, but I could not record it, so undo and history will not find it. "unblock x.test" takes it back.',
    );
    expect(decisions).toEqual([]);
  });

  it('tries the record once more, under the same plan', async () => {
    graph.rkeysForWrite.mockResolvedValue([]);
    plans.failing = 1;
    const out = await applyCommand(agent(), 'list_add', 'x.test');
    expect(out).toMatchObject({ ok: true, changed: true, logged: true });
    expect(out.message).toBe('Added x.test to the list.');
    expect(plans.ids).toHaveLength(2);
    expect(new Set(plans.ids).size).toBe(1);
    expect(decisions).toEqual([
      expect.objectContaining({ plan_id: plans.ids[0], action: 'list_add' }),
    ]);
  });

  it('says why a handle could not be resolved', async () => {
    resolveActor.mockRejectedValueOnce(
      new Error('the AppView could not resolve alice.test (HTTP 503)'),
    );
    const a = agent();
    const out = await applyCommand(a, 'list_add', 'alice.test');
    expect(out).toMatchObject({ ok: false });
    expect(out.message).toBe(
      'I could not resolve alice.test: the AppView could not resolve alice.test (HTTP 503).',
    );
    expect(a.com.atproto.repo.createRecord).not.toHaveBeenCalled();
  });

  it('refuses an action it does not know rather than removing', async () => {
    graph.rkeysForWrite.mockResolvedValue(['r1']);
    const a = agent();
    await expect(applyCommand(a, 'list_block', 'x.test')).rejects.toThrow();
    expect(a.com.atproto.repo.deleteRecord).not.toHaveBeenCalled();
  });
});

describe('the protected set for a bulk write', () => {
  it('names which of a batch are protected now', async () => {
    protectedRows.set('did:plc:friend', 'you follow them');
    expect(
      await protectedAmong(['did:plc:a', 'did:plc:friend', 'did:plc:a']),
    ).toEqual(new Set(['did:plc:friend']));
  });

  it('counts a snapshot that ran as building the set, though every row in it was added by hand', async () => {
    // Every account the owner follows is also a row added by hand, which a
    // snapshot leaves as it is.
    protectedRows.clear();
    protectedRows.set('did:plc:friend', 'you follow them');
    manual.add('did:plc:friend');
    circle.push({ did: 'did:plc:friend' });
    expect(await protectedAmong(['did:plc:a', 'did:plc:friend'])).toEqual(
      new Set(['did:plc:friend']),
    );
  });

  it('throws when the table cannot be read', async () => {
    veto.unreadable = true;
    await expect(protectedAmong(['did:plc:a'])).rejects.toThrow(
      /protected set/,
    );
  });

  it('names accounts the owner followed since the last snapshot, asking 30 at a time', async () => {
    const batch = Array.from({ length: 31 }, (_, i) => `did:plc:n${i}`);
    live.follows.add('did:plc:n30');
    expect(await protectedAmong(batch)).toEqual(new Set(['did:plc:n30']));
    expect(live.asked.map((a) => a.length)).toEqual([30, 1]);
  });

  it('throws when who the owner follows cannot be checked', async () => {
    live.unreadable = true;
    await expect(protectedAmong(['did:plc:a'])).rejects.toThrow(
      /who you follow/,
    );
  });

  it("names the owner's own account and the bot's", async () => {
    expect(
      await protectedAmong([OWNER_DID, 'did:plc:bot', 'did:plc:a']),
    ).toEqual(new Set([OWNER_DID, 'did:plc:bot']));
  });

  it('reads only the table when follows are left out', async () => {
    protectedRows.set('did:plc:friend', 'you follow them');
    live.follows.add('did:plc:new');
    expect(
      await protectedAmong(['did:plc:friend', 'did:plc:new', OWNER_DID], {
        follows: false,
      }),
    ).toEqual(new Set(['did:plc:friend', OWNER_DID]));
    expect(live.asked).toEqual([]);
  });
});

describe('one unblock', () => {
  it('deletes every copy of an account two plans added', async () => {
    graph.rkeysForWrite.mockResolvedValue(['r1', 'r2']);
    const a = agent();
    const out = await applyCommand(a, 'list_remove', 'x.test');
    expect(out).toMatchObject({ ok: true, changed: true });
    expect(a.com.atproto.repo.deleteRecord).toHaveBeenCalledTimes(2);
    expect(graph.noteUnlisted).toHaveBeenCalled();
  });

  it('closes the decision that added them, so "undo last" moves past it', async () => {
    decisions.push({
      plan_id: 'plan-block',
      did: 'did:plc:xtest',
      band: 'UNKNOWN',
      action: 'list_add',
      acted_at: '2026-10-01T10:00:00Z',
      undone_at: null,
    });
    graph.rkeysForWrite.mockResolvedValue(['r1']);
    const out = await applyCommand(agent(), 'list_remove', 'x.test', {
      raw: 'unblock @x.test',
    });
    expect(out).toMatchObject({ ok: true, changed: true });
    const block = decisions.find((r) => r.plan_id === 'plan-block');
    expect(block.undone_at).toBeTruthy();
    expect(block.undo_reason).toBe('unblock @x.test');
    // The unblock is still recorded as an action of its own.
    expect(decisions.some((r) => r.action === 'list_remove')).toBe(true);
  });

  it('treats an already-deleted copy as done, and changes nothing when membership is unknown', async () => {
    graph.rkeysForWrite.mockResolvedValue(['r1']);
    const a = agent();
    a.com.atproto.repo.deleteRecord.mockRejectedValue(
      new Error('Could not locate record'),
    );
    expect((await applyCommand(a, 'list_remove', 'x.test')).ok).toBe(true);

    graph.rkeysForWrite.mockResolvedValue(null);
    const out = await applyCommand(agent(), 'list_remove', 'x.test');
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/could not check/);
  });

  it('says so when the removal could not be recorded', async () => {
    graph.rkeysForWrite.mockResolvedValue(['r1']);
    plans.failing = 2;
    const out = await applyCommand(agent(), 'list_remove', 'x.test');
    expect(out).toMatchObject({ ok: true, changed: true, logged: false });
    expect(out.message).toBe(
      'Removed x.test from the list, but I could not record it, so history will not show it.',
    );
  });

  it('does not need the protected set to take someone off', async () => {
    graph.rkeysForWrite.mockResolvedValue(['r1']);
    veto.unreadable = true;
    const a = agent();
    const out = await applyCommand(a, 'list_remove', 'x.test');
    expect(out).toMatchObject({ ok: true, changed: true });
    expect(a.com.atproto.repo.deleteRecord).toHaveBeenCalledTimes(1);
  });
});
