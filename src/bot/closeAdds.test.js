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
