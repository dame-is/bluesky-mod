// setup.js runs when it is imported, so each test imports a fresh copy with
// the bot's agent mocked. Every repo write the mock receives is recorded.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const OWNER = 'did:plc:owner0000000000000000000';
const BOT = 'did:plc:bot00000000000000000000';
const LIST = `at://${BOT}/app.bsky.graph.list/3old`;
const MODLIST = 'app.bsky.graph.defs#modlist';

const h = vi.hoisted(() => ({
  logins: 0,
  writes: [],
  lists: [],
  declaration: null,
  getRecordError: null,
  finished: null,
}));

vi.mock('../src/bot/botAgent.js', () => {
  const agent = {
    session: { did: 'did:plc:bot00000000000000000000', handle: 'bot.test' },
    com: {
      atproto: {
        repo: {
          getRecord: async ({ collection, rkey }) => {
            if (h.getRecordError) throw h.getRecordError;
            if (collection === 'chat.bsky.actor.declaration') {
              if (h.declaration) return { data: { value: h.declaration } };
            }
            const list = h.lists.find((l) => l.uri.endsWith(`/${rkey}`));
            if (collection === 'app.bsky.graph.list' && list) {
              return { data: { value: list.value } };
            }
            throw Object.assign(new Error('Could not locate record'), {
              error: 'RecordNotFound',
            });
          },
          listRecords: async () => ({ data: { records: h.lists } }),
          putRecord: async (r) => {
            h.writes.push({ op: 'put', ...r });
            return {};
          },
          createRecord: async (r) => {
            h.writes.push({ op: 'create', ...r });
            return { data: { uri: `at://${r.repo}/${r.collection}/3new` } };
          },
        },
      },
    },
  };
  const chat = {
    chat: { bsky: { convo: { getLog: async () => ({ data: { logs: [] } }) } } },
  };
  return {
    botAgent: async () => {
      h.logins += 1;
      return { agent, via: 'login' };
    },
    chatView: () => chat,
  };
});

vi.mock('../src/bot/db.js', async (importOriginal) => ({
  ...(await importOriginal()),
  openDb: () => {},
  closeDb: () => h.finished(),
}));

let out;
let savedEnv;
let savedArgv;

/** Run setup.js once with these settings and arguments, to the end. */
async function setup(env = {}, args = []) {
  Object.assign(process.env, {
    MOD_OWNER_DID: OWNER,
    MOD_IDENTIFIER: BOT,
    MOD_APP_PASSWORD: 'not-a-real-password',
    MOD_LIST_URI: '',
    ...env,
  });
  process.argv = [...savedArgv.slice(0, 2), ...args];
  const done = new Promise((resolve) => {
    h.finished = resolve;
  });
  await import('./setup.js');
  await done;
  return out.join('\n');
}

beforeEach(() => {
  Object.assign(h, {
    logins: 0,
    writes: [],
    lists: [],
    declaration: null,
    getRecordError: null,
  });
  out = [];
  savedEnv = { ...process.env };
  savedArgv = process.argv;
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation((l) => out.push(String(l)));
  vi.spyOn(console, 'error').mockImplementation((l) => out.push(String(l)));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = savedEnv;
  process.argv = savedArgv;
  process.exitCode = 0;
});

describe('which account setup writes to', () => {
  it("refuses the owner's own DID as the bot, before logging in", async () => {
    const text = await setup({ MOD_IDENTIFIER: OWNER });
    expect(process.exitCode).toBe(1);
    expect(h.logins).toBe(0);
    expect(h.writes).toEqual([]);
    expect(text).toMatch(/MOD_IDENTIFIER is the same account as MOD_OWNER_DID/);
  });

  it('refuses a handle for the bot, before logging in', async () => {
    const text = await setup({ MOD_IDENTIFIER: 'bot.bsky.social' });
    expect(process.exitCode).toBe(1);
    expect(h.logins).toBe(0);
    expect(h.writes).toEqual([]);
    expect(text).toMatch(/MOD_IDENTIFIER must be the bot account's DID/);
  });
});

describe('the list', () => {
  it('makes one when the bot has none', async () => {
    const text = await setup();
    expect(process.exitCode ?? 0).toBe(0);
    expect(h.writes.filter((w) => w.op === 'create')).toHaveLength(1);
    expect(text).toContain(`MOD_LIST_URI=at://${BOT}/app.bsky.graph.list/3new`);
  });

  it('offers the existing one instead of making a second', async () => {
    h.lists = [{ uri: LIST, value: { purpose: MODLIST, name: 'quiet' } }];
    const text = await setup();
    expect(process.exitCode).toBe(1);
    expect(h.writes.filter((w) => w.op === 'create')).toEqual([]);
    expect(text).toContain(`MOD_LIST_URI=${LIST}`);
    expect(text).toContain('--new');
  });

  it('makes another with --new', async () => {
    h.lists = [{ uri: LIST, value: { purpose: MODLIST, name: 'quiet' } }];
    await setup({}, ['--new']);
    expect(process.exitCode ?? 0).toBe(0);
    expect(h.writes.filter((w) => w.op === 'create')).toHaveLength(1);
  });

  it('does not count a curation list as an existing one', async () => {
    h.lists = [
      { uri: LIST, value: { purpose: 'app.bsky.graph.defs#curatelist', name: 'friends' } },
    ];
    await setup();
    expect(h.writes.filter((w) => w.op === 'create')).toHaveLength(1);
  });

  it('checks the list MOD_LIST_URI names', async () => {
    h.lists = [{ uri: LIST, value: { purpose: MODLIST, name: 'quiet' } }];
    const text = await setup({ MOD_LIST_URI: LIST });
    expect(process.exitCode ?? 0).toBe(0);
    expect(text).toContain('List: "quiet" is ready.');
  });

  it('reports a failed read as itself, not as a missing list', async () => {
    h.getRecordError = Object.assign(new Error('Upstream Failure'), {
      error: 'UpstreamFailure',
      status: 502,
    });
    const text = await setup({ MOD_LIST_URI: LIST });
    expect(process.exitCode).toBe(1);
    expect(text).toContain('Upstream Failure');
    expect(text).not.toMatch(/does not exist/);
  });
});

describe('who may start a DM', () => {
  it('keeps the other fields of an existing declaration', async () => {
    h.declaration = {
      $type: 'chat.bsky.actor.declaration',
      allowIncoming: 'following',
      allowGroupInvites: 'none',
    };
    await setup();
    const put = h.writes.find((w) => w.op === 'put');
    expect(put.record).toMatchObject({
      $type: 'chat.bsky.actor.declaration',
      allowIncoming: 'all',
      allowGroupInvites: 'none',
    });
  });
});
