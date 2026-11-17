// The answered set is what stops a Jetstream replay from posting a second
// public reply. A mark that only lives in memory is forgotten by a restart, so
// the caller has to know when the mark did not reach the disk.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterAll } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluesky-mod-state-'));
process.env.DATA_DIR = dir;
const { config } = await import('./config.js');
const { loadState, markAnswered, hasAnswered } = await import('./state.js');

const answeredPath = path.resolve(config.dataDir, config.answeredFile);

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the answered set', () => {
  it('says the mark is stored, and a restart still knows it', () => {
    loadState();
    expect(markAnswered('at://did:plc:a/app.bsky.feed.post/1')).toBe(true);
    loadState();
    expect(hasAnswered('at://did:plc:a/app.bsky.feed.post/1')).toBe(true);
  });

  it('says so when the mark cannot be stored', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A directory where the temporary file goes makes the write fail, as a
    // full disk or a read-only volume would.
    fs.mkdirSync(`${answeredPath}.tmp`);
    try {
      expect(markAnswered('at://did:plc:a/app.bsky.feed.post/2')).toBe(false);
      // This process still skips it.
      expect(hasAnswered('at://did:plc:a/app.bsky.feed.post/2')).toBe(true);
    } finally {
      fs.rmdirSync(`${answeredPath}.tmp`);
      quiet.mockRestore();
    }
    // A restart does not, which is why the caller must not answer it.
    loadState();
    expect(hasAnswered('at://did:plc:a/app.bsky.feed.post/2')).toBe(false);
  });
});
