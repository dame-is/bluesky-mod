import { describe, it, expect } from 'vitest';
import { mapLimit, chunks } from './limit.js';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('mapLimit', () => {
  it('keeps input order and never runs more than the limit at once', async () => {
    let live = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 6, 7], 3, async (n) => {
      live += 1;
      peak = Math.max(peak, live);
      for (let i = 0; i < n; i += 1) await tick();
      live -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 60, 70]);
    expect(peak).toBe(3);
  });

  it('rejects on the first failure and starts nothing after it', async () => {
    const started = [];
    await expect(
      mapLimit([1, 2, 3, 4, 5], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});

describe('chunks', () => {
  it('cuts into slices of the size, the last one short', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 3)).toEqual([]);
  });
});
