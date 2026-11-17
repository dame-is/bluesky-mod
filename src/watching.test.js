// The timed loops and the one stored question per convo: a digest or an alert
// must never replace a question the owner is in the middle of answering.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { dm_choice: [] };

vi.mock('./bot/db.js', () => ({
  select: vi.fn(async (table, { eq = {} } = {}) =>
    (db[table] || []).filter((r) =>
      Object.entries(eq).every(([k, v]) => r[k] === v),
    ),
  ),
  upsert: vi.fn(async (table, rows) => {
    for (const row of rows) {
      const list = (db[table] ||= []);
      const at = list.findIndex((r) => r.convo_id === row.convo_id);
      if (at === -1) list.push({ ...row });
      else list[at] = { ...list[at], ...row };
    }
    return rows.length;
  }),
  update: vi.fn(async () => {}),
}));

const watch = {
  liveWatches: vi.fn(async () => []),
  checkWatch: vi.fn(async () => {}),
  digestFor: vi.fn(async () => null),
  digestSent: vi.fn(async () => {}),
  expiredWatches: vi.fn(async () => []),
  endWatch: vi.fn(async () => {}),
  ownPostAlerts: vi.fn(async () => []),
  alertSent: vi.fn(async () => {}),
};
vi.mock('./bot/watch.js', () => ({
  ...watch,
  alertText: ({ uri }) => ({
    text: `Your post ${uri} took off.`,
    pending: [`watch ${uri}`],
    describe: 'watch it',
    links: [],
  }),
  WATCH_EVERY_MS: 60_000,
}));

const { say, tickWatches, tickAlerts } = await import('./watching.js');
const { savePending, readPending } =
  await import('./bot/chatUx.js');

/** A chat whose sends to the convos in `down` fail. */
function chat({ down = [] } = {}) {
  const sent = [];
  return {
    sent,
    chat: {
      bsky: {
        convo: {
          sendMessage: async ({ convoId, message }) => {
            if (down.includes(convoId)) throw new Error('502 Bad Gateway');
            sent.push(message.text);
            return { data: { id: `m${sent.length}` } };
          },
        },
      },
    },
  };
}

const DIGEST = {
  text: 'Watching the post: 4 new, 3 read as hostile.',
  pending: ['approve 1c2d3e4f hostile'],
  describe: 'add the 3 read as hostile',
};

beforeEach(() => {
  db.dm_choice = [];
  for (const fn of Object.values(watch)) fn.mockClear();
});

describe('a timed message that asks something', () => {
  it('stores its question when nothing else is waiting', async () => {
    const c = chat();
    await say(c, 'convo1', DIGEST);
    expect(c.sent[0]).toMatch(/👍 or "yes" to: add the 3/);
    const p = await readPending('convo1');
    expect(p).toMatchObject({
      commands: ['approve 1c2d3e4f hostile'],
      background: true,
    });
  });

  it('leaves a question from the conversation alone, and does not offer a 👍 of its own', async () => {
    await savePending('convo1', {
      commands: ['list remove @x.test'],
      describe: 'remove @x.test',
      messageIds: ['asked'],
    });
    const c = chat();
    await say(c, 'convo1', DIGEST);
    expect(c.sent[0]).toBe(DIGEST.text);
    expect(await readPending('convo1')).toMatchObject({
      commands: ['list remove @x.test'],
      message_ids: ['asked'],
    });
  });

  it('replaces an earlier timed question', async () => {
    await say(chat(), 'convo1', {
      ...DIGEST,
      pending: ['approve aaaa1111 hostile'],
    });
    await say(chat(), 'convo1', DIGEST);
    expect((await readPending('convo1')).commands).toEqual([
      'approve 1c2d3e4f hostile',
    ]);
  });
});

describe('how often a watch is read', () => {
  it('follows the interval it is given', async () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    const w = {
      id: 'w1',
      convo_id: 'convo1',
      uri: 'at://p',
      last_checked_at: '2026-11-01T11:58:00Z',
    };
    const tick = (everyMs) =>
      tickWatches({
        chat: chat(),
        agent: {},
        reference: async () => ({ io: { score: () => {} } }),
        model: 'm',
        everyMs,
        now,
      });
    watch.liveWatches.mockResolvedValueOnce([w]).mockResolvedValueOnce([w]);
    // Read two minutes ago: due on a one-minute interval, not a five.
    await tick(60_000);
    expect(watch.checkWatch).toHaveBeenCalledTimes(1);
    await tick(5 * 60_000);
    expect(watch.checkWatch).toHaveBeenCalledTimes(1);
  });
});

