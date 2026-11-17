// Whole DM passes for where the cursor goes and what a pass answers: a
// backlog past MAX_BACKLOG, a restart in the middle of a pass, a cold start
// on a long log, messages the bot already answered, and a reply that cannot
// be sent after a change went through. Against the real database (SQLite in
// memory) and a fake chat service whose log is ordered by rev, with the list
// write, the plan functions and the agent faked.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const listWrite = { applyCommand: vi.fn() };
vi.mock('./listWrite.js', async (importOriginal) => ({
  ...(await importOriginal()),
  applyCommand: (...a) => listWrite.applyCommand(...a),
}));

const PLAN = { id: '1c2d3e4f-0000-4000-8000-000000000000', totals: {} };
const plans = {
  findPlan: vi.fn(async (code) => (code === '1c2d3e4f' ? PLAN : null)),
  lastChange: vi.fn(async () => ({ plan: PLAN, removed: null })),
  undoPlan: vi.fn(async () => ({
    ok: true,
    removed: 12,
    message: 'Took 12 back off.',
  })),
};
vi.mock('./bulkPlan.js', async (importOriginal) => ({
  ...(await importOriginal()),
  findPlan: (...a) => plans.findPlan(...a),
  lastChange: (...a) => plans.lastChange(...a),
  undoPlan: (...a) => plans.undoPlan(...a),
}));

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
const { resetQuiet, savePending } = await import('./chatUx.js');

const OWNER = 'did:plc:ownertestownertestowners';
const BOT = 'did:plc:bot';
const roster = {
  owner: OWNER,
  answers: (d) => d === OWNER,
  writes: (d) => d === OWNER,
  all: [OWNER],
  allWriters: [OWNER],
};

// Revs only ever grow, across tests too, so no cursor is ever reused.
let seq = 0;
const nextRev = () => `r${String(++seq).padStart(8, '0')}`;

const msg = (id, text, { at = new Date().toISOString() } = {}) => ({
  $type: 'chat.bsky.convo.defs#logCreateMessage',
  rev: nextRev(),
  convoId: 'c1',
  message: { id, text, sender: { did: OWNER }, sentAt: at },
});
const botReacted = (messageId, value) => ({
  $type: 'chat.bsky.convo.defs#logAddReaction',
  rev: nextRev(),
  convoId: 'c1',
  message: { id: messageId, sender: { did: OWNER } },
  reaction: { value, sender: { did: BOT } },
});

/**
 * A chat service over `log`. getLog returns the entries after the cursor (or
 * from `inclusive`, at it too), `page.size` at a time, and the rev of the
 * last one as the next cursor.
 */
function chatOver(log, { page = { size: 100 }, inclusive = false } = {}) {
  const sent = [];
  const reactions = [];
  const state = { failSend: null, hangOn: null };
  const convo = {
    getLog: async ({ cursor } = {}) => {
      const after = cursor
        ? log.filter((e) => (inclusive ? e.rev >= cursor : e.rev > cursor))
        : log;
      const logs = after.slice(0, page.size);
      return { data: { cursor: logs.at(-1)?.rev ?? cursor, logs } };
    },
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
    sendMessage: async ({ convoId, message }) => {
      if (state.failSend) throw new Error(state.failSend);
      sent.push({ convoId, text: message.text });
      return { data: { id: `b${sent.length}` } };
    },
    addReaction: async ({ messageId, value }) => {
      if (state.hangOn === messageId) return new Promise(() => {});
      reactions.push(`+${value}@${messageId}`);
      return {};
    },
    removeReaction: async ({ messageId, value }) => {
      reactions.push(`-${value}@${messageId}`);
      return {};
    },
  };
  return { chat: { chat: { bsky: { convo } } }, sent, reactions, state };
}

function pass(chat, extra = {}) {
  return runDmPass({
    chat,
    writeAgent: { session: { did: BOT } },
    getIo: async () => ({ lookUp: async () => null }),
    botDid: BOT,
    roster,
    generate: vi.fn(async () => ({ text: 'model said ok', steps: [] })),
    mode: 'classic',
    model: 'test/model',
    ...extra,
  });
}

async function storedCursor() {
  const rows = await db.select('dm_cursor', {
    select: 'cursor',
    eq: { id: 1 },
  });
  return rows?.[0]?.cursor;
}

beforeEach(async () => {
  db.closeDb();
  db.openDb(':memory:');
  await db.upsert('dm_cursor', [{ id: 1, cursor: nextRev() }]);
  resetQuiet();
  resetConvoKinds();
  listWrite.applyCommand.mockReset();
  for (const f of [...Object.values(plans), op.operate]) f.mockClear();
});

