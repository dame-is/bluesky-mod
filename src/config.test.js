// config.js reads the environment when it is imported, so each check imports
// a fresh copy with the settings under test in place.
import { describe, it, expect, vi, afterEach } from 'vitest';

const BOT = 'did:plc:bot00000000000000000000';
const USABLE = {
  MOD_IDENTIFIER: BOT,
  MOD_APP_PASSWORD: 'not-a-real-password',
  MOD_LIST_URI: `at://${BOT}/app.bsky.graph.list/3list`,
};

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

/** What assertConfig reports for these settings, one entry per problem. */
async function problemsWith(env) {
  process.env = { ...savedEnv, ...USABLE, ...env };
  vi.resetModules();
  const { assertConfig } = await import('./config.js');
  try {
    assertConfig();
    return [];
  } catch (err) {
    return err.message.split('\n  - ').slice(1);
  }
}

const MAX_TIMER_MS = 2 ** 31 - 1;

describe('number settings', () => {
  it('accept the defaults', async () => {
    expect(await problemsWith({})).toEqual([]);
  });

  it.each([
    'DM_POLL_MS',
    'RECONNECT_BASE_MS',
    'RECONNECT_MAX_MS',
    'RECONNECT_EVERY_MS',
    'REFERENCE_IDLE_MS',
    'SNAPSHOT_CHECK_MS',
    'DRIFT_CHECK_MS',
    'MOD_WATCH_EVERY_MS',
    'MOD_ALERT_EVERY_MS',
    'STATS_INTERVAL_MS',
    'MOD_OPERATOR_TIMEOUT_MS',
    'MOD_OPERATOR_CALL_TIMEOUT_MS',
    'MOD_ESCALATION_CALL_TIMEOUT_MS',
    'MOD_MODEL_TIMEOUT_MS',
  ])('refuse a %s too long for a timer, which would fire after 1 ms', async (name) => {
    const problems = await problemsWith({ [name]: String(MAX_TIMER_MS + 1) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${name} must be `));
    expect(problems[0]).toContain(String(MAX_TIMER_MS));
    expect(await problemsWith({ [name]: String(MAX_TIMER_MS) })).toEqual([]);
  });

  it.each([
    ['DM_POLL_MS', 1_000],
    ['RECONNECT_BASE_MS', 100],
    ['RECONNECT_MAX_MS', 1_000],
    ['RECONNECT_EVERY_MS', 60_000],
    ['SNAPSHOT_CHECK_MS', 60_000],
    ['DRIFT_CHECK_MS', 60_000],
    ['MOD_WATCH_EVERY_MS', 60_000],
    ['MOD_ALERT_EVERY_MS', 60_000],
  ])('refuse a %s below %i, which makes a slow loop a busy one', async (name, min) => {
    const problems = await problemsWith({ [name]: String(min - 1) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(new RegExp(`^${name} must be `));
    expect(problems[0]).toContain(String(min));
    expect(await problemsWith({ [name]: String(min) })).toEqual([]);
  });

  it('still take 0 to turn off watches, alerts, stats and the model-call watchdogs', async () => {
    expect(
      await problemsWith({
        MOD_WATCH_EVERY_MS: '0',
        MOD_ALERT_EVERY_MS: '0',
        STATS_INTERVAL_MS: '0',
        MOD_OPERATOR_CALL_TIMEOUT_MS: '0',
        MOD_ESCALATION_CALL_TIMEOUT_MS: '0',
      }),
    ).toEqual([]);
  });

  it('refuse a whole-turn deadline of 0, which would end every agent turn at once', async () => {
    const problems = await problemsWith({ MOD_OPERATOR_TIMEOUT_MS: '0' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^MOD_OPERATOR_TIMEOUT_MS must be /);
  });

  it.each(['MOD_OPERATOR_TIMEOUT_MS', 'MOD_MODEL_TIMEOUT_MS'])(
    'refuse a %s that is not a whole number, which AbortSignal.timeout throws on',
    async (name) => {
      const problems = await problemsWith({ [name]: '1500.5' });
      expect(problems).toEqual([
        `${name} must be a whole number above 0 and at most ${MAX_TIMER_MS}`,
      ]);
      expect(await problemsWith({ [name]: '0' })).toHaveLength(1);
      expect(await problemsWith({ [name]: '1500' })).toEqual([]);
    },
  );

  it('refuse 0 where a timer must run, as before', async () => {
    const problems = await problemsWith({ DM_POLL_MS: '0' });
    expect(problems).toEqual([expect.stringMatching(/^DM_POLL_MS must be /)]);
  });
});
