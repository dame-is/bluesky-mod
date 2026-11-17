import { describe, it, expect, vi } from 'vitest';
import {
  trustScore,
  assignBand,
  distanceFrom,
  summarise,
  createScorer,
  DEFAULT_THRESHOLDS,
} from './score.js';
import { referenceFrom } from './precompute.js';

describe('assignBand', () => {
  it('lets a protected reason beat every other signal', () => {
    const band = assignBand({
      protectedReason: 'you follow them',
      vouches: 0,
      followers: 0,
    });
    expect(band).toBe('PROTECTED');
  });

  it('puts a well-vouched account with a large audience in CONNECTED', () => {
    // The account a bulk sweep must not add unseen: deep in your circle, with
    // plenty of people who would notice.
    expect(assignBand({ vouches: 24, followers: 50000 })).toBe('CONNECTED');
  });

  it('promotes a single vouch to CONNECTED only when reach is real', () => {
    expect(assignBand({ vouches: 1, followers: 6000 })).toBe('CONNECTED');
    expect(assignBand({ vouches: 1, followers: 400 })).toBe('PERIPHERAL');
  });

  it('catches an unvouched account with a large audience as NOTABLE', () => {
    expect(assignBand({ vouches: 0, followers: 40000 })).toBe('NOTABLE');
  });

  it('catches a loud unvouched account below the reach bar', () => {
    expect(assignBand({ vouches: 0, followers: 3000, postsPerDay: 45 })).toBe(
      'NOTABLE',
    );
  });

  it('leaves an ordinary stranger in UNKNOWN', () => {
    // About three years old, a few hundred followers, a post a day, no vouches.
    expect(
      assignBand({ vouches: 0, followers: 372, postsPerDay: 1, ageDays: 1017 }),
    ).toBe('UNKNOWN');
  });

  it('honours overridden thresholds', () => {
    const strict = { ...DEFAULT_THRESHOLDS, notableReach: 500 };
    expect(assignBand({ vouches: 0, followers: 900 }, strict)).toBe('NOTABLE');
    expect(assignBand({ vouches: 0, followers: 900 })).toBe('UNKNOWN');
  });
});

describe('trustScore', () => {
  it('ranks by vouches ahead of raw reach', () => {
    const vouched = trustScore({ vouches: 10, followers: 800 });
    const popular = trustScore({ vouches: 0, followers: 200000 });
    expect(vouched).toBeGreaterThan(popular);
  });

  it('stays inside 0..99 so PROTECTED at 100 always sorts first', () => {
    const max = trustScore({
      vouches: 999,
      followers: 10_000_000,
      ageDays: 5000,
      mutual: true,
    });
    expect(max).toBeLessThanOrEqual(99);
    expect(trustScore({})).toBeGreaterThanOrEqual(0);
  });

  it('counts no tenure for a missing, unparseable or future createdAt', () => {
    const base = { vouches: 2, followers: 1000 };
    const none = trustScore({ ...base, ageDays: null });
    expect(trustScore({ ...base, ageDays: NaN })).toBe(none);
    expect(trustScore({ ...base, ageDays: -5000 })).toBe(none);
    expect(none).toBe(trustScore({ ...base, ageDays: 0 }));
  });

  it('gives a mutual more weight than a one-way follower', () => {
    const base = { vouches: 2, followers: 1000, ageDays: 900 };
    expect(trustScore({ ...base, mutual: true })).toBeGreaterThan(
      trustScore({ ...base, followsYou: true }),
    );
  });
});

describe('distanceFrom', () => {
  it('reports 0..3, where 3 means "not found" rather than three hops', () => {
    expect(distanceFrom({ inCircle: true, vouches: 0 })).toBe(0);
    expect(distanceFrom({ inCircle: false, vouches: 2 })).toBe(1);
    expect(
      distanceFrom({ inCircle: false, vouches: 0, inNeighbourhood: true }),
    ).toBe(2);
    expect(distanceFrom({ inCircle: false, vouches: 0 })).toBe(3);
  });
});

describe('referenceFrom', () => {
  it('derives the neighbourhood from the vouch table rather than crawling', () => {
    const ref = referenceFrom({
      vouchRows: [
        { did: 'did:plc:a', vouches: 3 },
        { did: 'did:plc:b', vouches: 1 },
      ],
      circleDids: ['did:plc:c'],
      protectedRows: [{ did: 'did:plc:c', reason: 'you follow them' }],
    });
    expect(ref.vouches.get('did:plc:a')).toBe(3);
    expect(ref.neighbourhood.has('did:plc:b')).toBe(true);
    expect(ref.protectedSet.get('did:plc:c')).toBe('you follow them');
  });
});

