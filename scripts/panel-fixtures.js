// Invented data for the panel: enough of a bot's store to open every page.
//
// Every account here is made up. Handles sit under example.social, which
// nobody can register, and DIDs start did:plc:demo. The same seed gives the
// same store every time, so a screenshot can be compared with the last one
// and a test can count on what it finds.
//
// Used by scripts/panel-demo.js (npm run panel:demo) and by the panel's
// tests. Nothing here reaches the network.

import crypto from 'node:crypto';

import { upsert, selectAll } from '../src/bot/db.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const FIRST = ['ash', 'bea', 'cass', 'dev', 'eli', 'fen', 'gray', 'hal', 'ivy', 'jun', 'kit', 'lou', 'mo', 'nia', 'oz', 'pip', 'quinn', 'rae', 'sol', 'tam', 'uma', 'vic', 'wren', 'xan', 'yael', 'zed'];
const LAST = ['marsh', 'vale', 'okafor', 'lindqvist', 'moreau', 'tanaka', 'reyes', 'hart', 'novak', 'quill', 'abara', 'sato', 'brennan', 'iyer', 'kowal'];
const BIOS = [
  'posting about transit maps and bad coffee',
  'they/them. tabletop games. mostly lurking',
  'software person. opinions are cached, not stored',
  'birds, bikes, the occasional thread about zoning',
  'tech worker, part-time contrarian',
  'i make zines and argue about fonts',
  '',
  'news junkie. reposts are not endorsements',
  'game dev. cats. do not @ me before coffee',
  '',
];
const QUOTES = {
  hostile: [
    'imagine being this wrong in public. pathetic little bureaucrat',
    'you are a clown and so is everyone who agrees with you. log off',
    'everyone go tell this idiot exactly what you think of them',
    'people like you are why this city is rotting',
    'resign. nobody wants you here and nobody ever did',
  ],
  arguing: [
    'This policy is cowardly and indefensible, and the people who wrote it know that.',
    'If this is the standard, the standard is broken. Fix the rule, not the replies.',
    'You can have sympathy or you can have this policy. You cannot have both.',
    'Read the thread again. Nobody here is asking for special treatment.',
  ],
  neutral: [
    'wait, is this the same pilot from last spring or a new one?',
    'saving this thread for later',
    'lol the replies on this one',
    'does this apply to the night bus too?',
  ],
};

/** The DID of invented account number `i`. */
export const demoDid = (i) => `did:plc:demo${String(i).padStart(6, '0')}`;
const indexOf = (did) => Number(String(did).slice('did:plc:demo'.length));

/** What the AppView would say about invented account `i`. */
export function demoAccount(i) {
  const r = prng(i * 7919 + 13);
  const first = FIRST[Math.floor(r() * FIRST.length)];
  const last = LAST[Math.floor(r() * LAST.length)];
  const big = i >= 800 && i < 900;
  return {
    did: demoDid(i),
    handle: `${first}${last}${i}.example.social`,
    // One in nine has no display name, as on the real network.
    displayName: i % 9 === 4 ? null : `${first[0].toUpperCase()}${first.slice(1)} ${last[0].toUpperCase()}${last.slice(1)}`,
    description: BIOS[i % BIOS.length] || null,
    followers: big ? Math.floor(12_000 + r() * 80_000) : Math.floor(20 + r() * 2400),
    follows: Math.floor(30 + r() * 900),
    posts: Math.floor(40 + r() * 9000),
    createdAt: new Date(Date.UTC(2023, 3, 1) + Math.floor(r() * 900) * DAY).toISOString(),
  };
}

/** Is this one of the invented DIDs, and which? */
export function demoIndex(actor) {
  const a = String(actor || '').replace(/^@/, '');
  if (a.startsWith('did:plc:demo')) return indexOf(a);
  const m = /(\d+)\.example\.social$/.exec(a);
  return m ? Number(m[1]) : null;
}

/**
 * The demo bot's lists, the main one first, as src/bot/lists.js numbers
 * them. Only the first exists unless the demo is run with several lists.
 */
export const demoLists = (bot) =>
  [
    ['3mdemolist', 'Block List'],
    ['3mdemospam', 'Spam'],
    ['3mdemotroll', 'Trolls'],
  ].map(([rkey, name], i) => ({ uri: `at://${bot}/app.bsky.graph.list/${rkey}`, rkey, name, n: i + 1 }));

