// What a preflight counts: the same people a scan of the post would hold.

import { describe, it, expect, vi, afterEach } from 'vitest';

import { OWNER_DID } from '../constants.js';

const AUTHOR = 'did:plc:author';
const POST = `at://${AUTHOR}/app.bsky.feed.post/3post`;

const engaged = (did, engagements) => ({ did, engagements, records: [] });
const harvested = vi.hoisted(() => []);
vi.mock('../lib/harvest.js', () => ({
  harvestPost: async (uri, opts) => (harvested.push(opts), {
    uri,
    participants: [
      engaged(AUTHOR, { gate: 1, reply: 1 }),
      engaged(OWNER_DID, { like: 1 }),
      engaged('did:plc:bot', { reply: 1 }),
      engaged('did:plc:s1', { quote: 1 }),
      engaged('did:plc:s2', { quote: 1, like: 1 }),
    ],
    totals: {
      participants: 5,
      engagements: { gate: 1, reply: 2, like: 2, quote: 2 },
    },
    truncated: false,
  }),
}));

const { makeIo } = await import('./reference.js');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  harvested.length = 0;
});

describe('a preflight', () => {
  it('leaves out the author, the owner and the bot, as a scan does', async () => {
    vi.stubEnv('MOD_LIST_URI', 'at://did:plc:bot/app.bsky.graph.list/3list');
    // An AppView that knows nobody: everyone left is an unscored stranger.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => ({
        ok: true,
        status: 200,
        json: async () =>
          /getProfiles/.test(url) ? { profiles: [] } : { relationships: [] },
      })),
    );
    const io = makeIo({ ref: {}, takenAt: '2026-10-01T00:00:00Z' });
    const out = await io.preflight(POST);
    expect(out.totals).toMatchObject({
      participants: 2,
      engagements: { quote: 2, like: 1 },
      byBand: { UNKNOWN: 2 },
    });
    expect(out.autoEligible).toBe(2);
  });

  it('stops when the turn gives up, and scores nothing it half read', async () => {
    // An aborted harvest hands back what it had rather than throwing, so the
    // preflight has to check the signal before it scores that.
    vi.stubEnv('MOD_LIST_URI', 'at://did:plc:bot/app.bsky.graph.list/3list');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort();
    const io = makeIo({ ref: {}, takenAt: '2026-10-01T00:00:00Z' });
    await expect(
      io.preflight(POST, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(harvested).toEqual([
      expect.objectContaining({ signal: controller.signal }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
