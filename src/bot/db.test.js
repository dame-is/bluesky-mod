import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { openDb, closeDb, select, selectAll, upsert, update, del, count, rpc } from './db.js';

beforeEach(() => {
  closeDb();
  openDb(':memory:');
});
afterAll(() => closeDb());

describe('db', () => {
  it('upserts, merging only the columns given', async () => {
    await upsert('plan', [{ id: 'p1', note: 'first', approved_bands: ['UNKNOWN'] }]);
    await upsert('plan', [{ id: 'p1', approved_at: '2026-01-01T00:00:00.000Z' }]);
    const [row] = await select('plan', { eq: { id: 'p1' } });
    expect(row.note).toBe('first');
    expect(row.approved_bands).toEqual(['UNKNOWN']);
    expect(row.approved_at).toBe('2026-01-01T00:00:00.000Z');
    expect(row.created_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('fills a uuid id when a row arrives without one', async () => {
    await upsert('memory', [{ text: 'never block people who only liked' }]);
    const [row] = await select('memory', {});
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reads booleans and JSON back as values', async () => {
    await upsert('plan', [{ id: 'p' }]);
    await upsert('decision', [
      { plan_id: 'p', did: 'did:plc:a', band: 'UNKNOWN', already_listed: true, engaged: ['like'] },
      { plan_id: 'p', did: 'did:plc:b', band: 'CONNECTED', already_listed: false },
    ]);
    const rows = await select('decision', { order: 'did.asc' });
    expect(rows.map((r) => r.already_listed)).toEqual([true, false]);
    expect(rows[0].engaged).toEqual(['like']);
    expect(await count('decision', { eq: { already_listed: true } })).toBe(1);
  });

  it('understands the filter strings callers use', async () => {
    await upsert('plan', [{ id: 'p' }]);
    await upsert('decision', [
      { plan_id: 'p', did: 'did:plc:a', band: 'UNKNOWN', acted_at: '2026-01-02T00:00:00.000Z', approved_via: 'agent:triage:hostile' },
      { plan_id: 'p', did: 'did:plc:b', band: 'CONNECTED' },
      { plan_id: 'p', did: 'did:plc:c', band: 'PERIPHERAL', acted_at: '2026-01-01T00:00:00.000Z' },
    ]);
    const dids = async (opts) => (await select('decision', { ...opts, order: 'did.asc' })).map((r) => r.did);
    expect(await dids({ where: { band: 'neq.UNKNOWN' } })).toEqual(['did:plc:b', 'did:plc:c']);
    expect(await dids({ where: { acted_at: 'not.is.null' } })).toEqual(['did:plc:a', 'did:plc:c']);
    expect(await dids({ is: { acted_at: 'null' } })).toEqual(['did:plc:b']);
    expect(await dids({ where: { acted_at: 'gte.2026-01-02' } })).toEqual(['did:plc:a']);
    expect(await dids({ where: { did: 'in.(did:plc:a,did:plc:c)' } })).toEqual(['did:plc:a', 'did:plc:c']);
    expect(await dids({ where: { did: 'in.("did:plc:b")' } })).toEqual(['did:plc:b']);
    expect(await dids({ where: { approved_via: 'like.*triage:hostile*' } })).toEqual(['did:plc:a']);
  });

  it('binds each value of an { in: [...] } list, quotes and commas included', async () => {
    await upsert('plan', [{ id: 'p' }]);
    await upsert('decision', [
      { plan_id: 'p', did: 'did:plc:x"y', band: 'UNKNOWN' },
      { plan_id: 'p', did: 'did:plc:a,b', band: 'UNKNOWN' },
      { plan_id: 'p', did: 'did:plc:c', band: 'PROTECTED' },
    ]);
    const dids = async (opts) => (await select('decision', { ...opts, order: 'did.asc' })).map((r) => r.did);
    expect(await dids({ where: { did: { in: ['did:plc:x"y', 'did:plc:c'] } } })).toEqual(['did:plc:c', 'did:plc:x"y']);
    expect(await dids({ where: { did: { in: ['did:plc:a,b'] } } })).toEqual(['did:plc:a,b']);
    expect(await dids({ where: { did: { in: [] } } })).toEqual([]);
    expect(await count('decision', { where: { did: { in: ['did:plc:c'] }, band: 'eq.PROTECTED' } })).toBe(1);
  });

  it('refuses a double quote inside an in.(...) value rather than matching fewer rows', async () => {
    // The string form has no escape for a quote. Read loosely, one stray quote
    // merges the values after it into one, and the rows they name drop out of
    // the answer without any error.
    await upsert('plan', [{ id: 'p' }]);
    await upsert('decision', [{ plan_id: 'p', did: 'did:plc:c', band: 'PROTECTED' }]);
    const read = (list) => select('decision', { where: { did: list } });
    await expect(read('in.("did:plc:x"y","did:plc:c")')).rejects.toThrow(/double quote/);
    await expect(read('in.(did:plc:x"y,did:plc:c)')).rejects.toThrow(/double quote/);
    await expect(read('in.("did:plc:x,did:plc:c)')).rejects.toThrow(/double quote/);
    expect(await read('in.("did:plc:x","did:plc:c")')).toHaveLength(1);
  });

  it('sorts null as larger than any value', async () => {
    await upsert('plan', [{ id: 'p' }]);
    await upsert('decision', [
      { plan_id: 'p', did: 'a', band: 'X', acted_at: '2026-01-01' },
      { plan_id: 'p', did: 'b', band: 'X' },
      { plan_id: 'p', did: 'c', band: 'X', acted_at: '2026-01-02' },
    ]);
    const desc = await select('decision', { order: 'acted_at.desc' });
    expect(desc.map((r) => r.did)).toEqual(['b', 'c', 'a']);
    const asc = await selectAll('decision', { order: 'acted_at.asc' });
    expect(asc.map((r) => r.did)).toEqual(['a', 'c', 'b']);
  });

  it('updates and deletes only what matches, and refuses an unfiltered one', async () => {
    await upsert('protected', [
      { did: 'a', reason: 'you follow them', source: 'derived' },
      { did: 'b', reason: 'added by hand', source: 'manual' },
    ]);
    await update('protected', { eq: { did: 'a' } }, { reason: 'changed' });
    await del('protected', { eq: { source: 'manual' } });
    expect(await select('protected', {})).toEqual([
      expect.objectContaining({ did: 'a', reason: 'changed' }),
    ]);
    await expect(del('protected', {})).rejects.toThrow(/every row/);
  });

  it('finalises a snapshot into vouch counts, and refuses a partial one', async () => {
    const t = '2026-01-01T00:00:00.000Z';
    await upsert('circle', [
      { taken_at: t, did: 'm1', follows_indexed_at: t },
      { taken_at: t, did: 'm2' },
    ]);
    await upsert('circle_follow', [
      { taken_at: t, member_did: 'm1', target_did: 'x' },
      { taken_at: t, member_did: 'm2', target_did: 'x' },
      { taken_at: t, member_did: 'm2', target_did: 'y' },
    ]);
    await expect(rpc('finalise_snapshot', { snapshot: t })).rejects.toThrow(/incomplete/);
    await update('circle', { eq: { taken_at: t, did: 'm2' } }, { follows_indexed_at: t });
    expect(await rpc('finalise_snapshot', { snapshot: t })).toBe(2);
    const rows = await select('vouch', { order: 'did.asc', select: 'did,vouches' });
    expect(rows).toEqual([{ did: 'x', vouches: 2 }, { did: 'y', vouches: 1 }]);
    expect(await count('circle_follow', {})).toBe(0);
  });

  it('keeps the newest two snapshots and drops older ones', async () => {
    const times = [
      '2026-01-01T00:00:00.000Z',
      '2026-01-08T00:00:00.000Z',
      '2026-01-15T00:00:00.000Z',
    ];
    for (const t of times) {
      await upsert('circle', [{ taken_at: t, did: 'm1', follows_indexed_at: t }]);
      await upsert('circle_follow', [{ taken_at: t, member_did: 'm1', target_did: 'x' }]);
      await rpc('finalise_snapshot', { snapshot: t });
    }
    const kept = await select('vouch', { select: 'taken_at', order: 'taken_at.asc' });
    expect(kept.map((r) => r.taken_at)).toEqual(times.slice(1));
  });

  it('keeps the singleton tables single', async () => {
    await upsert('dm_cursor', [{ id: 1, cursor: 'a' }]);
    await upsert('dm_cursor', [{ id: 1, cursor: 'b' }]);
    expect(await select('dm_cursor', { select: 'cursor' })).toEqual([{ cursor: 'b' }]);
    await upsert('dm_choice', [{ convo_id: 'c', pending: { commands: ['block @x'] } }]);
    const [c] = await select('dm_choice', {});
    expect(c.pending).toEqual({ commands: ['block @x'] });
    expect(c.options).toEqual([]);
  });

  it('creates the file readable by its owner only', () => {
    closeDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluesky-mod-db-'));
    const file = path.join(dir, 'state', 'bot.db');
    try {
      openDb(file);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
