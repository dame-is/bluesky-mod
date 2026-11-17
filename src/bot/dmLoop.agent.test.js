// One whole DM pass in agent mode, against an in-memory database and a fake
// chat service. The unit tests pin routeFor and the tools separately; this
// covers the wiring between them.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { dm_cursor: [], dm_choice: [], writes: [] };

vi.mock('./db.js', () => ({
  select: vi.fn(async (table, opts = {}) => {
    const rows = db[table] || [];
    const eq = opts.eq || {};
    return rows.filter((r) => Object.entries(eq).every(([k, v]) => r[k] === v));
  }),
  selectAll: vi.fn(async () => []),
  update: vi.fn(async () => {}),
  upsert: vi.fn(async (table, rows) => {
    db.writes.push({ table, rows });
    if (table === 'dm_cursor') db.dm_cursor = rows.map((r) => ({ ...r }));
    if (table === 'dm_choice') {
      for (const row of rows) {
        const i = db.dm_choice.findIndex((r) => r.convo_id === row.convo_id);
        if (i === -1) db.dm_choice.push({ ...row });
        else db.dm_choice[i] = { ...db.dm_choice[i], ...row };
      }
    }
    return rows.length;
  }),
}));

vi.mock('./agentConfig.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadAgentConfig: async () => null,
}));

const { runDmPass } = await import('./dmLoop.js');

const OWNER = 'did:plc:ownertestownertestowners';
const BOT = 'did:plc:bot';

/** The chat service's answer for a one-to-one conversation. */
const directConvo = async ({ convoId }) => ({
  data: {
    convo: {
      id: convoId,
      members: [{ did: BOT }, { did: OWNER }],
      kind: { $type: 'chat.bsky.convo.defs#directConvo' },
    },
  },
});

const roster = {
  owner: OWNER,
  answers: (d) => d === OWNER,
  writes: (d) => d === OWNER,
  all: [OWNER],
  allWriters: [OWNER],
};

function chatWith(text) {
  const sent = [];
  return {
    sent,
    chat: {
      chat: {
        bsky: {
          convo: {
            getLog: async () => ({
              data: {
                cursor: 'c1',
                logs: [
                  {
                    $type: 'chat.bsky.convo.defs#logCreateMessage',
                    convoId: 'convo1',
                    message: {
                      id: 'm1',
                      text,
                      sender: { did: OWNER },
                      sentAt: new Date().toISOString(),
                    },
                  },
                ],
              },
            }),
            getMessages: async () => ({ data: { messages: [] } }),
            getConvo: directConvo,
            sendMessage: async ({ message }) => {
              sent.push(message.text);
            },
          },
        },
      },
    },
  };
}

const io = {
  lookUp: async () => null,
  preflight: async () => ({}),
  referenceStatus: () => ({}),
};

beforeEach(() => {
  db.dm_cursor = [{ id: 1, cursor: 'c0' }];
  db.dm_choice.length = 0;
  db.writes.length = 0;
});

