// The panel over HTTP, end to end: the real server on a local port, over the
// invented store, with the stand-in bot from scripts/panel-demo.js where the
// real one would write to Bluesky.

import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { closeDb, openDb, select } from '../bot/db.js';
import { makeRoster } from '../lib/senders.js';
import { issueCode } from './auth.js';
import { forgetList } from './queries.js';
import { createPanel } from './server.js';

const READER = 'did:plc:reader000000000000000000';

let panel;
let seeded;
let base;

beforeAll(async () => {
  await closeDb();
  openDb(':memory:');
  forgetList();
  const { demoPanel } = await import('../../scripts/panel-demo.js');
  ({ panel, seeded } = await demoPanel({ extraRoster: { allowed: [READER] } }));
  base = `http://127.0.0.1:${(await panel.listen()).port}`;
}, 60_000);

afterAll(async () => {
  await panel?.close();
});

const get = (path, cookie) =>
  fetch(base + path, { headers: cookie ? { cookie } : {} });

const post = (path, body, { cookie, headers = {} } = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-panel-request': '1',
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function signIn(did, at = base) {
  const code = await issueCode(did);
  const res = await fetch(`${at}/api/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-panel-request': '1' },
    body: JSON.stringify({ code }),
  });
  const set = res.headers.get('set-cookie') || '';
  return { res, set, cookie: set.split(';')[0] };
}

/** A request with the path exactly as written, which fetch would tidy up. */
const raw = (path) =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    http
      .get({ hostname, port, path }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      })
      .on('error', reject);
  });

describe('the page', () => {
  it('is served with headers that keep it to itself', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('answers a second ask with "not changed"', async () => {
    const first = await get('/');
    const again = await fetch(`${base}/`, { headers: { 'if-none-match': first.headers.get('etag') } });
    expect(again.status).toBe(304);
  });

  it('serves nothing from outside its own folder', async () => {
    for (const path of ['/../server.js', '/..%2fserver.js', '/%2e%2e/auth.js', '/../../../package.json', '/nope.js', '/index.html%00.js']) {
      expect(await raw(path), path).toBe(404);
    }
  });

  it('takes only reads of files', async () => {
    const res = await fetch(`${base}/`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});

describe('signing in', () => {
  it('answers nobody without a session', async () => {
    for (const path of ['/api/me', '/api/overview', '/api/list', '/api/settings']) {
      const res = await get(path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect((await post('/api/command', { command: 'undo 3f2a1b7c' })).status).toBe(401);
    expect((await get('/api/me', 'bm_panel=not-a-session')).status).toBe(401);
  });

  it('turns a code from the bot into a cookie the page cannot read', async () => {
    const { res, set, cookie } = await signIn(seeded.owner);
    expect(res.status).toBe(200);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Path=/');
    const me = await (await get('/api/me', cookie)).json();
    expect(me).toMatchObject({ did: seeded.owner, tier: 'owner', canWrite: true });
  });

  it('refuses a wrong code', async () => {
    const res = await post('/api/sign-in', { code: '0000 0000' });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBe(null);
  });

  it('gives a code to the roster and to nobody else', async () => {
    expect(await panel.codeFor('did:plc:stranger00000000000000')).toBe(null);
    expect(await panel.codeFor(READER)).toMatch(/Your panel code is \d{4} \d{4}\./);
  });

  it('stops answering after five wrong codes', async () => {
    const other = createPanel({
      settings: { port: 0, host: '127.0.0.1', url: '', sessionDays: 30 },
      roster: makeRoster({ owner: seeded.owner }),
      deps: {},
    });
    const at = `http://127.0.0.1:${(await other.listen()).port}`;
    try {
      const guess = () =>
        fetch(`${at}/api/sign-in`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-panel-request': '1' },
          body: JSON.stringify({ code: '1111 1111' }),
        });
      for (let i = 0; i < 5; i += 1) expect((await guess()).status).toBe(401);
      expect((await guess()).status).toBe(429);
      // A right code does not get through either, or the limit would only
      // slow the guesses that were going to fail anyway.
      expect((await signIn(seeded.owner, at)).res.status).toBe(429);
    } finally {
      await other.close();
    }
  });

  it('signs out', async () => {
    const { cookie } = await signIn(seeded.owner);
    const out = await post('/api/sign-out', {}, { cookie });
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await get('/api/me', cookie)).status).toBe(401);
  });
});

