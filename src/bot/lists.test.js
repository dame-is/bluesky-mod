// The registry of the bot's lists in multi-list mode: which lists, in what
// order, what a typed word means, and making a new one.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const BOT = 'did:plc:bot0000000000000000000000';
const PRIMARY = `at://${BOT}/app.bsky.graph.list/3primary`;

const lists = await import('./lists.js');
const {
  botLists,
  resolveList,
  createList,
  listName,
  listsText,
  listMenu,
  setListReader,
  resetLists,
  nameKey,
} = lists;

const MODLIST = 'app.bsky.graph.defs#modlist';
const rec = (rkey, name, createdAt, extra = {}) => ({
  uri: `at://${BOT}/app.bsky.graph.list/${rkey}`,
  value: { purpose: MODLIST, name, createdAt, ...extra },
});

let records;

beforeEach(() => {
  process.env.MOD_LIST_URI = PRIMARY;
  process.env.MOD_MULTI_LIST = 'true';
  records = [
    rec('3zz', 'Trolls', '2026-03-01T00:00:00.000Z'),
    rec('3primary', 'Block List', '2026-05-01T00:00:00.000Z'),
    rec('3aa', 'Spam', '2026-01-01T00:00:00.000Z'),
    // A curation list is not a list anyone can block with.
    rec('3cur', 'Friends', '2026-01-02T00:00:00.000Z', {
      purpose: 'app.bsky.graph.defs#curatelist',
    }),
    // Nothing in another repo is ever the bot's to write.
    {
      uri: 'at://did:plc:someoneelse/app.bsky.graph.list/3x',
      value: { purpose: MODLIST, name: 'Theirs', createdAt: '2025-01-01' },
    },
  ];
  setListReader(async (repo) => {
    expect(repo).toBe(BOT);
    return records;
  });
});

afterEach(() => {
  setListReader(null);
  resetLists();
  delete process.env.MOD_MULTI_LIST;
});

