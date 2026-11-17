// The owner's own post sent with no words: the card, its menu, and that a
// number on it runs what was shown, through the real DM pass.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { freshStore } from './testStores.js';
import { select, upsert } from './db.js';
import { createGates } from '../gates.js';
import { createActivity } from '../ownerActivity.js';
import { LINK_SOURCES } from '../spacedust.js';
import { readShieldConfig } from '../lib/shieldConfig.js';
import { createClassifier, createPostInfo, guardPost, liveGuards } from '../shield.js';
import { setShieldDeps } from './shieldDm.js';
import { ownPostIn, ownPostCard, ownPostOptions } from './ownPost.js';
import { runDmPass } from './dmLoop.js';

const OWNER = 'did:plc:owner0000000000000000000';
const BOT = 'did:plc:bot';
const POSTS = 'app.bsky.feed.post';
const TG = 'app.bsky.feed.threadgate';
const ROOT = `at://${OWNER}/${POSTS}/3kroot`;
const REPLY = `at://${OWNER}/${POSTS}/3kreply`;
const THEIRS = `at://did:plc:someone/${POSTS}/3kx`;

/** Just enough of the owner's repo for the gate writer. */
function fakeRepo() {
  const records = new Map([
    [`${POSTS}/3kroot`, { $type: POSTS, text: 'hi', createdAt: new Date().toISOString() }],
  ]);
  const agent = {
    com: {
      atproto: {
        repo: {
          listRecords: async ({ repo, collection }) => ({
            data: {
              records: [...records]
                .filter(([k]) => k.startsWith(`${collection}/`))
                .map(([k, value]) => ({ uri: `at://${repo}/${k}`, value })),
            },
          }),
          getRecord: async ({ collection, rkey }) => {
            const v = records.get(`${collection}/${rkey}`);
            if (!v) throw Object.assign(new Error('Could not locate record'), { error: 'RecordNotFound' });
            return { data: { value: structuredClone(v) } };
          },
          applyWrites: async ({ writes }) => {
            for (const w of writes) {
              if (w.$type.endsWith('#delete')) records.delete(`${w.collection}/${w.rkey}`);
              else records.set(`${w.collection}/${w.rkey}`, structuredClone(w.value));
            }
          },
        },
      },
    },
  };
  return { agent, gate: () => records.get(`${TG}/3kroot`) ?? null };
}

/** The AppView's getPosts, answering for the owner's root post and reply. */
function appview({ threadgate = null } = {}) {
  return vi.fn(async (url) => {
    const uri = new URL(url).searchParams.get('uris');
    const post = {
      uri,
      likeCount: 1200,
      repostCount: 40,
      replyCount: 33,
      quoteCount: 5,
      record: uri === REPLY ? { text: 'r', reply: { root: { uri: ROOT }, parent: { uri: ROOT } } } : { text: 'hi' },
      ...(threadgate ? { threadgate: { record: threadgate } } : {}),
    };
    return { ok: true, json: async () => ({ posts: [post] }) };
  });
}

let repo;
let activity;
let watches;

function install({ gates = true, watch = true, env = {} } = {}) {
  const { shield } = readShieldConfig({ MOD_OWNER_APP_PASSWORD: 'abcd-efgh-ijkl-mnop', ...env });
  const g = gates ? createGates({ getAgent: () => repo.agent, ownerDid: OWNER }) : null;
  const deps = {
    cfg: shield,
    gates: g,
    activity,
    outsideAmong: createClassifier({
      score: async (dids) => new Map(dids.map((d) => [d, { band: d.includes('friend') ? 'CONNECTED' : 'UNKNOWN' }])),
    }),
    postInfo: createPostInfo({ gates: g }),
    startWatch: watch ? async (uri, convoId) => watches.push([uri, convoId]) : null,
    streaming: true,
    dryRun: false,
    log: () => {},
  };
  setShieldDeps(deps);
  return deps;
}

beforeEach(async () => {
  await freshStore('sqlite', ':memory:');
  repo = fakeRepo();
  activity = createActivity();
  watches = [];
});