describe('summarise', () => {
  const harvest = {
    uri: 'at://did:plc:me/app.bsky.feed.post/x',
    harvestedAt: '2026-09-16T00:00:00.000Z',
    truncated: false,
    totals: { participants: 4, engagements: { like: 3, reply: 1 }, records: 4 },
    participants: [
      {
        did: 'did:plc:me',
        engagements: { reply: 1 },
        primary: 'reply',
        total: 1,
      },
      { did: 'did:plc:a', engagements: { like: 1 }, primary: 'like', total: 1 },
      { did: 'did:plc:b', engagements: { like: 1 }, primary: 'like', total: 1 },
      { did: 'did:plc:c', engagements: { like: 1 }, primary: 'like', total: 1 },
    ],
  };
  const scores = new Map([
    ['did:plc:a', { band: 'CONNECTED', trust: 90, followers: 5000 }],
    ['did:plc:b', { band: 'UNKNOWN', trust: 12, followers: 100 }],
    ['did:plc:c', { band: 'PROTECTED', trust: 100, followers: 9000 }],
  ]);

  it('drops the post author so a thread is not a roster of yourself', () => {
    const s = summarise(harvest, scores, { excludeSelf: 'did:plc:me' });
    expect(s.rows).toHaveLength(3);
    expect(s.rows.some((r) => r.did === 'did:plc:me')).toBe(false);
  });

  it('separates the named review set from the auto-eligible count', () => {
    const s = summarise(harvest, scores, { excludeSelf: 'did:plc:me' });
    expect(s.requiresReview.map((r) => r.did)).toEqual([
      'did:plc:c',
      'did:plc:a',
    ]);
    expect(s.autoEligible.map((r) => r.did)).toEqual(['did:plc:b']);
  });

  it('totals the reach of the review set, which is who would notice', () => {
    const s = summarise(harvest, scores, { excludeSelf: 'did:plc:me' });
    expect(s.totals.reviewReach).toBe(14000);
    expect(s.totals.byBand.CONNECTED).toBe(1);
  });

  it('carries the kinds the harvest could not read', () => {
    const s = summarise(
      { ...harvest, truncated: true, unread: [{ kind: 'like', count: 900 }] },
      scores,
    );
    expect(s.truncated).toBe(true);
    expect(s.unread).toEqual([{ kind: 'like', count: 900 }]);
  });

  it('treats an unscored participant as UNKNOWN rather than dropping them', () => {
    const s = summarise(harvest, new Map(), { excludeSelf: 'did:plc:me' });
    expect(s.rows).toHaveLength(3);
    expect(s.totals.byBand.UNKNOWN).toBe(3);
  });
});

