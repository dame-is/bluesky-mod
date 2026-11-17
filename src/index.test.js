// index.js runs start() when it is imported, so each test imports a fresh copy
// with the network-facing modules mocked and fake timers in place. The mocks
// record what ran, in order, in `h.events`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BOT = 'did:plc:bot00000000000000000000';

const h = vi.hoisted(() => ({
  events: [],
  logins: 0,
  loginFailures: 0,
  snapshotExists: true,
  steps: 0,
  stepsToFinish: 5,
  onEvent: null,
  trigger: null,
  answerText: '',
  answerError: null,
  posted: [],
}));

vi.mock('./bot/dmLoop.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runDmPass: async () => {
    h.events.push('dm');
    return { answered: 0, scanned: 0, turns: [] };
  },
}));

vi.mock('./bot/botAgent.js', () => {
  const agent = {
    session: { did: 'did:plc:bot00000000000000000000', handle: 'bot.test' },
    app: {
      bsky: {
        actor: { getProfile: async () => ({ data: { handle: 'owner.test' } }) },
      },
    },
  };
  const chat = {
    chat: { bsky: { convo: { getLog: async () => ({ data: { logs: [] } }) } } },
  };
  return {
    botAgent: async () => {
      h.logins += 1;
      h.events.push('login');
      if (h.logins <= h.loginFailures) {
        throw Object.assign(new Error('Invalid identifier or password'), {
          status: 401,
        });
      }
      return { agent, via: 'login' };
    },
    chatView: () => chat,
  };
});

vi.mock('./snapshot.js', () => ({
  hasSnapshot: async () => h.snapshotExists,
  snapshotStep: async () => {
    h.events.push('step');
    // A step spends its whole budget, as a real one does on a large graph.
    await new Promise((r) => setTimeout(r, 25_000));
    h.steps += 1;
    return h.steps < h.stepsToFinish
      ? { state: 'collecting', remaining: 100, indexed: h.steps }
      : { state: 'finalised', snapshot: 's', vouches: 1, unreadableMembers: 0 };
  },
}));

vi.mock('./jetstream.js', () => ({
  connectJetstream: ({ onEvent }) => {
    h.events.push('jetstream');
    h.onEvent = onEvent;
    return { close() {} };
  },
}));

// The public path, from a mention to the posts under it.
vi.mock('./lib/trigger.js', async (importOriginal) => ({
  ...(await importOriginal()),
  classify: () => h.trigger ?? { trigger: false, reason: 'test' },
}));

vi.mock('./bot/reference.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadReference: async () => ({
    ref: { vouches: new Map(), circle: new Set() },
    takenAt: '2026-01-01T00:00:00.000Z',
  }),
  makeIo: () => ({}),
}));

vi.mock('./lib/agent.js', async (importOriginal) => ({
  ...(await importOriginal()),
  answer: async () => {
    h.events.push('answer');
    if (h.answerError) throw h.answerError;
    return { text: h.answerText, steps: 12, usage: null, pulses: [] };
  },
}));

vi.mock('./publicReply.js', () => ({
  replyInThread: async (agent, refs, chunks) => {
    h.posted.push(...chunks);
    return chunks.map((_, i) => `at://${BOT}/app.bsky.feed.post/r${i}`);
  },
}));

const ENV = {
  MOD_IDENTIFIER: BOT,
  MOD_APP_PASSWORD: 'not-a-real-password',
  MOD_LIST_URI: `at://${BOT}/app.bsky.graph.list/3list`,
  ATMOSPHERE: 'false',
  DRIFT_EVERY_HOURS: '0',
  MOD_WATCH_EVERY_MS: '0',
  MOD_ALERTS: 'off',
  STATS_INTERVAL_MS: '0',
  LOG_LEVEL: 'error',
};

let savedEnv;

let dataDir;

async function boot(extraEnv = {}) {
  savedEnv = { ...process.env };
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluesky-mod-index-'));
  Object.assign(process.env, ENV, extraEnv, {
    DATA_DIR: dataDir,
    MOD_CONFIG_FILE: path.join(os.tmpdir(), 'bluesky-mod-no-such-config.json'),
  });
  await import('./index.js');
  // Let start() run up to its timers.
  await vi.advanceTimersByTimeAsync(10);
}

/** Whether a DM poll ran between every two snapshot steps. */
function pollBetweenSteps(events) {
  const steps = events.flatMap((e, i) => (e === 'step' ? [i] : []));
  return steps
    .slice(1)
    .every((at, n) => events.slice(steps[n] + 1, at).includes('dm'));
}

