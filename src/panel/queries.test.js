// What the panel reads from the store, against the invented store in
// scripts/panel-fixtures.js. Run on SQLite, and on Postgres as well when
// TEST_DATABASE_URL names a database, since the counts are written once for
// both.

import { describe, it, expect, beforeAll } from 'vitest';

import { storesFor, freshStore } from '../bot/testStores.js';
import { select } from '../bot/db.js';
import { seedDemo, demoDid, demoAccount } from '../../scripts/panel-fixtures.js';
import * as q from './queries.js';

const NOW = Date.parse('2026-11-17T14:40:00Z');

describe('how someone came to be on the list', () => {
  it('sorts approved_via into a few families', () => {
    expect(q.viaFamily('command')).toBe('name');
    expect(q.viaFamily('individual')).toBe('name');
    expect(q.viaFamily('band')).toBe('band');
    expect(q.viaFamily('triage:hostile')).toBe('label');
    expect(q.viaFamily('agent:band')).toBe('agent');
    expect(q.viaFamily('watch:triage:hostile')).toBe('agent');
    expect(q.viaFamily(null)).toBe('none');
  });
});

describe('the words that asked for a change', () => {
  it('are a typed block\'s whole note', () => {
    expect(q.wordsOf({ note: 'block this guy', totals: null })).toEqual(['block this guy']);
  });

  it('are each approval of a scan, without what was scanned', () => {
    const plan = {
      totals: { uri: 'at://x' },
      note: 'bulk everyone from at://x; approved: approve 3f2a1b7c UNKNOWN; approved: approve 3f2a1b7c hostile (cancelled)',
    };
    expect(q.wordsOf(plan)).toEqual(['approve 3f2a1b7c UNKNOWN', 'approve 3f2a1b7c hostile']);
    expect(q.wordsOf({ totals: {}, note: 'bulk likers from at://x' })).toEqual([]);
  });
});

