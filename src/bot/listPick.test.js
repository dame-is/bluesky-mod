import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const plan = { row: null };
vi.mock('./bulkPlan.js', async (importOriginal) => ({
  ...(await importOriginal()),
  findPlan: vi.fn(async (code) => (code === '1c2d3e4f' ? plan.row : null)),
}));

const { namedIn, needsList, askListFor, withNamedList } = await import('./listPick.js');
const { setListReader, resetLists } = await import('./lists.js');

const BOT = 'did:plc:bot';
const MAIN = `at://${BOT}/app.bsky.graph.list/3main`;
const SPAM = `at://${BOT}/app.bsky.graph.list/3spam`;
const MODLIST = 'app.bsky.graph.defs#modlist';

beforeEach(() => {
  process.env.MOD_MULTI_LIST = 'true';
  process.env.MOD_LIST_URI = MAIN;
  plan.row = { id: '1c2d3e4f-0000-4000-8000-000000000000', approved_at: null };
  setListReader(async () => [
    { uri: MAIN, value: { purpose: MODLIST, name: 'Block List', createdAt: '1' } },
    { uri: SPAM, value: { purpose: MODLIST, name: 'Spam', createdAt: '2' } },
  ]);
});
afterEach(() => {
  setListReader(null);
  resetLists();
  delete process.env.MOD_MULTI_LIST;
});

describe('namedIn', () => {
  const spam = { name: 'Spam', n: 2, rkey: '3spam' };
  const main = { name: 'Block List', n: 1, rkey: '3main' };

  it('finds a list named in words, by number, or by its token', () => {
    expect(namedIn('put them on the spam list', spam)).toBe(true);
    expect(namedIn('add to block-list please', main)).toBe(true);
    expect(namedIn('add them to 2', spam)).toBe(true);
    expect(namedIn('list #2', spam)).toBe(true);
    expect(namedIn('list add did:plc:a list:3spam', spam)).toBe(true);
  });

  it('does not find it inside another word or another number', () => {
    expect(namedIn('the spammers are back', spam)).toBe(false);
    expect(namedIn('add them to 21', spam)).toBe(false);
    expect(namedIn('block @x', main)).toBe(false);
    expect(namedIn('', spam)).toBe(false);
  });
});

describe('needsList', () => {
  it('is true for a block, a blocking watch, and an approval of an unbound plan', async () => {
    expect(await needsList('list add did:plc:a')).toBe(true);
    expect(await needsList('watch at://did:plc:a/app.bsky.feed.post/1 24h auto')).toBe(true);
    expect(await needsList('approve 1c2d3e4f likers')).toBe(true);
    expect(await needsList('hostile 1c2d3e4f')).toBe(true);
  });

  it('is false once a list is named, for a bound plan, and for what finds its own list', async () => {
    expect(await needsList('list add did:plc:a list:3spam')).toBe(false);
    expect(await needsList('list remove did:plc:a')).toBe(false);
    expect(await needsList('undo 1c2d3e4f')).toBe(false);
    expect(await needsList('watch at://did:plc:a/app.bsky.feed.post/1 24h')).toBe(false);
    plan.row.list_uri = SPAM;
    expect(await needsList('approve 1c2d3e4f likers')).toBe(false);
  });

  it('is never true with the mode off', async () => {
    delete process.env.MOD_MULTI_LIST;
    expect(await needsList('list add did:plc:a')).toBe(false);
    expect(await askListFor(['list add did:plc:a'])).toBeNull();
  });
});

describe('askListFor', () => {
  it('asks once, and each option runs every command with the list on those that need it', async () => {
    const out = await askListFor(['list add did:plc:a', 'approve 1c2d3e4f likers', 'cancel 1c2d3e4f']);
    expect(out.text).toBe('Which list?');
    expect(out.options[1]).toEqual({
      label: 'Spam',
      command: 'list add did:plc:a list:3spam',
      commands: [
        'list add did:plc:a list:3spam',
        'approve 1c2d3e4f likers list:3spam',
        'cancel 1c2d3e4f',
      ],
    });
  });

  it('asks nothing when no command needs a list', async () => {
    expect(await askListFor(['list remove did:plc:a', 'undo'])).toBeNull();
  });

  it('puts a list named in words on the commands that need one', async () => {
    expect(await withNamedList(['list add did:plc:a', 'cancel 1c2d3e4f'], 'spam')).toEqual([
      'list add did:plc:a list:spam',
      'cancel 1c2d3e4f',
    ]);
  });
});
