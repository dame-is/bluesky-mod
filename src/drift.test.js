// The weekly re-score: what it compares against, and what the brief says.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const LIST = 'at://did:plc:bot/app.bsky.graph.list/3list';
process.env.MOD_LIST_URI = LIST;

const db = { audit: [], audit_item: [] };

vi.mock('./bot/db.js', () => ({
  select: vi.fn(async (table, { eq = {}, where = {}, limit } = {}) => {
    let rows = (db[table] || []).filter((r) =>
      Object.entries(eq).every(([k, v]) => r[k] === v),
    );
    if (where.finished_at === 'not.is.null') {
      rows = rows.filter((r) => r.finished_at != null);
    }
    if (where.total === 'gt.0') rows = rows.filter((r) => r.total > 0);
    rows = [...rows].sort((a, b) => b.started_at.localeCompare(a.started_at));
    return limit ? rows.slice(0, limit) : rows;
  }),
  selectAll: vi.fn(async (table, { eq = {} } = {}) =>
    (db[table] || []).filter((r) =>
      Object.entries(eq).every(([k, v]) => r[k] === v),
    ),
  ),
  upsert: vi.fn(async () => 0),
}));

vi.mock('./bot/reference.js', () => ({
  loadReference: vi.fn(async () => ({ ref: {}, thresholds: {}, takenAt: 't' })),
}));

const scoring = { fail: false };
vi.mock('./lib/score.js', () => ({
  createScorer: () => ({
    score: async (dids) => {
      if (scoring.fail) {
        throw new Error(
          'could not read profiles from Bluesky (HTTP 429), so nothing was scored. Try again in a minute',
        );
      }
      return new Map(dids.map((did) => [did, { band: 'UNKNOWN', handle: did }]));
    },
  }),
}));

const { runDrift, renderBrief, maybeRunDrift } = await import('./drift.js');
const { upsert } = await import('./bot/db.js');

const audit = (id, started_at, extra = {}) => ({
  id,
  list_uri: LIST,
  started_at,
  finished_at: started_at,
  total: 2,
  scored: 2,
  ...extra,
});

function agentWith(subjects) {
  return {
    com: {
      atproto: {
        repo: {
          listRecords: async () => ({
            data: {
              records: subjects.map((subject, i) => ({
                uri: `at://did:plc:bot/app.bsky.graph.listitem/r${i}`,
                value: { list: LIST, subject },
              })),
            },
          }),
        },
      },
    },
  };
}

/** A repo whose listitems come one per page, `pages` pages long. */
function agentWithPages(pages) {
  return {
    com: {
      atproto: {
        repo: {
          listRecords: async ({ cursor }) => {
            const n = cursor ? Number(cursor) : 0;
            return {
              data: {
                records: [
                  {
                    uri: `at://did:plc:bot/app.bsky.graph.listitem/r${n}`,
                    value: { list: LIST, subject: `did:plc:m${n}` },
                  },
                ],
                cursor: n + 1 < pages ? String(n + 1) : undefined,
              },
            };
          },
        },
      },
    },
  };
}

beforeEach(() => {
  db.audit = [];
  db.audit_item = [];
  scoring.fail = false;
  upsert.mockClear();
});

describe('the baseline a re-score is compared with', () => {
  it('is the last run that finished, not one that died partway', async () => {
    db.audit = [
      audit('done', '2026-10-01T00:00:00Z'),
      // Killed after writing its row and none of its items.
      audit('crashed', '2026-10-08T00:00:00Z', {
        finished_at: null,
        total: 2,
        scored: 0,
      }),
    ];
    db.audit_item = [
      { audit_id: 'done', did: 'did:plc:a', band: 'UNKNOWN' },
      { audit_id: 'done', did: 'did:plc:b', band: 'UNKNOWN' },
    ];
    const out = await runDrift(agentWith(['did:plc:a', 'did:plc:b']));
    // Measured against the finished run, nobody is new.
    expect(out.added).toBe(0);
  });
});

