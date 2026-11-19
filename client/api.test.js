// The client: what it sends, what it keeps, and what it throws. Then the
// same client against the real panel server over the invented store.

import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import * as pkg from './index.js';
import { ApiError, createClient } from './api.js';

/** A fetch that records requests and answers from `answer`. */
function fakeFetch(answer = () => ({ status: 200, body: { ok: true } })) {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, ...init });
    const { status, body } = answer(url, init);
    return { ok: status < 400, status, json: async () => body };
  };
  return { fetch, sent };
}

const jwt = (exp) =>
  `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;

describe('the client', () => {
  it('sends a token as a bearer and no cookie', async () => {
    const { fetch, sent } = fakeFetch();
    const c = createClient({ baseUrl: 'https://mod.example.com/', auth: { token: 'abc' }, fetch });
    await c.list({ sort: 'recent', band: null, limit: 5 });
    expect(sent[0].url).toBe('https://mod.example.com/api/list?sort=recent&limit=5');
    expect(sent[0].headers.Authorization).toBe('Bearer abc');
    expect(sent[0].credentials).toBe('omit');
  });

  it('uses the cookie on the panel’s own page, and says a change came from it', async () => {
    const { fetch, sent } = fakeFetch();
    const c = createClient({ fetch });
    await c.keep('did:plc:x', 'CONNECTED');
    expect(sent[0].url).toBe('/api/queue/keep');
    expect(sent[0].credentials).toBe('same-origin');
    expect(sent[0].headers['X-Panel-Request']).toBe('1');
    expect(sent[0].headers.Authorization).toBeUndefined();
    expect(JSON.parse(sent[0].body)).toEqual({ did: 'did:plc:x', band: 'CONNECTED' });
  });

  it('asks for a service-auth token once, and again when it is nearly out', async () => {
    const { fetch, sent } = fakeFetch();
    let asked = 0;
    let exp = Math.floor(Date.now() / 1000) + 60;
    const c = createClient({ auth: { serviceAuth: async () => ((asked += 1), jwt(exp)) }, fetch });
    await c.me();
    await c.me();
    expect(asked).toBe(1);
    exp = Math.floor(Date.now() / 1000) + 5;
    // Nearly out: the held one is replaced on the next call after it.
    const d = createClient({ auth: { serviceAuth: async () => ((asked += 1), jwt(exp)) }, fetch });
    await d.me();
    await d.me();
    expect(asked).toBe(3);
    expect(sent.every((s) => s.headers.Authorization?.startsWith('Bearer x.'))).toBe(true);
  });

  it('shares one token between calls made together', async () => {
    let asked = 0;
    const c = createClient({
      auth: { serviceAuth: async () => ((asked += 1), jwt(Math.floor(Date.now() / 1000) + 60)) },
      fetch: fakeFetch().fetch,
    });
    await Promise.all([c.me(), c.queue(), c.lists()]);
    expect(asked).toBe(1);
  });

  it('asks again after a token fails to come', async () => {
    let asked = 0;
    const c = createClient({
      auth: {
        serviceAuth: async () => {
          asked += 1;
          if (asked === 1) throw new Error('the PDS is down');
          return jwt(Math.floor(Date.now() / 1000) + 60);
        },
      },
      fetch: fakeFetch().fetch,
    });
    await expect(c.me()).rejects.toThrow('the PDS is down');
    await c.me();
    expect(asked).toBe(2);
  });

  it('throws the bot’s words, and says when it was signed out', async () => {
    let signedOut = 0;
    const { fetch } = fakeFetch(() => ({ status: 401, body: { error: 'Sign in first.' } }));
    const c = createClient({ auth: { token: 't' }, fetch, onSignedOut: () => (signedOut += 1) });
    const err = await c.me().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, message: 'Sign in first.' });
    expect(signedOut).toBe(1);
  });

  it('says so when the bot cannot be reached', async () => {
    const c = createClient({ auth: { token: 't' }, fetch: async () => { throw new TypeError('fetch failed'); } });
    await expect(c.me()).rejects.toMatchObject({ status: 0 });
  });

  it('signs in for a token when it is not the panel’s page', async () => {
    const { fetch, sent } = fakeFetch(() => ({ status: 200, body: { ok: true, token: 't' } }));
    await createClient({ auth: { token: '' }, fetch }).signIn('48219357');
    expect(JSON.parse(sent[0].body)).toEqual({ code: '48219357', token: true });
    await createClient({ fetch }).signIn('48219357');
    expect(JSON.parse(sent[1].body)).toEqual({ code: '48219357' });
  });
});

describe('the package', () => {
  it('has a type for everything it exports, and nothing else', () => {
    const dts = fs.readFileSync(new URL('./index.d.ts', import.meta.url), 'utf8');
    const typed = new Set([...dts.matchAll(/^export (?:const|function|class) (\w+)/gm)].map((m) => m[1]));
    expect(new Set(Object.keys(pkg))).toEqual(typed);
  });

  it('imports nothing from outside its folder', () => {
    for (const file of fs.readdirSync(new URL('.', import.meta.url))) {
      if (!file.endsWith('.js') || file.endsWith('.test.js')) continue;
      const src = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      for (const m of src.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+'([^']+)'/gms)) {
        expect(m[1], `${file} imports ${m[1]}`).toMatch(/^\.\/[\w-]+\.js$/);
      }
    }
  });
});

describe('against the bot’s panel', () => {
  let panel;
  let base;
  let seeded;

  beforeAll(async () => {
    const { closeDb, openDb } = await import('../src/bot/db.js');
    await closeDb();
    openDb(':memory:');
    const { demoPanel } = await import('../scripts/panel-demo.js');
    ({ panel, seeded } = await demoPanel());
    base = `http://127.0.0.1:${(await panel.listen()).port}`;
  }, 60_000);

  afterAll(async () => {
    await panel?.close();
  });

  it('signs in with a code for a token, and reads with it', async () => {
    const { issueCode } = await import('../src/panel/auth.js');
    const anon = createClient({ baseUrl: base, auth: { token: '' } });
    const { token } = await anon.signIn(await issueCode(seeded.owner));
    const c = createClient({ baseUrl: base, auth: { token } });
    const me = await c.me();
    expect(me).toMatchObject({ apiVersion: pkg.API_VERSION, tier: 'owner', via: 'token' });
    const page = await c.list({ limit: 3 });
    expect(page.rows).toHaveLength(3);
    const scans = await c.scans({ limit: 1 });
    const plan = await c.scan(scans.scans[0].code);
    expect(plan.scan).toBe(true);
    const out = await c.command(pkg.undoCommand('ffffffff'));
    expect(out.ok).toBe(true);
  });
});
