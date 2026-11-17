// `review <code>` against the real plan functions and an in-memory database,
// with the AppView and Constellation stubbed out, so the menu is built from a
// plan row as findPlan really returns it and pressing each option runs the
// real approve and cancel.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const LIST = 'at://did:plc:bot/app.bsky.graph.list/3list';
process.env.MOD_LIST_URI = LIST;

vi.mock('../lib/atproto.js', async (importOriginal) => ({
  ...(await importOriginal()),
  // No profiles, and nobody followed: every read of the AppView "fails" or
  // answers with no relationships.
  fetchWithTimeout: async (url) =>
    String(url).includes('getRelationships')
      ? { ok: true, json: async () => ({ relationships: [] }) }
      : { ok: false, status: 503, json: async () => ({}) },
}));
vi.mock('../lib/constellation.js', () => ({
  getManyToMany: async () => null,
  getBacklinks: async () => ({ records: [], cursor: null }),
}));

const db = await import('./db.js');
const { runCommand } = await import('./dmLoop.js');
const { parseCommand, parseChoice } = await import('../lib/command.js');

const ID = 'abcd1234-0000-4000-8000-000000000000';
const BOT = 'did:plc:bot';

const agent = {
  session: { did: BOT },
  com: {
    atproto: {
      repo: {
        applyWrites: async ({ writes }) => ({
          data: {
            results: writes.map((_, n) => ({
              uri: `at://${BOT}/app.bsky.graph.listitem/x${n}`,
            })),
          },
        }),
        createRecord: async () => ({
          data: { uri: `at://${BOT}/app.bsky.graph.listitem/one` },
        }),
        listRecords: async () => ({ data: { records: [] } }),
      },
    },
  },
};

/** One plan, as proposePlan stores it: 3 PROTECTED, 5 CONNECTED, 20 PERIPHERAL, 10 NOTABLE. */
async function seed() {
  const byBand = { PROTECTED: 3, CONNECTED: 5, PERIPHERAL: 20, NOTABLE: 10 };
  await db.upsert('plan', [
    {
      id: ID,
      created_at: new Date().toISOString(),
      totals: { kind: 'everyone', byBand: { ...byBand, UNKNOWN: 0 } },
      note: 'bulk everyone',
    },
  ]);
  const trust = { PROTECTED: 100, CONNECTED: 70, PERIPHERAL: 40, NOTABLE: 20 };
  const rows = [];
  for (const [band, n] of Object.entries(byBand)) {
    for (let i = 0; i < n; i += 1) {
      rows.push({
        plan_id: ID,
        did: `did:plc:${band.toLowerCase()}${String(i).padStart(12, '0')}`,
        band,
        trust: trust[band],
      });
    }
  }
  await db.upsert('decision', rows);
  // PROTECTED is read from this table at the write, and an empty table
  // refuses every add.
  await db.upsert('protected', [
    ...rows
      .filter((r) => r.band === 'PROTECTED')
      .map((r) => ({ did: r.did, reason: 'you follow them' })),
  ]);
}

/** Press option n of a reply's menu, as a bare number would. */
function press(reply, n) {
  const chosen = reply.options[parseChoice(String(n)) - 1];
  return runCommand(parseCommand(chosen.command), agent, {});
}

beforeEach(async () => {
  db.closeDb();
  db.openDb(':memory:');
  await seed();
});