describe('the brief', () => {
  it('names who moved and how to take them off', () => {
    const body = renderBrief({
      scored: 10,
      drifted: [{ did: 'did:plc:a', handle: 'a.test', now: 'CONNECTED' }],
      gone: [],
      added: 0,
    });
    expect(body).toContain('@a.test is now CONNECTED');
    expect(body).toContain('unblock @handle');
  });

  it('names every member who became PROTECTED, however many others moved', () => {
    const strangers = Array.from({ length: 13 }, (_, i) => ({
      did: `did:plc:s${i}`,
      handle: `stranger${i}.test`,
      was: 'UNKNOWN',
      now: 'CONNECTED',
      vouches: 5,
    }));
    const friends = Array.from({ length: 13 }, (_, i) => ({
      did: `did:plc:f${i}`,
      handle: `friend${i}.test`,
      was: 'UNKNOWN',
      now: 'PROTECTED',
      vouches: 0,
    }));
    const body = renderBrief({
      scored: 500,
      drifted: [...strangers, ...friends],
      gone: [],
      added: 0,
    });
    for (const f of friends) {
      expect(body).toContain(`@${f.handle} is now PROTECTED`);
    }
    // The cut applies to the others alone.
    expect(body).toContain('@stranger11.test is now CONNECTED');
    expect(body).not.toContain('@stranger12.test');
    expect(body).toContain('and 1 more');
  });

  it('puts a member who became PROTECTED under its own line, with its earlier band', () => {
    const body = renderBrief({
      scored: 40,
      drifted: [
        {
          did: 'did:plc:f',
          handle: 'f.test',
          was: 'CONNECTED',
          now: 'PROTECTED',
          vouches: 4,
        },
      ],
      gone: [],
      added: 0,
    });
    expect(body).toContain('1 account on the list is now PROTECTED:');
    expect(body).toContain('@f.test is now PROTECTED, was CONNECTED, 4 vouches');
    expect(body).not.toContain('no longer a stranger');
    expect(body).toContain('unblock @handle');
  });

  it('counts a stranger who became PROTECTED once, under PROTECTED', () => {
    const body = renderBrief({
      scored: 40,
      drifted: [
        { did: 'did:plc:a', handle: 'a.test', was: 'UNKNOWN', now: 'NOTABLE' },
        { did: 'did:plc:b', handle: 'b.test', was: 'UNKNOWN', now: 'PROTECTED' },
      ],
      gone: [],
      added: 0,
    });
    expect(body).toContain('1 account on the list is now PROTECTED:');
    expect(body).toContain('1 account is no longer a stranger:');
    expect(body.match(/@b\.test/g)).toHaveLength(1);
    expect(body.indexOf('@b.test')).toBeLessThan(body.indexOf('@a.test'));
  });

  it('counts one account re-scored as one account', () => {
    const body = renderBrief({
      scored: 1,
      drifted: [],
      gone: [{ did: 'did:plc:a' }],
      added: 0,
    });
    expect(body).toContain('Re-scored 1 account on the list.');
  });

  it('says nothing when nothing moved', () => {
    expect(renderBrief({ scored: 10, drifted: [], gone: [], added: 3 })).toBe(
      null,
    );
  });
});

describe('sending the brief', () => {
  it('waits for a convo to send it to before running', async () => {
    const listRecords = vi.fn();
    const agent = { com: { atproto: { repo: { listRecords } } } };
    expect(await maybeRunDrift(agent, {}, null)).toBe(null);
    expect(listRecords).not.toHaveBeenCalled();
  });
});

describe('a re-score the AppView cannot answer', () => {
  it('is left unfinished, so it is neither a brief nor next week\'s baseline', async () => {
    scoring.fail = true;
    await expect(
      runDrift(agentWith(['did:plc:a', 'did:plc:b'])),
    ).rejects.toThrow(/nothing was scored/);
    const auditRows = upsert.mock.calls
      .filter(([table]) => table === 'audit')
      .flatMap(([, rows]) => rows);
    expect(auditRows.some((r) => r.finished_at)).toBe(false);
    expect(upsert.mock.calls.some(([table]) => table === 'audit_item')).toBe(
      false,
    );
  });

  it('sends nothing and records no brief, so the next check runs it again', async () => {
    scoring.fail = true;
    const sendMessage = vi.fn();
    const chat = { chat: { bsky: { convo: { sendMessage } } } };
    await expect(
      maybeRunDrift(agentWith(['did:plc:a']), chat, 'convo1'),
    ).rejects.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(upsert.mock.calls.some(([table]) => table === 'brief')).toBe(false);
  });
});

describe('a list longer than 40,000 accounts', () => {
  it('is re-scored past the first 400 pages', async () => {
    const out = await runDrift(agentWithPages(450));
    expect(out.scored).toBe(450);
  });
});
