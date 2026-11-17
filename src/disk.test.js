import { describe as group, it, expect } from 'vitest';
import os from 'node:os';
import { diskSpace, isLow, describe } from './disk.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;

group('the data disk', () => {
  it('is low under a tenth, never under 256 MB and never over 2 GB', () => {
    expect(isLow({ free: 200 * MB, total: 1 * GB })).toBe(true);
    expect(isLow({ free: 300 * MB, total: 1 * GB })).toBe(false);
    expect(isLow({ free: 400 * MB, total: 5 * GB })).toBe(true);
    expect(isLow({ free: 600 * MB, total: 5 * GB })).toBe(false);
    expect(isLow({ free: 3 * GB, total: 100 * GB })).toBe(false);
    expect(isLow({ free: 1.5 * GB, total: 100 * GB })).toBe(true);
  });

  it('says how much is left in words', () => {
    expect(describe({ free: 180 * MB, total: GB })).toBe('180 MB free of 1 GB');
    expect(describe({ free: 2.5 * GB, total: 5 * GB })).toBe('2.5 GB free of 5 GB');
  });

  it('reads a real filesystem', async () => {
    const space = await diskSpace(os.tmpdir());
    expect(space.total).toBeGreaterThan(0);
    expect(space.free).toBeLessThanOrEqual(space.total);
  });
});