describe('botLists', () => {
  it('numbers the primary first, then the rest by when they were made', async () => {
    const got = await botLists();
    expect(got.map((l) => [l.n, l.name, l.rkey])).toEqual([
      [1, 'Block List', '3primary'],
      [2, 'Spam', '3aa'],
      [3, 'Trolls', '3zz'],
    ]);
  });

  it('is only MOD_LIST_URI with the mode off, and reads nothing', async () => {
    delete process.env.MOD_MULTI_LIST;
    const reader = vi.fn();
    setListReader(reader);
    expect(await botLists()).toEqual([
      { uri: PRIMARY, rkey: '3primary', name: 'the list', n: 1 },
    ]);
    expect(reader).not.toHaveBeenCalled();
    expect(listName(PRIMARY)).toBe('the list');
  });

  it('reuses what it read, and reads again when asked to', async () => {
    const reader = vi.fn(async () => records);
    setListReader(reader);
    await botLists();
    await botLists();
    expect(reader).toHaveBeenCalledTimes(1);
    await botLists({ refresh: true });
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('refuses rather than guesses when the lists cannot be read at all', async () => {
    setListReader(async () => {
      throw new Error('PDS down');
    });
    await expect(botLists()).rejects.toThrow(/could not read your lists/);
  });

  it('keeps the last good read when a later one fails', async () => {
    let down = false;
    setListReader(async () => {
      if (down) throw new Error('PDS down');
      return records;
    });
    await botLists();
    down = true;
    const got = await botLists({ refresh: true });
    expect(got.map((l) => l.name)).toEqual(['Block List', 'Spam', 'Trolls']);
  });

  it('still lists the primary first when its record cannot be found', async () => {
    records = records.filter((r) => !r.uri.endsWith('/3primary'));
    const got = await botLists();
    expect(got[0]).toMatchObject({ uri: PRIMARY, n: 1 });
    expect(got.map((l) => l.name)).toEqual(['main list', 'Spam', 'Trolls']);
  });
});

describe('resolveList', () => {
  let all;
  beforeEach(async () => {
    records.push(rec('3sp2', 'Spammers', '2026-06-01T00:00:00.000Z'));
    all = await botLists();
  });

  it('takes a number, an rkey, a name in any spelling, or a unique start of one', () => {
    expect(resolveList('2', all).list.name).toBe('Spam');
    expect(resolveList('3zz', all).list.name).toBe('Trolls');
    expect(resolveList('block-list', all).list.name).toBe('Block List');
    expect(resolveList('BLOCKLIST', all).list.name).toBe('Block List');
    expect(resolveList('trol', all).list.name).toBe('Trolls');
    // "spam" is a whole name, so it is not ambiguous with "Spammers".
    expect(resolveList('spam', all).list.name).toBe('Spam');
  });

  it('says why rather than picking when the word names none or several', () => {
    expect(resolveList('9', all).error).toMatch(/no list 9/);
    expect(resolveList('nazis', all).error).toMatch(/don't have a list called "nazis"/);
    expect(resolveList('sp', all).error).toMatch(/more than one/);
  });

  it('reads "all" as every list only where that is allowed', () => {
    expect(resolveList('all', all, { allowAll: true })).toEqual({ all: true });
    expect(resolveList('all', all).error).toBeTruthy();
  });

  it('names lists for replies, and numbers them in a menu', () => {
    expect(listName(all[1].uri)).toBe('Spam');
    expect(listsText(all.slice(0, 2))).toBe('1. Block List (main)\n2. Spam');
    const options = listMenu(all.slice(0, 2), (l) => [`list add did:plc:a list:${l.rkey}`], {
      all: ['x', 'y'],
    });
    expect(options).toEqual([
      { label: 'Block List', command: 'list add did:plc:a list:3primary', commands: ['list add did:plc:a list:3primary'] },
      { label: 'Spam', command: 'list add did:plc:a list:3aa', commands: ['list add did:plc:a list:3aa'] },
      { label: 'Every list', command: 'x', commands: ['x', 'y'] },
    ]);
  });

  it('compares names with case, spaces and hyphens ignored', () => {
    expect(nameKey('Block - List')).toBe(nameKey('blocklist'));
  });
});

describe('createList', () => {
  const agentFor = () => {
    const created = [];
    return {
      created,
      session: { did: BOT },
      com: {
        atproto: {
          repo: {
            createRecord: vi.fn(async ({ repo, collection, record }) => {
              created.push({ repo, collection, record });
              const rkey = `3new${created.length}`;
              records.push({ uri: `at://${repo}/${collection}/${rkey}`, value: record });
              return { data: { uri: `at://${repo}/${collection}/${rkey}` } };
            }),
          },
        },
      },
    };
  };

  it('makes a moderation list in the bot repo and gives it the next number', async () => {
    const agent = agentFor();
    const out = await createList(agent, '  "Pile-on accounts" ');
    expect(out.ok).toBe(true);
    expect(agent.created[0]).toMatchObject({
      repo: BOT,
      collection: 'app.bsky.graph.list',
      record: { purpose: MODLIST, name: 'Pile-on accounts' },
    });
    expect(out.list).toMatchObject({ n: 4, name: 'Pile-on accounts' });
    expect(out.message).toMatch(/number 4/);
    expect(out.link).toBe(`https://bsky.app/profile/${BOT}/lists/3new1`);
  });

  it('refuses a name already in use, however it is spelled', async () => {
    const agent = agentFor();
    const out = await createList(agent, 'block-list');
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/already have a list called "Block List" \(number 1\)/);
    expect(agent.created).toHaveLength(0);
  });

  it('refuses names that would read as a number or as every list, or are too long', async () => {
    const agent = agentFor();
    expect((await createList(agent, '2')).ok).toBe(false);
    expect((await createList(agent, 'all')).ok).toBe(false);
    expect((await createList(agent, 'x'.repeat(65))).ok).toBe(false);
    expect((await createList(agent, '   ')).ok).toBe(false);
    expect(agent.created).toHaveLength(0);
  });

  it('refuses to make lists for an account that does not own MOD_LIST_URI', async () => {
    const agent = agentFor();
    agent.session.did = 'did:plc:other';
    const out = await createList(agent, 'Spam two');
    expect(out.ok).toBe(false);
    expect(agent.created).toHaveLength(0);
  });
});
