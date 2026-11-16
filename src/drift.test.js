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

vi.mock('./lib/score.js', () => ({
  createScorer: () => ({
    score: async (dids) =>
      new Map(dids.map((did) => [did, { band: 'UNKNOWN', handle: did }])),
  }),
}));

const { runDrift, renderBrief, maybeRunDrift } = await import('./drift.js');

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

beforeEach(() => {
  db.audit = [];
  db.audit_item = [];
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
