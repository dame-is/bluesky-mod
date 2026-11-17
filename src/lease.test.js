// One copy per data directory: a fresh lease keeps a second copy out, a stale
// one or this process's own from before a restart is taken over.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { acquireLease, STALE_MS } from './lease.js';

let dir;
let clock;
const now = () => clock;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluesky-mod-lease-'));
  clock = 1_000_000;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the lease', () => {
  it('keeps a second copy out while the first one beats', () => {
    const first = acquireLease({ dir, now, host: 'a', pid: 1 });
    expect(first.ok).toBe(true);
    const second = acquireLease({ dir, now, host: 'b', pid: 1 });
    expect(second).toMatchObject({ ok: false, holder: { host: 'a', pid: 1 } });
    first.release();
    expect(acquireLease({ dir, now, host: 'b', pid: 1 }).ok).toBe(true);
  });

  it('is taken over once the holder has stopped beating', () => {
    acquireLease({ dir, now, host: 'a', pid: 1 });
    clock += STALE_MS + 1;
    expect(acquireLease({ dir, now, host: 'b', pid: 7 }).ok).toBe(true);
  });

  it("is this process's own after a restart with the same host and PID", () => {
    // A container restarted after a crash keeps its hostname and PID 1.
    acquireLease({ dir, now, host: 'container', pid: 1 });
    expect(acquireLease({ dir, now, host: 'container', pid: 1 }).ok).toBe(true);
  });

  it('leaves a lease another copy took alone on release', () => {
    const first = acquireLease({ dir, now, host: 'a', pid: 1 });
    clock += STALE_MS + 1;
    acquireLease({ dir, now, host: 'b', pid: 2 });
    first.release();
    expect(
      acquireLease({ dir, now, host: 'c', pid: 3 }),
    ).toMatchObject({ ok: false, holder: { host: 'b' } });
  });
});
