// What the bot sets up on its own account at its first start.

import { describe, it, expect } from 'vitest';
import { ensureDmsOpen, findOrCreateList } from './bootstrap.js';

const BOT = 'did:plc:bot00000000000000000000';
const MODLIST = 'app.bsky.graph.defs#modlist';

function agentWith({ lists = [], declaration = null } = {}) {
  const writes = [];
  const agent = {
    session: { did: BOT },
    com: {
      atproto: {
        repo: {
          listRecords: async () => ({ data: { records: lists } }),
          getRecord: async () => {
            if (declaration) return { data: { value: declaration } };
            throw Object.assign(new Error('not found'), { error: 'RecordNotFound' });
          },
          putRecord: async (r) => writes.push({ op: 'put', ...r }),
          createRecord: async (r) => {
            writes.push({ op: 'create', ...r });
            return { data: { uri: `at://${BOT}/app.bsky.graph.list/3new` } };
          },
        },
      },
    },
  };
  return { agent, writes };
}

describe("the bot's list", () => {
  it('is made when the bot has none', async () => {
    const { agent, writes } = agentWith();
    expect(await findOrCreateList(agent)).toEqual({
      uri: `at://${BOT}/app.bsky.graph.list/3new`,
      name: 'Block list',
      created: true,
    });
    expect(writes[0].record).toMatchObject({ purpose: MODLIST, name: 'Block list' });
  });

  it('is the one it has, and only a moderation list counts', async () => {
    const { agent, writes } = agentWith({
      lists: [
        { uri: `at://${BOT}/app.bsky.graph.list/3a`, value: { purpose: MODLIST, name: 'quiet' } },
        { uri: `at://${BOT}/app.bsky.graph.list/3b`, value: { purpose: 'app.bsky.graph.defs#curatelist', name: 'friends' } },
      ],
    });
    expect(await findOrCreateList(agent)).toMatchObject({ name: 'quiet', created: false });
    expect(writes).toEqual([]);
  });

  it('is the owner to choose when there are several', async () => {
    const { agent } = agentWith({
      lists: [
        { uri: `at://${BOT}/app.bsky.graph.list/3a`, value: { purpose: MODLIST, name: 'one' } },
        { uri: `at://${BOT}/app.bsky.graph.list/3b`, value: { purpose: MODLIST, name: 'two' } },
      ],
    });
    await expect(findOrCreateList(agent)).rejects.toThrow(/set MOD_LIST_URI/);
  });
});

describe("the bot's DMs", () => {
  it('open to everyone, keeping what else the declaration says', async () => {
    const { agent, writes } = agentWith({
      declaration: { $type: 'chat.bsky.actor.declaration', allowIncoming: 'following', allowGroupInvites: 'none' },
    });
    expect(await ensureDmsOpen(agent)).toBe('opened');
    expect(writes[0].record).toMatchObject({ allowIncoming: 'all', allowGroupInvites: 'none' });
    const open = agentWith({ declaration: { allowIncoming: 'all' } });
    expect(await ensureDmsOpen(open.agent)).toBe('already');
    expect(open.writes).toEqual([]);
  });
});
