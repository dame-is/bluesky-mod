// The page's pure parts: the commands it writes, where the radar puts each
// mark, and how numbers and dates are worded. The commands are checked
// against the bot's own parser, because a command the page writes is only
// as right as what the bot reads it to mean.

import { describe, it, expect } from 'vitest';

import { parseCommand } from '../lib/command.js';
import { estimateWrites } from '../bot/bulkPlan.js';
import {
  addable,
  approveByName,
  approveCommand,
  blockCommand,
  cancelCommand,
  NAMED_PER_COMMAND,
  onList,
  primaryKind,
  selected,
  triageCommand,
  undoCommand,
  unblockCommand,
} from './public/lib/commands.js';
import {
  EDGES,
  RINGS,
  nearest,
  place,
  ringAt,
  ringOf,
  sectorAngles,
  sectorAt,
  spots,
  texture,
  walkOrder,
} from './public/lib/radar-layout.js';
import {
  ago,
  bandName,
  bytes,
  compact,
  dayMonth,
  duration,
  plural,
  postAuthor,
  postLink,
  shortDid,
  until,
  viaWords,
  writeCost,
} from './public/lib/format.js';
import { checkCommand } from './commands.js';

const CODE = '3f2a1b7c';
const owner = { canWrite: true };

const row = (did, band, extra = {}) => ({
  did,
  band,
  kinds: ['like'],
  label: null,
  protected: band === 'PROTECTED',
  added: false,
  undone: false,
  listed: false,
  ...extra,
});

const ROWS = [
  row('did:plc:p1', 'PROTECTED', { kinds: ['quote'], label: 'hostile' }),
  row('did:plc:c1', 'CONNECTED', { kinds: ['quote'], label: 'hostile' }),
  row('did:plc:c2', 'CONNECTED', { kinds: ['like'] }),
  row('did:plc:n1', 'NOTABLE', { kinds: ['reply'], label: 'arguing' }),
  row('did:plc:u1', 'UNKNOWN', { kinds: ['quote', 'like'], label: 'hostile' }),
  row('did:plc:u2', 'UNKNOWN', { kinds: ['threadReply'], label: 'neutral' }),
  row('did:plc:u3', 'UNKNOWN', { kinds: ['like'] }),
  row('did:plc:u4', 'UNKNOWN', { kinds: ['repost'], added: true }),
  row('did:plc:u5', 'UNKNOWN', { kinds: ['like'], listed: true }),
  row('did:plc:u6', 'UNKNOWN', { kinds: ['like'], undone: true }),
  // Followed since the scan: an UNKNOWN the veto now covers.
  row('did:plc:u7', 'UNKNOWN', { kinds: ['like'], protected: true }),
];
const dids = (rows) => rows.map((r) => r.did);