describe('a change whose reply cannot be sent', () => {
  for (const text of ['undo 1c2d3e4f', 'undo']) {
    it(`"${text}": keeps the ✅, so the undo is not sent again`, async () => {
      const { chat, reactions, state } = chatOver([msg('m1', text)]);
      state.failSend = 'Rate Limit Exceeded';
      const logged = [];
      await pass(chat, { log: (line) => logged.push(line) });
      expect(plans.undoPlan).toHaveBeenCalledTimes(1);
      expect(reactions).toContain('+✅@m1');
      expect(reactions).not.toContain('+❌@m1');
      expect(logged).toContain(
        'A change went through but its reply was not sent',
      );
    });
  }

  it('still gets ❌ when nothing changed and nothing was said', async () => {
    const { chat, reactions, state } = chatOver([msg('m1', 'help')]);
    state.failSend = 'Rate Limit Exceeded';
    await pass(chat);
    expect(reactions).toContain('+❌@m1');
  });

  it('agent mode: keeps the ✅, and stores no question nobody saw', async () => {
    op.operate.mockResolvedValueOnce({
      ok: true,
      text: 'Took those 12 back off. Want the author off too?',
      actions: ['undo 1c2d3e4f'],
      pending: [
        { commands: ['list remove did:plc:a'], describe: 'take @a off' },
      ],
      links: [],
      usages: [],
      steps: 2,
      trace: [],
      checks: [],
    });
    const { chat, reactions, state } = chatOver([
      msg('m1', 'take the last batch back off'),
    ]);
    state.failSend = 'Rate Limit Exceeded';
    await pass(chat, { mode: 'agent' });
    expect(op.operate).toHaveBeenCalledTimes(1);
    expect(reactions).toContain('+✅@m1');
    expect(reactions).not.toContain('+❌@m1');
    const rows = await db.select('dm_choice', {
      select: 'pending',
      eq: { convo_id: 'c1' },
    });
    expect(rows?.[0]?.pending ?? null).toBe(null);
  });
});

describe('the reaction says what a command did, not what its reply says', () => {
  const tickOf = (reactions, id = 'm1') =>
    reactions.filter((r) => /^\+(✅|❌)@/.test(r) && r.endsWith(`@${id}`));

  for (const text of [
    'approve 1c2d3e4f hostile except @friend.test',
    'approve 1c2d3e4f UNKNOWN thanks',
    'undo zz',
    'approve 1c2d3e4f',
    'block',
  ]) {
    it(`"${text}": a refusal or a nudge gets no ✅`, async () => {
      const { chat, reactions } = chatOver([msg('m1', text)]);
      await pass(chat);
      expect(listWrite.applyCommand).not.toHaveBeenCalled();
      expect(plans.undoPlan).not.toHaveBeenCalled();
      expect(tickOf(reactions)).toEqual([]);
    });
  }

  it('a bare undo after an unblock gets no ✅, the reply sent or not', async () => {
    plans.lastChange.mockResolvedValueOnce({
      plan: null,
      removed: { did: 'did:plc:s', planId: 'p', at: new Date().toISOString() },
    });
    let { chat, reactions, sent, state } = chatOver([msg('m1', 'undo')]);
    await pass(chat);
    expect(sent.at(-1).text).toMatch(/so nothing was undone/);
    expect(plans.undoPlan).not.toHaveBeenCalled();
    expect(tickOf(reactions)).toEqual([]);

    plans.lastChange.mockResolvedValueOnce({
      plan: null,
      removed: { did: 'did:plc:s', planId: 'p', at: new Date().toISOString() },
    });
    ({ chat, reactions, state } = chatOver([msg('m2', 'undo')]));
    state.failSend = 'Rate Limit Exceeded';
    await pass(chat);
    expect(tickOf(reactions, 'm2')).not.toContain('+✅@m2');
  });

  it('a block that went on the list but missed the log gets its ✅', async () => {
    listWrite.applyCommand.mockResolvedValue({
      ok: true,
      changed: true,
      logged: false,
      did: 'did:plc:pest',
      message:
        'Added @pest.test to the list, but I could not record it, so undo and history will not find it. "unblock @pest.test" takes it back.',
    });
    let { chat, reactions, state } = chatOver([msg('m1', 'block @pest.test')]);
    await pass(chat);
    expect(tickOf(reactions)).toEqual(['+✅@m1']);

    // And keeps it when the reply cannot be sent: the block went through.
    ({ chat, reactions, state } = chatOver([msg('m2', 'block @pest.test')]));
    state.failSend = 'Rate Limit Exceeded';
    await pass(chat);
    expect(tickOf(reactions, 'm2')).toEqual(['+✅@m2']);
  });

  it('a block that was refused gets no ✅', async () => {
    listWrite.applyCommand.mockResolvedValue({
      ok: false,
      did: BOT,
      message: "@bot.test is this bot's own account, so I have not added it.",
    });
    const { chat, reactions } = chatOver([msg('m1', 'block @bot.test')]);
    await pass(chat);
    expect(tickOf(reactions)).toEqual([]);
  });

  it('a "yes" to a stored approval the parser refuses gets no ✅', async () => {
    await savePending('c1', {
      commands: ['approve 1c2d3e4f hostile except @friend.test'],
      describe: 'add the hostile ones but not @friend.test',
      messageIds: ['b-asked'],
    });
    const { chat, reactions } = chatOver([msg('m1', 'yes')]);
    await pass(chat);
    expect(tickOf(reactions)).toEqual(['+❌@m1']);
  });
});

