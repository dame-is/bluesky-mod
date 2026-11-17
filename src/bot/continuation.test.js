// The store behind approvals that carry on by themselves, against the real
// database.

import { describe, it, expect, beforeEach } from 'vitest';

const db = await import('./db.js');
const {
  continueLater,
  dueContinuation,
  retryLater,
  stopContinuation,
  RATE_LIMIT_WAIT_MS,
  RETRY_WAIT_MS,
  MAX_FAILURES,
} = await import('./continuation.js');

const PLAN = '1c2d3e4f-0000-4000-8000-000000000000';
const T0 = Date.parse('2026-11-17T20:00:00.000Z');

beforeEach(() => {
  db.closeDb();
  db.openDb(':memory:');
});

describe('a carried-on approval', () => {
  it('is due at once, and an hour later after the write limit', async () => {
    await continueLater(
      { planId: PLAN, convoId: 'c1', command: 'approve 1c2d3e4f UNKNOWN', added: 500 },
      { now: T0 },
    );
    expect(await dueContinuation({ now: T0 })).toMatchObject({
      plan_id: PLAN,
      convo_id: 'c1',
      command: 'approve 1c2d3e4f UNKNOWN',
      added: 500,
    });

    await continueLater(
      { planId: PLAN, convoId: 'c1', command: 'approve 1c2d3e4f UNKNOWN', added: 442, rateLimited: true },
      { now: T0 },
    );
    expect(await dueContinuation({ now: T0 })).toBe(null);
    expect(
      await dueContinuation({ now: T0 + RATE_LIMIT_WAIT_MS }),
    ).toMatchObject({ added: 942 });
  });

  it('waits after a failed batch and gives up after a few in a row', async () => {
    await continueLater(
      { planId: PLAN, convoId: 'c1', command: 'approve 1c2d3e4f UNKNOWN' },
      { now: T0 },
    );
    for (let i = 1; i < MAX_FAILURES; i += 1) {
      expect(await retryLater(PLAN, { now: T0 })).toEqual({ gaveUp: false });
      expect(await dueContinuation({ now: T0 })).toBe(null);
      expect(await dueContinuation({ now: T0 + RETRY_WAIT_MS })).not.toBe(null);
    }
    expect(await retryLater(PLAN, { now: T0 })).toEqual({ gaveUp: true });
    expect(await dueContinuation({ now: T0 + 10 * RETRY_WAIT_MS })).toBe(null);
  });

  it('is gone once stopped', async () => {
    await continueLater(
      { planId: PLAN, convoId: 'c1', command: 'approve 1c2d3e4f UNKNOWN' },
      { now: T0 },
    );
    await stopContinuation(PLAN);
    expect(await dueContinuation({ now: T0 })).toBe(null);
  });
});
