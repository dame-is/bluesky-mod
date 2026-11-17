import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OWNER_DID } from '../constants.js';

const db = { watch: [], post_alert: [] };
vi.mock('./db.js', () => ({
  select: vi.fn(async (table, opts = {}) => {
    let rows = db[table] || [];
    for (const [k, v] of Object.entries(opts.is || {})) {
      if (v === 'null') rows = rows.filter((r) => r[k] == null);
    }
    return rows;
  }),
  selectAll: vi.fn(async () => []),
  update: vi.fn(async (table, { eq }, patch) => {
    for (const r of db[table] || [])
      if (r.id === eq.id) Object.assign(r, patch);
  }),
  upsert: vi.fn(async (table, rows) => {
    for (const row of rows) {
      const i = db[table].findIndex((r) => r.uri === row.uri);
      if (i === -1) db[table].push({ ...row });
      else db[table][i] = { ...db[table][i], ...row };
    }
    return rows.length;
  }),
}));

const {
  digestFor,
  digestSent,
  ownPostAlerts,
  alertSent,
  alertText,
  watchesText,
} = await import('./watch.js');

const { createActivity } = await import('../ownerActivity.js');
const { LINK_SOURCES } = await import('../spacedust.js');

const HOUR = 3_600_000;
const URI = `at://${OWNER_DID}/app.bsky.feed.post/3abc`;

beforeEach(() => {
  db.watch.length = 0;
  db.post_alert.length = 0;
});

describe('the hourly digest', () => {
  const watch = (extra = {}) => ({
    id: 'w1',
    uri: URI,
    plan_id: '1c2d3e4f-0000-4000-8000-000000000000',
    mode: 'ask',
    until: new Date(10 * HOUR).toISOString(),
    last_digest_at: new Date(0).toISOString(),
    stats: {
      newSinceDigest: 12,
      hostileSinceDigest: 3,
      held: 3,
      heldAsOf: '2026-11-01T10:00:00.000Z',
    },
    ...extra,
  });

  it('says what was found and offers the hostile ones for a thumbs-up', async () => {
    const w = watch();
    db.watch.push(w);
    const out = await digestFor(w, { now: 2 * HOUR });
    expect(out.text).toContain(
      '(8h left): 12 new quotes and replies since the last update, 3 read as hostile.',
    );
    expect(out.pending).toEqual([
      'approve 1c2d3e4f hostile asof=2026-11-01T10:00:00.000Z',
    ]);
    await digestSent(w, { now: 2 * HOUR });
    // Counters reset, so the next digest is about the next hour.
    expect(db.watch[0].stats.newSinceDigest).toBe(0);
  });

  it('records nothing until the digest has gone', async () => {
    const w = watch();
    db.watch.push(w);
    await digestFor(w, { now: 2 * HOUR });
    // A send that fails leaves the counts for the next try.
    expect(db.watch[0].stats.newSinceDigest).toBe(12);
    expect(db.watch[0].last_digest_at).toBe(new Date(0).toISOString());
    await digestSent(w, { now: 2 * HOUR });
    expect(db.watch[0].stats).toMatchObject({
      newSinceDigest: 0,
      hostileSinceDigest: 0,
      held: 3,
    });
    expect(db.watch[0].last_digest_at).toBe(new Date(2 * HOUR).toISOString());
  });

  it('says who was added on an auto watch, and what was held', async () => {
    const w = watch({
      mode: 'auto',
      stats: {
        newSinceDigest: 20,
        hostileSinceDigest: 5,
        addedSinceDigest: 4,
        held: 1,
        heldAsOf: '2026-11-01T10:00:00.000Z',
      },
    });
    db.watch.push(w);
    const out = await digestFor(w, { now: 2 * HOUR });
    expect(out.text).toContain('Added 4 (plan');
    expect(out.text).toContain(
      '1 hostile one is CONNECTED or NOTABLE, so I held it',
    );
  });

  it('stays quiet with nothing new, and within the hour', async () => {
    const quiet = watch({ stats: {} });
    expect(await digestFor(quiet, { now: 2 * HOUR })).toBe(null);
    const recent = watch({
      last_digest_at: new Date(1.5 * HOUR).toISOString(),
    });
    expect(await digestFor(recent, { now: 2 * HOUR })).toBe(null);
  });

  it('lists what is being watched', () => {
    expect(watchesText([watch()], { now: 2 * HOUR })).toContain(
      '8h left, asking before adding',
    );
    expect(watchesText([])).toMatch(/^Not watching anything/);
  });
});