describe('the command for a selection', () => {
  it('is nothing until a ring is ticked', () => {
    expect(approveCommand(CODE, { bands: [] })).toBe(null);
    expect(approveCommand(CODE, { bands: [], hostileOnly: true })).toBe(null);
    expect(approveCommand(CODE, { bands: ['PROTECTED'] })).toBe(null);
  });

  it('names the bands in the bot\'s order, and never PROTECTED', () => {
    expect(approveCommand(CODE, { bands: ['UNKNOWN', 'CONNECTED', 'PROTECTED'] })).toBe(`approve ${CODE} CONNECTED,UNKNOWN`);
  });

  it('narrows to sectors, or to the hostile ones, never both', () => {
    expect(approveCommand(CODE, { bands: ['UNKNOWN'], sectors: ['like', 'repost'] })).toBe(`approve ${CODE} UNKNOWN reposters likers`);
    expect(approveCommand(CODE, { bands: ['UNKNOWN', 'NOTABLE'], hostileOnly: true, sectors: ['like'] })).toBe(`approve ${CODE} hostile NOTABLE,UNKNOWN`);
    // An engagement from outside Bluesky's lexicons has no word.
    expect(approveCommand(CODE, { bands: ['UNKNOWN'], sectors: ['other'] })).toBe(`approve ${CODE} UNKNOWN`);
  });

  it('means to the bot what it meant to the page', () => {
    const cases = [
      [{ bands: ['UNKNOWN'] }, { bands: ['UNKNOWN'], kinds: [], labels: [] }],
      [{ bands: ['UNKNOWN', 'NOTABLE', 'PERIPHERAL'] }, { bands: ['PERIPHERAL', 'NOTABLE', 'UNKNOWN'], kinds: [], labels: [] }],
      [{ bands: ['UNKNOWN'], sectors: ['quote', 'reply'] }, { bands: ['UNKNOWN'], kinds: ['quoters', 'repliers'], labels: [] }],
      [{ bands: ['CONNECTED', 'UNKNOWN'], hostileOnly: true }, { bands: ['CONNECTED', 'UNKNOWN'], kinds: [], labels: ['hostile'] }],
    ];
    for (const [sel, want] of cases) {
      const cmd = parseCommand(approveCommand(CODE, sel));
      expect(cmd).toMatchObject({ action: 'approve', code: CODE, needsTarget: false, refusal: null, actors: [], ...want });
      expect(checkCommand(cmd.raw, owner).ok).toBe(true);
    }
  });

  it('adds named accounts as the personal path, a few per command', () => {
    const many = Array.from({ length: 60 }, (_, i) => `did:plc:x${i}`);
    const commands = approveByName(CODE, [...many, many[0]]);
    expect(commands).toHaveLength(Math.ceil(60 / NAMED_PER_COMMAND));
    const parsed = commands.map((c) => parseCommand(c));
    expect(parsed.every((c) => c.action === 'approve' && !c.refusal && !c.bands.length && !c.labels.length)).toBe(true);
    expect(parsed.flatMap((c) => c.actors)).toEqual(many);
  });

  it('bounds an approval of the hostile ones by when the page counted them', () => {
    const asOf = '2026-11-17T14:20:00.000Z';
    const text = approveCommand(CODE, { bands: ['UNKNOWN', 'NOTABLE'], hostileOnly: true }, { asOf });
    expect(text).toBe(`approve ${CODE} hostile NOTABLE,UNKNOWN asof=${asOf}`);
    expect(parseCommand(text)).toMatchObject({ action: 'approve', labels: ['hostile'], bands: ['NOTABLE', 'UNKNOWN'], asOf, needsTarget: false });
    // A ring has no label time to be bounded by, and the parser refuses one.
    expect(approveCommand(CODE, { bands: ['UNKNOWN'] }, { asOf })).toBe(`approve ${CODE} UNKNOWN`);
  });

  it('names the list a write goes to the way the bot\'s own menus do', () => {
    expect(onList('block did:plc:abc', null)).toBe('block did:plc:abc');
    const before = process.env.MOD_MULTI_LIST;
    process.env.MOD_MULTI_LIST = 'true';
    try {
      expect(parseCommand(onList(blockCommand('did:plc:abc'), '3kspam'))).toMatchObject({ action: 'list_add', actor: 'did:plc:abc', list: '3kspam', needsTarget: false });
      expect(parseCommand(onList(unblockCommand('did:plc:abc'), '3kspam'))).toMatchObject({ action: 'list_remove', actor: 'did:plc:abc', list: '3kspam' });
      expect(parseCommand(onList(approveCommand(CODE, { bands: ['UNKNOWN'], sectors: ['like'] }), '3kspam'))).toMatchObject({ action: 'approve', code: CODE, bands: ['UNKNOWN'], list: '3kspam' });
      expect(parseCommand(onList(approveCommand(CODE, { bands: ['UNKNOWN'], hostileOnly: true }, { asOf: '2026-11-17T14:20:00.000Z' }), '3kspam'))).toMatchObject({ labels: ['hostile'], asOf: '2026-11-17T14:20:00.000Z', list: '3kspam' });
      for (const text of approveByName(CODE, ['did:plc:abc', 'did:plc:def']).map((c) => onList(c, '3kspam'))) {
        expect(parseCommand(text)).toMatchObject({ action: 'approve', actors: ['did:plc:abc', 'did:plc:def'], list: '3kspam' });
      }
    } finally {
      if (before === undefined) delete process.env.MOD_MULTI_LIST;
      else process.env.MOD_MULTI_LIST = before;
    }
  });

  it('writes the other commands the way the bot reads them', () => {
    expect(parseCommand(blockCommand('did:plc:abc'))).toMatchObject({ action: 'list_add', actor: 'did:plc:abc', needsTarget: false });
    expect(parseCommand(unblockCommand('did:plc:abc'))).toMatchObject({ action: 'list_remove', actor: 'did:plc:abc' });
    expect(parseCommand(undoCommand(CODE))).toMatchObject({ action: 'undo', code: CODE, last: false });
    expect(parseCommand(cancelCommand(CODE))).toMatchObject({ action: 'cancel', code: CODE });
    expect(parseCommand(triageCommand(CODE))).toMatchObject({ action: 'triage', code: CODE });
  });
});