beforeEach(() => {
  Object.assign(h, {
    events: [],
    logins: 0,
    loginFailures: 0,
    snapshotExists: true,
    steps: 0,
    stepsToFinish: 5,
    onEvent: null,
    trigger: null,
    answerText: '',
    answerError: null,
    posted: [],
  });
  vi.resetModules();
  vi.useFakeTimers();
  vi.spyOn(process, 'exit').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = savedEnv;
});

describe('the first login', () => {
  it('is retried in the process on a backoff instead of exiting', async () => {
    h.loginFailures = 2;
    await boot();
    expect(process.exit).not.toHaveBeenCalled();
    expect(h.logins).toBe(1);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(h.logins).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.logins).toBe(2);

    // The wait doubles after each failure.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.logins).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.logins).toBe(3);

    // Nothing else starts until a login works.
    expect(h.events.slice(0, 3)).toEqual(['login', 'login', 'login']);
    expect(h.events).toContain('jetstream');
    expect(process.exit).not.toHaveBeenCalled();
  });
});

describe('DMs while the snapshot builds', () => {
  it('polls once before the first step, so the DM cursor is set at start', async () => {
    h.snapshotExists = false;
    await boot();
    expect(h.events).toContain('dm');
    expect(h.events).toContain('step');
    expect(h.events.indexOf('dm')).toBeLessThan(h.events.indexOf('step'));
  });

  it('polls between every two snapshot steps', async () => {
    h.snapshotExists = false;
    await boot();
    await vi.advanceTimersByTimeAsync(h.stepsToFinish * 26_000);
    expect(h.steps).toBe(h.stepsToFinish);
    expect(pollBetweenSteps(h.events)).toBe(true);
  });

  it('never polls in a dry run', async () => {
    h.snapshotExists = false;
    await boot({ DRY_RUN: 'true' });
    await vi.advanceTimersByTimeAsync(h.stepsToFinish * 26_000);
    expect(h.steps).toBe(h.stepsToFinish);
    expect(h.events).not.toContain('dm');
  });
});

describe('a public mention', () => {
  const POST = 'at://did:plc:owner0000000000000000000/app.bsky.feed.post/3abc';
  const mention = () => ({
    trigger: true,
    uri: POST,
    author: 'did:plc:owner0000000000000000000',
    text: '@bot.test who is this?',
    target: 'at://did:plc:someone000000000000000000/app.bsky.feed.post/3xyz',
    targetSource: 'link',
    isFollowUp: false,
    reply: {
      root: { uri: POST, cid: 'bafyroot' },
      parent: { uri: POST, cid: 'bafyroot' },
    },
  });

  it('is answered in the thread', async () => {
    await boot();
    h.trigger = mention();
    h.answerText = 'A stranger: nobody you follow follows them.';
    h.onEvent({ time_us: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.events).toContain('answer');
    expect(h.posted).toEqual(['A stranger: nobody you follow follows them.']);
  });

  it('records what a failed answer spent before it failed', async () => {
    await boot();
    h.trigger = mention();
    h.answerError = Object.assign(new Error('provider went away'), {
      usage: { inputTokens: 120, outputTokens: 3 },
    });
    h.onEvent({ time_us: 1 });
    await vi.advanceTimersByTimeAsync(10);
    const { select } = await import('./bot/db.js');
    const rows = await select('llm_usage', {
      select: 'kind,input_tokens,output_tokens',
    });
    expect(rows).toEqual([
      { kind: 'post', input_tokens: 120, output_tokens: 3 },
    ]);
    expect(h.posted).toEqual([]);
  });

  it('is not answered when it cannot be recorded as answered', async () => {
    // A restart would replay a mention it has no record of, and answer it a
    // second time, in public.
    await boot();
    const { config } = await import('./config.js');
    fs.mkdirSync(path.join(dataDir, `${config.answeredFile}.tmp`));
    h.trigger = mention();
    h.answerText = 'A stranger: nobody you follow follows them.';
    h.onEvent({ time_us: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.events).not.toContain('answer');
    expect(h.posted).toEqual([]);
  });

  it('posts nothing when the analyst produced no text', async () => {
    // A turn that ended on a tool call at the step cap, or a provider that
    // sent back nothing. A placeholder under someone's post cannot be taken
    // back.
    await boot();
    h.trigger = mention();
    h.answerText = '';
    h.onEvent({ time_us: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.events).toContain('answer');
    expect(h.posted).toEqual([]);
  });
});