const uuid = (r) => {
  const hex = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const range = (from, n) => Array.from({ length: n }, (_, k) => from + k);

/**
 * Fill the open store. `now` is the moment the data is "as of", so the
 * newest change is minutes old whenever this runs. `lists` adds what a bot
 * with several lists would also hold: blocks on a second list and a scan
 * approved to a third.
 *
 * @returns {Promise<{ owner: string, bot: string, codes: Record<string, string> }>}
 */
export async function seedDemo({ now = Date.now(), owner = 'did:plc:owner0000000000000000000', lists = false } = {}) {
  const r = prng(20261117);
  const iso = (ms) => new Date(ms).toISOString();
  const bot = 'did:plc:demobot00000000000000000';
  const postBy = (who, rkey) => `at://${who}/app.bsky.feed.post/${rkey}`;
  const codes = {};
  let seq = 0;

  const put = async (table, rows) => {
    for (let i = 0; i < rows.length; i += 2000) await upsert(table, rows.slice(i, i + 2000));
  };

  // --- who the owner follows, and who that protects -----------------------------
  const takenAt = iso(now - 3 * DAY - 5 * HOUR);
  const follows = range(1, 412);
  const curated = range(413, 72);
  await put('circle', follows.map((i) => ({ taken_at: takenAt, did: demoDid(i), follows_indexed_at: takenAt, scoring: 'full' })));
  await put('protected', [
    ...follows.map((i) => ({ did: demoDid(i), reason: 'you follow them', source: 'derived', added_at: iso(now - (30 + (i % 300)) * DAY) })),
    ...curated.map((i) => ({ did: demoDid(i), reason: 'on your list "Transit people"', source: 'derived', added_at: iso(now - (10 + (i % 90)) * DAY) })),
    ...range(485, 3).map((i) => ({ did: demoDid(i), reason: 'added by hand', source: 'manual', added_at: iso(now - 40 * DAY) })),
  ]);
  const vouch = new Map();
  for (const i of range(600, 60)) vouch.set(i, 3 + Math.floor(r() * 9));
  for (const i of range(700, 100)) vouch.set(i, 1 + Math.floor(r() * 2));
  for (const i of range(2000, 1800)) vouch.set(i, 1);
  await put('vouch', [...vouch].map(([i, vouches]) => ({ taken_at: takenAt, did: demoDid(i), vouches })));

  // --- scans ---------------------------------------------------------------------
  const KIND = { quote: ['quote'], reply: ['reply'], repost: ['repost'], like: ['like'] };
  const pick = (arr) => arr[Math.floor(r() * arr.length)];

  /** Rows for one band of a scan: who, how they engaged, and what they wrote. */
  const band = (name, from, counts, labels = null) => {
    const rows = [];
    let i = from;
    for (const [kind, n] of Object.entries(counts)) {
      const wrote = kind === 'quote' || kind === 'reply';
      // Labels are dealt to the writers in order: hostile first.
      const deal = labels && wrote ? { ...labels[kind] } : null;
      for (let k = 0; k < n; k += 1, i += 1) {
        let label = null;
        if (deal) {
          label = deal.hostile > 0 ? 'hostile' : deal.arguing > 0 ? 'arguing' : deal.neutral > 0 ? 'neutral' : null;
          if (label) deal[label] -= 1;
        }
        const v = vouch.get(i) ?? (name === 'CONNECTED' ? 3 : name === 'PERIPHERAL' ? 1 : 0);
        rows.push({
          did: demoDid(i),
          band: name,
          trust: name === 'PROTECTED' ? 100 : name === 'CONNECTED' ? 60 + (v % 30) : name === 'PERIPHERAL' ? 35 + v * 5 : name === 'NOTABLE' ? 30 : 5 + (i % 12),
          distance: name === 'PROTECTED' ? 1 : v ? 2 : 3,
          vouches: v,
          engaged: KIND[kind],
          evidence_uri: wrote ? postBy(demoDid(i), `3demo${i}`) : null,
          triage: label,
          triage_quote: label ? pick(QUOTES[label]) : null,
          triage_at: label ? iso(now - 3 * HOUR + 11 * 60_000) : null,
          triage_model: label ? 'deepseek/deepseek-v4.1-flash' : null,
          already_listed: false,
          blocks_me: name === 'UNKNOWN' && i % 97 === 0,
        });
      }
    }
    return rows;
  };

  const scan = async (key, { uri, kind, at, rows, note = '' }) => {
    const id = uuid(r);
    codes[key] = id.slice(0, 8);
    const byBand = { PROTECTED: 0, CONNECTED: 0, PERIPHERAL: 0, NOTABLE: 0, UNKNOWN: 0 };
    const engagements = {};
    for (const row of rows) {
      byBand[row.band] += 1;
      for (const k of row.engaged) engagements[k] = (engagements[k] || 0) + 1;
    }
    await put('plan', [{
      id,
      created_at: iso(at),
      approved_at: null,
      approved_bands: null,
      totals: { uri, kind, participants: rows.length, selected: rows.length, byBand, engagements, alreadyListed: 0, blocksYou: rows.filter((x) => x.blocks_me).length, snapshot: takenAt, truncated: false, unread: [] },
      note: `bulk ${kind} from ${uri}${note}`,
    }]);
    await put('decision', rows.map((row) => ({ plan_id: id, ...row })));
    return id;
  };

  /** Stamp some of a plan's rows as added, the way an approval does. */
  const add = async (planId, rows, at, via, { undoneAt = null, undoReason = null } = {}) => {
    await put('decision', rows.map((row, k) => ({
      plan_id: planId,
      did: row.did,
      band: row.band,
      action: 'list_add',
      acted_at: iso(at + k * 40),
      acted_seq: (seq += 1),
      approved_via: via,
      undone_at: undoneAt ? iso(undoneAt) : null,
      undo_reason: undoReason,
    })));
  };

  const ownPost = postBy(owner, '3mfarecap2026');

  // The post that took off this morning: scanned, sorted, waiting.
  await scan('pilot', {
    uri: ownPost,
    kind: 'everyone',
    at: now - 3 * HOUR,
    rows: [
      ...band('PROTECTED', 1, { quote: 2, reply: 3, repost: 2, like: 7 }, { quote: { arguing: 1, neutral: 1 }, reply: { arguing: 1, neutral: 2 } }),
      ...band('CONNECTED', 600, { quote: 6, reply: 8, repost: 4, like: 13 }, { quote: { hostile: 4, arguing: 2 }, reply: { hostile: 2, arguing: 3, neutral: 3 } }),
      ...band('PERIPHERAL', 700, { quote: 12, reply: 17, repost: 9, like: 38 }, { quote: { hostile: 6, arguing: 4, neutral: 2 }, reply: { hostile: 5, arguing: 6, neutral: 6 } }),
      ...band('NOTABLE', 800, { quote: 5, reply: 4, repost: 3, like: 10 }, { quote: { hostile: 2, arguing: 2, neutral: 1 }, reply: { hostile: 1, arguing: 2, neutral: 1 } }),
      ...band('UNKNOWN', 20000, { quote: 282, reply: 356, repost: 394, like: 3037 }, { quote: { hostile: 52, arguing: 130, neutral: 100 }, reply: { hostile: 46, arguing: 150, neutral: 160 } }),
    ],
  });

  // Someone else's post, scanned yesterday and not read yet.
  await scan('hottake', {
    uri: postBy(demoDid(823), '3mhottake'),
    kind: 'quoters',
    at: now - 26 * HOUR,
    rows: [
      ...band('CONNECTED', 640, { quote: 4 }),
      ...band('PERIPHERAL', 780, { quote: 9 }),
      ...band('NOTABLE', 830, { quote: 2 }),
      ...band('UNKNOWN', 25000, { quote: 296 }),
    ],
  });

  // A thread of the owner's from two days ago, read and waiting.
  await scan('thread', {
    uri: postBy(owner, '3mthreaddata'),
    kind: 'repliers',
    at: now - 2 * DAY - 4 * HOUR,
    rows: [
      ...band('PERIPHERAL', 790, { reply: 3 }, { reply: { arguing: 2, neutral: 1 } }),
      ...band('UNKNOWN', 26000, { reply: 85 }, { reply: { hostile: 12, arguing: 28, neutral: 45 } }),
    ],
  });

  // Approved this afternoon and still writing: 1,000 of 1,840 so far.
  {
    const rows = band('UNKNOWN', 30000, { like: 1840 });
    const id = await scan('shift', {
      uri: postBy(demoDid(821), '3mshiftwork'),
      kind: 'likers',
      at: now - 5 * HOUR,
      rows,
      note: '; approved: approve {code} UNKNOWN',
    });
    await add(id, rows.slice(0, 500), now - 48 * 60_000, 'band');
    await add(id, rows.slice(500, 1000), now - 19 * 60_000, 'band');
    await upsert('plan', [{ id, approved_at: iso(now - 48 * 60_000), approved_bands: ['UNKNOWN'], note: `bulk likers from ${postBy(demoDid(821), '3mshiftwork')}; approved: approve ${id.slice(0, 8)} UNKNOWN` }]);
    await upsert('continuation', [{ plan_id: id, convo_id: 'demo-convo', command: `approve ${id.slice(0, 8)} UNKNOWN`, next_at: iso(now + 12 * 60_000), added: 1000, failures: 0 }]);
  }

  // Two weeks ago: 640 added, 12 taken back the same day.
  {
    const rows = [...band('PERIPHERAL', 795, { quote: 5 }), ...band('UNKNOWN', 40000, { quote: 240, reply: 400 })];
    const at = now - 14 * DAY;
    const id = await scan('nightbus', { uri: postBy(owner, '3mnightbus'), kind: 'everyone', at: at - HOUR, rows });
    const unknown = rows.filter((x) => x.band === 'UNKNOWN');
    await add(id, unknown.slice(12), at, 'band');
    await add(id, unknown.slice(0, 12), at, 'band', { undoneAt: at + 2 * HOUR, undoReason: `undo ${id.slice(0, 8)}` });
    await upsert('plan', [{ id, approved_at: iso(at), approved_bands: ['UNKNOWN'], note: `bulk everyone from ${postBy(owner, '3mnightbus')}; approved: approve ${id.slice(0, 8)} UNKNOWN` }]);
  }

  // Scanned on Saturday and cancelled.
  {
    const id = await scan('ratio', {
      uri: postBy(demoDid(824), '3mratio'),
      kind: 'everyone',
      at: now - 3 * DAY,
      rows: [...band('CONNECTED', 650, { reply: 5 }), ...band('PERIPHERAL', 760, { reply: 7 }), ...band('UNKNOWN', 45000, { reply: 48 })],
    });
    await upsert('plan', [{ id, note: `bulk everyone from ${postBy(demoDid(824), '3mratio')} (cancelled)` }]);
  }

  // Yesterday: the hostile ones on a watched post, approved by label.
  let watchedPlan;
  {
    const rows = [...band('PERIPHERAL', 770, { reply: 4 }, { reply: { arguing: 4 } }), ...band('UNKNOWN', 46000, { quote: 60, reply: 110 }, { quote: { hostile: 20, arguing: 25, neutral: 15 }, reply: { hostile: 26, arguing: 40, neutral: 44 } })];
    const at = now - 20 * HOUR;
    const uri = postBy(owner, '3mbikelanes');
    watchedPlan = await scan('bikes', { uri, kind: 'everyone', at: at - HOUR, rows });
    await add(watchedPlan, rows.filter((x) => x.triage === 'hostile'), at, 'triage:hostile');
    await upsert('plan', [{ id: watchedPlan, approved_at: iso(at), approved_bands: ['triage:hostile'], note: `bulk everyone from ${uri}; approved: approve ${watchedPlan.slice(0, 8)} hostile` }]);
  }

  // September: the sweep that made most of the list.
  {
    const rows = band('UNKNOWN', 50000, { like: 5200, repost: 700, reply: 600, quote: 400 });
    const at = now - 70 * DAY;
    const uri = postBy(owner, '3msweep');
    const id = await scan('sweep', { uri, kind: 'everyone', at: at - HOUR, rows });
    await add(id, rows, at, 'band');
    await upsert('plan', [{ id, approved_at: iso(at), approved_bands: ['UNKNOWN'], note: `bulk everyone from ${uri}; approved: approve ${id.slice(0, 8)} UNKNOWN` }]);
  }

  // --- single blocks and unblocks, a month of them --------------------------------
  const WORDS = ['block', 'block', 'block', 'block this guy', 'block, it is spam'];
  const single = async ({ i, at, action = 'list_add', bandName = 'UNKNOWN', via = 'command', words, already = false }) => {
    const id = uuid(r);
    await upsert('plan', [{ id, created_at: iso(at), approved_at: iso(at), approved_bands: [via], note: words }]);
    await upsert('decision', [{ plan_id: id, did: demoDid(i), band: bandName, action, acted_at: iso(at), acted_seq: (seq += 1), approved_via: via, ...(already ? { already_listed: true } : {}) }]);
    return id;
  };
  let n = 60000;
  for (let d = 29; d >= 1; d -= 1) {
    const count = 2 + Math.floor(r() * 9);
    for (let k = 0; k < count; k += 1, n += 1) {
      const agent = k % 6 === 5;
      await single({
        i: n,
        at: now - d * DAY - Math.floor(r() * 10) * HOUR,
        via: agent ? 'agent:individual' : 'command',
        words: agent ? 'block whoever wrote this, it is spam [agent: the author of the post you attached]' : pick(WORDS),
      });
    }
  }
  // Today: a run of 39 this morning, then a few by hand.
  for (let k = 0; k < 39; k += 1, n += 1) await single({ i: n, at: now - 6 * HOUR + k * 37_000, words: 'block' });
  await single({ i: n, at: now - 88 * 60_000, via: 'agent:individual', words: 'block whoever wrote this, it is spam [agent: the author of the post you attached]' });
  n += 1;
  // An unblock of someone a typed block put there a week ago.
  {
    const i = 59990;
    const words = `unblock @${demoAccount(i).handle}`;
    const blocked = await single({ i, at: now - 7 * DAY, bandName: 'PERIPHERAL', words: 'block' });
    // The removal closes the add that put them there (closeAdds.js).
    await upsert('decision', [{ plan_id: blocked, did: demoDid(i), band: 'PERIPHERAL', action: 'list_add', acted_at: iso(now - 7 * DAY), undone_at: iso(now - 38 * 60_000), undo_reason: words }]);
    await single({ i, at: now - 38 * 60_000, action: 'list_remove', bandName: 'PERIPHERAL', words });
  }
  await single({ i: n, at: now - 4 * 60_000, words: 'block' });
  // Notable and peripheral accounts blocked by name over the month.
  for (const [k, i] of range(840, 26).entries()) await single({ i, at: now - (3 + k) * DAY, bandName: 'NOTABLE', words: 'block' });
  for (const [k, i] of range(900, 34).entries()) await single({ i, at: now - (2 + (k % 27)) * DAY, bandName: 'UNKNOWN', words: 'block' });

  // --- the weekly re-score ---------------------------------------------------------
  // Read back who the log says is on the list, then say where each sits now.
  const open = await selectAll('decision', {
    select: 'did,band',
    eq: { action: 'list_add' },
    where: { acted_at: 'not.is.null', undone_at: 'is.null' },
    order: 'did.asc',
  });
  const listed = [...new Map(open.map((o) => [o.did, o])).values()];
  const audit = async (at, moved) => {
    const id = uuid(r);
    await upsert('audit', [{ id, list_uri: `at://${bot}/app.bsky.graph.list/3mdemolist`, started_at: iso(at), finished_at: iso(at + 9 * 60_000), total: listed.length, scored: listed.length }]);
    await put('audit_item', listed.map((o) => {
      const i = indexOf(o.did);
      const a = demoAccount(i);
      const now_ = moved.get(i) || (o.band === 'UNSCORED' ? 'UNKNOWN' : o.band);
      return {
        audit_id: id,
        did: o.did,
        handle: a.handle,
        band: now_,
        trust: now_ === 'PROTECTED' ? 100 : now_ === 'CONNECTED' ? 62 : now_ === 'PERIPHERAL' ? 40 : now_ === 'NOTABLE' ? 30 : 6,
        vouches: now_ === 'CONNECTED' ? 3 + (i % 5) : now_ === 'PERIPHERAL' ? 1 + (i % 2) : 0,
        followers: a.followers,
        protected_reason: now_ === 'PROTECTED' ? 'you follow them' : null,
      };
    }));
  };
  // Strangers when the sweep added them; not strangers any more.
  const moved = new Map();
  for (const i of range(50010, 2)) moved.set(i, 'PROTECTED');
  for (const i of range(50100, 9)) moved.set(i, 'CONNECTED');
  for (const i of range(50200, 31)) moved.set(i, 'PERIPHERAL');
  for (const i of range(50300, 4)) moved.set(i, 'NOTABLE');
  const before = new Map([...moved].filter(([i]) => i % 3 !== 0));
  await audit(now - 9 * DAY, before);
  await audit(now - 2 * DAY, moved);
  await upsert('review_keep', [
    { did: demoDid(50201), band: 'PERIPHERAL', kept_at: iso(now - DAY), kept_by: owner },
    { did: demoDid(50301), band: 'NOTABLE', kept_at: iso(now - DAY), kept_by: owner },
  ]);

  // --- watches, notes, model calls ---------------------------------------------------
  await upsert('watch', [
    { id: uuid(r), convo_id: 'demo-convo', uri: ownPost, plan_id: null, mode: 'ask', created_at: iso(now - 3 * HOUR - 46 * 60_000), until: iso(now + 20 * HOUR), last_checked_at: iso(now - 4 * 60_000), last_digest_at: iso(now - 90 * 60_000), stats: { checks: 44, seen: 695, fresh: 37, hostile: 9, added: 0 } },
    { id: uuid(r), convo_id: 'demo-convo', uri: postBy(owner, '3mbikelanes'), plan_id: watchedPlan, mode: 'auto', created_at: iso(now - 21 * HOUR), until: iso(now + 3 * HOUR), last_checked_at: iso(now - 2 * 60_000), last_digest_at: iso(now - 5 * HOUR), stats: { checks: 250, seen: 174, fresh: 4, hostile: 0, added: 46 } },
    { id: uuid(r), convo_id: 'demo-convo', uri: postBy(owner, '3mnightbus'), plan_id: null, mode: 'ask', created_at: iso(now - 14 * DAY), until: iso(now - 13 * DAY), stopped_at: null, last_checked_at: iso(now - 13 * DAY), stats: { checks: 288, seen: 640, fresh: 0, hostile: 31, added: 0 } },
  ]);
  await upsert('memory', [
    { id: uuid(r), text: 'Anyone from the transit advocacy group is a friend, even when they argue with me.', author_did: owner, created_at: iso(now - 20 * DAY) },
    { id: uuid(r), text: 'Do not offer to watch posts that are replies.', author_did: owner, created_at: iso(now - 6 * DAY) },
  ]);
  const usage = [];
  for (let d = 29; d >= 0; d -= 1) {
    const busy = d === 0 || d === 14 ? 6 : 1;
    const at = iso(now - d * DAY - 2 * HOUR);
    usage.push({ at, kind: 'triage', model: 'deepseek/deepseek-v4.1-flash', input_tokens: Math.floor((20_000 + r() * 30_000) * busy), output_tokens: Math.floor((1500 + r() * 2500) * busy) });
    usage.push({ at, kind: 'agent', model: 'deepseek/deepseek-v4.1-flash', input_tokens: Math.floor(9000 + r() * 16_000), output_tokens: Math.floor(700 + r() * 1800) });
    usage.push({ at, kind: 'check', model: 'deepseek/deepseek-v4.1-flash', input_tokens: Math.floor(1200 + r() * 2000), output_tokens: Math.floor(20 + r() * 40) });
    if (d % 3 === 0) usage.push({ at, kind: 'read', model: 'deepseek/deepseek-v4.1-flash', input_tokens: Math.floor(6000 + r() * 9000), output_tokens: Math.floor(500 + r() * 700) });
    if (busy > 1) usage.push({ at, kind: 'triage-escalated', model: 'test/escalation', input_tokens: Math.floor(14_000 + r() * 8000), output_tokens: Math.floor(900 + r() * 600) });
  }
  await put('llm_usage', usage);

  // --- other lists -----------------------------------------------------------------
  // After the re-score on purpose: it reads the main list and no other.
  if (lists) {
    const [, spam, trolls] = demoLists(bot);
    for (let k = 0; k < 61; k += 1) {
      const id = await single({ i: 65000 + k, at: now - (1 + (k % 20)) * DAY - k * 60_000, words: 'block, it is spam to spam' });
      await upsert('plan', [{ id, list_uri: spam.uri }]);
    }
    const rows = [...band('PERIPHERAL', 792, { quote: 3 }), ...band('UNKNOWN', 66000, { quote: 30 })];
    const at = now - 4 * DAY;
    const uri = postBy(demoDid(826), '3mpileon');
    const id = await scan('pileon', { uri, kind: 'quoters', at: at - HOUR, rows });
    await add(id, rows.filter((x) => x.band === 'UNKNOWN'), at, 'band');
    await upsert('plan', [{ id, approved_at: iso(at), approved_bands: ['UNKNOWN'], list_uri: trolls.uri, note: `bulk quoters from ${uri}; approved: approve ${id.slice(0, 8)} UNKNOWN to trolls` }]);
  }

  return { owner, bot, codes };
}

/** A stand-in avatar: initials on a tint, as a data URI. Some have none. */
export function demoAvatar(i) {
  if (i % 7 === 3) return null;
  const a = demoAccount(i);
  const initials = (a.displayName || a.handle).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const hue = [12, 38, 95, 160, 205, 250, 290, 330][i % 8];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 42% 60%)"/><text x="32" y="41" font-family="sans-serif" font-size="26" text-anchor="middle" fill="hsl(${hue} 45% 18%)">${initials}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** A random id for the demo's own writes. */
export const demoId = () => crypto.randomUUID();