describe('who a selection would add', () => {
  it('is nobody until a ring is ticked', () => {
    expect(selected(ROWS, { bands: [] })).toEqual([]);
  });

  it('leaves out the protected, the added, the listed and the taken back', () => {
    expect(dids(selected(ROWS, { bands: ['UNKNOWN'] }))).toEqual(['did:plc:u1', 'did:plc:u2', 'did:plc:u3']);
    expect(selected(ROWS, { bands: ['PROTECTED'] })).toEqual([]);
    expect(ROWS.filter(addable)).toHaveLength(6);
  });

  it('narrows by what they did, the way the bot does: any of it counts', () => {
    // u1 quoted and liked, so "likers" takes them too.
    expect(dids(selected(ROWS, { bands: ['UNKNOWN'], sectors: ['like'] }))).toEqual(['did:plc:u1', 'did:plc:u3']);
    expect(dids(selected(ROWS, { bands: ['UNKNOWN'], sectors: ['reply'] }))).toEqual(['did:plc:u2']);
  });

  it('narrows to the ones read as hostile, whatever sectors are ticked', () => {
    expect(dids(selected(ROWS, { bands: ['CONNECTED', 'UNKNOWN'], hostileOnly: true, sectors: ['like'] }))).toEqual(['did:plc:c1', 'did:plc:u1']);
  });
});

describe('the sector an account is drawn in', () => {
  it('is the loudest thing it did', () => {
    expect(primaryKind(['like', 'quote'])).toBe('quote');
    expect(primaryKind(['like', 'threadReply'])).toBe('reply');
    expect(primaryKind(['repost', 'like'])).toBe('repost');
    expect(primaryKind(['like'])).toBe('like');
    expect(primaryKind(['com.example.bookmark'])).toBe('other');
    expect(primaryKind([])).toBe('other');
  });
});