describe('review <code>', () => {
  it('names the plan by its code, so every option it offers runs', async () => {
    const review = await runCommand(parseCommand('review abcd1234'), agent, {});
    expect(review.text).toMatch(/^Plan abcd1234: 38 need a look:/);
    expect(review.text).toContain('approve abcd1234 @handle @handle');
    expect(review.text).not.toContain('undefined');
    for (const o of review.options) {
      expect(parseCommand(o.command).needsTarget).toBe(false);
    }

    const cancelled = await press(review, review.options.length);
    expect(cancelled.text).toMatch(/^Cancelled abcd1234/);
  });

  it('"add" covers every band under review, not only the rows on screen', async () => {
    const review = await runCommand(parseCommand('review abcd1234'), agent, {});
    // 15 rows on screen, all PROTECTED, CONNECTED or PERIPHERAL. The 10
    // NOTABLE ones are past the fold.
    expect(review.text).toContain('(23 more)');
    expect(review.text).not.toMatch(/NOTABLE, \d+ vouches/);
    const add = review.options[0];
    expect(add.label).toMatch(/CONNECTED, PERIPHERAL and NOTABLE/);
    expect(add.label).not.toMatch(/38/);
    expect(parseCommand(add.command).bands.sort()).toEqual([
      'CONNECTED',
      'NOTABLE',
      'PERIPHERAL',
    ]);

    const out = await press(review, 1);
    expect(out.text).toMatch(/^Added 35 to the list\./);
  });

  it('keeps to the bands a narrowed review asked for', async () => {
    const review = await runCommand(
      parseCommand('review abcd1234 NOTABLE'),
      agent,
      {},
    );
    expect(review.text).toMatch(/^Plan abcd1234: 10 need a look:/);
    expect(parseCommand(review.options[0].command).bands).toEqual(['NOTABLE']);
    const out = await press(review, 1);
    expect(out.text).toMatch(/^Added 10 to the list\./);
  });

  it('offers no add when everything under review is PROTECTED', async () => {
    const other = 'feedbeef-0000-4000-8000-000000000000';
    await db.upsert('plan', [
      { id: other, created_at: new Date().toISOString(), note: 'bulk' },
    ]);
    await db.upsert('decision', [
      { plan_id: other, did: 'did:plc:p1', band: 'PROTECTED', trust: 100 },
      { plan_id: other, did: 'did:plc:u1', band: 'UNKNOWN', trust: 1 },
    ]);
    const review = await runCommand(
      parseCommand('review feedbeef'),
      agent,
      {},
    );
    expect(review.text).toMatch(/^Plan feedbeef: 1 need a look:/);
    expect(review.options.map((o) => o.command)).toEqual(['cancel feedbeef']);
  });

  it('names only the bands on screen when the whole set fits', async () => {
    const small = 'c0ffee00-0000-4000-8000-000000000000';
    await db.upsert('plan', [
      { id: small, created_at: new Date().toISOString(), note: 'bulk' },
    ]);
    await db.upsert('decision', [
      { plan_id: small, did: 'did:plc:c1', band: 'CONNECTED', trust: 70 },
      { plan_id: small, did: 'did:plc:c2', band: 'CONNECTED', trust: 60 },
    ]);
    const review = await runCommand(
      parseCommand('review c0ffee00'),
      agent,
      {},
    );
    expect(review.options[0]).toEqual({
      label: 'Add the CONNECTED ones',
      command: 'approve c0ffee00 CONNECTED',
    });
  });
});

describe('a label approval that names bands or a time', () => {
  /** Label `n` rows of `band` hostile, at `at`. */
  async function label(band, n, at) {
    const rows = await db.selectAll('decision', {
      select: 'plan_id,did,band',
      eq: { plan_id: ID, band },
      order: 'did.asc',
    });
    await db.upsert(
      'decision',
      rows.slice(0, n).map((r) => ({ ...r, triage: 'hostile', triage_at: at })),
    );
  }

  it('adds only the hostile ones in the bands it names', async () => {
    await label('CONNECTED', 2, '2026-11-01T10:00:00.000Z');
    await label('PERIPHERAL', 3, '2026-11-01T10:00:00.000Z');
    const out = await runCommand(
      parseCommand('approve abcd1234 hostile CONNECTED'),
      agent,
      {},
    );
    expect(out.text).toMatch(/^Added 2 that a model read as hostile\./);
    const added = await db.selectAll('decision', {
      select: 'did,band',
      eq: { plan_id: ID },
      where: { acted_at: 'not.is.null' },
      order: 'did.asc',
    });
    expect(added.map((r) => r.band)).toEqual(['CONNECTED', 'CONNECTED']);
  });

  it('adds nothing labelled after the time it carries', async () => {
    await label('NOTABLE', 2, '2026-11-01T10:00:00.000Z');
    await label('CONNECTED', 1, '2026-11-01T11:00:00.000Z');
    const out = await runCommand(
      parseCommand('approve abcd1234 hostile asof=2026-11-01T10:30:00.000Z'),
      agent,
      {},
    );
    expect(out.text).toMatch(/^Added 2 that a model read as hostile\./);
  });
});