describe('a request that changes something', () => {
  let cookie;
  beforeAll(async () => {
    ({ cookie } = await signIn(seeded.owner));
  });

  it('must come from the panel\'s own page', async () => {
    const bare = await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ command: 'undo 3f2a1b7c' }),
    });
    expect(bare.status).toBe(403);
    const foreign = await post('/api/command', { command: 'undo 3f2a1b7c' }, { cookie, headers: { origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    const own = await post('/api/profiles', { dids: [] }, { cookie, headers: { origin: base } });
    expect(own.status).toBe(200);
  });

  it('must be a JSON object', async () => {
    expect((await post('/api/command', 'not json', { cookie })).status).toBe(400);
    expect((await post('/api/command', '[1,2]', { cookie })).status).toBe(400);
    const form = await post('/api/command', 'command=undo', { cookie, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(form.status).toBe(415);
    const big = await post('/api/command', { command: 'x'.repeat(70_000) }, { cookie });
    expect(big.status).toBe(413);
  });

  it('has nothing at an address nobody wrote', async () => {
    expect((await get('/api/nope', cookie)).status).toBe(404);
    expect((await post('/api/overview', {}, { cookie })).status).toBe(404);
  });
});

describe('the owner', () => {
  let cookie;
  beforeAll(async () => {
    ({ cookie } = await signIn(seeded.owner));
  });

  it('reads every page\'s data', async () => {
    for (const path of ['/api/overview', '/api/health', '/api/scans', '/api/queue', '/api/list', '/api/list/radar', '/api/activity', '/api/watches', '/api/protected', '/api/graph', '/api/models', '/api/people', '/api/settings']) {
      const res = await get(path, cookie);
      expect(res.status, path).toBe(200);
      expect(await res.json(), path).toBeTypeOf('object');
    }
  });

  it('approves part of a scan, and the log keeps the command as the words', async () => {
    const code = seeded.codes.thread;
    const before = await (await get(`/api/scan?code=${code}`, cookie)).json();
    expect(before.added).toBe(0);
    const res = await post('/api/command', { command: `approve ${code} hostile UNKNOWN` }, { cookie });
    const out = await res.json();
    expect(res.status).toBe(200);
    expect(out).toMatchObject({ ok: true, action: 'approve', outcome: 'done' });
    expect(out.text).toContain('Added 12');
    expect(out.options).toEqual([{ label: 'Undo all 12', command: `undo ${code}` }]);
    const after = await (await get(`/api/scan?code=${code}`, cookie)).json();
    expect(after).toMatchObject({ added: 12, state: 'added' });
    expect(after.words).toEqual([`approve ${code} hostile UNKNOWN`]);
    const log = await (await get('/api/activity?limit=3', cookie)).json();
    expect(log.events[0]).toMatchObject({ code, kind: 'added', n: 12, via: 'triage:hostile' });
  });

  it('takes it back', async () => {
    const code = seeded.codes.thread;
    const out = await (await post('/api/command', { command: `undo ${code}` }, { cookie })).json();
    expect(out.outcome).toBe('done');
    const after = await (await get(`/api/scan?code=${code}`, cookie)).json();
    expect(after.live).toBe(0);
  });

  it('is told, not obeyed, when blocking someone protected', async () => {
    const res = await post('/api/command', { command: 'block did:plc:demo000005' }, { cookie });
    const out = await res.json();
    expect(out.outcome).toBe(null);
    expect(out.text).toContain('PROTECTED');
    const rows = await select('decision', { eq: { did: 'did:plc:demo000005', action: 'list_add' }, where: { acted_at: 'not.is.null' } });
    expect(rows).toHaveLength(0);
  });

  it('keeps someone in the review queue, and puts them back', async () => {
    const before = await (await get('/api/queue?limit=100', cookie)).json();
    const target = before.rows.find((r) => r.band === 'CONNECTED');
    expect((await post('/api/queue/keep', { did: target.did, band: target.band }, { cookie })).status).toBe(200);
    const kept = await (await get('/api/queue?limit=100', cookie)).json();
    expect(kept.total).toBe(before.total - 1);
    expect((await post('/api/queue/reopen', { did: target.did }, { cookie })).status).toBe(200);
    expect((await (await get('/api/queue?limit=100', cookie)).json()).total).toBe(before.total);
    expect((await post('/api/queue/keep', { did: 'not-a-did' }, { cookie })).status).toBe(400);
  });

  it('scans a post, and is told when it is not one', async () => {
    const ok = await post('/api/scans', { link: 'https://bsky.app/profile/someone.example.social/post/3kabc', kind: 'everyone' }, { cookie });
    expect(ok.status).toBe(200);
    const { code } = await ok.json();
    expect(code).toMatch(/^[0-9a-f]{8}$/);
    expect((await get(`/api/scan?code=${code}`, cookie)).status).toBe(200);
    const bad = await post('/api/scans', { link: 'https://bsky.app/profile/someone.example.social', kind: 'everyone' }, { cookie });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('that is not a post');
    expect((await post('/api/scans', { link: 'x', kind: 'friends' }, { cookie })).status).toBe(400);
  });

  it('opens an account with what the log says about it', async () => {
    const account = await (await get('/api/account?actor=did:plc:demo000600', cookie)).json();
    expect(account.live).toMatchObject({ band: 'CONNECTED' });
    expect(account.entries[0]).toMatchObject({ scan: true, label: 'hostile' });
    expect((await get('/api/account?actor=nobody', cookie)).status).toBe(404);
  });

  it('sees who else the bot answers', async () => {
    const people = await (await get('/api/people', cookie)).json();
    expect(people.people).toEqual(expect.arrayContaining([
      { did: seeded.owner, tier: 'owner' },
      { did: READER, tier: 'reader' },
    ]));
    expect(people.sessions.length).toBeGreaterThan(0);
  });

  it('gets names for DIDs, and only for DIDs', async () => {
    const out = await (await post('/api/profiles', { dids: ['did:plc:demo000600', 'javascript:alert(1)', 42] }, { cookie })).json();
    expect(Object.keys(out.profiles)).toEqual(['did:plc:demo000600']);
    expect(out.profiles['did:plc:demo000600'].handle).toMatch(/\.example\.social$/);
  });
});

describe('a read-only account', () => {
  let cookie;
  beforeAll(async () => {
    ({ cookie } = await signIn(READER));
  });

  it('is told so', async () => {
    const me = await (await get('/api/me', cookie)).json();
    expect(me).toMatchObject({ did: READER, tier: 'reader', canWrite: false });
  });

  it('cannot change the list, the queue or a watch', async () => {
    for (const command of ['block did:plc:demo070000', 'unblock did:plc:demo050100', `approve ${seeded.codes.pilot} UNKNOWN`, `undo ${seeded.codes.nightbus}`, `cancel ${seeded.codes.pilot}`]) {
      const res = await post('/api/command', { command }, { cookie });
      expect(res.status, command).toBe(403);
    }
    expect((await post('/api/queue/keep', { did: 'did:plc:demo050100', band: 'CONNECTED' }, { cookie })).status).toBe(403);
    expect((await post('/api/watches/stop', { uri: 'at://did:plc:x/app.bsky.feed.post/3k' }, { cookie })).status).toBe(403);
    const pilot = await (await get(`/api/scan?code=${seeded.codes.pilot}`, cookie)).json();
    expect(pilot.added).toBe(0);
  });

  it('sees what was done and not the words that asked for it', async () => {
    const scan = await (await get(`/api/scan?code=${seeded.codes.shift}`, cookie)).json();
    expect(scan.words).toEqual([]);
    const log = await (await get('/api/activity', cookie)).json();
    expect(log.events.length).toBeGreaterThan(0);
    expect(log.events.every((e) => e.words.length === 0)).toBe(true);
    const settings = await (await get('/api/settings', cookie)).json();
    expect(settings.notes).toBe(null);
    expect(settings.file.style).toBe(true);
  });

  it('sees itself on the roster and nobody else', async () => {
    const people = await (await get('/api/people', cookie)).json();
    expect(people.people).toEqual([{ did: READER, tier: 'reader' }]);
  });

  it('may still scan a post, which adds nobody', async () => {
    const res = await post('/api/scans', { link: 'https://bsky.app/profile/someone.example.social/post/3kabd', kind: 'likers' }, { cookie });
    expect(res.status).toBe(200);
  });
});
