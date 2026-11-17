// What the daily clean-up clears out, against the real store.

import { describe, it, expect, beforeEach } from 'vitest';

process.env.MOD_LIST_URI =
  'at://did:plc:bot00000000000000000000/app.bsky.graph.list/3list';
const db = await import('./bot/db.js');
const { pruneData, pruneAudits } = await import('./retention.js');

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const day = (n) => new Date(NOW - n * 86_400_000).toISOString();
const KEEP = {
  snapshots: 2,
  audits: 4,
  unapprovedDays: 30,
  quotesDays: 0,
  usageDays: 90,
};

beforeEach(() => {
  db.closeDb();
  db.openDb(':memory:');
});

describe('re-score records', () => {
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

    await pruneAudits({ now: NOW, keep: KEEP });

    const audits = await db.selectAll('audit', { select: 'id', order: 'id.asc' });
    expect(audits.map((a) => a.id)).toEqual(['a2', 'a3', 'a4', 'a5', 'running']);
    expect(await db.count('audit_item', {})).toBe(4);
  });

  it('keeps as many as MOD_KEEP_AUDITS says', async () => {
    const list = process.env.MOD_LIST_URI;
    for (let i = 0; i < 3; i += 1) {
      await db.upsert('audit', [
        { id: `a${i}`, list_uri: list, started_at: day(10 - i), finished_at: day(10 - i) },
      ]);
    }
    await pruneAudits({ now: NOW, keep: { ...KEEP, audits: 1 } });
    expect(await db.count('audit', {})).toBe(1);
  });
});

describe('scans never acted on', () => {
  async function plan(id, createdDaysAgo, { acted = false } = {}) {
    await db.upsert('plan', [{ id, created_at: day(createdDaysAgo) }]);
    await db.upsert('decision', [
      { plan_id: id, did: 'did:plc:a', band: 'UNKNOWN', acted_at: acted ? day(createdDaysAgo) : null },
      { plan_id: id, did: 'did:plc:b', band: 'UNKNOWN' },
    ]);
  }

  it('go after 30 days with their rows; anything written from is kept', async () => {
    await plan('old-idle', 40);
    await plan('old-acted', 40, { acted: true });
    await plan('new-idle', 5);

    const res = await pruneData({ now: NOW, keep: KEEP });

    expect(res.plans).toBe(1);
    const left = await db.selectAll('plan', { select: 'id', order: 'id.asc' });
    expect(left.map((p) => p.id)).toEqual(['new-idle', 'old-acted']);
    expect(await db.count('decision', { eq: { plan_id: 'old-idle' } })).toBe(0);
    expect(await db.count('decision', { eq: { plan_id: 'old-acted' } })).toBe(2);
  });

  it('stay while a batch or a live watch still points at them', async () => {
    await plan('carrying-on', 40);
    await plan('watched', 40);
    await plan('watch-ended', 40);
    await db.upsert('continuation', [
      { plan_id: 'carrying-on', convo_id: 'c', command: 'approve carrying-on likers', next_at: day(0) },
    ]);
    await db.upsert('watch', [
      { id: 'w1', convo_id: 'c', uri: 'at://x/app.bsky.feed.post/1', plan_id: 'watched', until: day(-1) },
      { id: 'w2', convo_id: 'c', uri: 'at://x/app.bsky.feed.post/2', plan_id: 'watch-ended', until: day(2) },
    ]);

    await pruneData({ now: NOW, keep: KEEP });

    const left = await db.selectAll('plan', { select: 'id', order: 'id.asc' });
    expect(left.map((p) => p.id)).toEqual(['carrying-on', 'watched']);
  });

  it('are kept for good with MOD_KEEP_UNAPPROVED_DAYS=0', async () => {
    await plan('ancient', 400);
    await pruneData({ now: NOW, keep: { ...KEEP, unapprovedDays: 0 } });
    expect(await db.count('plan', {})).toBe(1);
  });
});

describe('quotes and token counts', () => {
  it('keeps quotes by default, and clears old ones when told to', async () => {
    await db.upsert('plan', [{ id: 'p', created_at: day(100) }]);
    await db.upsert('decision', [
      { plan_id: 'p', did: 'did:plc:old', band: 'UNKNOWN', acted_at: day(100), triage: 'hostile', triage_quote: 'old words', triage_at: day(100) },
      { plan_id: 'p', did: 'did:plc:new', band: 'UNKNOWN', triage: 'hostile', triage_quote: 'new words', triage_at: day(2) },
    ]);

    await pruneData({ now: NOW, keep: KEEP });
    expect(await db.count('decision', { not_null: 'triage_quote' })).toBe(2);

    await pruneData({ now: NOW, keep: { ...KEEP, quotesDays: 30 } });
    const rows = await db.selectAll('decision', {
      select: 'did,triage,triage_quote',
      order: 'did.asc',
    });
    expect(rows).toEqual([
      { did: 'did:plc:new', triage: 'hostile', triage_quote: 'new words' },
      { did: 'did:plc:old', triage: 'hostile', triage_quote: null },
    ]);
  });

  it('drops token counts past 90 days, or never with 0', async () => {
    await db.upsert('llm_usage', [
      { at: day(120), kind: 'dm', model: 'm' },
      { at: day(10), kind: 'dm', model: 'm' },
    ]);
    await pruneData({ now: NOW, keep: { ...KEEP, usageDays: 0 } });
    expect(await db.count('llm_usage', {})).toBe(2);
    await pruneData({ now: NOW, keep: KEEP });
    expect(await db.count('llm_usage', {})).toBe(1);
  });
});
