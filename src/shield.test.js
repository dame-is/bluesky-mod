// The shield end to end, against a store in memory and a fake of the owner's
// repo behind the real gate writer: what trips, what gets written, and that
// everything comes back off exactly.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { freshStore } from './bot/testStores.js';
import { selectAll } from './bot/db.js';
import { createGates } from './gates.js';
import { createActivity } from './ownerActivity.js';
import { LINK_SOURCES } from './spacedust.js';
import { readShieldConfig } from './lib/shieldConfig.js';
import { THREADGATE, POSTGATE, quotesOff, repliesLimited } from './lib/gateRules.js';
import {
  createClassifier,
  createPostInfo,
  shieldTick,
  shieldsUp,
  shieldsDown,
  onOwnerPost,
  closeReplies,
  disableQuotes,
  reopen,
  readState,
  liveGates,
} from './shield.js';

const OWNER = 'did:plc:owner0000000000000000000';
const POST = 'app.bsky.feed.post';
const uriOf = (rkey) => `at://${OWNER}/${POST}/${rkey}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-11-17T12:00:00.000Z');

/** The owner's repo, as the PDS would answer for it. */
function fakeRepo() {
  const records = new Map();
  const calls = [];
  const key = (c, r) => `${c}/${r}`;
  const agent = {
    com: {
      atproto: {
        repo: {
          async listRecords({ repo, collection }) {
            calls.push(['listRecords', repo, collection]);
            // Newest first, as a repo lists by record key.
            const out = [...records.entries()]
              .filter(([k]) => k.startsWith(`${collection}/`))
              .map(([k, value]) => ({ uri: `at://${repo}/${k}`, value }))
              .sort((a, b) => (String(a.value.createdAt) < String(b.value.createdAt) ? 1 : -1));
            return { data: { records: out } };
          },
          async getRecord({ repo, collection, rkey }) {
            calls.push(['getRecord', repo, collection]);
            const v = records.get(key(collection, rkey));
            if (!v) {
              throw Object.assign(new Error('Could not locate record'), {
                error: 'RecordNotFound',
                status: 400,
              });
            }
            return { data: { value: structuredClone(v) } };
          },
          async applyWrites({ repo, writes }) {
            calls.push(['applyWrites', repo, writes.map((w) => w.collection)]);
            for (const w of writes) {
              if (w.$type.endsWith('#create') && records.has(key(w.collection, w.rkey))) {
                throw new Error('record already exists');
              }
            }
            for (const w of writes) {
              if (w.$type.endsWith('#delete')) records.delete(key(w.collection, w.rkey));
              else records.set(key(w.collection, w.rkey), structuredClone(w.value));
            }
            return {};
          },
          async putRecord({ repo, collection, rkey, record }) {
            calls.push(['putRecord', repo, collection]);
            records.set(key(collection, rkey), structuredClone(record));
          },
          async deleteRecord({ repo, collection, rkey }) {
            calls.push(['deleteRecord', repo, collection]);
            records.delete(key(collection, rkey));
          },
        },
      },
    },
  };
  return {
    agent,
    calls,
    post(rkey, { at = T0 - HOUR, reply = null } = {}) {
      records.set(key(POST, rkey), {
        $type: POST,
        text: 'hi',
        createdAt: new Date(at).toISOString(),
        ...(reply ? { reply } : {}),
      });
      return uriOf(rkey);
    },
    gate: (kind, rkey) => records.get(key(kind === 'threadgate' ? THREADGATE : POSTGATE, rkey)) ?? null,
    setGate: (kind, rkey, value) => records.set(key(kind === 'threadgate' ? THREADGATE : POSTGATE, rkey), value),
    writes: () => calls.filter(([c]) => ['applyWrites', 'putRecord', 'deleteRecord'].includes(c)),
  };
}

let t;
let repo;
let activity;
let notes;
let bands;
let watches;

