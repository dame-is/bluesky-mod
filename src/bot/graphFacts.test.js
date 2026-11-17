import { describe, it, expect, vi, beforeEach } from 'vitest';

const constellation = {
  getBacklinks: vi.fn(),
  getManyToMany: vi.fn(),
};
vi.mock('../lib/constellation.js', () => constellation);
const atproto = {
  resolvePds: vi.fn(async () => 'https://pds.test'),
  fetchWithTimeout: vi.fn(),
};
vi.mock('../lib/atproto.js', () => atproto);

const facts = await import('./graphFacts.js');

const LIST = 'at://did:plc:bot/app.bsky.graph.list/3list';
const listitem = (did, rkey, list = LIST) => ({
  linkRecord: {
    did: 'did:plc:bot',
    collection: 'app.bsky.graph.listitem',
    rkey,
  },
  otherSubject: list,
});
const page = (records, cursor = null) => ({
  ok: true,
  json: async () => ({ records, cursor }),
});
const record = (rkey, subject, list = LIST) => ({
  uri: `at://did:plc:bot/app.bsky.graph.listitem/${rkey}`,
  value: { list, subject },
});

beforeEach(() => {
  facts.resetGraphFacts();
  constellation.getBacklinks.mockReset();
  constellation.getManyToMany.mockReset();
  atproto.fetchWithTimeout.mockReset();
});