describe('a DM pass in agent mode', () => {
  it('sends words to the agent, with the write tools, and answers', async () => {
    const { chat, sent } = chatWith('block the person who wrote that');
    const generate = vi.fn(async () => ({
      text: 'Added @a.test.',
      steps: [{}],
      usage: { inputTokens: 5, outputTokens: 2 },
    }));
    const out = await runDmPass({
      chat,
      writeAgent: { session: { did: BOT } },
      getIo: async () => io,
      botDid: BOT,
      roster,
      generate,
      mode: 'agent',
      model: 'test/model',
    });
    expect(out.turns[0].agent).toBe(true);
    expect(sent).toEqual(['Added @a.test.']);
    const { tools, instructions } = generate.mock.calls[0][0];
    expect(tools).toHaveProperty('add_to_list');
    expect(tools).toHaveProperty('approve_plan');
    expect(instructions.content).toContain('YOU ARE TALKING TO: the owner');
    // The menu is cleared, so a "2" next reaches the agent rather than an
    // option some earlier classic reply offered.
    expect(db.dm_choice[0].options).toEqual([]);
    expect(
      db.writes.some(
        (w) => w.table === 'llm_usage' && w.rows[0].kind === 'dm-agent',
      ),
    ).toBe(true);
  });

  it('takes "!" to the classic path and never calls the agent', async () => {
    const { chat, sent } = chatWith('!help');
    const generate = vi.fn();
    const out = await runDmPass({
      chat,
      writeAgent: { session: { did: BOT } },
      getIo: async () => io,
      botDid: BOT,
      roster,
      generate,
      mode: 'agent',
      model: 'test/model',
    });
    expect(generate).not.toHaveBeenCalled();
    expect(out.turns[0].command).toBe('help');
    expect(sent[0]).toContain('pulse');
  });

  it('runs a live classic menu option for a bare number, and the agent otherwise', async () => {
    db.dm_choice.push({
      convo_id: 'convo1',
      options: [
        { label: 'Help', command: 'help', offered_at: new Date().toISOString() },
      ],
    });
    const generate = vi.fn(async () => ({ text: 'ok', steps: [] }));
    const first = chatWith('1');
    await runDmPass({
      chat: first.chat,
      writeAgent: { session: { did: BOT } },
      getIo: async () => io,
      botDid: BOT,
      roster,
      generate,
      mode: 'agent',
      model: 'test/model',
    });
    expect(generate).not.toHaveBeenCalled();

    db.dm_choice[0].options = [];
    const second = chatWith('1');
    await runDmPass({
      chat: second.chat,
      writeAgent: { session: { did: BOT } },
      getIo: async () => io,
      botDid: BOT,
      roster,
      generate,
      mode: 'agent',
      model: 'test/model',
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('lets a menu lapse thirty minutes after it was offered, however recently a post was remembered', async () => {
    // Offered forty minutes ago; a post was remembered on the same row since.
    db.dm_choice.push({
      convo_id: 'convo1',
      options: [
        {
          label: 'Help',
          command: 'help',
          offered_at: new Date(Date.now() - 40 * 60_000).toISOString(),
        },
      ],
      last_post: 'at://did:plc:author/app.bsky.feed.post/3abc',
      last_post_at: new Date().toISOString(),
    });
    const generate = vi.fn(async () => ({ text: 'ok', steps: [] }));
    const { chat } = chatWith('1');
    await runDmPass({
      chat,
      writeAgent: { session: { did: BOT } },
      getIo: async () => io,
      botDid: BOT,
      roster,
      generate,
      mode: 'agent',
      model: 'test/model',
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('says what it had already done when the turn fails', async () => {
    const { chat, sent } = chatWith('do the thing');
    const generate = vi.fn(async () => {
      throw new Error('gateway 502');
    });
    await runDmPass({
      chat,
      writeAgent: { session: { did: BOT } },
      getIo: async () => io,
      botDid: BOT,
      roster,
      generate,
      mode: 'agent',
      model: 'test/model',
    });
    // The second wave is announced before it runs, then fails the same way.
    expect(sent[0]).toMatch(/^Still on it: the first model failed/);
    expect(sent.at(-1)).toMatch(
      /failed: gateway 502[\s\S]*Nothing was changed/,
    );
  });

  it('gives the classic analyst no write tools', async () => {
    const { chat } = chatWith('what is going on');
    const generate = vi.fn(async () => ({ text: 'ok', steps: [] }));
    await runDmPass({
      chat,
      writeAgent: { session: { did: BOT } },
      getIo: async () => io,
      botDid: BOT,
      roster,
      generate,
      mode: 'classic',
      model: 'test/model',
    });
    // The read-only analyst: no write tool in the set.
    const { tools } = generate.mock.calls[0][0];
    expect(tools).not.toHaveProperty('add_to_list');
    expect(tools).toHaveProperty('look_up_account');
  });

  it('never answers its own messages, even with its DID on the roster', async () => {
    const { chat, sent } = chatWith('hello');
    const generate = vi.fn(async () => ({ text: 'ok', steps: [] }));
    const fromBot = await chat.chat.bsky.convo.getLog();
    fromBot.data.logs[0].message.sender.did = BOT;
    chat.chat.bsky.convo.getLog = async () => fromBot;
    await runDmPass({
      chat,
      writeAgent: { session: { did: BOT } },
      getIo: async () => io,
      botDid: BOT,
      roster: { ...roster, answers: () => true, writes: () => true },
      generate,
      mode: 'agent',
      model: 'test/model',
    });
    expect(generate).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('answers the first message on an account whose chat log was empty at start', async () => {
    db.dm_cursor = [];
    const message = {
      $type: 'chat.bsky.convo.defs#logCreateMessage',
      convoId: 'convo1',
      message: {
        id: 'm1',
        text: 'hello',
        sender: { did: OWNER },
        sentAt: new Date().toISOString(),
      },
    };
    let logs = [];
    const sent = [];
    const chat = {
      chat: {
        bsky: {
          convo: {
            // No cursor at all while the log is empty.
            getLog: async () =>
              logs.length ? { data: { cursor: 'c1', logs } } : { data: { logs } },
            getMessages: async () => ({ data: { messages: [] } }),
            getConvo: directConvo,
            sendMessage: async ({ message: m }) => {
              sent.push(m.text);
            },
          },
        },
      },
    };
    const generate = vi.fn(async () => ({ text: 'Hello.', steps: [] }));
    const run = () =>
      runDmPass({
        chat,
        writeAgent: { session: { did: BOT } },
        getIo: async () => io,
        botDid: BOT,
        roster,
        generate,
        mode: 'agent',
        model: 'test/model',
      });

    expect((await run()).coldStart).toBe(true);
    logs = [message];
    await run();
    expect(sent).toEqual(['Hello.']);
    expect(db.dm_cursor[0].cursor).toBe('c1');
  });
});
