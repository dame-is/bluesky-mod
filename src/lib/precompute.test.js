import { describe, it, expect, vi } from 'vitest';
import {
  followsOf,
  indexCircleFollows,
  referenceFrom,
  readCircle,
  readCurationMembers,
} from './precompute.js';

/** A getFollows stub: `pages` responses, each optionally taking time. */
function fakeFetch(pages, { msPerPage = 0 } = {}) {
  let n = 0;
  return vi.fn(async () => {
    const page = pages[Math.min(n++, pages.length - 1)];
    if (msPerPage) vi.advanceTimersByTime(msPerPage);
    return { ok: true, json: async () => page };
  });
}

const page = (dids, cursor) => ({
  follows: dids.map((did) => ({ did })),
  ...(cursor ? { cursor } : {}),
});

describe('followsOf', () => {
  it('pages until the cursor runs out', async () => {
    const fetchImpl = fakeFetch([
      page(['did:plc:a'], 'c1'),
      page(['did:plc:b']),
    ]);
    const out = await followsOf('did:plc:m', { fetchImpl });
    expect(out).toEqual({
      dids: ['did:plc:a', 'did:plc:b'],
      complete: true,
      aborted: false,
      permanent: false,
    });
  });

  it('aborts mid-member once the deadline passes', async () => {
    // The budget is checked per page, so eight workers that each start a long
    // follow list just under the limit cannot run tens of seconds past it.
    vi.useFakeTimers();
    try {
      const fetchImpl = fakeFetch(
        Array.from({ length: 15 }, (_, i) => page([`did:plc:${i}`], `c${i}`)),
        { msPerPage: 400 },
      );
      const out = await followsOf('did:plc:m', {
        fetchImpl,
        deadline: Date.now() + 1000,
      });
      expect(out.aborted).toBe(true);
      expect(out.complete).toBe(false);
      // Stopped early rather than reading all fifteen pages.
      expect(fetchImpl.mock.calls.length).toBeLessThan(15);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports incomplete without aborting when it hits the page cap', async () => {
    // Truncation at MAX_PAGES is accepted and recorded; a deadline abort is not.
    const fetchImpl = fakeFetch([page(['did:plc:a'], 'always-more')]);
    const out = await followsOf('did:plc:m', { fetchImpl });
    expect(out.complete).toBe(false);
    expect(out.aborted).toBe(false);
  });
});

describe('permanently unreadable members', () => {
  // getFollows answers 400 for a deactivated or taken-down account, and always
  // will. finalise_snapshot waits for every member, so one such account left
  // pending would hold the snapshot open for good.
  const status = (code) =>
    vi.fn(async () => ({ ok: false, status: code, json: async () => ({}) }));

  it('marks a 400 as permanent, so the caller can stop asking', async () => {
    const out = await followsOf('did:plc:gone', { fetchImpl: status(400) });
    expect(out.permanent).toBe(true);
    expect(out.dids).toEqual([]);
  });

  it('does not mark a rate limit as permanent', async () => {
    // Slower than it looks: a retryable status waits out the backoff between
    // tries (500 + 1000ms) before giving up, so the caller comes back for it.
    // A permanent 400 returns on the first response with no backoff at all.
    const out = await followsOf('did:plc:busy', { fetchImpl: status(429) });
    expect(out.permanent).toBe(false);
  }, 10_000);

  it.each([500, 401, 403, 404, 408])(
    'does not mark a %i as permanent, since it may answer next time',
    async (code) => {
      vi.useFakeTimers();
      try {
        const reading = followsOf('did:plc:flaky', { fetchImpl: status(code) });
        await vi.runAllTimersAsync();
        const out = await reading;
        expect(out.permanent).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('reports the failure and its permanence up to the caller', async () => {
    const out = await indexCircleFollows({
      pending: ['did:plc:gone', 'did:plc:busy'],
      fetchImpl: vi.fn(async (url) => ({
        ok: false,
        status: url.includes('gone') ? 400 : 503,
        json: async () => ({}),
      })),
      writeEdges: async () => {},
      markDone: async () => {},
    });
    expect(out.indexed).toBe(0);
    expect(out.unreadable).toHaveLength(2);
    expect(
      out.unreadable.find((u) => u.member === 'did:plc:gone').permanent,
    ).toBe(true);
    expect(
      out.unreadable.find((u) => u.member === 'did:plc:busy').permanent,
    ).toBe(false);
  });
});

describe('indexCircleFollows', () => {
  it('writes and marks each member it finishes', async () => {
    const written = [];
    const done = [];
    const out = await indexCircleFollows({
      pending: ['did:plc:m1', 'did:plc:m2'],
      fetchImpl: fakeFetch([page(['did:plc:t'])]),
      writeEdges: async (rows) => written.push(...rows),
      markDone: async (m) => done.push(m),
    });
    expect(out.indexed).toBe(2);
    expect(done.sort()).toEqual(['did:plc:m1', 'did:plc:m2']);
    expect(written).toHaveLength(2);
  });

  it('discards a member it could not finish, rather than recording a partial', async () => {
    // Marking a follow list cut short by the clock as done would understate
    // that member's vouches for the life of the snapshot. Leaving it pending
    // costs a retry.
    vi.useFakeTimers();
    try {
      const written = [];
      const done = [];
      await indexCircleFollows({
        pending: ['did:plc:m1'],
        budgetMs: 1000,
        fetchImpl: fakeFetch(
          Array.from({ length: 15 }, (_, i) => page([`did:plc:${i}`], `c${i}`)),
          { msPerPage: 400 },
        ),
        writeEdges: async (rows) => written.push(...rows),
        markDone: async (m) => done.push(m),
      });
      expect(done).toEqual([]);
      expect(written).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes on where the deadline stopped it, so a list longer than one budget still finishes', async () => {
    // Fifteen pages at 400ms against a one-second budget: every run is cut
    // short. Started again from the first page each time, it would never end.
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (url) => {
        const at = Number(new URL(url).searchParams.get('cursor') ?? -1) + 1;
        vi.advanceTimersByTime(400);
        return {
          ok: true,
          json: async () =>
            page([`did:plc:t${at}`], at < 14 ? String(at) : null),
        };
      });
      const resume = new Map();
      const written = [];
      const done = [];
      for (let run = 0; run < 10 && !done.length; run += 1) {
        await indexCircleFollows({
          pending: ['did:plc:m1'],
          budgetMs: 1000,
          resume,
          fetchImpl,
          writeEdges: async (rows) => written.push(...rows),
          markDone: async (m) => done.push(m),
        });
      }
      expect(done).toEqual(['did:plc:m1']);
      expect(new Set(written.map((e) => e.target)).size).toBe(15);
      // No page was read twice, and nothing is held once it is done.
      expect(fetchImpl).toHaveBeenCalledTimes(15);
      expect(resume.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a member unmarked when the read fails outright', async () => {
    const done = [];
    const out = await indexCircleFollows({
      pending: ['did:plc:m1'],
      fetchImpl: vi.fn(async () => ({ ok: false, status: 400 })),
      writeEdges: async () => {},
      markDone: async (m) => done.push(m),
    });
    expect(done).toEqual([]);
    expect(out.indexed).toBe(0);
  });

  it('leaves a member pending when a later page fails, rather than keeping a cut-short list', async () => {
    // Marked done with the first 200 follows, this member would understate
    // vouches for everyone deeper in their list for the life of the snapshot.
    vi.useFakeTimers();
    try {
      let n = 0;
      const fetchImpl = vi.fn(async () => {
        n += 1;
        if (n <= 2) {
          return {
            ok: true,
            json: async () => page([`did:plc:t${n}`], `c${n}`),
          };
        }
        return { ok: false, status: 503, json: async () => ({}) };
      });
      const written = [];
      const done = [];
      const running = indexCircleFollows({
        pending: ['did:plc:m1'],
        fetchImpl,
        writeEdges: async (rows) => written.push(...rows),
        markDone: async (m) => done.push(m),
      });
      await vi.runAllTimersAsync();
      const out = await running;
      expect(written).toEqual([]);
      expect(done).toEqual([]);
      expect(out.partial).toEqual([]);
      expect(out.unreadable).toEqual([
        { member: 'did:plc:m1', permanent: false },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps and marks a member cut short by the page cap', async () => {
    const written = [];
    const done = [];
    const out = await indexCircleFollows({
      pending: ['did:plc:m1'],
      fetchImpl: fakeFetch([page(['did:plc:a'], 'always-more')]),
      writeEdges: async (rows) => written.push(...rows),
      markDone: async (m) => done.push(m),
    });
    expect(out.partial).toEqual(['did:plc:m1']);
    expect(done).toEqual(['did:plc:m1']);
    expect(written).toHaveLength(1);
  });

  it('deduplicates a follow list before writing edges', async () => {
    const written = [];
    await indexCircleFollows({
      pending: ['did:plc:m1'],
      fetchImpl: fakeFetch([page(['did:plc:t', 'did:plc:t'])]),
      writeEdges: async (rows) => written.push(...rows),
      markDone: async () => {},
    });
    expect(written).toHaveLength(1);
  });
});

describe('referenceFrom', () => {
  it('treats the vouch table as the one-hop neighbourhood', () => {
    const ref = referenceFrom({
      vouchRows: [{ did: 'did:plc:a', vouches: 2 }],
      circleDids: ['did:plc:c'],
    });
    expect(ref.neighbourhood.has('did:plc:a')).toBe(true);
    expect(ref.circle.has('did:plc:c')).toBe(true);
  });
});

describe('readCurationMembers', () => {
  const CURATE = 'app.bsky.graph.defs#curatelist';
  const collections = {
    'app.bsky.graph.list': [
      {
        uri: 'at://me/app.bsky.graph.list/hand',
        value: { purpose: CURATE, name: 'Artists' },
      },
      {
        uri: 'at://me/app.bsky.graph.list/auto',
        value: { purpose: CURATE, name: 'Who engages with me' },
      },
      {
        uri: 'at://me/app.bsky.graph.list/kept',
        value: { purpose: CURATE, name: 'Who I engage with' },
      },
    ],
    'app.bsky.graph.listitem': [
      {
        value: {
          list: 'at://me/app.bsky.graph.list/hand',
          subject: 'did:plc:picked',
        },
      },
      {
        value: {
          list: 'at://me/app.bsky.graph.list/auto',
          subject: 'did:plc:replier',
        },
      },
      {
        value: {
          list: 'at://me/app.bsky.graph.list/kept',
          subject: 'did:plc:friend',
        },
      },
    ],
  };
  const fetchImpl = vi.fn(async (url) => {
    const collection = new URL(url).searchParams.get('collection');
    return {
      ok: true,
      json: async () => ({ records: collections[collection] || [] }),
    };
  });

  it('protects every curation list except the ones excluded', async () => {
    const out = await readCurationMembers({
      pds: 'https://pds',
      did: 'me',
      exclude: ['at://me/app.bsky.graph.list/auto'],
      fetchImpl,
    });
    expect([...out.keys()].sort()).toEqual([
      'did:plc:friend',
      'did:plc:picked',
    ]);
  });
});

describe('reading the protected set', () => {
  // The snapshot replaces the protected set with what these return, so a
  // partial read would quietly take protection away from real follows.
  const pagesThenFail = () => {
    let n = 0;
    return vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return {
          ok: true,
          json: async () => ({
            records: [{ value: { subject: 'did:plc:friend' } }],
            cursor: 'more',
          }),
        };
      }
      return { ok: false, status: 400, json: async () => ({}) };
    });
  };

  it('reads the follows across pages', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return {
        ok: true,
        json: async () =>
          n === 1
            ? { records: [{ value: { subject: 'did:plc:a' } }], cursor: 'c' }
            : { records: [{ value: { subject: 'did:plc:b' } }] },
      };
    });
    const out = await readCircle({ pds: 'https://pds', did: 'me', fetchImpl });
    expect(out).toEqual(['did:plc:a', 'did:plc:b']);
  });

  it('throws on a failed page rather than returning part of the circle', async () => {
    await expect(
      readCircle({
        pds: 'https://pds',
        did: 'me',
        fetchImpl: pagesThenFail(),
      }),
    ).rejects.toThrow(/app.bsky.graph.follow/);
  });

  it('throws on a failed page of curation lists too', async () => {
    await expect(
      readCurationMembers({
        pds: 'https://pds',
        did: 'me',
        fetchImpl: pagesThenFail(),
      }),
    ).rejects.toThrow(/app.bsky.graph.list/);
  });
});
