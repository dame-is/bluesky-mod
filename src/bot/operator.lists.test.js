// Agent mode in multi-list mode: the write tools take a list, a write goes to
// a list only when the owner named it, and otherwise the owner is asked with
// a menu built by code. The write check reads which list when it is known.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const membership = new Map(); // `${list} ${did}` -> rkeys
vi.mock('./graphFacts.js', async (importOriginal) => ({
  ...(await importOriginal()),
  rkeysForWrite: vi.fn(async (list, did) => membership.get(`${list} ${did}`) ?? []),
}));
const updates = [];
vi.mock('./db.js', async (importOriginal) => ({
  ...(await importOriginal()),
  update: vi.fn(async (table, match, patch) => updates.push({ table, match, patch })),
}));

const { buildActionTools, operatorPrompt, actionText } = await import('./operator.js');
const { setListReader, resetLists } = await import('./lists.js');

const BOT = 'did:plc:bot';
const LIST = (rkey) => `at://${BOT}/app.bsky.graph.list/${rkey}`;
const MAIN = LIST('3main');
const SPAM = LIST('3spam');
const MODLIST = 'app.bsky.graph.defs#modlist';
const PLAN = { id: '3f9a2c1b-0000-4000-8000-000000000000', note: 'scan', totals: {} };

function deps(overrides = {}) {
  return {
    applyCommand: vi.fn(async (_agent, action, actor, opts) => ({
      ok: true,
      did: actor,
      message: `${action} ${actor} ${opts.list ?? '(main)'}`,
    })),
    findPlan: vi.fn(async () => PLAN),
    applyPlan: vi.fn(async () => ({ ok: true, added: 3, remaining: 0, message: 'Added 3.' })),
    countDecisions: vi.fn(async () => 3),
    decisionsFor: vi.fn(async () => new Map()),
    handlesFor: vi.fn(async () => new Map()),
    resolveActor: vi.fn(async (a) =>
      String(a).startsWith('did:') ? a : `did:plc:${String(a).replace(/^@/, '').split('.')[0]}`,
    ),
    checkIntent: vi.fn(async () => ({ allow: true, by: 'test', why: 'asked for', usage: [] })),
    startWatch: vi.fn(async () => ({ extended: false, watch: { uri: 'at://x/app.bsky.feed.post/1' } })),
    ...overrides,
  };
}

function ctxFor(said, extra = {}) {
  return {
    writeAgent: { session: { did: BOT } },
    canWrite: true,
    raw: said,
    said,
    ownerText: '',
    earlier: '',
    convoText: '',
    generate: vi.fn(),
    model: 'test/model',
    log: () => {},
    lookUp: null,
    actions: [],
    links: new Set(),
    plans: [],
    pending: [],
    listMenus: [],
    checkWrites: true,
    convoId: 'convo1',
    ...extra,
  };
}

beforeEach(() => {
  process.env.MOD_MULTI_LIST = 'true';
  process.env.MOD_LIST_URI = MAIN;
  membership.clear();
  updates.length = 0;
  PLAN.list_uri = undefined;
  PLAN.approved_at = undefined;
  setListReader(async () => [
    { uri: MAIN, value: { purpose: MODLIST, name: 'Block List', createdAt: '2026-01-01' } },
    { uri: SPAM, value: { purpose: MODLIST, name: 'Spam', createdAt: '2026-02-01' } },
  ]);
});

afterEach(() => {
  setListReader(null);
  resetLists();
  delete process.env.MOD_MULTI_LIST;
});

describe('add_to_list with several lists', () => {
  it('is not done when the owner named no list: the owner is asked with a menu', async () => {
    const d = deps();
    const ctx = ctxFor('block @pest.test');
    const tools = buildActionTools(ctx, d);
    const out = await tools.add_to_list.execute({ accounts: ['@pest.test'] });
    expect(d.applyCommand).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: false, notDone: true, waitingOnOwner: true });
    expect(out.result).toMatch(/1\. Block List, 2\. Spam/);
    expect(ctx.listMenus).toHaveLength(1);
    const [menu] = ctx.listMenus;
    expect(menu.commandsFor({ rkey: '3spam' })).toEqual(['list add did:plc:pest list:3spam']);
  });

  it('does not take a list the agent chose by itself', async () => {
    const d = deps();
    const ctx = ctxFor('block @pest.test, they keep posting junk');
    const tools = buildActionTools(ctx, d);
    await tools.add_to_list.execute({ accounts: ['@pest.test'], list: 'spam' });
    expect(d.applyCommand).not.toHaveBeenCalled();
    expect(ctx.listMenus).toHaveLength(1);
  });

  it('writes to the list the owner named, and the check reads which', async () => {
    const d = deps();
    const ctx = ctxFor('put @pest.test on the spam list');
    const tools = buildActionTools(ctx, d);
    await tools.add_to_list.execute({ accounts: ['@pest.test'], list: 'spam' });
    expect(d.applyCommand.mock.calls[0][3].list).toBe(SPAM);
    expect(d.checkIntent.mock.calls[0][0].action).toBe(
      'Add 1 account to the moderation list "Spam": @pest.test (named in the owner\'s message).',
    );
  });

  it('reads the list from the owner\'s words when the agent passed none', async () => {
    const d = deps();
    const ctx = ctxFor('block @pest.test to 2');
    const tools = buildActionTools(ctx, d);
    await tools.add_to_list.execute({ accounts: ['@pest.test'] });
    expect(d.applyCommand.mock.calls[0][3].list).toBe(SPAM);
  });

  it("asks rather than taking a list's name said as an ordinary word", async () => {
    // "spam" describes the account here; it does not choose the Spam list.
    for (const passed of [undefined, 'spam']) {
      const d = deps();
      const ctx = ctxFor("block @pest.test, it's spam");
      const tools = buildActionTools(ctx, d);
      await tools.add_to_list.execute({ accounts: ['@pest.test'], ...(passed ? { list: passed } : {}) });
      expect(d.applyCommand).not.toHaveBeenCalled();
      expect(ctx.listMenus).toHaveLength(1);
    }
  });

  it('puts a refused write to the owner with the list they named on it', async () => {
    const d = deps({
      checkIntent: vi.fn(async () => ({ allow: false, by: 'test', why: 'unclear', usage: [] })),
    });
    const ctx = ctxFor('add @pest.test to spam');
    const tools = buildActionTools(ctx, d);
    await tools.add_to_list.execute({ accounts: ['@pest.test'], list: 'spam' });
    expect(ctx.pending[0].commands).toEqual(['list add did:plc:pest list:3spam']);
    expect(ctx.listMenus).toHaveLength(0);
  });
});