function deps(env = {}, extra = {}) {
  const { shield } = readShieldConfig({ MOD_OWNER_APP_PASSWORD: 'abcd-efgh-ijkl-mnop', ...env });
  const gates = extra.gates === null ? null : createGates({ getAgent: () => repo.agent, ownerDid: OWNER });
  return {
    cfg: shield,
    gates,
    activity,
    outsideAmong: createClassifier({
      score: async (dids) => new Map(dids.map((d) => [d, { band: bands[d] ?? 'UNKNOWN' }])),
      now: () => t,
    }),
    postInfo: createPostInfo({ gates }),
    notify: async (msg) => notes.push(msg),
    startWatch: async (uri) => watches.push(uri),
    dryRun: false,
    ...extra,
    ...(extra.gates === null ? { gates: null } : {}),
  };
}

/** One Spacedust frame: `actor` linked to `subject` as `kind`. */
let seq = 0;
function link(kind, actor, subject) {
  seq += 1;
  const source = {
    reply: LINK_SOURCES.reply,
    threadReply: LINK_SOURCES.threadReply,
    quote: LINK_SOURCES.quote,
    mention: LINK_SOURCES.mention,
  }[kind];
  activity.record({
    kind: 'link',
    link: {
      operation: 'create',
      source,
      source_record: `at://${actor}/${POST}/r${seq}`,
      subject,
    },
  });
}

const strangers = (n, prefix = 's') => Array.from({ length: n }, (_, i) => `did:plc:${prefix}${i}`);

beforeEach(async () => {
  await freshStore('sqlite', ':memory:');
  t = T0;
  repo = fakeRepo();
  activity = createActivity({ now: () => t });
  notes = [];
  bands = {};
  watches = [];
  seq = 0;
  // The stream has been listening for a while.
  t = T0;
});