describe('createScorer against the AppView', () => {
  const FRIEND = 'did:plc:friend';
  const BIG = 'did:plc:big';
  const GONE = 'did:plc:gone';

  /** An AppView whose answers are scripted per endpoint, in order. */
  function appview({ profiles = [], relationships = [] } = {}) {
    const script = { getProfiles: profiles, getRelationships: relationships };
    const healthy = {
      getProfiles: () => ({
        ok: true,
        status: 200,
        json: async () => ({
          profiles: [
            { did: FRIEND, handle: 'friend.test', followersCount: 300 },
            { did: BIG, handle: 'big.test', followersCount: 50_000 },
          ],
        }),
      }),
      getRelationships: () => ({
        ok: true,
        status: 200,
        json: async () => ({
          relationships: [
            { did: FRIEND, following: 'at://me/follow/1' },
            { did: BIG },
          ],
        }),
      }),
    };
    return vi.fn(async (url) => {
      const name = /xrpc\/app\.bsky\.\w+\.(\w+)/.exec(url)[1];
      const next = script[name].shift() ?? 'ok';
      if (next === 'ok') return healthy[name]();
      if (next === 'throw') throw new TypeError('fetch failed');
      return { ok: false, status: next, json: async () => ({}) };
    });
  }
  const scorerWith = (fetchImpl) =>
    createScorer({}, { fetchImpl, retryDelaysMs: [0, 0] });

  it("scores the owner's own account and the bot's as PROTECTED", async () => {
    const owner = process.env.MOD_OWNER_DID;
    const bot = 'did:plc:bot';
    vi.stubEnv('MOD_LIST_URI', `at://${bot}/app.bsky.graph.list/3list`);
    try {
      const scores = await scorerWith(appview()).score([owner, bot, BIG]);
      expect(scores.get(owner)).toMatchObject({
        band: 'PROTECTED',
        protectedReason: 'your own account',
      });
      expect(scores.get(bot)).toMatchObject({
        band: 'PROTECTED',
        protectedReason: 'this bot',
      });
      expect(scores.get(BIG).band).toBe('NOTABLE');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('scores live accounts from a healthy answer', async () => {
    const scores = await scorerWith(appview()).score([FRIEND, BIG, GONE]);
    expect(scores.get(FRIEND)).toMatchObject({
      band: 'PROTECTED',
      missing: false,
    });
    expect(scores.get(BIG)).toMatchObject({ band: 'NOTABLE', missing: false });
    // Left out of a profiles answer that did come back: really gone.
    expect(scores.get(GONE).missing).toBe(true);
  });

  it('reads a big scan a few batches at a time, and scores every account', async () => {
    const dids = Array.from({ length: 400 }, (_, i) => `did:plc:many${String(i).padStart(4, '0')}`);
    let live = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (url) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 2));
      live -= 1;
      const u = new URL(url);
      if (u.pathname.endsWith('getProfiles')) {
        const profiles = u.searchParams.getAll('actors').map((did) => ({
          did,
          handle: `${did.slice(-4)}.test`,
          followersCount: 10,
        }));
        return { ok: true, json: async () => ({ profiles }) };
      }
      const relationships = u.searchParams
        .getAll('others')
        .map((did) => ({ did, following: false, followedBy: false }));
      return { ok: true, json: async () => ({ relationships }) };
    });
    const scores = await scorerWith(fetchImpl).score(dids);
    expect(scores.size).toBe(400);
    expect([...scores.values()].every((s) => !s.missing && s.band === 'UNKNOWN')).toBe(true);
    // 16 profile batches and 14 relationship batches, never all at once.
    expect(fetchImpl).toHaveBeenCalledTimes(30);
    expect(peak).toBeGreaterThan(2);
    expect(peak).toBeLessThanOrEqual(12);
  });

  it('scores nothing when one batch of many cannot be read', async () => {
    const dids = Array.from({ length: 100 }, (_, i) => `did:plc:fail${String(i).padStart(4, '0')}`);
    const fetchImpl = vi.fn(async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('getProfiles') && u.searchParams.getAll('actors').includes('did:plc:fail0060')) {
        return { ok: false, status: 400, json: async () => ({}) };
      }
      const key = u.pathname.endsWith('getProfiles') ? 'profiles' : 'relationships';
      return { ok: true, json: async () => ({ [key]: [] }) };
    });
    await expect(scorerWith(fetchImpl).score(dids)).rejects.toThrow(/nothing was scored/);
  });

  it('asks again after a rate limit or a server error', async () => {
    const fetchImpl = appview({
      profiles: [429, 503],
      relationships: ['throw'],
    });
    const scores = await scorerWith(fetchImpl).score([FRIEND, BIG]);
    expect(scores.get(FRIEND).band).toBe('PROTECTED');
    expect(scores.get(BIG)).toMatchObject({ band: 'NOTABLE', missing: false });
  });

  it('throws rather than scoring a failed profiles batch as strangers with no profile', async () => {
    // Read as an empty answer, a 429 would make a 50,000-follower account
    // UNKNOWN and every account in the batch "gone".
    const fetchImpl = appview({ profiles: [429, 429, 429] });
    await expect(scorerWith(fetchImpl).score([FRIEND, BIG])).rejects.toThrow(
      /429.*nothing was scored/,
    );
  });

  it('throws rather than reading a failed follow check as "you do not follow them"', async () => {
    // The friend is followed since the snapshot, so only the live
    // relationship protects them.
    const fetchImpl = appview({ relationships: [500, 502, 504] });
    await expect(scorerWith(fetchImpl).score([FRIEND])).rejects.toThrow(
      /nothing was scored/,
    );
  });

  it('does not retry an answer that will not change', async () => {
    const fetchImpl = appview({ profiles: [400] });
    await expect(scorerWith(fetchImpl).score([FRIEND])).rejects.toThrow(
      /400/,
    );
    const profileCalls = fetchImpl.mock.calls.filter(([u]) =>
      u.includes('getProfiles'),
    );
    expect(profileCalls).toHaveLength(1);
  });
});
