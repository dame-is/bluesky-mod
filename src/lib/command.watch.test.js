// "stop watching" with a list or a feed, through the real stopWatch against
// an in-memory database. Neither can be watched, so neither stops a watch.

import { describe, it, expect, beforeEach } from 'vitest';

const db = await import('../bot/db.js');
const { stopWatch, liveWatches } = await import('../bot/watch.js');
const { parseWatchCommand } = await import('./command.js');

const until = new Date(Date.now() + 3_600_000).toISOString();

beforeEach(async () => {
  db.closeDb();
  db.openDb(':memory:');
  await db.upsert('watch', [
    {
      id: 'w1',
      convo_id: 'c',
      uri: 'at://did:plc:a/app.bsky.feed.post/1',
      until,
      created_at: '2026-11-17T10:00:00.000Z',
    },
    {
      id: 'w2',
      convo_id: 'c',
      uri: 'at://did:plc:a/app.bsky.feed.post/2',
      until,
      created_at: '2026-11-17T11:00:00.000Z',
    },
  ]);
});

describe('stop watching something that is not a post', () => {
  it('stops neither watch', async () => {
    for (const text of [
      'stop watching at://did:plc:abc/app.bsky.graph.list/3abc',
      'stop watching at://did:plc:abc/app.bsky.feed.generator/hot',
    ]) {
      const { target } = parseWatchCommand(text);
      expect(await stopWatch({ target }), text).toBe(null);
    }
    expect((await liveWatches()).map((w) => w.id)).toEqual(['w2', 'w1']);
  });
});
