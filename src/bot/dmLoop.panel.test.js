// "panel" in a DM asks for a sign-in code for the web panel. The reply is a
// credential, so it is answered by code in either mode, only while there is
// a panel, and only to the sender. Against a fake chat service, with the
// agent faked so a message that reaches a model is seen to.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const op = { operate: vi.fn() };
vi.mock('./operator.js', async (importOriginal) => ({
  ...(await importOriginal()),
  operate: (...a) => op.operate(...a),
}));
vi.mock('./agentConfig.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadAgentConfig: async () => null,
}));

const db = await import('./db.js');
const { runDmPass, resetConvoKinds } = await import('./dmLoop.js');
const { resetQuiet } = await import('./chatUx.js');

const OWNER = 'did:plc:ownertestownertestowners';
const GUEST = 'did:plc:guesttestguesttestguests';
const BOT = 'did:plc:bot';
const roster = {
  owner: OWNER,
  answers: (d) => d === OWNER || d === GUEST,
  writes: (d) => d === OWNER,
  all: [OWNER, GUEST],
  allWriters: [OWNER],
};

let seq = 0;
const nextRev = () => `p${String(++seq).padStart(8, '0')}`;
const msg = (id, text, sender = OWNER) => ({
  $type: 'chat.bsky.convo.defs#logCreateMessage',
  rev: nextRev(),
  convoId: sender === OWNER ? 'c1' : 'c2',
  message: { id, text, sender: { did: sender }, sentAt: new Date().toISOString() },
});

function chatOver(log) {
  const sent = [];
  const convo = {
    getLog: async ({ cursor } = {}) => {
      const logs = cursor ? log.filter((e) => e.rev > cursor) : log;
      return { data: { cursor: logs.at(-1)?.rev ?? cursor, logs } };
    },
    getMessages: async () => ({ data: { messages: [] } }),
    getConvo: async ({ convoId }) => ({
      data: {
        convo: {
          id: convoId,
          members: [{ did: BOT }, { did: convoId === 'c1' ? OWNER : GUEST }],
          kind: { $type: 'chat.bsky.convo.defs#directConvo' },
        },
      },
    }),
    sendMessage: async ({ convoId, message }) => {
      sent.push({ convoId, text: message.text });
      return { data: { id: `b${sent.length}` } };
    },
    addReaction: async () => ({}),
    removeReaction: async () => ({}),
  };
  return { chat: { chat: { bsky: { convo } } }, sent };
}

const pass = (chat, extra = {}) =>
  runDmPass({
    chat,
    writeAgent: { session: { did: BOT } },
    getIo: async () => ({ lookUp: async () => null }),
    botDid: BOT,
    roster,
    generate: vi.fn(async () => ({ text: 'a model wrote this', steps: [] })),
    mode: 'classic',
    model: 'test/model',
    ...extra,
  });

beforeEach(async () => {
  db.closeDb();
  db.openDb(':memory:');
  await db.upsert('dm_cursor', [{ id: 1, cursor: nextRev() }]);
  resetQuiet();
  resetConvoKinds();
  op.operate.mockReset();
});

describe('"panel" in a DM', () => {
  const signIn = () => vi.fn(async (did) => `code for ${did}`);

  for (const text of ['panel', 'Panel', ' panel. ', 'panel code', 'panel?']) {
    it(`"${text}" is answered with the sender's code, by code`, async () => {
      const hook = signIn();
      const { chat, sent } = chatOver([msg('m1', text)]);
      const generate = vi.fn();
      const res = await pass(chat, { signIn: hook, generate });
      expect(hook).toHaveBeenCalledExactlyOnceWith(OWNER);
      expect(sent).toEqual([{ convoId: 'c1', text: `code for ${OWNER}` }]);
      expect(generate).not.toHaveBeenCalled();
      expect(res.turns).toEqual([{ convoId: 'c1', panel: 'code' }]);
    });
  }

  it('is answered the same way in agent mode, with or without the "!"', async () => {
    for (const text of ['panel', '!panel']) {
      const hook = signIn();
      const { chat, sent } = chatOver([msg(`m-${text}`, text)]);
      await pass(chat, { signIn: hook, mode: 'agent' });
      expect(hook).toHaveBeenCalledExactlyOnceWith(OWNER);
      expect(sent).toHaveLength(1);
      expect(op.operate).not.toHaveBeenCalled();
    }
  });

  it('gives a read-only guest their own code, in their own conversation', async () => {
    const hook = signIn();
    const { chat, sent } = chatOver([msg('m1', 'panel', GUEST)]);
    await pass(chat, { signIn: hook });
    expect(hook).toHaveBeenCalledExactlyOnceWith(GUEST);
    expect(sent).toEqual([{ convoId: 'c2', text: `code for ${GUEST}` }]);
  });

  it('is only the word alone: a sentence about a panel is a sentence', async () => {
    const hook = signIn();
    for (const text of ['what is the panel?', 'panel discussion on transit tonight', 'open the panel for me please']) {
      const { chat } = chatOver([msg(`m-${text}`, text)]);
      await pass(chat, { signIn: hook });
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it('means nothing special when there is no panel', async () => {
    const { chat, sent } = chatOver([msg('m1', 'panel')]);
    const generate = vi.fn(async () => ({ text: 'a model wrote this', steps: [] }));
    const res = await pass(chat, { generate });
    expect(res.turns.some((t) => t.panel)).toBe(false);
    expect(sent.some((s) => /code/.test(s.text))).toBe(false);
  });

  it('falls through when the hook has no code to give', async () => {
    const hook = vi.fn(async () => null);
    const { chat } = chatOver([msg('m1', 'panel')]);
    const res = await pass(chat, { signIn: hook });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(res.turns.some((t) => t.panel)).toBe(false);
  });
});