afterEach(() => {
  setShieldDeps(null);
  vi.unstubAllGlobals();
});

describe('ownPostIn', () => {
  it("finds the owner's own post sent alone, and nothing else", async () => {
    expect(await ownPostIn('', { embedUri: ROOT })).toBe(ROOT);
    expect(await ownPostIn(ROOT)).toBe(ROOT);
    expect(await ownPostIn('this', { embedUri: ROOT })).toBe(ROOT);
    // Someone else's post keeps its scan card; words make it something else.
    expect(await ownPostIn('', { embedUri: THEIRS })).toBeNull();
    expect(await ownPostIn('block the likers', { embedUri: ROOT })).toBeNull();
    expect(await ownPostIn('hello')).toBeNull();
  });
});

describe('the card', () => {
  it('says what is going on with the post, and offers what can be done', async () => {
    install();
    for (let i = 0; i < 4; i += 1) {
      activity.record({
        kind: 'link',
        link: {
          operation: 'create',
          source: LINK_SOURCES.reply,
          source_record: `at://did:plc:${i < 3 ? 'stranger' : 'friend'}${i}/${POSTS}/r${i}`,
          subject: ROOT,
        },
      });
    }
    const card = await ownPostCard(ROOT, { fetchImpl: appview() });
    expect(card.text).toMatch(/^Your post /);
    expect(card.text).toMatch(/1,200 likes · 40 reposts · 33 replies · 5 quotes/);
    expect(card.text).toMatch(/4 replies and quotes, 3 from outside your circle/);
    expect(card.text).toMatch(/replies: open to anyone/);
    expect(card.text).toMatch(/quotes: on/);
    expect(card.text).not.toMatch(/MOD_OWNER_APP_PASSWORD/);
    expect(card.options.map((o) => o.command)).toEqual([
      `shield watch ${ROOT}`,
      `watch ${ROOT} 24h auto`,
      `guard ${ROOT} for 72h`,
      `close replies ${ROOT}`,
      `disable quotes ${ROOT}`,
      `add everyone ${ROOT}`,
    ]);
    // The blocking watch runs as a stored question, so several lists ask.
    expect(card.options[1].commands).toEqual([`watch ${ROOT} 24h auto`]);
  });

  it('offers only telling, and nothing that writes a gate, without the password', async () => {
    install({ gates: false });
    const card = await ownPostCard(ROOT, { fetchImpl: appview() });
    expect(card.text).toMatch(/needs MOD_OWNER_APP_PASSWORD/);
    expect(card.text).not.toMatch(/quotes:/);
    const commands = card.options.map((o) => o.command);
    expect(commands).toContain(`guard ${ROOT} for 72h ask`);
    expect(commands.some((c) => /^(close|open) replies|quotes/.test(c))).toBe(false);
  });

  it('offers the way back for what the bot did, and nothing for what the owner did', async () => {
    const d = install();
    const { closeReplies } = await import('../shield.js');
    await closeReplies(d, ROOT, { why: 'manual' });
    await guardPost(ROOT, { mode: 'auto', hours: 72 });
    const card = await ownPostCard(ROOT, { fetchImpl: appview() });
    expect(card.text).toMatch(/replies: limited to people you follow, people you mention \(by me\)/);
    expect(card.text).toMatch(/guarded: 72h left, acts by itself/);
    const commands = card.options.map((o) => o.command);
    expect(commands).toContain(`open replies ${ROOT}`);
    expect(commands).toContain(`unguard ${ROOT}`);
    expect(commands).not.toContain(`close replies ${ROOT}`);
  });

  it("does not offer to close replies on a reply, or on a post the owner limited", async () => {
    install();
    const onReply = await ownPostCard(REPLY, { fetchImpl: appview() });
    expect(onReply.text).toMatch(/it is a reply, so they cannot be limited/);
    expect(onReply.options.map((o) => o.command)).not.toContain(`close replies ${REPLY}`);

    const theirs = { $type: TG, post: ROOT, createdAt: new Date().toISOString(), allow: [] };
    const viewed = await ownPostCard(ROOT, { fetchImpl: appview({ threadgate: theirs }), deps: { ...install(), gates: null } });
    expect(viewed.text).toMatch(/replies: closed \(by you\)/);
  });

  it('leaves watches out when watching is not on, and guards out when no trigger can fire', () => {
    const base = { uri: ROOT, root: true, gates: false, canWatch: false, canGuard: false, replyRule: ['following'] };
    expect(ownPostOptions(base).map((o) => o.command)).toEqual([`add everyone ${ROOT}`]);
  });
});