describe('a backlog', () => {
  it('past 30 messages says what it skipped, in the conversation', async () => {
    const log = Array.from({ length: 35 }, (_, i) =>
      msg(`m${i + 1}`, i < 5 ? `block @skipped${i + 1}.test` : 'history'),
    );
    const { chat, sent, reactions } = chatOver(log);
    const res = await pass(chat);
    expect(res.answered).toBe(30);
    expect(listWrite.applyCommand).not.toHaveBeenCalled();
    expect(sent[0].text).toBe(
      [
        'Too many messages were waiting, so I skipped the oldest 5:',
        '"block @skipped1.test"',
        '"block @skipped2.test"',
        '"block @skipped3.test"',
        '"block @skipped4.test"',
        '"block @skipped5.test"',
        'Send again any that still matter.',
      ].join('\n'),
    );
    expect(sent.filter((s) => s.text === 'Nothing done yet.')).toHaveLength(
      30,
    );
    for (let i = 1; i <= 5; i += 1) {
      expect(reactions.some((r) => r.endsWith(`@m${i}`))).toBe(false);
    }
    expect(reactions).toContain('+👀@m6');
    expect(await storedCursor()).toBe(log.at(-1).rev);
  });

  it('says so for one skipped message too', async () => {
    const log = Array.from({ length: 31 }, (_, i) =>
      msg(`m${i + 1}`, 'history'),
    );
    const { chat, sent } = chatOver(log);
    await pass(chat);
    expect(sent[0].text).toMatch(/skipped the oldest one:\n"history"\n/);
  });
});

describe('a restart in the middle of a pass', () => {
  it('drops the message in flight and answers the ones after it', async () => {
    const log = [
      msg('m1', 'history'),
      msg('m2', 'history'),
      msg('m3', 'history'),
    ];
    const first = chatOver(log);
    first.state.hangOn = 'm2';
    // The process stops while m2 is being handled.
    pass(first.chat);
    await vi.waitFor(async () =>
      expect(await storedCursor()).toBe(log[1].rev),
    );
    expect(first.sent.map((s) => s.text)).toEqual(['Nothing done yet.']);

    const second = chatOver(log);
    const res = await pass(second.chat);
    expect(res.answered).toBe(1);
    expect(second.reactions).toContain('+👀@m3');
    expect(second.reactions.some((r) => r.endsWith('@m2'))).toBe(false);
    expect(await storedCursor()).toBe(log[2].rev);
  });

  it('does not read the entry at the cursor again', async () => {
    const log = [msg('m1', 'history'), msg('m2', 'history')];
    await db.upsert('dm_cursor', [{ id: 1, cursor: log[0].rev }]);
    const { chat, reactions } = chatOver(log, { inclusive: true });
    const res = await pass(chat);
    expect(res.answered).toBe(1);
    expect(reactions.some((r) => r.endsWith('@m1'))).toBe(false);
  });
});

describe('messages answered before', () => {
  it('are not answered again when their reaction is on the page', async () => {
    // As after a restored backup: the cursor is behind messages the bot
    // already picked up and reacted to.
    const log = [
      msg('m1', 'history'),
      botReacted('m1', '👀'),
      botReacted('m1', '✅'),
      msg('m2', 'history'),
    ];
    const { chat, sent, reactions } = chatOver(log);
    const res = await pass(chat);
    expect(res.answered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(reactions.some((r) => r.endsWith('@m1'))).toBe(false);
    expect(reactions).toContain('+👀@m2');
  });
});

describe('a cold start on a log longer than it reads', () => {
  it('says it stopped short, and answers nothing sent before it', async () => {
    db.closeDb();
    db.openDb(':memory:');
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const log = Array.from({ length: 55 }, (_, i) =>
      msg(`old${i + 1}`, 'history', { at: old }),
    );
    const page = { size: 1 };
    const { chat, sent } = chatOver(log, { page });
    const logged = [];
    const cold = await pass(chat, { log: (line) => logged.push(line) });
    expect(cold.coldStart).toBe(true);
    expect(logged[0]).toMatch(/longer than a cold start reads/);
    expect(await storedCursor()).toBe(log[49].rev);

    // The owner writes after the start; the rest of the history is read in
    // the same pass.
    log.push(msg('new', 'history'));
    page.size = 100;
    const res = await pass(chat);
    expect(res.answered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await storedCursor()).toBe(log.at(-1).rev);
  });
});
