// index.js runs start() when it is imported, so each test imports a fresh copy
// with the network-facing modules mocked and fake timers in place. The mocks
// record what ran, in order, in `h.events`. Each copy also adds its own
// process listeners, which afterEach removes so they do not pile up.
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
  stepScript: [],
  stream: null,
  dms: [],
  disk: { free: 50 * 2 ** 30, total: 100 * 2 ** 30 },
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
    com: {
      atproto: {
        repo: {
          getRecord: async ({ collection }) => ({
            data: {
              value:
                collection === 'app.bsky.graph.list'
                  ? { purpose: 'app.bsky.graph.defs#modlist', name: 'list' }
                  : { allowIncoming: 'all' },
            },
          }),
        },
      },
    },
  };
  const chat = {
    chat: {
      bsky: {
        convo: {
          getLog: async () => ({ data: { logs: [] } }),
          sendMessage: async ({ message }) => {
            h.dms.push(message.text);
            return { data: { id: 'sent' } };
          },
        },
      },
    },
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
  UNPROTECTED_LISTS: [],
  hasSnapshot: async () => h.snapshotExists,
  snapshotStep: async () => {
    h.events.push('step');
    // A step spends its whole budget, as a real one does on a large graph.
    await new Promise((r) => setTimeout(r, 25_000));
    h.steps += 1;
    if (h.stepScript.length) return h.stepScript.shift();
    return h.steps < h.stepsToFinish
      ? { state: 'collecting', remaining: 100, indexed: h.steps }
      : { state: 'finalised', snapshot: 's', vouches: 1, unreadableMembers: 0 };
  },
}));

vi.mock('./jetstream.js', () => ({
  connectJetstream: ({ dids, collections }) => {
    h.events.push('jetstream');
    h.stream = { dids, collections };
    return { close() {} };
  },
}));

vi.mock('./bot/reference.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadReference: async () => ({
    ref: { vouches: new Map(), circle: new Set() },
    takenAt: '2026-01-01T00:00:00.000Z',
  }),
  makeIo: () => ({}),
}));

vi.mock('./drift.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ownerConvo: async () => 'owner-convo',
}));

vi.mock('./disk.js', async (importOriginal) => ({
  ...(await importOriginal()),
  diskSpace: async () => h.disk,
}));

vi.mock('./watching.js', () => ({
  tickWatches: async ({ model }) => {
    h.events.push(`watch:${model}`);
  },
  tickAlerts: async () => {},
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

const PROCESS_EVENTS = [
  'SIGINT',
  'SIGTERM',
  'uncaughtException',
  'unhandledRejection',
];
/** The process listeners there were before index.js was imported. */
let listenersBefore = null;

async function boot(extraEnv = {}, { beforeImport = () => {} } = {}) {
  savedEnv = { ...process.env };
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluesky-mod-index-'));
  beforeImport(dataDir);
  Object.assign(
    process.env,
    ENV,
    {
      MOD_CONFIG_FILE: path.join(
        os.tmpdir(),
        'bluesky-mod-no-such-config.json',
      ),
    },
    extraEnv,
    { DATA_DIR: dataDir },
  );
  listenersBefore = Object.fromEntries(
    PROCESS_EVENTS.map((e) => [e, new Set(process.listeners(e))]),
  );
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
    stepScript: [],
    stream: null,
    dms: [],
    disk: { free: 50 * 2 ** 30, total: 100 * 2 ** 30 },
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
  for (const e of PROCESS_EVENTS) {
    for (const fn of process.listeners(e)) {
      if (listenersBefore && !listenersBefore[e].has(fn)) process.off(e, fn);
    }
  }
  listenersBefore = null;
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
    expect(h.events).toContain('dm');
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

  it('comes back when a member that failed may be asked again', async () => {
    // Every member left failed a moment ago. The hourly check would leave
    // the build waiting far longer than the ten-minute pause.
    h.snapshotExists = false;
    h.stepScript = [{ state: 'waiting', remaining: 2, retryInMs: 600_000 }];
    await boot();
    // The first step, the pause and a second, each step taking 25s.
    await vi.advanceTimersByTimeAsync(25_000 + 601_000 + 25_000 + 1_000);
    expect(h.steps).toBe(2);
  });

  it('never polls in a dry run', async () => {
    h.snapshotExists = false;
    await boot({ DRY_RUN: 'true' });
    await vi.advanceTimersByTimeAsync(h.stepsToFinish * 26_000);
    expect(h.steps).toBe(h.stepsToFinish);
    expect(h.events).not.toContain('dm');
  });
});

describe('a second copy', () => {
  it('waits while another copy holds the data directory, then starts', async () => {
    await boot({}, {
      beforeImport: (dir) =>
        fs.writeFileSync(
          path.join(dir, 'bot.lease'),
          JSON.stringify({ host: 'elsewhere', pid: 5, heartbeatAt: Date.now() }),
        ),
    });
    expect(h.events).not.toContain('login');
    // The other copy stopped beating; its lease goes stale.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.events).toContain('login');
  });
});

describe('a data disk running low', () => {
  it('is said by DM once, not every hour', async () => {
    h.disk = { free: 100 * 2 ** 20, total: 2 ** 30 };
    await boot();
    expect(h.dms).toEqual([
      "The bot's data disk is nearly full: 100 MB free of 1 GB. Give it a bigger disk before writes start failing; docs/DEPLOY.md says how for each host.",
    ]);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(h.dms).toHaveLength(1);
  });

  it('says nothing while there is room', async () => {
    await boot();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.dms).toEqual([]);
  });
});

describe('the Jetstream subscription', () => {
  it("follows only the owner's own follows and list items", async () => {
    await boot();
    expect(h.stream).toEqual({
      dids: ['did:plc:owner0000000000000000000'],
      collections: ['app.bsky.graph.follow', 'app.bsky.graph.listitem'],
    });
  });
});

describe('the startup log', () => {
  it("names the config file's model, and the check model it implies", async () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'bluesky-mod-config-')),
      'bot.json',
    );
    fs.writeFileSync(file, JSON.stringify({ model: 'from/config-file' }));
    const lines = [];
    vi.spyOn(console, 'log').mockImplementation((line) => lines.push(line));
    await boot({ MOD_CONFIG_FILE: file, LOG_LEVEL: 'info', LOG_JSON: 'true' });
    const started = lines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.msg === 'Bot started');
    expect(started).toMatchObject({
      model: 'from/config-file',
      check: 'from/config-file',
    });
  });
});

describe('a watch', () => {
  it("is read on the config file's model when it names one", async () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'bluesky-mod-config-')),
      'bot.json',
    );
    fs.writeFileSync(file, JSON.stringify({ model: 'from/config-file' }));
    await boot({ MOD_WATCH_EVERY_MS: '60000', MOD_CONFIG_FILE: file });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(h.events).toContain('watch:from/config-file');
  });
});