describe('where the radar puts a mark', () => {
  const points = [
    { id: 'did:plc:a', band: 'PROTECTED', sector: 0 },
    { id: 'did:plc:b', band: 'CONNECTED', sector: 1 },
    { id: 'did:plc:c', band: 'PERIPHERAL', sector: 2 },
    { id: 'did:plc:d', band: 'NOTABLE', sector: 3 },
    { id: 'did:plc:e', band: 'UNKNOWN', sector: 0 },
  ];

  it('is the same every time, and differs between accounts', () => {
    expect(place(points, 4)).toEqual(place(points, 4));
    expect(spots('did:plc:a')).not.toEqual(spots('did:plc:b'));
    const [u, v] = spots('did:plc:a');
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it('keeps each band in its ring and each account in its slice', () => {
    const many = [];
    for (let i = 0; i < 400; i += 1) {
      many.push({ id: `did:plc:m${i}`, band: ['PROTECTED', 'CONNECTED', 'PERIPHERAL', 'NOTABLE'][i % 4], sector: i % 5 });
    }
    for (const p of place(many, 5)) {
      const [lo, hi] = RINGS[p.ring];
      expect(p.r).toBeGreaterThanOrEqual(lo);
      expect(p.r).toBeLessThanOrEqual(hi);
      expect(ringAt(p.r)).toBe(p.ring);
      expect(sectorAt(p.angle, 5)).toBe(p.sector);
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(p.r, 10);
    }
  });

  it('draws notable accounts out with the strangers', () => {
    expect(ringOf('NOTABLE')).toBe('OUTER');
    expect(ringOf('UNKNOWN')).toBe('OUTER');
    expect(ringOf('CONNECTED')).toBe('CONNECTED');
  });

  it('knows which ring a click landed in', () => {
    expect(ringAt(0.1)).toBe('PROTECTED');
    expect(ringAt(EDGES.PROTECTED + 0.01)).toBe('CONNECTED');
    expect(ringAt(0.45)).toBe('PERIPHERAL');
    expect(ringAt(0.9)).toBe('OUTER');
    expect(ringAt(1.01)).toBe(null);
  });

  it('cuts the circle into slices clockwise from the top', () => {
    const four = sectorAngles(4);
    expect(four[0].start).toBeCloseTo(-Math.PI / 2);
    expect(four[0].mid).toBeCloseTo(-Math.PI / 4);
    // Up and to the right is the first slice; up and to the left the last.
    expect(sectorAt(Math.atan2(-1, 1), 4)).toBe(0);
    expect(sectorAt(Math.atan2(1, 1), 4)).toBe(1);
    expect(sectorAt(Math.atan2(1, -1), 4)).toBe(2);
    expect(sectorAt(Math.atan2(-1, -1), 4)).toBe(3);
  });

  it('shares the strangers\' texture out by how many each slice holds', () => {
    const dust = texture([3000, 300, 30, 0], { max: 600 });
    const by = [0, 1, 2, 3].map((s) => dust.filter((d) => d.sector === s).length);
    expect(by[0]).toBeGreaterThan(by[1]);
    expect(by[1]).toBeGreaterThan(by[2]);
    // Something that is there is never drawn as nothing.
    expect(by[2]).toBeGreaterThanOrEqual(1);
    expect(by[3]).toBe(0);
    expect(dust.length).toBeLessThanOrEqual(620);
    expect(dust.every((d) => ringAt(d.r) === 'OUTER')).toBe(true);
    expect(texture([0, 0])).toEqual([]);
  });

  it('finds the mark under the pointer, or nothing', () => {
    const placed = place(points, 4);
    const target = placed[1];
    expect(nearest(placed, target.x + 0.01, target.y, 0.03)).toBe(target);
    expect(nearest(placed, 0.999, 0.999, 0.02)).toBe(null);
  });

  it('walks the accounts from the centre out', () => {
    const order = walkOrder(place(points, 4)).map((p) => p.ring);
    expect(order).toEqual(['PROTECTED', 'CONNECTED', 'PERIPHERAL', 'OUTER', 'OUTER']);
  });
});

describe('how the panel words things', () => {
  it('quotes a cost the way the bot does', () => {
    for (const n of [1, 98, 118, 500, 4069, 8000]) {
      const cost = writeCost(n);
      expect(`${n.toLocaleString()} writes, ${cost.points.toLocaleString()} points, ${cost.time}`).toBe(estimateWrites(n));
    }
    expect(writeCost(12, { kind: 'delete' }).points).toBe(12);
  });

  it('names bands as words, not as the store\'s capitals', () => {
    expect(bandName('CONNECTED')).toBe('Connected');
    expect(bandName('UNSCORED')).toBe('Not scored');
    expect(bandName(null)).toBe('Not scored');
  });

  it('counts with the right noun', () => {
    expect(plural(1, 'account')).toBe('1 account');
    expect(plural(4069, 'person', 'people')).toBe('4,069 people');
    expect(compact(950)).toBe('950');
    expect(compact(1100)).toBe('1.1K');
    expect(compact(48_000)).toBe('48K');
    expect(compact(2_400_000)).toBe('2.4M');
    expect(bytes(288 * 1048576)).toBe('288 MB');
    expect(bytes(1536 * 1048576)).toBe('1.5 GB');
  });

  it('says how long ago, and how long until', () => {
    const now = Date.parse('2026-11-17T14:40:00Z');
    const at = (ms) => new Date(now - ms).toISOString();
    expect(ago(at(20_000), now)).toBe('just now');
    expect(ago(at(12 * 60_000), now)).toBe('12 minutes ago');
    expect(ago(at(3 * 3600_000), now)).toBe('3 hours ago');
    expect(ago(at(26 * 3600_000), now)).toBe('yesterday');
    expect(ago(at(3 * 86400_000), now)).toBe('3 days ago');
    expect(ago(at(70 * 86400_000), now)).toMatch(/Sept?/);
    expect(until(at(-12 * 60_000), now)).toBe('in 12 minutes');
    expect(until(at(-20 * 3600_000), now)).toBe('in 20 hours');
    expect(until(at(5000), now)).toBe('now');
    expect(duration(0.4)).toBe('under a minute');
    expect(duration(146)).toBe('about 2.4 hours');
    // A bare day is one of the log's UTC days, wherever the reader is.
    expect(dayMonth('2026-11-17', now)).toBe('17 Nov');
  });

  it('turns a post\'s URI into a link and an author', () => {
    const uri = 'at://did:plc:abc/app.bsky.feed.post/3kxyz';
    expect(postLink(uri)).toBe('https://bsky.app/profile/did:plc:abc/post/3kxyz');
    expect(postAuthor(uri)).toBe('did:plc:abc');
    expect(postLink('at://did:plc:abc/app.bsky.graph.list/3k')).toBe(null);
    expect(postLink('javascript:alert(1)')).toBe(null);
    expect(shortDid('did:plc:abcdefghijklmnopqrstuvwx')).toBe('did:plc:abcdef…uvwx');
  });

  it('says how an account came to be on the list', () => {
    expect(viaWords('command')).toBe('Typed by name');
    expect(viaWords('band')).toBe('Approved by band');
    expect(viaWords('triage:hostile')).toBe('Approved as hostile');
    expect(viaWords('agent:individual')).toBe('The agent, approved by name');
    expect(viaWords('watch:triage:hostile')).toBe('A watch, approved as hostile');
    expect(viaWords(null)).toBe('No record');
  });
});
