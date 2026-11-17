// closeAdds against the real store, for what its in-list binds.

import { describe, it, expect, beforeEach } from 'vitest';

const db = await import('./db.js');
const { closeAdds } = await import('./closeAdds.js');

const PLAN = '1c2d3e4f-0000-4000-8000-000000000000';
const add = (did) => ({
  plan_id: PLAN,
  did,
  band: 'UNKNOWN',
  action: 'list_add',
  acted_at: '2026-10-01T10:00:00.000Z',
});

beforeEach(async () => {
  db.closeDb();
  db.openDb(':memory:');
  await db.upsert('plan', [{ id: PLAN, note: 'test' }]);
});

describe('closing adds', () => {
  it('closes exactly the accounts named, whatever their text holds', async () => {
    // A value holding quote, comma, quote would read as two values in an
    // in.(...) string, and close two accounts nobody named.
    const odd = 'did:plc:a","did:plc:b';
    await db.upsert('decision', [add('did:plc:a'), add('did:plc:b'), add(odd)]);
    expect(await closeAdds([odd], 'undo')).toBe(1);
    const open = await db.selectAll('decision', {
      select: 'did',
      where: { undone_at: 'is.null' },
      order: 'did.asc',
    });
    expect(open.map((r) => r.did)).toEqual(['did:plc:a', 'did:plc:b']);
  });
});

describe('closing adds on one list of several', () => {
  const MAIN = 'at://did:plc:bot/app.bsky.graph.list/3main';
  const SPAM = 'at://did:plc:bot/app.bsky.graph.list/3spam';
  const ON_SPAM = '9e8d7c6b-0000-4000-8000-000000000002';
  const SCAN = '5a6b7c8d-0000-4000-8000-000000000003';

  beforeEach(async () => {
    process.env.MOD_LIST_URI = MAIN;
    // PLAN has no list_uri: the main list. ON_SPAM and SCAN are bound to Spam.
    await db.upsert('plan', [
      { id: ON_SPAM, note: 'spam', list_uri: SPAM },
      { id: SCAN, note: 'scan', list_uri: SPAM },
    ]);
    await db.upsert('decision', [
      add('did:plc:a'),
      { ...add('did:plc:a'), plan_id: ON_SPAM },
      // A scan on Spam that found them there and skipped them.
      { plan_id: SCAN, did: 'did:plc:a', band: 'UNKNOWN', already_listed: true },
    ]);
  });

  it('closes only the adds on that list, and clears only its marks', async () => {
    expect(await closeAdds(['did:plc:a'], 'unblocked', { list: SPAM })).toBe(1);
    const rows = await db.selectAll('decision', {
      select: 'plan_id,undone_at,already_listed',
      order: 'plan_id.asc',
    });
    const by = Object.fromEntries(rows.map((r) => [r.plan_id, r]));
    // Still on the main list: that add stands.
    expect(by[PLAN].undone_at).toBeNull();
    expect(by[ON_SPAM].undone_at).not.toBeNull();
    expect(by[SCAN].already_listed).toBe(false);
  });

  it('closes every list with no list given, as before lists were told apart', async () => {
    expect(await closeAdds(['did:plc:a'], 'unblocked')).toBe(2);
  });
});