describe('per-post triggers', () => {
  it('count only accounts outside the circle', async () => {
    const root = repo.post('3kroot');
    const friends = strangers(20, 'friend');
    for (const f of friends) bands[f] = 'CONNECTED';
    for (const f of friends) link('reply', f, root);
    for (const s of strangers(11)) link('reply', s, root);
    const d = deps({ MOD_SHIELD: 'auto' });
    expect((await shieldTick(d, { now: t })).fired).toEqual([]);
    expect(repo.writes()).toEqual([]);

    link('reply', 'did:plc:one-more', root);
    const { fired } = await shieldTick(d, { now: t });
    expect(fired).toEqual([`replies:${root}`]);
    expect(repliesLimited(repo.gate('threadgate', '3kroot'))).toBe(true);
    expect(notes[0].text).toMatch(/12 accounts outside your circle replied/);
    expect(notes[0].options.map((o) => o.command)).toContain(`open replies ${root}`);
  });

  it('ask the owner first in ask mode, with the command a 👍 runs', async () => {
    const root = repo.post('3kroot');
    for (const s of strangers(6)) link('quote', s, root);
    const { fired } = await shieldTick(deps({ MOD_SHIELD: 'ask' }), { now: t });
    expect(fired).toEqual([`quotes:${root}`]);
    expect(repo.writes()).toEqual([]);
    expect(notes[0].pending).toEqual([`disable quotes ${root}`]);
    expect(notes[0].options[0].command).toBe(`disable quotes ${root}`);
  });

  it('say once per post, not once per reply', async () => {
    const root = repo.post('3kroot');
    const d = deps({ MOD_SHIELD: 'ask' });
    for (const s of strangers(12)) link('reply', s, root);
    await shieldTick(d, { now: t });
    for (const s of strangers(12, 'more')) link('reply', s, root);
    t += 5 * MIN;
    expect((await shieldTick(d, { now: t })).fired).toEqual([]);
    expect(notes).toHaveLength(1);
  });

  it('leave a post the owner already limited alone', async () => {
    const root = repo.post('3kroot');
    repo.setGate('threadgate', '3kroot', {
      $type: THREADGATE,
      post: root,
      createdAt: new Date(T0 - HOUR).toISOString(),
      allow: [{ $type: 'app.bsky.feed.threadgate#listRule', list: `at://${OWNER}/app.bsky.graph.list/x` }],
    });
    for (const s of strangers(12)) link('reply', s, root);
    expect((await shieldTick(deps({ MOD_SHIELD: 'auto' }), { now: t })).fired).toEqual([]);
    expect(repo.writes()).toEqual([]);
  });

  it('never close replies on a reply, where a threadgate does nothing', async () => {
    const reply = repo.post('3kreply', { reply: { root: { uri: 'at://x/y/z' }, parent: { uri: 'at://x/y/z' } } });
    for (const s of strangers(12)) link('reply', s, reply);
    expect((await shieldTick(deps({ MOD_SHIELD: 'auto' }), { now: t })).fired).toEqual([]);
  });

  it('only tell, and offer a watch, without the owner\'s password', async () => {
    const root = repo.post('3kroot');
    for (const s of strangers(12)) link('reply', s, root);
    const d = deps({ MOD_SHIELD: 'auto' }, { gates: null, postInfo: async () => ({ root: true }) });
    const { fired } = await shieldTick(d, { now: t });
    expect(fired).toHaveLength(1);
    expect(notes[0].text).toMatch(/MOD_OWNER_APP_PASSWORD/);
    expect(notes[0].options.map((o) => o.command)).toEqual([`shield watch ${root}`]);
    expect(repo.writes()).toEqual([]);
  });

  it('come off by themselves once the post has been quiet, unless kept', async () => {
    const root = repo.post('3kroot');
    for (const s of strangers(12)) link('reply', s, root);
    const d = deps({ MOD_SHIELD: 'auto', MOD_SHIELD_RESTORE_HOURS: '2' });
    await shieldTick(d, { now: t });
    expect(repliesLimited(repo.gate('threadgate', '3kroot'))).toBe(true);
    // Still under fire at the restore time: it stays.
    t += 2 * HOUR;
    link('reply', 'did:plc:latecomer', root);
    await shieldTick(d, { now: t });
    expect(repliesLimited(repo.gate('threadgate', '3kroot'))).toBe(true);
    // An hour of quiet later, it opens.
    t += HOUR + MIN;
    await shieldTick(d, { now: t });
    expect(repo.gate('threadgate', '3kroot')).toBeNull();
    expect(notes.at(-1).text).toMatch(/Opened replies .* quiet for an hour/);
  });
});

describe('restoring', () => {
  it('puts back exactly what was there, and only while it is as the shield left it', async () => {
    const root = repo.post('3kroot');
    const before = {
      $type: THREADGATE,
      post: root,
      createdAt: new Date(T0 - HOUR).toISOString(),
      hiddenReplies: ['at://did:plc:x/app.bsky.feed.post/1'],
    };
    repo.setGate('threadgate', '3kroot', before);
    const d = deps();
    await closeReplies(d, root, { now: t });
    expect(repo.gate('threadgate', '3kroot').hiddenReplies).toEqual(before.hiddenReplies);
    await reopen(d, root, 'threadgate', { now: t });
    expect(repo.gate('threadgate', '3kroot')).toEqual(before);
  });

  it('leaves a gate the owner changed since', async () => {
    const root = repo.post('3kroot');
    const d = deps();
    await closeReplies(d, root, { now: t });
    const theirs = { ...repo.gate('threadgate', '3kroot'), allow: [] };
    repo.setGate('threadgate', '3kroot', theirs);
    const out = await reopen(d, root, 'threadgate', { now: t });
    expect(out.text).toMatch(/changed since/);
    expect(repo.gate('threadgate', '3kroot')).toEqual(theirs);
    expect(await liveGates({ post: root })).toEqual([]);
  });

  it('takes layered gates off in either order without stranding one', async () => {
    const root = repo.post('3kroot');
    const d = deps({ MOD_SHIELD_RESTORE_HOURS: '1' });
    // A trigger turns quotes off; then attack mode detaches a stranger's quote.
    await disableQuotes(d, root, { why: 'trigger', now: t });
    link('quote', 'did:plc:dunker', root);
    await shieldsUp(d, { now: t });
    expect(repo.gate('postgate', '3kroot').detachedEmbeddingUris).toHaveLength(1);
    // The trigger's time comes on a quiet post: its gate comes off, and
    // attack mode's stays on top.
    t += 2 * HOUR;
    await shieldTick(d, { now: t });
    expect(quotesOff(repo.gate('postgate', '3kroot'))).toBe(true);
    expect((await liveGates({ post: root, kind: 'postgate' })).map((r) => r.why)).toEqual(['attack']);
    // Then attack mode stands down, and the post is as it was at the start.
    await shieldsDown(d, { now: t });
    expect(repo.gate('postgate', '3kroot')).toBeNull();
    expect(repo.gate('threadgate', '3kroot')).toBeNull();
    expect(await liveGates()).toEqual([]);
  });

  it('lifts every layer when the owner says so', async () => {
    const root = repo.post('3kroot');
    const d = deps();
    await disableQuotes(d, root, { why: 'trigger', now: t });
    link('quote', 'did:plc:dunker', root);
    await shieldsUp(d, { now: t });
    const out = await reopen(d, root, 'postgate', { now: t });
    expect(out.text).toMatch(/open again/);
    expect(repo.gate('postgate', '3kroot')).toBeNull();
  });
});