describe('in a DM pass', () => {
  function chatWith(logs) {
    const sent = [];
    let id = 0;
    const chat = {
      chat: {
        bsky: {
          convo: {
            getLog: async () => ({ data: { cursor: 'c1', logs } }),
            getMessages: async () => ({ data: { messages: [] } }),
            getConvo: async ({ convoId }) => ({
              data: {
                convo: {
                  id: convoId,
                  members: [{ did: BOT }, { did: OWNER }],
                  kind: { $type: 'chat.bsky.convo.defs#directConvo' },
                },
              },
            }),
            sendMessage: async ({ message }) => {
              sent.push(message.text);
              id += 1;
              return { data: { id: `b${id}` } };
            },
            addReaction: async () => ({}),
            removeReaction: async () => ({}),
          },
        },
      },
    };
    return { chat, sent };
  }
  const msg = (id, text, embed = null) => ({
    $type: 'chat.bsky.convo.defs#logCreateMessage',
    convoId: 'convo1',
    rev: id,
    message: {
      id,
      text,
      sender: { did: OWNER },
      sentAt: new Date().toISOString(),
      ...(embed ? { embed } : {}),
    },
  });
  const roster = {
    owner: OWNER,
    answers: (d) => d === OWNER,
    writes: (d) => d === OWNER,
    all: [OWNER],
    allWriters: [OWNER],
  };
  const pass = (chat, mode) =>
    runDmPass({
      chat,
      writeAgent: { session: { did: BOT } },
      getIo: async () => ({}),
      botDid: BOT,
      roster,
      generate: vi.fn(async () => ({ text: 'model', steps: [] })),
      mode,
      model: 'test/model',
    });

  beforeEach(async () => {
    await upsert('dm_cursor', [{ id: 1, cursor: 'c0' }]);
    vi.stubGlobal('fetch', appview());
  });

  for (const mode of ['classic', 'agent']) {
    it(`answers the owner's bare post with the card in ${mode} mode, and a number runs an option`, async () => {
      install();
      const first = chatWith([msg('m1', '', { $type: 'app.bsky.embed.record#view', record: { uri: ROOT } })]);
      await pass(first.chat, mode);
      expect(first.sent[0]).toMatch(/^Your post /);
      expect(first.sent[0]).toMatch(/reply with a number:\n1\. Watch it for 24 hours/);
      const [row] = await select('dm_choice', { eq: { convo_id: 'convo1' } });
      expect(row.last_post).toBe(ROOT);
      const guard = row.options.findIndex((o) => o.command.startsWith('guard '));

      const second = chatWith([msg('m2', String(guard + 1))]);
      await pass(second.chat, mode);
      expect(second.sent[0]).toMatch(/^Guarding /);
      expect((await liveGuards()).get(ROOT)?.mode).toBe('auto');

      const third = chatWith([msg('m3', '1')]);
      await pass(third.chat, mode);
      expect(third.sent[0]).toMatch(/^Stopped guarding/);
    });
  }

  it('runs the first option as a watch', async () => {
    install();
    await pass(chatWith([msg('m1', '', { $type: 'app.bsky.embed.record#view', record: { uri: ROOT } })]).chat, 'classic');
    const second = chatWith([msg('m2', '1')]);
    await pass(second.chat, 'classic');
    expect(watches).toEqual([[ROOT, 'convo1']]);
    expect(second.sent[0]).toMatch(/^Watching /);
  });
});