describe("alerts on the owner's own posts", () => {
  const feed = (count, copies = 1) =>
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        feed: Array.from({ length: copies }, () => ({
          post: {
            uri: URI,
            author: { did: OWNER_DID },
            indexedAt: new Date(0).toISOString(),
            quoteCount: count,
            replyCount: 0,
          },
        })),
      }),
    }));

  it('sets a baseline, then alerts once on a jump within the hour', async () => {
    expect(await ownPostAlerts({ fetchImpl: feed(3), now: 1000 })).toEqual([]);
    expect(
      await ownPostAlerts({ fetchImpl: feed(9), now: 1000 + 20 * 60_000 }),
    ).toEqual([]);
    const alerts = await ownPostAlerts({
      fetchImpl: feed(25),
      now: 1000 + 40 * 60_000,
    });
    expect(alerts).toEqual([{ uri: URI, growth: 22, count: 25 }]);
    await alertSent(alerts[0], { now: 1000 + 40 * 60_000 });
    // Not again for six hours.
    expect(
      await ownPostAlerts({ fetchImpl: feed(60), now: 1000 + 50 * 60_000 }),
    ).toEqual([]);
    expect(alertText(alerts[0]).pending).toEqual([`watch ${URI}`]);
  });

  it('offers an alert again when it was not sent', async () => {
    await ownPostAlerts({ fetchImpl: feed(3), now: 1000 });
    const first = await ownPostAlerts({
      fetchImpl: feed(25),
      now: 1000 + 20 * 60_000,
    });
    expect(first).toHaveLength(1);
    const again = await ownPostAlerts({
      fetchImpl: feed(26),
      now: 1000 + 25 * 60_000,
    });
    expect(again).toEqual([{ uri: URI, growth: 23, count: 26 }]);
  });

  it('alerts once on a post that is in the feed twice', async () => {
    // The owner reposting their own post puts it in the feed again.
    await ownPostAlerts({ fetchImpl: feed(0, 2), now: 1000 });
    const alerts = await ownPostAlerts({
      fetchImpl: feed(30, 2),
      now: 1000 + 20 * 60_000,
    });
    expect(alerts).toEqual([{ uri: URI, growth: 30, count: 30 }]);
  });
});

describe('alerts from the stream', () => {
  const linkTo = (subject, n, source = LINK_SOURCES.reply) => ({
    kind: 'link',
    link: {
      operation: 'create',
      source,
      source_record: `at://did:plc:who${n}/app.bsky.feed.post/r${n}`,
      subject,
    },
  });
  const OTHER = 'at://did:plc:someoneelse/app.bsky.feed.post/3xyz';

  /** A tracker that has been connected since t=0, at `t` now. */
  function streamAt(t0 = 0) {
    const clock = { t: t0 };
    const a = createActivity({ now: () => clock.t, coveredFromStart: false, ownerDid: OWNER_DID });
    a.opened([]);
    return { a, clock };
  }

  it('alerts on the stream without polling, once the stream covers the hour', async () => {
    const { a, clock } = streamAt();
    const fetchImpl = vi.fn();
    clock.t = 5 * 60_000;
    for (let i = 0; i < 20; i += 1) a.record(linkTo(URI, i));
    // Only five minutes covered: the poll is the answer, not the stream.
    const early = await ownPostAlerts({ activity: a, fetchImpl: vi.fn(async () => ({ ok: false })), now: clock.t });
    expect(early).toEqual([]);
    clock.t = HOUR + 10 * 60_000;
    for (let i = 20; i < 36; i += 1) a.record(linkTo(URI, i, LINK_SOURCES.quote));
    const alerts = await ownPostAlerts({ activity: a, fetchImpl, now: clock.t });
    // The 20 from five minutes after it connected are out of the last hour.
    expect(alerts).toEqual([{ uri: URI, growth: 16, count: 16 }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("counts only the owner's posts, below the threshold says nothing, and respects the six hours", async () => {
    const { a, clock } = streamAt();
    clock.t = 2 * HOUR;
    for (let i = 0; i < 30; i += 1) a.record(linkTo(OTHER, i));
    for (let i = 30; i < 40; i += 1) a.record(linkTo(URI, i));
    expect(await ownPostAlerts({ activity: a, now: clock.t })).toEqual([]);
    for (let i = 40; i < 50; i += 1) a.record(linkTo(URI, i));
    const [alert] = await ownPostAlerts({ activity: a, now: clock.t });
    expect(alert).toMatchObject({ uri: URI, growth: 20 });
    await alertSent(alert, { now: clock.t });
    expect(await ownPostAlerts({ activity: a, now: clock.t + 60_000 })).toEqual([]);
  });

  it('leaves a watched post alone', async () => {
    const { a, clock } = streamAt();
    clock.t = 2 * HOUR;
    db.watch.push({ id: 'w', uri: URI, until: new Date(clock.t + HOUR).toISOString() });
    for (let i = 0; i < 30; i += 1) a.record(linkTo(URI, i));
    expect(await ownPostAlerts({ activity: a, now: clock.t })).toEqual([]);
  });
});