describe('attack mode', () => {
  it('trips on a pile-on across posts and mentions, gates everything, and stands down exactly', async () => {
    const a = repo.post('3ka', { at: T0 - 2 * HOUR });
    const b = repo.post('3kb', { at: T0 - 3 * HOUR });
    const old = repo.post('3kold', { at: T0 - 30 * 24 * HOUR });
    const theirs = {
      $type: POSTGATE,
      post: b,
      createdAt: new Date(T0 - HOUR).toISOString(),
      detachedEmbeddingUris: ['at://did:plc:earlier/app.bsky.feed.post/q'],
    };
    repo.setGate('postgate', '3kb', theirs);
    const pile = strangers(40);
    pile.slice(0, 20).forEach((s) => link('reply', s, a));
    pile.slice(20, 35).forEach((s) => link('quote', s, a));
    pile.slice(35).forEach((s) => link('mention', s, OWNER));
    const d = deps({ MOD_ATTACK: 'auto' });

    const { fired } = await shieldTick(d, { now: t });
    expect(fired).toEqual(['attack']);
    const state = await readState();
    expect(Date.parse(state.attackUntil)).toBe(t + 24 * HOUR);
    expect(repliesLimited(repo.gate('threadgate', '3ka'))).toBe(true);
    expect(quotesOff(repo.gate('postgate', '3ka'))).toBe(true);
    expect(repo.gate('postgate', '3ka').detachedEmbeddingUris).toHaveLength(15);
    expect(quotesOff(repo.gate('postgate', '3kb'))).toBe(true);
    expect(repo.gate('postgate', '3kb').detachedEmbeddingUris).toEqual(theirs.detachedEmbeddingUris);
    // Older than MOD_ATTACK_DAYS and not under fire.
    expect(repo.gate('threadgate', '3kold')).toBeNull();
    expect(watches).toEqual([a]);
    expect(notes[0].text).toMatch(/Attack mode is on: 40 accounts outside your circle/);

    // A post made during attack mode is gated as it lands.
    repo.post('3knew', { at: t });
    const gated = await onOwnerPost(
      { kind: 'commit', did: OWNER, commit: { operation: 'create', collection: POST, rkey: '3knew', record: { text: 'x' } } },
      d,
      { now: t + MIN },
    );
    expect(gated).toBe(true);
    expect(repliesLimited(repo.gate('threadgate', '3knew'))).toBe(true);

    // Its time runs out, and every post is as it was.
    t += 24 * HOUR + MIN;
    const down = await shieldTick(d, { now: t });
    expect(down.fired).toContain('attack-down');
    for (const rkey of ['3ka', '3knew']) {
      expect(repo.gate('threadgate', rkey)).toBeNull();
      expect(repo.gate('postgate', rkey)).toBeNull();
    }
    expect(repo.gate('postgate', '3kb')).toEqual(theirs);
    expect(await liveGates()).toEqual([]);
    expect((await readState()).attackUntil).toBeNull();
  });

  it('does not gate a new post when it is off', async () => {
    repo.post('3knew', { at: t });
    const gated = await onOwnerPost(
      { kind: 'commit', did: OWNER, commit: { operation: 'create', collection: POST, rkey: '3knew', record: {} } },
      deps(),
      { now: t },
    );
    expect(gated).toBe(false);
    expect(repo.writes()).toEqual([]);
  });

  it('asks before tripping by default, and asks once', async () => {
    repo.post('3ka');
    for (const s of strangers(40)) link('mention', s, OWNER);
    const d = deps();
    expect(d.cfg.attack.mode).toBe('ask');
    expect((await shieldTick(d, { now: t })).fired).toEqual(['attack']);
    expect(notes[0].pending).toEqual(['shields up']);
    expect(repo.writes()).toEqual([]);
    expect((await shieldTick(d, { now: t + 5 * MIN })).fired).toEqual([]);
  });

  it('is not tripped by the owner\'s own circle', async () => {
    for (const s of strangers(60, 'pal')) {
      bands[s] = 'PERIPHERAL';
      link('mention', s, OWNER);
    }
    expect((await shieldTick(deps({ MOD_ATTACK: 'auto' }), { now: t })).fired).toEqual([]);
  });

  it('writes nothing and sends nothing in a dry run', async () => {
    const root = repo.post('3ka');
    for (const s of strangers(40)) link('reply', s, root);
    const log = vi.fn();
    const d = deps({ MOD_ATTACK: 'auto', MOD_SHIELD: 'auto' }, { dryRun: true, log });
    const { fired } = await shieldTick(d, { now: t });
    expect(fired).toEqual(['attack']);
    expect(repo.writes()).toEqual([]);
    expect(notes).toEqual([]);
    expect(watches).toEqual([]);
    expect(await selectAll('shield_gate', { select: 'id', order: 'id.asc' })).toEqual([]);
    expect((await readState()).attackUntil).toBeNull();
    expect(log).toHaveBeenCalledWith('DRY_RUN: the shield would say', expect.anything());
    // And it does not say it again every minute.
    expect((await shieldTick(d, { now: t + MIN })).fired).toEqual([]);
  });
});

