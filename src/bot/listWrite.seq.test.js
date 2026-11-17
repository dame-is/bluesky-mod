// The order of changes across a typed block and a plan's batch, against the
// real store, listWrite and bulkPlan. A bare undo takes back the newest
// change by acted_seq, so a typed block's log row needs one, or it sorts
// above every numbered batch (nulls first, descending) and is chosen forever.
// The network is faked: nobody is followed, the list starts empty and every
// write is taken.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const LIST = 'at://did:plc:bot/app.bsky.graph.list/3list';
process.env.MOD_LIST_URI = LIST;

vi.mock('../lib/atproto.js', () => ({
  resolvePds: async () => 'https://pds.test',
  fetchWithTimeout: async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('getRelationships')) {
      return {
        ok: true,
        json: async () => ({
          relationships: u.searchParams
            .getAll('others')
            .map((did) => ({ did })),
        }),
      };
    }
    if (u.pathname.endsWith('listRecords')) {
      return { ok: true, json: async () => ({ records: [] }) };
    }
    throw new Error(`unexpected request: ${url}`);
  },
}));
vi.mock('../lib/constellation.js', () => ({
  getManyToMany: async () => ({ items: [] }),
  getBacklinks: async () => ({ records: [] }),
}));
vi.mock('../lib/target.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveActor: async (a) =>
    a.startsWith('did:') ? a : `did:plc:${a.replace(/\W/g, '')}`,
}));

const db = await import('./db.js');
const { applyCommand } = await import('./listWrite.js');
const { applyPlan, lastChange } = await import('./bulkPlan.js');
const { resetGraphFacts } = await import('./graphFacts.js');

let n = 0;
const bot = {
  session: { did: 'did:plc:bot' },
  com: {
    atproto: {
      repo: {
        createRecord: async () => ({
          data: { uri: `at://did:plc:bot/app.bsky.graph.listitem/c${++n}` },
        }),
        applyWrites: async ({ writes }) => ({
          data: {
            results: writes.map(() => ({
              uri: `at://did:plc:bot/app.bsky.graph.listitem/w${++n}`,
            })),
          },
        }),
      },
    },
  },
};

/** A scan of one UNKNOWN liker, approved by band. Returns the plan id. */
async function batch(did) {
  const id = crypto.randomUUID();
  await db.upsert('plan', [{ id, note: 'scan of a post' }]);
  await db.upsert('decision', [
    { plan_id: id, did, band: 'UNKNOWN', engaged: ['like'] },
  ]);
  const [plan] = await db.select('plan', { eq: { id } });
  expect(await applyPlan(bot, plan, ['UNKNOWN'])).toMatchObject({ added: 1 });
  return id;
}

/** The decision row a typed block of `did` logged. */
async function typed(did) {
  const [row] = await db.select('decision', {
    select: 'plan_id,acted_seq',
    eq: { did, approved_via: 'command' },
  });
  return row;
}

/** The highest acted_seq among the batches' rows. */
async function topBatchSeq() {
  const rows = await db.selectAll('decision', {
    select: 'acted_seq',
    eq: { approved_via: 'band' },
    order: 'acted_seq.desc',
  });
  return rows[0]?.acted_seq;
}

beforeEach(async () => {
  db.closeDb();
  db.openDb(':memory:');
  resetGraphFacts();
  // A snapshot has filled the protected set, so writes are allowed.
  await db.upsert('protected', [
    { did: 'did:plc:friend', reason: 'you follow them', source: 'derived' },
  ]);
});

describe('the order of changes', () => {
  it('puts a batch approved after a typed block ahead of it for a bare undo', async () => {
    const block = await applyCommand(bot, 'list_add', 'pest.test', {
      raw: 'block @pest.test',
    });
    expect(block).toMatchObject({ changed: true, logged: true });

    const planId = await batch('did:plc:liker1');

    expect(Number.isInteger((await typed('did:plc:pesttest')).acted_seq)).toBe(
      true,
    );
    expect((await lastChange()).plan.id).toBe(planId);
  });

  it('gives a typed block after a batch the next number, so a bare undo takes the block', async () => {
    await batch('did:plc:liker2');
    const block = await applyCommand(bot, 'list_add', 'pest2.test', {
      raw: 'block @pest2.test',
    });
    expect(block).toMatchObject({ changed: true, logged: true });

    const row = await typed('did:plc:pest2test');
    expect(row.acted_seq).toBe((await topBatchSeq()) + 1);
    expect((await lastChange()).plan.id).toBe(row.plan_id);
  });
});
