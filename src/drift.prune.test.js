// What the weekly re-score clears out, against the real store, so the file
// stops growing by a row per listed account every week.

import { describe, it, expect, beforeEach } from 'vitest';

process.env.MOD_LIST_URI =
  'at://did:plc:bot00000000000000000000/app.bsky.graph.list/3list';
const db = await import('./bot/db.js');
const { pruneOld } = await import('./drift.js');

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const day = (n) => new Date(NOW - n * 86_400_000).toISOString();

beforeEach(() => {
  db.closeDb();
  db.openDb(':memory:');
});

describe('pruning after a re-score', () => {
  it('keeps the newest four finished audits and nothing a killed run left', async () => {
    const list = process.env.MOD_LIST_URI;
    for (let i = 0; i < 6; i += 1) {
      await db.upsert('audit', [
        { id: `a${i}`, list_uri: list, started_at: day(7 * (6 - i)), finished_at: day(7 * (6 - i)) },
      ]);
      await db.upsert('audit_item', [
        { audit_id: `a${i}`, did: 'did:plc:x', band: 'UNKNOWN' },
      ]);
    }
    await db.upsert('audit', [
      { id: 'killed', list_uri: list, started_at: day(3) },
      { id: 'running', list_uri: list, started_at: new Date(NOW - 60_000).toISOString() },
    ]);
    await db.upsert('llm_usage', [
      { at: day(120), kind: 'dm', model: 'm' },
      { at: day(10), kind: 'dm', model: 'm' },
    ]);

    await pruneOld({ now: NOW });

    const audits = await db.selectAll('audit', { select: 'id', order: 'id.asc' });
    expect(audits.map((a) => a.id)).toEqual(['a2', 'a3', 'a4', 'a5', 'running']);
    expect(await db.count('audit_item', {})).toBe(4);
    expect(await db.count('llm_usage', {})).toBe(1);
  });
});