describe('a send that fails', () => {
  const tick = (c) =>
    tickWatches({
      chat: c,
      agent: {},
      reference: async () => ({ io: { score: () => {} } }),
      model: 'm',
      now: Date.parse('2026-11-01T12:00:00Z'),
    });

  it('keeps an expired watch open until its closing digest has gone', async () => {
    const w = {
      id: 'w1',
      convo_id: 'convo1',
      uri: 'at://p',
      until: '2026-11-01T11:00:00Z',
    };
    watch.expiredWatches.mockResolvedValue([w]);
    watch.digestFor.mockResolvedValue({ text: 'Stopped watching: 12 added.' });
    try {
      await tick(chat({ down: ['convo1'] }));
      expect(watch.endWatch).not.toHaveBeenCalled();

      const c = chat();
      await tick(c);
      expect(c.sent).toEqual(['Stopped watching: 12 added.']);
      expect(watch.endWatch).toHaveBeenCalledWith(w, expect.anything());
    } finally {
      watch.expiredWatches.mockReset();
      watch.expiredWatches.mockResolvedValue([]);
      watch.digestFor.mockReset();
      watch.digestFor.mockResolvedValue(null);
    }
  });

  it('gives up on a closing digest a day after the watch ended', async () => {
    const w = { id: 'w1', convo_id: 'convo1', until: '2026-10-31T11:00:00Z' };
    watch.expiredWatches.mockResolvedValueOnce([w]);
    watch.digestFor.mockResolvedValueOnce({ text: 'Stopped watching.' });
    await tick(chat({ down: ['convo1'] }));
    expect(watch.endWatch).toHaveBeenCalledWith(w, expect.anything());
  });

  it('records a digest only once it has gone, and goes on to the next watch', async () => {
    const a = { id: 'a', convo_id: 'convo1', uri: 'at://a' };
    const b = { id: 'b', convo_id: 'convo2', uri: 'at://b' };
    watch.liveWatches.mockResolvedValueOnce([a, b]);
    watch.digestFor
      .mockResolvedValueOnce({ text: 'Added 12 on a.' })
      .mockResolvedValueOnce({ text: 'Added 3 on b.' });
    const c = chat({ down: ['convo1'] });
    await tick(c);
    expect(c.sent).toEqual(['Added 3 on b.']);
    expect(watch.digestSent).toHaveBeenCalledTimes(1);
    expect(watch.digestSent).toHaveBeenCalledWith(b, expect.anything());
  });

  it('records an alert only once it has gone', async () => {
    watch.ownPostAlerts.mockResolvedValueOnce([{ uri: 'at://p', growth: 20 }]);
    const n = await tickAlerts({
      chat: chat({ down: ['convo1'] }),
      convoFor: async () => 'convo1',
    });
    expect(n).toBe(0);
    expect(watch.alertSent).not.toHaveBeenCalled();

    watch.ownPostAlerts.mockResolvedValueOnce([{ uri: 'at://p', growth: 20 }]);
    const c = chat();
    expect(await tickAlerts({ chat: c, convoFor: async () => 'convo1' })).toBe(
      1,
    );
    expect(watch.alertSent).toHaveBeenCalledWith(
      { uri: 'at://p', growth: 20 },
      expect.anything(),
    );
  });
});

describe('the loops wait for an answer', () => {
  it('holds a watch digest while a question is open, and keeps reading', async () => {
    await savePending('convo1', {
      commands: ['list remove @x.test'],
      describe: 'remove @x.test',
      messageIds: ['asked'],
    });
    watch.liveWatches.mockResolvedValueOnce([
      { id: 'w1', convo_id: 'convo1', uri: 'at://p', last_checked_at: null },
    ]);
    const c = chat();
    await tickWatches({
      chat: c,
      agent: {},
      reference: async () => ({ io: { score: () => {} } }),
      model: 'm',
    });
    expect(watch.checkWatch).toHaveBeenCalled();
    expect(watch.digestFor).not.toHaveBeenCalled();
    expect(c.sent).toEqual([]);
  });

  it('holds an alert while a question is open, before it is used up', async () => {
    await savePending('convo1', {
      commands: ['list remove @x.test'],
      describe: 'remove @x.test',
      messageIds: ['asked'],
    });
    const c = chat();
    const n = await tickAlerts({ chat: c, convoFor: async () => 'convo1' });
    expect(n).toBe(0);
    expect(watch.ownPostAlerts).not.toHaveBeenCalled();
    expect(c.sent).toEqual([]);
  });

  it('holds an alert while there is no convo to send it to', async () => {
    const c = chat();
    expect(await tickAlerts({ chat: c, convoFor: async () => null })).toBe(0);
    expect(watch.ownPostAlerts).not.toHaveBeenCalled();
  });

  it('sends an alert when nothing is waiting', async () => {
    watch.ownPostAlerts.mockResolvedValueOnce([{ uri: 'at://p', growth: 20 }]);
    const c = chat();
    expect(await tickAlerts({ chat: c, convoFor: async () => 'convo1' })).toBe(
      1,
    );
    expect(c.sent[0]).toMatch(/took off/);
  });
});
