// The owner's new follows and curation-list items protect their subjects at
// once, against the real store.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = await import('./bot/db.js');
const { ownerGraphHandler } = await import('./ownerGraph.js');

const OWNER = 'did:plc:owner0000000000000000000';
const FRIEND = 'did:plc:friend000000000000000000';
const CURATE = 'app.bsky.graph.defs#curatelist';
const MODLIST = 'app.bsky.graph.defs#modlist';
const FRIENDS_LIST = `at://${OWNER}/app.bsky.graph.list/3friends`;
const MOD_LIST = `at://${OWNER}/app.bsky.graph.list/3mods`;

const lists = {
  [FRIENDS_LIST]: { purpose: CURATE, name: 'Friends' },
  [MOD_LIST]: { purpose: MODLIST, name: 'Spam' },
};
const fetchImpl = vi.fn(async (url) => {
  const uri = new URL(url).searchParams.get('list');
  return lists[uri]
    ? { ok: true, json: async () => ({ list: lists[uri] }) }
    : { ok: false, json: async () => ({}) };
});

const commit = (collection, record, { did = OWNER, operation = 'create' } = {}) => ({
  kind: 'commit',
  did,
  time_us: 1,
  commit: { operation, collection, rkey: '3abc', record },
});
const follow = (subject, opts) =>
  commit('app.bsky.graph.follow', { subject }, opts);
const listItem = (list, subject) =>
  commit('app.bsky.graph.listitem', { list, subject });

const protectedRows = () =>
  db.selectAll('protected', { select: 'did,reason,source', order: 'did.asc' });

let handle;
let protectedNow;

beforeEach(() => {
  db.closeDb();
  db.openDb(':memory:');
  fetchImpl.mockClear();
  protectedNow = [];
  handle = ownerGraphHandler({
    ownerDid: OWNER,
    fetchImpl,
    onProtect: (did) => protectedNow.push(did),
  });
});

describe('the owner graph watch', () => {
  it('protects someone the owner just followed', async () => {
    await handle(follow(FRIEND));
    expect(await protectedRows()).toEqual([
      { did: FRIEND, reason: 'you follow them', source: 'live' },
    ]);
    expect(protectedNow).toEqual([FRIEND]);
  });

  it('protects someone added to a curation list, named by the list', async () => {
    await handle(listItem(FRIENDS_LIST, FRIEND));
    expect(await protectedRows()).toEqual([
      { did: FRIEND, reason: 'list:Friends', source: 'live' },
    ]);
  });

  it('leaves members of a moderation list and of excluded lists alone', async () => {
    await handle(listItem(MOD_LIST, FRIEND));
    const excluding = ownerGraphHandler({
      ownerDid: OWNER,
      fetchImpl,
      excluded: [FRIENDS_LIST],
    });
    await excluding(listItem(FRIENDS_LIST, FRIEND));
    expect(await protectedRows()).toEqual([]);
  });

  it('protects when the list cannot be read, the safe way to be wrong', async () => {
    await handle(listItem(`at://${OWNER}/app.bsky.graph.list/3gone`, FRIEND));
    expect(await protectedRows()).toEqual([
      {
        did: FRIEND,
        reason: 'list:a list that could not be read',
        source: 'live',
      },
    ]);
  });

  it('keeps a row added by hand as it is', async () => {
    await db.upsert('protected', [
      { did: FRIEND, reason: 'added by hand', source: 'manual' },
    ]);
    await handle(follow(FRIEND));
    expect(await protectedRows()).toEqual([
      { did: FRIEND, reason: 'added by hand', source: 'manual' },
    ]);
    expect(protectedNow).toEqual([]);
  });

  it("ignores deletes, other people's repos, and anything that is not a DID", async () => {
    await handle(follow(FRIEND, { operation: 'delete' }));
    await handle(follow(FRIEND, { did: 'did:plc:someoneelse000000000000' }));
    await handle(follow('not-a-did'));
    await handle(listItem(`at://did:plc:other/app.bsky.graph.list/3x`, FRIEND));
    expect(await protectedRows()).toEqual([]);
  });

  it('does not open the write gate before the first snapshot', async () => {
    // The gate counts only the snapshot's own rows (listWrite.js).
    await handle(follow(FRIEND));
    const derived = await db.select('protected', {
      select: 'did',
      eq: { source: 'derived' },
      limit: 1,
    });
    expect(derived).toEqual([]);
  });
});
