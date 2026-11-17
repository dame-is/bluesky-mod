// The shield in a DM: who may run what, which post it acts on, and that its
// menus and questions run through the real DM pass.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { freshStore } from './testStores.js';
import { select, upsert } from './db.js';
import { createGates } from '../gates.js';
import { createActivity } from '../ownerActivity.js';
import { readShieldConfig } from '../lib/shieldConfig.js';
import { createClassifier, createPostInfo, readState } from '../shield.js';
import { setShieldDeps, shieldTurn, sendNotice, menuText } from './shieldDm.js';
import { runDmPass } from './dmLoop.js';

const OWNER = 'did:plc:owner0000000000000000000';
const WRITER = 'did:plc:writer000000000000000000';
const BOT = 'did:plc:bot';
const TG = 'app.bsky.feed.threadgate';
const POSTS = 'app.bsky.feed.post';
const ROOT = `at://${OWNER}/${POSTS}/3kroot`;

/** Just enough of the owner's repo for the gate writer. */
function fakeRepo() {
  const records = new Map([[`${POSTS}/3kroot`, { $type: POSTS, text: 'hi', createdAt: new Date().toISOString() }]]);
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

let repo;
let watches;

function install({ gates = true } = {}) {
  const { shield } = readShieldConfig({ MOD_OWNER_APP_PASSWORD: 'abcd-efgh-ijkl-mnop' });
  const g = gates ? createGates({ getAgent: () => repo.agent, ownerDid: OWNER }) : null;
  setShieldDeps({
    cfg: shield,
    gates: g,
    activity: createActivity(),
    outsideAmong: createClassifier({ score: async () => new Map() }),
    postInfo: createPostInfo({ gates: g }),
    startWatch: async (uri, convoId) => watches.push([uri, convoId]),
    dryRun: false,
    log: () => {},
  });
}

const turn = (text, extra = {}) =>
  shieldTurn({
    text,
    embedUri: null,
    links: [],
    isOwner: true,
    choice: async () => null,
    lastPost: async () => null,
    convoId: 'c1',
    ...extra,
  });

beforeEach(async () => {
  await freshStore('sqlite', ':memory:');
  repo = fakeRepo();
  watches = [];
  install();
});

describe('shieldTurn', () => {
  it('is nothing to do with messages that are not for it', async () => {
    expect(await turn('block @someone.example.com')).toBeNull();
    // A number whose menu option is a list command stays the list's.
    expect(await turn('1', { choice: async () => 'list add did:plc:x' })).toBeNull();
  });

  it('closes replies on the post attached, and offers the way back', async () => {
    const out = await turn('close replies', { embedUri: ROOT });
    expect(out.outcome).toBe('done');
    expect(out.text).toMatch(/Closed replies/);
    expect(repo.gate().allow).toHaveLength(2);
    expect(out.options).toEqual([{ label: 'Open replies again', command: `open replies ${ROOT}` }]);
  });

  it('runs the option a number picks from its menu', async () => {
    await turn('close replies to nobody', { embedUri: ROOT });
    expect(repo.gate().allow).toEqual([]);
    const out = await turn('1', { choice: async (n) => (n === 1 ? `open replies ${ROOT}` : null) });
    expect(out.text).toMatch(/open again/);
    expect(repo.gate()).toBeNull();
  });

  it('falls back to the post sent last, and asks when there is none', async () => {
    expect((await turn('no quotes')).text).toMatch(/Which post/);
    const out = await turn('no quotes', { lastPost: async () => ROOT });
    expect(out.text).toMatch(/Turned quotes off/);
  });

  it('only touches the owner\'s own posts', async () => {
    const out = await turn('close replies', {
      embedUri: 'at://did:plc:someoneelse/app.bsky.feed.post/3k',
    });
    expect(out.text).toMatch(/not one of your posts/);
    expect(repo.gate()).toBeNull();
  });

  it('lets anyone on the roster see the status, and only the owner change anything', async () => {
    const status = await turn('shield', { isOwner: false });
    expect(status.text).toMatch(/Attack mode: off/);
    expect(status.options).toBeNull();
    for (const t of ['shields up', 'shields down', 'close replies', 'enable quotes']) {
      const out = await turn(t, { isOwner: false, embedUri: ROOT });
      expect(out.text).toMatch(/Only the account I work for/);
    }
    expect(repo.gate()).toBeNull();
    expect((await readState()).attackUntil).toBeNull();
  });

  it('says what it needs without the owner\'s password, and offers a watch', async () => {
    install({ gates: false });
    const out = await turn('close replies', { embedUri: ROOT });
    expect(out.text).toMatch(/MOD_OWNER_APP_PASSWORD/);
    expect(out.options.map((o) => o.command)).toEqual([`shield watch ${ROOT}`]);
    const watched = await turn('1', { choice: async () => out.options[0].command });
    expect(watched.text).toMatch(/Watching/);
    expect(watches).toEqual([[ROOT, 'c1']]);
  });

  it('turns attack mode on and off', async () => {
    const up = await turn('shields up for 6h');
    expect(up.text).toMatch(/Attack mode is on until/);
    expect(repo.gate().allow).toHaveLength(2);
    const down = await turn('all clear');
    expect(down.text).toMatch(/Stood down/);
    expect(repo.gate()).toBeNull();
  });

  it('says why a rule it cannot read was not used', async () => {
    const out = await turn('close replies to friends', { embedUri: ROOT });
    expect(out.text).toMatch(/friends/);
    expect(repo.gate()).toBeNull();
  });
});

describe('guard', () => {
  it('guards a post to act by itself with the password, and says what will happen', async () => {
    install();
    const out = await turn(`guard ${ROOT} for 2 days`);
    expect(out.text).toMatch(/^Guarding .* for 48h\. If 12 accounts outside your circle reply within 15 min, or 6 quote it within 15 min, I'll close replies to following and mentioned or turn quotes off by myself/);
    expect(out.options.map((o) => o.command)).toEqual([`unguard ${ROOT}`]);
  });

  it('only tells without the password, and says why when acting was asked for', async () => {
    install({ gates: false });
    const out = await turn(`guard ${ROOT} auto`);
    expect(out.text).toMatch(/I'll tell you and ask first\. \(Closing them by myself needs MOD_OWNER_APP_PASSWORD\.\)/);
  });

  it('is the owner\'s alone, and only for their own posts', async () => {
    install();
    expect((await turn(`guard ${ROOT}`, { isOwner: false })).text).toMatch(/Only the account I work for/);
    expect((await turn('guard at://did:plc:else/app.bsky.feed.post/1')).text).toMatch(/not one of your posts/);
  });
});

describe('sendNotice', () => {
  it('stores its menu and its question, but never over one already open', async () => {
    const sent = [];
    const chat = {
      chat: { bsky: { convo: { sendMessage: async ({ message }) => (sent.push(message.text), { data: { id: `m${sent.length}` } }) } } },
    };
    const options = [{ label: 'Shields up', command: 'shields up' }];
    await sendNotice(chat, 'c1', { text: 'pile-on', options, pending: ['shields up'], describe: 'shields up' });
    expect(sent[0]).toBe(`${menuText('pile-on', options)}\n\n👍 or "yes" to: shields up`);
    const [row] = await select('dm_choice', { eq: { convo_id: 'c1' } });
    expect(row.options.map((o) => o.command)).toEqual(['shields up']);
    expect(row.pending.commands).toEqual(['shields up']);

    await sendNotice(chat, 'c1', { text: 'again', pending: ['shields down'], describe: 'down' });
    expect(sent[1]).toBe('again');
    const [after] = await select('dm_choice', { eq: { convo_id: 'c1' } });
    expect(after.pending.commands).toEqual(['shields up']);
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
              data: { convo: { id: convoId, members: [{ did: BOT }, { did: OWNER }], kind: { $type: 'chat.bsky.convo.defs#directConvo' } } },
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
  const msg = (id, text, extra = {}) => ({
    $type: 'chat.bsky.convo.defs#logCreateMessage',
    convoId: 'convo1',
    rev: id,
    message: { id, text, sender: { did: extra.from || OWNER }, sentAt: new Date().toISOString(), ...(extra.embed ? { embed: extra.embed } : {}) },
  });
  const roster = {
    owner: OWNER,
    answers: (d) => d === OWNER || d === WRITER,
    writes: (d) => d === OWNER || d === WRITER,
    all: [OWNER, WRITER],
    allWriters: [OWNER, WRITER],
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
  });

  for (const mode of ['classic', 'agent']) {
    it(`routes the shield before the ${mode} path, and a number answers its menu`, async () => {
      const first = chatWith([msg('m1', 'lock replies', { embed: { record: { uri: ROOT } } })]);
      await pass(first.chat, mode);
      expect(first.sent[0]).toMatch(/Closed replies/);
      expect(first.sent[0]).toMatch(/reply with a number:\n1\. Open replies again/);
      expect(repo.gate()).not.toBeNull();

      const second = chatWith([msg('m2', '1')]);
      await pass(second.chat, mode);
      expect(second.sent[0]).toMatch(/open again/);
      expect(repo.gate()).toBeNull();
    });
  }

  it('runs a stored shield question on a yes, for the owner only', async () => {
    const asked = chatWith([]);
    await sendNotice(asked.chat, 'convo1', { text: 'pile-on', pending: ['shields up'], describe: 'shields up' });

    const writer = chatWith([msg('m1', 'yes', { from: WRITER })]);
    await pass(writer.chat, 'classic');
    expect(writer.sent.join('\n')).toMatch(/Only the account I work for/);
    expect((await readState()).attackUntil).toBeNull();

    await sendNotice(asked.chat, 'convo1', { text: 'pile-on', pending: ['shields up'], describe: 'shields up' });
    const owner = chatWith([msg('m2', 'yes')]);
    await pass(owner.chat, 'classic');
    expect(owner.sent.join('\n')).toMatch(/Attack mode is on/);
    expect((await readState()).attackUntil).not.toBeNull();
  });
});