describe('createClassifier', () => {
  it('scores each account once while its band is fresh, and never counts the owner', async () => {
    const score = vi.fn(async (dids) => new Map(dids.map((d) => [d, { band: 'UNKNOWN' }])));
    let now = 0;
    const outside = createClassifier({ score, now: () => now });
    expect([...(await outside(['did:plc:a', OWNER]))]).toEqual(['did:plc:a']);
    await outside(['did:plc:a']);
    expect(score).toHaveBeenCalledTimes(1);
    now = 31 * MIN;
    await outside(['did:plc:a']);
    expect(score).toHaveBeenCalledTimes(2);
  });

  it('counts nobody it could not score', async () => {
    const outside = createClassifier({ score: async () => new Map() });
    expect((await outside(['did:plc:a'])).size).toBe(0);
  });
});

describe('pruneRestored', () => {
  it('forgets gates that came off long ago, never one still on', async () => {
    const root = repo.post('3kroot');
    const d = deps();
    await closeReplies(d, root, { now: t });
    await reopen(d, root, 'threadgate', { now: t });
    await disableQuotes(d, root, { now: t });
    const { pruneRestored } = await import('./shield.js');
    expect(await pruneRestored({ now: t + 30 * 24 * HOUR })).toBe(0);
    expect(await pruneRestored({ now: t + 91 * 24 * HOUR })).toBe(1);
    expect((await liveGates()).map((r) => r.kind)).toEqual(['postgate']);
  });
});
