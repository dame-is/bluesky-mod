// The panel joined to a bot, with the bot's hooks faked and the store empty:
// what a new install sees. Every page's data must come back from a store
// that has nothing in it yet, and what the panel says about the process must
// come from the hooks it was handed.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../bot/agentConfig.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadAgentConfig: async () => ({
    style: 'Short and plain.',
    guidance: 'Ask before adding anyone with a large audience.',
    openers: '',
    report: '',
    postReport: '',
    model: '',
    limits: null,
    barePost: 'card',
  }),
}));

const db = await import('../bot/db.js');
const { issueCode } = await import('./auth.js');
const { forgetList } = await import('./queries.js');
const { startPanel } = await import('./attach.js');

const OWNER = process.env.MOD_OWNER_DID;
let panel;
let base;
let cookie;
const queued = vi.fn((label, job) => Promise.resolve().then(job));

const get = async (path) => {
  const res = await fetch(base + path, { headers: { cookie } });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  await db.closeDb();
  db.openDb(':memory:');
  forgetList();
  delete process.env.MOD_LIST_URI;
  panel = await startPanel({
    queued,
    agent: () => ({ session: { did: 'did:plc:bot0000000000000000000000', handle: 'quietlist.test' } }),
    chat: () => ({}),
    reference: async () => ({
      io: { lookUp: async () => ({ did: 'did:plc:someone00000000000000000', handle: 'someone.test', band: 'UNKNOWN', vouches: 0 }) },
    }),
    vitals: () => ({ queued: 2, dmAnswers: 7, errors: 1, lastPollAt: null, lastDmAt: null, snapshotBusy: true, reference: 'released' }),
  });
  base = `http://127.0.0.1:${panel.address().port}`;
  const res = await fetch(`${base}/api/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-panel-request': '1' },
    body: JSON.stringify({ code: await issueCode(OWNER) }),
  });
  cookie = res.headers.get('set-cookie').split(';')[0];
});

afterAll(async () => {
  await panel?.close();
});

describe('the panel on a bot that has only just started', () => {
  it('says who the bot is and who it works for', async () => {
    const { body } = await get('/api/me');
    expect(body).toMatchObject({
      did: OWNER,
      tier: 'owner',
      canWrite: true,
      bot: { handle: 'quietlist.test' },
      owner: { did: OWNER },
      dryRun: false,
    });
  });

  it('reports what the process is doing from the hooks it was given', async () => {
    const { body } = await get('/api/health');
    expect(body).toMatchObject({ queued: 2, dmAnswers: 7, errors: 1, snapshotBusy: true, reference: 'released' });
    expect(body.database.kind).toBe('SQLite');
    expect(body.memory.rss).toBeGreaterThan(0);
    expect(body.intervals.dmPollMs).toBeGreaterThan(0);
  });

  it('has an answer for every page before anything has happened', async () => {
    const overview = await get('/api/overview');
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({
      list: { total: 0, source: 'log' },
      week: { added: 0, removed: 0 },
      waiting: { queue: 0, scans: 0 },
      protected: { total: 0 },
      snapshot: null,
      scans: [],
      adding: [],
      watches: [],
      changes: [],
    });
    expect(overview.body.days).toHaveLength(30);
    for (const path of ['/api/scans', '/api/queue', '/api/list', '/api/list/radar', '/api/activity', '/api/watches', '/api/protected', '/api/graph', '/api/models', '/api/people']) {
      const { status, body } = await get(path);
      expect(status, path).toBe(200);
      expect(body, path).toBeTypeOf('object');
    }
    expect((await get('/api/graph')).body).toMatchObject({ snapshot: null, newest: null, audits: [] });
    expect((await get('/api/list/radar')).body).toMatchObject({ total: 0, near: [], far: {} });
    expect((await get('/api/scan?code=3f2a1b7c')).status).toBe(404);
  });

  it('shows the owner the config file\'s words, and the settings', async () => {
    const { body } = await get('/api/settings');
    expect(body.file).toMatchObject({ style: 'Short and plain.', guidance: 'Ask before adding anyone with a large audience.', barePost: 'card' });
    expect(body.notes).toEqual([]);
    expect(body.keep.audits).toBeGreaterThan(0);
    expect(body.panel.sessionDays).toBe(30);
    expect(JSON.stringify(body)).not.toMatch(/password|api[_-]?key|secret/i);
  });

  it('scores an account on the bot\'s queue, and reads its history from the log', async () => {
    queued.mockClear();
    const { status, body } = await get('/api/account?actor=someone.test');
    expect(status).toBe(200);
    expect(queued).toHaveBeenCalledWith('panel-lookup', expect.any(Function));
    expect(body).toMatchObject({ did: 'did:plc:someone00000000000000000', live: { band: 'UNKNOWN' }, onLists: [], entries: [] });
  });
});
