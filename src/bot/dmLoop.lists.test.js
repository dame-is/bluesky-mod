// Whole DM passes in multi-list mode: a block that names no list is asked
// "Which list?" and a number answers it; an unblock looks for the account
// first; a card's words and a 👍 ask once; a plan is bound to one list. The
// lists come from a fake repo read, the writes are faked, and nothing here
// reaches a network.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const models = vi.hoisted(() => ({ on: true }));
vi.mock('../models.js', async (importOriginal) => ({
  ...(await importOriginal()),
  modelsEnabled: () => models.on,
}));

const db = {
  dm_cursor: [{ id: 1, cursor: 'c0' }],
  dm_choice: [],
  memory: [],
  plan: [],
};

vi.mock('./db.js', () => ({
  select: vi.fn(async (table, opts = {}) => {
    let rows = db[table] || [];
    for (const [k, v] of Object.entries(opts.eq || {})) {
      rows = rows.filter((r) => r[k] === v);
    }
    return rows;
  }),
  selectAll: vi.fn(async () => []),
  update: vi.fn(async (table, { eq }, patch) => {
    db.updates.push({ table, eq, patch });
  }),
  upsert: vi.fn(async (table, rows) => {
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

const config = { value: null };
vi.mock('./agentConfig.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadAgentConfig: async () => config.value,
}));

const listWrite = { applyCommand: vi.fn() };
vi.mock('./listWrite.js', async (importOriginal) => ({
  ...(await importOriginal()),
  applyCommand: (...args) => listWrite.applyCommand(...args),
}));

const PLAN_ID = '1c2d3e4f-0000-4000-8000-000000000000';
const plan = { row: null };
const plans = {
  proposePlan: vi.fn(),
  findPlan: vi.fn(async (code) => (code === '1c2d3e4f' ? plan.row : null)),
  applyPlan: vi.fn(async () => ({
    ok: true,
    added: 12,
    message: 'Added 12 to Spam.',
  })),
  handlesFor: vi.fn(
    async (dids) =>
      new Map(dids.map((d) => [d, { handle: `${d.split(':').pop()}.test` }])),
  ),
};
vi.mock('./bulkPlan.js', async (importOriginal) => ({
  ...(await importOriginal()),
  proposePlan: (...a) => plans.proposePlan(...a),
  findPlan: (...a) => plans.findPlan(...a),
  applyPlan: (...a) => plans.applyPlan(...a),
  handlesFor: (...a) => plans.handlesFor(...a),
}));

// Which lists each account is on, as Constellation answers per list.
const membership = new Map(); // `${list} ${did}` -> rkeys
vi.mock('./graphFacts.js', async (importOriginal) => ({
  ...(await importOriginal()),
  rkeysForWrite: vi.fn(async (list, did) => membership.get(`${list} ${did}`) ?? []),
}));

// Agent mode's model turn, faked: what the tools stored is what comes back.
const operator = { operate: vi.fn() };
vi.mock('./operator.js', async (importOriginal) => ({
  ...(await importOriginal()),
  operate: (...a) => operator.operate(...a),
}));

vi.mock('../lib/target.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveActor: async (a) =>
    String(a).startsWith('did:')
      ? a
      : `did:plc:${String(a).replace(/^@/, '').split('.')[0]}`,
}));

const { runDmPass } = await import('./dmLoop.js');
const { resetQuiet } = await import('./chatUx.js');
const { setListReader, resetLists, botLists } = await import('./lists.js');

const OWNER = 'did:plc:ownertestownertestowners';
const BOT = 'did:plc:bot';
const LIST = (rkey) => `at://${BOT}/app.bsky.graph.list/${rkey}`;
const MAIN = LIST('3main');
const SPAM = LIST('3spam');
const TROLLS = LIST('3trolls');
const MODLIST = 'app.bsky.graph.defs#modlist';
const records = () => [
  { uri: MAIN, value: { purpose: MODLIST, name: 'Block List', createdAt: '2026-01-01' } },
  { uri: SPAM, value: { purpose: MODLIST, name: 'Spam', createdAt: '2026-02-01' } },
  { uri: TROLLS, value: { purpose: MODLIST, name: 'Trolls', createdAt: '2026-03-01' } },
];

const directConvo = async ({ convoId }) => ({
  data: {
    convo: {
      id: convoId,
      members: [{ did: BOT }, { did: OWNER }],
      kind: { $type: 'chat.bsky.convo.defs#directConvo' },
    },
  },
});

const POST = 'at://did:plc:author/app.bsky.feed.post/3abc';
const roster = {
  owner: OWNER,
  answers: (d) => d === OWNER,
  writes: (d) => d === OWNER,
  all: [OWNER],
  allWriters: [OWNER],
};

let nextId = 0;
function chatWith(logs) {
  const sent = [];
  const reactions = [];
  const chat = {
    chat: {
      bsky: {
        convo: {
          getLog: async () => ({ data: { cursor: 'c1', logs } }),
          getMessages: async () => ({ data: { messages: [] } }),
          getConvo: directConvo,
          sendMessage: async ({ message }) => {
            sent.push(message.text);
            nextId += 1;
            return { data: { id: `b${nextId}` } };
          },
          addReaction: async ({ messageId, value }) => {
            reactions.push(`+${value}@${messageId}`);
            return {};
          },
          removeReaction: async ({ messageId, value }) => {
            reactions.push(`-${value}@${messageId}`);
            return {};
          },
        },
      },
    },
  };
  return { chat, sent, reactions };
}

const msg = (id, text, extra = {}) => ({
  $type: 'chat.bsky.convo.defs#logCreateMessage',
  convoId: 'convo1',
  message: {
    id,
    text,
    sender: { did: OWNER },
    sentAt: new Date().toISOString(),
    ...extra,
  },
});
const shared = (id, text) =>
  msg(id, text, { embed: { record: { uri: POST } } });

const io = {
  lookUp: async () => null,
  preflight: async () => ({}),
  referenceStatus: () => ({}),
};

const writeAgent = {
  session: { did: BOT },
  com: {
    atproto: {
      repo: {
        createRecord: vi.fn(async ({ repo, collection }) => ({
          data: { uri: `at://${repo}/${collection}/3hate` },
        })),
      },
    },
  },
};

function pass(chat, extra = {}) {
  return runDmPass({
    chat,
    writeAgent,
    getIo: async () => io,
    botDid: BOT,
    roster,
    generate: extra.generate || vi.fn(async () => ({ text: 'ok', steps: [] })),
    mode: 'classic',
    model: 'test/model',
    ...extra,
  });
}

/** What applyCommand was asked: [action, actor, list]. */
const writes = () =>
  listWrite.applyCommand.mock.calls.map((c) => [c[1], c[2], c[3].list]);

let repo;
beforeEach(() => {
  process.env.MOD_MULTI_LIST = 'true';
  process.env.MOD_LIST_URI = MAIN;
  repo = records();
  setListReader(async () => repo);
  db.dm_choice.length = 0;
  db.updates = [];
  config.value = null;
  membership.clear();
  resetQuiet();
  plan.row = { id: PLAN_ID, totals: { kind: 'everyone' }, approved_at: null };
  listWrite.applyCommand.mockReset();
  listWrite.applyCommand.mockImplementation(async (_agent, action, actor, opts) => ({
    ok: true,
    changed: true,
    did: actor,
    account: { handle: `${String(actor).split(':').pop()}.test`, band: 'UNKNOWN' },
    message: `${action === 'list_add' ? 'Added' : 'Removed'} ${actor} ${action === 'list_add' ? 'to' : 'from'} ${opts.list}.`,
  }));
  plans.proposePlan.mockReset();
  plans.applyPlan.mockClear();
});

afterEach(() => {
  setListReader(null);
  resetLists();
  delete process.env.MOD_MULTI_LIST;
});

describe('a block that names no list', () => {
  it('is not done: the bot asks which list, and "2" adds to the second', async () => {
    let { chat, sent } = chatWith([msg('m1', 'block @pest.test')]);
    await pass(chat);
    expect(listWrite.applyCommand).not.toHaveBeenCalled();
    expect(sent[0]).toBe(
      'Which list for @pest.test?\n\nreply with a number:\n1. Block List\n2. Spam\n3. Trolls',
    );

    ({ chat, sent } = chatWith([msg('m2', '2')]));
    await pass(chat);
    expect(writes()).toEqual([['list_add', 'did:plc:pest', SPAM]]);
    // The way back takes them off the same list.
    expect(sent[0]).toContain('reply with a number:\n1. Undo that');
    const undo = db.dm_choice[0].options[0];
    expect(undo.command).toBe('list remove did:plc:pest list:3spam');
  });

  it('goes straight to the list it names, by name or number', async () => {
    const { chat } = chatWith([
      msg('m1', 'block @pest.test to trolls'),
      msg('m2', 'block @other.test list:3spam'),
      msg('m3', 'block @third.test on 1'),
    ]);
    await pass(chat);
    expect(writes()).toEqual([
      ['list_add', 'pest.test', TROLLS],
      ['list_add', 'other.test', SPAM],
      ['list_add', 'third.test', MAIN],
    ]);
  });

  it('says a list it does not know, and asks rather than guessing', async () => {
    const { chat, sent } = chatWith([msg('m1', 'block @pest.test to nazis')]);
    await pass(chat);
    expect(listWrite.applyCommand).not.toHaveBeenCalled();
    expect(sent[0]).toMatch(/^I don't have a list called "nazis"\. Which list for @pest\.test\?/);
  });

  it('asks nothing when the bot has one list', async () => {
    repo = records().slice(0, 1);
    const { chat, sent } = chatWith([msg('m1', 'block @pest.test')]);
    await pass(chat);
    expect(writes()).toEqual([['list_add', 'pest.test', MAIN]]);
    expect(sent[0]).not.toMatch(/Which list/);
  });

  it('asks in the quick lane too, with no model, and a number answers it', async () => {
    const generate = vi.fn();
    let { chat, sent, reactions } = chatWith([shared('m1', 'block')]);
    await pass(chat, { mode: 'agent', generate });
    expect(generate).not.toHaveBeenCalled();
    expect(listWrite.applyCommand).not.toHaveBeenCalled();
    expect(sent[0]).toMatch(/^Which list for @author\.test\?\n\nreply with a number:\n1\. Block List/);
    // A question gets no check mark.
    expect(reactions).not.toContain('+✅@m1');

    ({ chat, sent } = chatWith([msg('m2', '3')]));
    await pass(chat, { mode: 'agent', generate });
    expect(generate).not.toHaveBeenCalled();
    expect(writes()).toEqual([['list_add', 'did:plc:author', TROLLS]]);
  });

  it('goes quietly in the quick lane when it names its list', async () => {
    const { chat, sent, reactions } = chatWith([shared('m1', 'block to spam')]);
    await pass(chat, { mode: 'agent' });
    expect(writes()).toEqual([['list_add', 'did:plc:author', SPAM]]);
    expect(sent).toEqual([]);
    expect(reactions).toContain('+✅@m1');
  });
});

describe('an unblock', () => {
  it('comes off the one list the account is on, without asking', async () => {
    membership.set(`${SPAM} did:plc:pest`, ['rk1']);
    const { chat, sent } = chatWith([msg('m1', 'unblock @pest.test')]);
    await pass(chat);
    expect(writes()).toEqual([['list_remove', 'pest.test', SPAM]]);
    expect(sent[0]).toMatch(/^Removed pest\.test from/);
  });

  it('asks which when the account is on several, with every list as an option', async () => {
    membership.set(`${MAIN} did:plc:pest`, ['rk1']);
    membership.set(`${TROLLS} did:plc:pest`, ['rk2']);
    let { chat, sent } = chatWith([msg('m1', 'unblock @pest.test')]);
    await pass(chat);
    expect(listWrite.applyCommand).not.toHaveBeenCalled();
    expect(sent[0]).toBe(
      '@pest.test is on 2 of your lists. Which should they come off?\n\nreply with a number:\n1. Block List\n2. Trolls\n3. Every list',
    );
    ({ chat, sent } = chatWith([msg('m2', '3')]));
    await pass(chat);
    expect(writes()).toEqual([
      ['list_remove', 'did:plc:pest', MAIN],
      ['list_remove', 'did:plc:pest', TROLLS],
    ]);
  });

  it('says so when the account is on none of them', async () => {
    const { chat, sent } = chatWith([msg('m1', 'unblock @pest.test')]);
    await pass(chat);
    expect(listWrite.applyCommand).not.toHaveBeenCalled();
    expect(sent[0]).toBe('@pest.test is not on any of your lists.');
  });

  it('takes "on all" as every list', async () => {
    const { chat } = chatWith([msg('m1', 'unblock @pest.test on all')]);
    await pass(chat);
    expect(writes().map((w) => w[2])).toEqual([MAIN, SPAM, TROLLS]);
  });
});

describe('approving a plan', () => {
  it('asks which list for a plan nothing has bound, then binds it to the answer', async () => {
    let { chat, sent } = chatWith([msg('m1', 'approve 1c2d3e4f UNKNOWN')]);
    await pass(chat);
    expect(plans.applyPlan).not.toHaveBeenCalled();
    expect(sent[0]).toMatch(/^Which list should plan 1c2d3e4f add to\?\n\nreply with a number:\n1\. Block List\n2\. Spam/);

    ({ chat, sent } = chatWith([msg('m2', '2')]));
    await pass(chat);
    expect(plans.applyPlan).toHaveBeenCalledTimes(1);
    expect(plans.applyPlan.mock.calls[0][1].list_uri).toBe(SPAM);
    expect(plans.applyPlan.mock.calls[0][2]).toEqual(['UNKNOWN']);
    expect(db.updates).toContainEqual({
      table: 'plan',
      eq: { id: PLAN_ID },
      patch: { list_uri: SPAM },
    });
  });

  it('goes where a bound plan went, and refuses another list', async () => {
    plan.row = { ...plan.row, list_uri: SPAM, approved_at: '2026-11-01T00:00:00Z' };
    let { chat, sent } = chatWith([msg('m1', 'approve 1c2d3e4f NOTABLE')]);
    await pass(chat);
    expect(plans.applyPlan).toHaveBeenCalledTimes(1);

    ({ chat, sent } = chatWith([msg('m2', 'approve 1c2d3e4f UNKNOWN to trolls')]));
    await pass(chat);
    expect(plans.applyPlan).toHaveBeenCalledTimes(1);
    expect(sent[0]).toBe(
      'Plan 1c2d3e4f adds to Spam, so it cannot add to Trolls as well. Scan the post again and approve that scan to Trolls.',
    );
  });

  it('treats a plan approved before the mode existed as bound to the main list', async () => {
    plan.row = { ...plan.row, approved_at: '2026-10-01T00:00:00Z' };
    const { chat, sent } = chatWith([msg('m1', 'approve 1c2d3e4f UNKNOWN to spam')]);
    await pass(chat);
    expect(plans.applyPlan).not.toHaveBeenCalled();
    expect(sent[0]).toMatch(/^Plan 1c2d3e4f adds to Block List, so it cannot add to Spam/);
  });
});

describe("a card's words", () => {
  const card = {
    code: '1c2d3e4f',
    uri: POST,
    author: { did: 'did:plc:author', handle: 'author.test' },
    total: 3,
    engagements: { like: 3 },
    byBand: { UNKNOWN: 3 },
    fresh: { total: 3, byBand: { UNKNOWN: 3 }, likers: 3 },
    withText: 0,
  };

  it('ask once for "author and likers", and the answer runs both on that list', async () => {
    plans.proposePlan.mockResolvedValue(card);
    let { chat, sent } = chatWith([shared('m1', '')]);
    await pass(chat, { mode: 'agent' });
    expect(sent[0]).toMatch(/reply with: author · likers/);

    ({ chat, sent } = chatWith([msg('m2', 'author and likers')]));
    await pass(chat, { mode: 'agent' });
    expect(listWrite.applyCommand).not.toHaveBeenCalled();
    expect(plans.applyPlan).not.toHaveBeenCalled();
    expect(sent[0]).toMatch(/^Which list\?\n\nreply with a number:\n1\. Block List\n2\. Spam\n3\. Trolls$/);

    ({ chat, sent } = chatWith([msg('m3', '2')]));
    await pass(chat, { mode: 'agent' });
    expect(writes()).toEqual([['list_add', 'did:plc:author', SPAM]]);
    expect(plans.applyPlan).toHaveBeenCalledTimes(1);
    expect(plans.applyPlan.mock.calls[0][1].list_uri).toBe(SPAM);
  });

  it('take a list named alongside them, and ask nothing', async () => {
    plans.proposePlan.mockResolvedValue(card);
    let { chat } = chatWith([shared('m1', '')]);
    await pass(chat, { mode: 'agent' });
    ({ chat } = chatWith([msg('m2', 'likers to trolls')]));
    await pass(chat, { mode: 'agent' });
    expect(plans.applyPlan).toHaveBeenCalledTimes(1);
    expect(plans.applyPlan.mock.calls[0][1].list_uri).toBe(TROLLS);
  });
});

describe('agent mode', () => {
  it('sends the "Which list?" a write tool stored, last, and a number does the write', async () => {
    operator.operate.mockImplementationOnce(async () => ({
      ok: true,
      text: 'Which list should @pest.test go on?',
      actions: [],
      links: [],
      pending: [],
      usages: [],
      steps: 1,
      listMenus: [
        {
          lists: await botLists(),
          commandsFor: (l) => [`list add did:plc:pest list:${l.rkey}`],
          describe: 'add @pest.test',
        },
      ],
    }));
    let { chat, sent } = chatWith([
      msg('m1', 'block @pest.test, they keep replying to me'),
    ]);
    await pass(chat, { mode: 'agent' });
    expect(listWrite.applyCommand).not.toHaveBeenCalled();
    expect(sent.at(-1)).toBe(
      'Which list? (add @pest.test)\n\nreply with a number:\n1. Block List\n2. Spam\n3. Trolls',
    );

    ({ chat, sent } = chatWith([msg('m2', '2')]));
    await pass(chat, { mode: 'agent' });
    expect(operator.operate).toHaveBeenCalledTimes(1);
    expect(writes()).toEqual([['list_add', 'did:plc:pest', SPAM]]);
  });
});

describe('the lists themselves', () => {
  it('"lists" numbers them as the menus do', async () => {
    const { chat, sent } = chatWith([msg('m1', 'lists')]);
    await pass(chat);
    expect(sent[0]).toMatch(/^Your lists:\n1\. Block List \(main\)\n2\. Spam\n3\. Trolls\n\n/);
  });

  it('"new list" makes one on the bot account', async () => {
    writeAgent.com.atproto.repo.createRecord.mockClear();
    const { chat, sent } = chatWith([msg('m1', 'new list Hate')]);
    await pass(chat);
    expect(writeAgent.com.atproto.repo.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: BOT,
        collection: 'app.bsky.graph.list',
        record: expect.objectContaining({ name: 'Hate', purpose: MODLIST }),
      }),
    );
    expect(sent[0]).toMatch(/^Made a list called "Hate", number 4\./);
  });

  it('say the mode is off when it is', async () => {
    delete process.env.MOD_MULTI_LIST;
    const { chat, sent } = chatWith([msg('m1', 'lists'), msg('m2', 'new list Hate')]);
    await pass(chat);
    expect(sent[0]).toMatch(/^Multi-list mode is off/);
    expect(sent[1]).toMatch(/^Multi-list mode is off/);
  });
});
