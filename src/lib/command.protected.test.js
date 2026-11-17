// An approval narrowed only to PROTECTED, run through the real runCommand,
// applyPlanToTriage and applyPlan against an in-memory database. PROTECTED is
// dropped from what the parse carries, so a refusal is what keeps the
// approval from reading as no narrowing at all.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const LIST = 'at://did:plc:bot/app.bsky.graph.list/3list';
process.env.MOD_LIST_URI = LIST;

vi.mock('./atproto.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchWithTimeout: async (url) =>
    String(url).includes('getRelationships')
      ? { ok: true, json: async () => ({ relationships: [] }) }
      : { ok: false, status: 503, json: async () => ({}) },
}));
vi.mock('./constellation.js', () => ({
  getManyToMany: async () => null,
  getBacklinks: async () => ({ records: [], cursor: null }),
}));

const db = await import('../bot/db.js');
const { resetGraphFacts } = await import('../bot/graphFacts.js');
const { runCommand } = await import('../bot/dmLoop.js');
const { parseCommand } = await import('./command.js');

const ID = 'abcd1234-0000-4000-8000-000000000000';
const BOT = 'did:plc:bot';
const written = [];
const agent = {
  session: { did: BOT },
  com: {
    atproto: {
      repo: {
        applyWrites: async ({ writes }) => {
          written.push(...writes.map((w) => w.value?.subject));
          return {
            data: {
              results: writes.map((_, n) => ({
                uri: `at://${BOT}/app.bsky.graph.listitem/x${n}`,
              })),
            },
          };
        },
        createRecord: async ({ record }) => {
          written.push(record?.subject);
          return { data: { uri: `at://${BOT}/app.bsky.graph.listitem/one` } };
        },
        listRecords: async () => ({ data: { records: [] } }),
      },
    },
  },
};

/** Two hostile likers in each band but PROTECTED, which has one. */
async function seed() {
  const byBand = { PROTECTED: 1, CONNECTED: 2, NOTABLE: 2, UNKNOWN: 2 };
  await db.upsert('plan', [
    {
      id: ID,
      created_at: new Date().toISOString(),
      totals: { kind: 'everyone', byBand },
      note: 'bulk everyone',
    },
  ]);
  const rows = [];
  for (const [band, n] of Object.entries(byBand)) {
    for (let i = 0; i < n; i += 1) {
      rows.push({
        plan_id: ID,
        did: `did:plc:${band.toLowerCase()}${String(i).padStart(12, '0')}`,
        band,
        engaged: ['like'],
        triage: 'hostile',
        triage_quote: 'words',
        triage_at: new Date(Date.now() - 60_000).toISOString(),
      });
    }
  }
  await db.upsert('decision', rows);
  // PROTECTED is read from this table at the write, and a table no snapshot
  // has filled refuses every add.
  await db.upsert(
    'protected',
    rows
      .filter((r) => r.band === 'PROTECTED')
      .map((r) => ({
        did: r.did,
        reason: 'you follow them',
        source: 'derived',
      })),
  );
}

beforeEach(async () => {
  db.closeDb();
  db.openDb(':memory:');
  resetGraphFacts();
  written.length = 0;
  await seed();
});

describe('an approval narrowed only to PROTECTED', () => {
  it('adds nobody for a label or a kind', async () => {
    for (const text of [
      'approve abcd1234 hostile PROTECTED',
      'approve abcd1234 PROTECTED likers',
    ]) {
      const out = await runCommand(parseCommand(text), agent, {});
      expect(out.text).toMatch(/PROTECTED is never added/);
      expect(out.outcome).toBe(null);
      expect(written).toEqual([]);
    }
  });

  it('still narrows a label to another band named with it', async () => {
    await runCommand(
      parseCommand('approve abcd1234 hostile PROTECTED UNKNOWN'),
      agent,
      {},
    );
    expect(written.length).toBe(2);
    expect(written.every((d) => d.startsWith('did:plc:unknown'))).toBe(true);
  });
});