describe('membership for a write', () => {
  it('asks Constellation about the one account, filtered to this list', async () => {
    constellation.getManyToMany.mockResolvedValue({
      items: [
        listitem('did:plc:a', 'r1'),
        listitem('did:plc:a', 'r9', 'at://other/list'),
      ],
      cursor: null,
    });
    expect(await facts.rkeysForWrite(LIST, 'did:plc:a')).toEqual(['r1']);
    expect(constellation.getManyToMany.mock.calls[0][3].otherSubject).toBe(
      LIST,
    );
  });

  it("covers Constellation's lag with this process's own writes", async () => {
    constellation.getManyToMany.mockResolvedValue({ items: [], cursor: null });
    facts.noteListed(LIST, 'did:plc:a', 'rNew');
    // Just added, not indexed yet: a second "block" must see it.
    expect(await facts.rkeysForWrite(LIST, 'did:plc:a')).toEqual(['rNew']);
    expect(facts.isListed(LIST, 'did:plc:a')).toBe(true);

    constellation.getManyToMany.mockResolvedValue({
      items: [listitem('did:plc:b', 'rOld')],
      cursor: null,
    });
    facts.noteUnlisted(LIST, 'did:plc:b');
    // Just removed, still indexed: not on the list any more.
    expect(await facts.rkeysForWrite(LIST, 'did:plc:b')).toEqual([]);
    expect(facts.isListed(LIST, 'did:plc:b')).toBe(false);
  });

  it('walks the repo when Constellation cannot say', async () => {
    constellation.getManyToMany.mockResolvedValue(null);
    atproto.fetchWithTimeout.mockResolvedValue(
      page([
        record('r1', 'did:plc:a'),
        record('r2', 'did:plc:a'),
        record('r3', 'did:plc:a', 'other'),
      ]),
    );
    // Duplicates are kept: taking someone off means deleting every copy.
    expect(await facts.rkeysForWrite(LIST, 'did:plc:a')).toEqual(['r1', 'r2']);
  });

  it('can be told not to walk, for a caller that will walk once for many', async () => {
    constellation.getManyToMany.mockResolvedValue(null);
    expect(await facts.rkeysForWrite(LIST, 'did:plc:a', { walk: false })).toBe(
      null,
    );
    expect(atproto.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('says it could not tell when the list runs past the page cap', async () => {
    // A partial walk would call everyone past the cut "not listed".
    const fetchImpl = vi.fn(async () => page([record('r1', 'did:plc:a')], 'more'));
    expect(await facts.readListed(LIST, { fetchImpl, maxPages: 2 })).toBe(null);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('the held copy, for reading many at once', () => {
  it('is unknown until loaded, and the scorer only ever sees true', () => {
    expect(facts.isListed(LIST, 'did:plc:a')).toBe(null);
    expect(facts.blocksMe('did:plc:a')).toBe(null);
    expect(facts.listedView(LIST).has('did:plc:a')).toBe(false);
  });

  it('holds the list and who blocks the owner after one load', async () => {
    atproto.fetchWithTimeout.mockResolvedValue(page([record('r1', 'did:plc:a')]));
    constellation.getBacklinks.mockResolvedValue({
      records: [{ did: 'did:plc:b' }],
      cursor: null,
    });
    await Promise.all([
      facts.graphFacts({ list: LIST }),
      facts.graphFacts({ list: LIST }),
    ]);
    expect(atproto.fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(facts.isListed(LIST, 'did:plc:a')).toBe(true);
    expect(facts.isListed(LIST, 'did:plc:c')).toBe(false);
    expect(facts.blocksMe('did:plc:b')).toBe(true);
    expect(facts.blocksMe('did:plc:c')).toBe(false);
  });

  it('leaves blocks unknown when there are more blockers than it reads', async () => {
    atproto.fetchWithTimeout.mockResolvedValue(page([]));
    constellation.getBacklinks.mockResolvedValue({
      records: [{ did: 'did:plc:b' }],
      cursor: 'more',
    });
    await facts.graphFacts({ list: LIST });
    expect(facts.blocksMe('did:plc:b')).toBe(null);
  });
});

describe('a list longer than the held copy reads', () => {
  const walkNeverEnds = () =>
    atproto.fetchWithTimeout.mockImplementation(async () =>
      page([record('r1', 'did:plc:a')], 'more'),
    );

  it('still knows who it saw, and calls the rest unknown rather than unlisted', async () => {
    walkNeverEnds();
    constellation.getBacklinks.mockResolvedValue({ records: [], cursor: null });
    await facts.graphFacts({ list: LIST });
    expect(facts.isListed(LIST, 'did:plc:a')).toBe(true);
    expect(facts.isListed(LIST, 'did:plc:z')).toBe(null);
    expect(facts.listedView(LIST).has('did:plc:a')).toBe(true);
  });

  it('is kept for the full half hour, not walked again every two minutes', async () => {
    let t = 1_000_000;
    const now = () => t;
    walkNeverEnds();
    constellation.getBacklinks.mockResolvedValue({ records: [], cursor: null });
    await facts.graphFacts({ list: LIST, now });
    const walked = atproto.fetchWithTimeout.mock.calls.length;
    t += 5 * 60_000;
    await facts.graphFacts({ list: LIST, now });
    expect(atproto.fetchWithTimeout.mock.calls.length).toBe(walked);
  });

  it('keeps a blockers count too big to read for the full half hour as well', async () => {
    let t = 1_000_000;
    const now = () => t;
    atproto.fetchWithTimeout.mockResolvedValue(page([]));
    constellation.getBacklinks.mockResolvedValue({
      records: [{ did: 'did:plc:b' }],
      cursor: 'more',
    });
    await facts.graphFacts({ list: LIST, now });
    const asked = constellation.getBacklinks.mock.calls.length;
    t += 5 * 60_000;
    await facts.graphFacts({ list: LIST, now });
    expect(constellation.getBacklinks.mock.calls.length).toBe(asked);
    expect(facts.blocksMe('did:plc:b')).toBe(null);
  });

  it('tries a load that failed again after two minutes', async () => {
    let t = 1_000_000;
    const now = () => t;
    atproto.fetchWithTimeout.mockResolvedValue({ ok: false, status: 502 });
    constellation.getBacklinks.mockResolvedValue({ records: [], cursor: null });
    await facts.graphFacts({ list: LIST, now });
    expect(facts.isListed(LIST, 'did:plc:a')).toBe(null);
    atproto.fetchWithTimeout.mockResolvedValue(page([record('r1', 'did:plc:a')]));
    t += 3 * 60_000;
    await facts.graphFacts({ list: LIST, now });
    expect(facts.isListed(LIST, 'did:plc:a')).toBe(true);
  });
});

describe('the list and the blockers, each on its own clock', () => {
  it('asks Constellation again after a failure without walking the list again', async () => {
    let t = 1_000_000;
    const now = () => t;
    atproto.fetchWithTimeout.mockResolvedValue(page([record('r1', 'did:plc:a')]));
    constellation.getBacklinks.mockResolvedValue(null);
    await facts.graphFacts({ list: LIST, now });
    expect(facts.blocksMe('did:plc:b')).toBe(null);
    const walked = atproto.fetchWithTimeout.mock.calls.length;

    constellation.getBacklinks.mockResolvedValue({
      records: [{ did: 'did:plc:b' }],
      cursor: null,
    });
    t += 3 * 60_000;
    await facts.graphFacts({ list: LIST, now });
    expect(facts.blocksMe('did:plc:b')).toBe(true);
    expect(atproto.fetchWithTimeout.mock.calls.length).toBe(walked);
    expect(facts.isListed(LIST, 'did:plc:a')).toBe(true);
  });

  it('walks the list again after a failure without asking Constellation again', async () => {
    let t = 1_000_000;
    const now = () => t;
    atproto.fetchWithTimeout.mockResolvedValue({ ok: false, status: 502 });
    constellation.getBacklinks.mockResolvedValue({
      records: [{ did: 'did:plc:b' }],
      cursor: null,
    });
    await facts.graphFacts({ list: LIST, now });
    const asked = constellation.getBacklinks.mock.calls.length;

    atproto.fetchWithTimeout.mockResolvedValue(page([record('r1', 'did:plc:a')]));
    t += 3 * 60_000;
    await facts.graphFacts({ list: LIST, now });
    expect(facts.isListed(LIST, 'did:plc:a')).toBe(true);
    expect(constellation.getBacklinks.mock.calls.length).toBe(asked);
    expect(facts.blocksMe('did:plc:b')).toBe(true);
  });
});

describe("this process's own writes", () => {
  it('are let go once they are too old to be read, so they do not pile up', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
    try {
      for (let i = 0; i < 500; i += 1) {
        facts.noteListed(LIST, `did:plc:add${i}`, `r${i}`);
        facts.noteUnlisted(LIST, `did:plc:off${i}`);
      }
      // Written again later, which also moves it to the back of the line.
      vi.setSystemTime(1_000_000 + 9 * 60_000);
      facts.noteListed(LIST, 'did:plc:add0', 'rAgain');
      expect(facts.ownWritesHeld()).toBe(1000);

      vi.setSystemTime(1_000_000 + 11 * 60_000);
      facts.noteListed(LIST, 'did:plc:later', 'rLater');
      // The 999 from eleven minutes ago are gone; the two since are kept.
      expect(facts.ownWritesHeld()).toBe(2);
      expect(facts.isListed(LIST, 'did:plc:add0')).toBe(true);
      expect(facts.isListed(LIST, 'did:plc:later')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('several lists (multi-list mode)', () => {
  const OTHER = 'at://did:plc:bot/app.bsky.graph.list/3other';

  it("never offers one list's listitem for a write to another", async () => {
    // Constellation has indexed neither yet.
    constellation.getManyToMany.mockResolvedValue({ items: [], cursor: null });
    facts.noteListed(OTHER, 'did:plc:a', 'rOnOther');
    expect(await facts.rkeysForWrite(LIST, 'did:plc:a')).toEqual([]);
    expect(await facts.rkeysForWrite(OTHER, 'did:plc:a')).toEqual(['rOnOther']);
    expect(facts.isListed(OTHER, 'did:plc:a')).toBe(true);
    expect(facts.isListed(LIST, 'did:plc:a')).toBe(null);
  });

  it('keeps a removal from one list off that list only', async () => {
    constellation.getManyToMany.mockImplementation(
      async (_did, _src, _path, { otherSubject }) => ({
        items: [
          listitem('did:plc:a', otherSubject === LIST ? 'r1' : 'r2', otherSubject),
        ],
        cursor: null,
      }),
    );
    facts.noteUnlisted(LIST, 'did:plc:a');
    expect(await facts.rkeysForWrite(LIST, 'did:plc:a')).toEqual([]);
    expect(await facts.rkeysForWrite(OTHER, 'did:plc:a')).toEqual(['r2']);
  });

  it('holds a copy of each list, and reading one does not throw out the other', async () => {
    constellation.getBacklinks.mockResolvedValue({ records: [], cursor: null });
    atproto.fetchWithTimeout.mockImplementation(async () =>
      page([record('r1', 'did:plc:a', LIST), record('r2', 'did:plc:b', OTHER)]),
    );
    await facts.graphFacts({ list: LIST });
    await facts.graphFacts({ list: OTHER });
    expect(facts.isListed(LIST, 'did:plc:a')).toBe(true);
    expect(facts.isListed(LIST, 'did:plc:b')).toBe(false);
    expect(facts.isListed(OTHER, 'did:plc:b')).toBe(true);
    expect(facts.listedOnAnyView([LIST, OTHER]).has('did:plc:b')).toBe(true);
    expect(facts.listedOnAnyView([LIST]).has('did:plc:b')).toBe(false);
  });
});
