// The Jetstream cursor survives a restart, so the subscription resumes from
// where it got to.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluesky-mod-state-'));
process.env.DATA_DIR = dir;
const { config } = await import('./config.js');

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the stream cursor', () => {
  it('is read back after a restart', async () => {
    const first = await import('./state.js');
    first.loadState();
    first.setCursor(1700000000000000);
    expect(
      fs.readFileSync(path.resolve(config.dataDir, config.cursorFile), 'utf8'),
    ).toBe('1700000000000000');

    vi.resetModules();
    const again = await import('./state.js');
    expect(again.loadState()).toEqual({ cursor: '1700000000000000' });
    expect(again.getCursor()).toBe('1700000000000000');
  });
});