describe('remove_from_list with several lists', () => {
  it('takes an account off the one list it is on, without asking', async () => {
    membership.set(`${SPAM} did:plc:pest`, ['rk']);
    const d = deps();
    const ctx = ctxFor('unblock @pest.test');
    const tools = buildActionTools(ctx, d);
    await tools.remove_from_list.execute({ accounts: ['@pest.test'] });
    expect(d.applyCommand.mock.calls.map((c) => c[3].list)).toEqual([SPAM]);
  });

  it('asks about an account on several, with every list as an option', async () => {
    membership.set(`${MAIN} did:plc:pest`, ['rk1']);
    membership.set(`${SPAM} did:plc:pest`, ['rk2']);
    const d = deps();
    const ctx = ctxFor('unblock @pest.test');
    const tools = buildActionTools(ctx, d);
    await tools.remove_from_list.execute({ accounts: ['@pest.test'] });
    expect(d.applyCommand).not.toHaveBeenCalled();
    expect(ctx.listMenus[0].all).toEqual([
      'list remove did:plc:pest list:3main',
      'list remove did:plc:pest list:3spam',
    ]);
  });
});

describe('approve_plan with several lists', () => {
  it('binds an unbound plan to the list the owner named', async () => {
    const d = deps();
    const ctx = ctxFor('approve 3f9a2c1b UNKNOWN to spam');
    const tools = buildActionTools(ctx, d);
    await tools.approve_plan.execute({ code: '3f9a2c1b', bands: ['UNKNOWN'], list: 'spam' });
    expect(updates).toContainEqual({
      table: 'plan',
      match: { eq: { id: PLAN.id } },
      patch: { list_uri: SPAM },
    });
    expect(d.applyPlan.mock.calls[0][1].list_uri).toBe(SPAM);
  });

  it('asks for an unbound plan when the owner named no list', async () => {
    const d = deps();
    const ctx = ctxFor('approve 3f9a2c1b UNKNOWN');
    const tools = buildActionTools(ctx, d);
    const out = await tools.approve_plan.execute({ code: '3f9a2c1b', bands: ['UNKNOWN'] });
    expect(d.applyPlan).not.toHaveBeenCalled();
    expect(out.waitingOnOwner).toBe(true);
    expect(ctx.listMenus[0].commandsFor({ rkey: '3main' })).toEqual([
      'approve 3f9a2c1b UNKNOWN list:3main',
    ]);
  });

  it('refuses a list other than the one a plan is bound to', async () => {
    PLAN.list_uri = MAIN;
    const d = deps();
    const ctx = ctxFor('approve 3f9a2c1b UNKNOWN to spam');
    const tools = buildActionTools(ctx, d);
    const out = await tools.approve_plan.execute({ code: '3f9a2c1b', bands: ['UNKNOWN'], list: 'spam' });
    expect(out.error).toMatch(/adds to Block List, so it cannot add to Spam/);
    expect(d.applyPlan).not.toHaveBeenCalled();
  });
});

describe('the tools and the prompt with one list', () => {
  it('take no list argument and say nothing about lists', () => {
    delete process.env.MOD_MULTI_LIST;
    const tools = buildActionTools(ctxFor('block @x.test'), deps());
    expect(tools.add_to_list.inputSchema.shape.list).toBeUndefined();
    expect(operatorPrompt({ canWrite: true })).not.toMatch(/SEVERAL LISTS/);
    expect(actionText('add', { accounts: ['@x'] })).toBe(
      'Add 1 account to the moderation list: @x.',
    );
  });

  it('take one, and the prompt explains it, in multi-list mode', () => {
    const tools = buildActionTools(ctxFor('block @x.test'), deps());
    expect(tools.add_to_list.inputSchema.shape.list).toBeDefined();
    expect(tools.approve_plan.inputSchema.shape.list).toBeDefined();
    expect(operatorPrompt({ canWrite: true })).toMatch(/SEVERAL LISTS/);
    expect(operatorPrompt({ canWrite: false })).not.toMatch(/SEVERAL LISTS/);
  });
});