for (const [kind, target] of storesFor('panel_queries_test')) {
  describe(`the panel's reads (${kind})`, () => {
    let seeded;
    let members;

    beforeAll(async () => {
      await freshStore(kind, target);
      q.forgetList();
      seeded = await seedDemo({ now: NOW });
      const open = await select('decision', {
        select: 'did',
        eq: { action: 'list_add' },
        where: { acted_at: 'not.is.null', undone_at: 'is.null' },
      });
      members = { dids: [...new Set(open.map((o) => o.did))], complete: true, at: 1 };
    }, 60_000);

    it('the overview adds up', async () => {
      const o = await q.overview({ now: NOW, members, canWrite: true });
      expect(o.list.total).toBe(members.dids.length);
      expect(o.list.source).toBe('repo');
      expect(o.days).toHaveLength(30);
      expect(o.days.at(-1)).toMatchObject({ day: '2026-11-17', added: 1041, removed: 1 });
      expect(o.week.added).toBe(o.days.slice(-7).reduce((n, d) => n + d.added, 0));
      expect(o.waiting.scans).toBe(3);
      expect(o.scans.map((s) => s.code)).toContain(seeded.codes.pilot);
      expect(o.adding).toHaveLength(1);
      expect(o.adding[0]).toMatchObject({ code: seeded.codes.shift, added: 1000, total: 1840 });
      expect(o.protected).toEqual({ total: 487, follows: 412, lists: 72, manual: 3 });
      expect(o.snapshot).toMatchObject({ scoring: 'full', ageDays: 3 });
      expect(o.watches).toHaveLength(2);
      // In the last hour: 1,000 from the batch and one block, at 3 points
      // each, and one unblock at 1 point, though it is two rows in the log.
      expect(o.budget.hour.used).toBe(1001 * 3 + 1);
      expect(o.changes).toHaveLength(8);
    });

    it('counts the list by where the last re-score put everyone', async () => {
      const o = await q.overview({ now: NOW, members });
      expect(o.list.counts.PROTECTED).toBe(2);
      expect(o.list.counts.CONNECTED).toBe(9);
      expect(o.list.counts.PERIPHERAL).toBe(31);
      const sum = Object.values(o.list.counts).reduce((a, b) => a + b, 0);
      expect(sum).toBe(o.list.total);
    });

    it('falls back to the re-score, then the log, when the repo cannot be read', async () => {
      q.forgetList();
      const o = await q.overview({ now: NOW, members: null });
      expect(o.list.source).toBe('rescore');
      expect(o.list.total).toBeGreaterThan(8000);
      q.forgetList();
    });

    it('sorts scans by what state they are in', async () => {
      const all = await q.scans();
      expect(all.counts).toMatchObject({ waiting: 3, adding: 1, cancelled: 1 });
      const by = Object.fromEntries(all.scans.map((s) => [s.code, s]));
      expect(by[seeded.codes.pilot]).toMatchObject({
        state: 'waiting',
        total: 4212,
        kind: 'everyone',
        byBand: { PROTECTED: 14, CONNECTED: 31, PERIPHERAL: 76, NOTABLE: 22, UNKNOWN: 4069 },
        labels: { hostile: 118, arguing: 301, neutral: 276 },
        withText: 695,
      });
      expect(by[seeded.codes.nightbus]).toMatchObject({ state: 'added', added: 640, live: 628 });
      expect(by[seeded.codes.ratio].state).toBe('cancelled');
      expect((await q.scans({ state: 'waiting' })).scans).toHaveLength(3);
    });

    it('opens a scan with every account in it', async () => {
      const s = await q.scan(seeded.codes.pilot, { canWrite: true });
      expect(s.rows).toHaveLength(4212);
      const hostile = s.rows.filter((r) => r.label === 'hostile');
      expect(hostile).toHaveLength(118);
      expect(hostile.every((r) => r.quote && r.hasText)).toBe(true);
      expect(s.rows.filter((r) => r.protected)).toHaveLength(14);
      expect(s.rows.find((r) => r.did === demoDid(600))).toMatchObject({ band: 'CONNECTED', kinds: ['quote'] });
      expect(await q.scan('00000000')).toBe(null);
      expect(await q.scan('not-a-code')).toBe(null);
    });

    it('marks someone protected since the scan, whatever band the scan gave', async () => {
      const s = await q.scan(seeded.codes.thread);
      // The fixtures protect accounts 1 to 487; none of them is in this scan.
      expect(s.rows.some((r) => r.protected)).toBe(false);
    });

    it('keeps the words that asked for a change from a read-only account', async () => {
      const mine = await q.scan(seeded.codes.shift, { canWrite: true });
      expect(mine.words).toEqual([`approve ${seeded.codes.shift} UNKNOWN`]);
      const theirs = await q.scan(seeded.codes.shift, { canWrite: false });
      expect(theirs.words).toEqual([]);
      const log = await q.activity({ limit: 10, canWrite: false });
      expect(log.events.every((e) => e.words.length === 0)).toBe(true);
    });

    it('reads the log as events: one line for a batch', async () => {
      const log = await q.activity({ limit: 60, canWrite: true });
      const batch = log.events.find((e) => e.code === seeded.codes.shift);
      expect(batch).toMatchObject({ kind: 'added', n: 1000, via: 'band', band: 'UNKNOWN', scan: true, did: null });
      const newest = log.events[0];
      expect(newest).toMatchObject({ kind: 'added', n: 1, via: 'command', words: ['block'] });
      expect(newest.did).toMatch(/^did:plc:demo/);
      const times = log.events.map((e) => e.at);
      expect([...times].sort().reverse()).toEqual(times);
    });

    it('shows an undo once, and an unblock once', async () => {
      const undone = await q.activity({ filter: 'undone', limit: 50, canWrite: true });
      const took = undone.events.find((e) => e.code === seeded.codes.nightbus);
      expect(took).toMatchObject({ kind: 'undone', n: 12, words: [`undo ${seeded.codes.nightbus}`] });
      // The unblock closed the add that put them there. That is the removal,
      // not a second event.
      const removed = await q.activity({ filter: 'removed', limit: 50, canWrite: true });
      expect(removed.events).toHaveLength(1);
      expect(removed.events[0].did).toBe(demoDid(59990));
      expect(undone.events.some((e) => e.did === demoDid(59990))).toBe(false);
    });

    it('pages the log', async () => {
      const first = await q.activity({ limit: 5 });
      const second = await q.activity({ limit: 5, offset: 5 });
      expect(first.more).toBe(true);
      expect(first.events).toHaveLength(5);
      expect(second.events[0].at <= first.events[4].at).toBe(true);
      expect(second.events.map((e) => e.code)).not.toEqual(first.events.map((e) => e.code));
    });

    it('finds someone on the list by part of a handle, or by DID', async () => {
      const handle = demoAccount(50100).handle;
      const byHandle = await q.listPage({ members, q: handle.slice(0, 12) });
      expect(byHandle.rows.some((r) => r.did === demoDid(50100))).toBe(true);
      const byDid = await q.listPage({ members, q: demoDid(50100) });
      expect(byDid.matched).toBe(1);
      expect(byDid.rows[0]).toMatchObject({ band: 'CONNECTED', bandThen: 'UNKNOWN', family: 'band', rescored: true });
      expect((await q.listPage({ members, q: 'nobody-by-this-name' })).matched).toBe(0);
    });

    it('narrows the list to a band, closest first', async () => {
      const page = await q.listPage({ members, limit: 20 });
      expect(page.rows[0].band).toBe('PROTECTED');
      const connected = await q.listPage({ members, band: 'CONNECTED' });
      expect(connected.matched).toBe(9);
      expect(connected.rows.every((r) => r.band === 'CONNECTED')).toBe(true);
    });

    it('draws the list: a mark for everyone near, a count for the strangers', async () => {
      const radar = await q.listRadar({ members });
      expect(radar.near).toHaveLength(radar.total - radar.counts.UNKNOWN - radar.counts.UNSCORED);
      expect(radar.near.every((p) => p.band !== 'UNKNOWN')).toBe(true);
      const far = Object.values(radar.far).reduce((a, b) => a + b, 0);
      expect(far).toBe(radar.counts.UNKNOWN + radar.counts.UNSCORED);
      expect(radar.far.band).toBeGreaterThan(6000);
    });

    it('queues everyone on the list who is not a stranger, minus the kept', async () => {
      const queue = await q.queue({ members });
      // 2 protected, 9 connected, 31 peripheral and 30 notable, with one
      // peripheral and one notable kept.
      expect(queue.counts).toEqual({ PROTECTED: 2, CONNECTED: 9, PERIPHERAL: 30, NOTABLE: 29 });
      expect(queue.total).toBe(70);
      expect(queue.rows[0].band).toBe('PROTECTED');
      expect(queue.rows.some((r) => r.did === demoDid(50201))).toBe(false);
      expect((await q.queue({ members, band: 'CONNECTED' })).matched).toBe(9);
    });

    it('keeps an account out of the queue until it moves closer', async () => {
      const did = demoDid(50205);
      await q.keep(did, { band: 'PERIPHERAL', by: seeded.owner });
      expect((await q.queue({ members, limit: 100 })).rows.some((r) => r.did === did)).toBe(false);
      await q.reopen(did);
      expect((await q.queue({ members, limit: 100 })).rows.some((r) => r.did === did)).toBe(true);
      // Kept as notable, connected now: closer than when it was kept.
      const moved = demoDid(50100);
      await q.keep(moved, { band: 'NOTABLE', by: seeded.owner });
      expect((await q.queue({ members, limit: 100 })).rows.some((r) => r.did === moved)).toBe(true);
      await q.reopen(moved);
    });

    it('tells an account\'s whole story from the log', async () => {
      const h = await q.accountHistory(demoDid(59990), { canWrite: true });
      expect(h.entries.map((e) => e.action)).toEqual(['list_remove', 'list_add']);
      expect(h.entries[1].undoneAt).toBeTruthy();
      expect(h.entries[1].words).toEqual(['block']);
      const quoted = await q.accountHistory(demoDid(600), { canWrite: false });
      expect(quoted.entries[0]).toMatchObject({ scan: true, label: 'hostile', action: null, words: [] });
      expect((await q.accountHistory(demoDid(5))).protectedReason).toBe('you follow them');
    });

    it('lists watches, live ones apart', async () => {
      const w = await q.watches({ now: NOW });
      expect(w.live).toHaveLength(2);
      expect(w.ended).toHaveLength(1);
      expect(w.live.find((x) => x.mode === 'auto').code).toBe(seeded.codes.bikes);
    });

    it('pages the protected accounts and says where the protection came from', async () => {
      const p = await q.protectedPage({ limit: 20 });
      expect(p.counts.total).toBe(487);
      expect(p.rows).toHaveLength(20);
      expect(p.more).toBe(true);
      const found = await q.protectedPage({ q: demoDid(486) });
      expect(found.rows).toEqual([expect.objectContaining({ did: demoDid(486), source: 'manual' })]);
    });

    it('describes the follow graph and the re-scores', async () => {
      const g = await q.graph({ now: NOW });
      expect(g.snapshot).toMatchObject({ scoring: 'full', ageDays: 3 });
      expect(g.snapshot.vouches).toBeGreaterThan(1000);
      expect(g.newest).toMatchObject({ circle: 412, pending: 0, building: false });
      expect(g.audits).toHaveLength(2);
      expect(g.audits[0].bands.CONNECTED).toBe(9);
      expect(g.audits[1].bands.CONNECTED).toBeLessThan(9);
    });

    it('adds up tokens by day, kind and model', async () => {
      const u = await q.usage({ days: 30, now: NOW });
      expect(u.days).toHaveLength(30);
      expect(u.byKind.map((k) => k.name)).toEqual(expect.arrayContaining(['triage', 'agent', 'check', 'read']));
      expect(u.byModel).toHaveLength(2);
      const perDay = u.days.reduce((n, d) => n + d.input + d.output, 0);
      expect(perDay).toBe(u.total.input + u.total.output);
      expect(u.byKind.reduce((n, k) => n + k.input, 0)).toBe(u.total.input);
    });
  });
}
