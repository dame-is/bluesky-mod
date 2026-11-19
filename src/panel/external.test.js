// The API as another site's admin page uses it: bearer tokens instead of the
// panel's cookie, CORS for the sites PANEL_CORS_ORIGINS names, and the routes
// such a page needs. The real server over the invented store, as in
// server.test.js.

import { Secp256k1Keypair } from '@atproto/crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { closeDb, openDb } from '../bot/db.js';
import { issueCode } from './auth.js';
import { forgetList } from './queries.js';
import { forgetKeys, LXM } from './serviceAuth.js';

const READER = 'did:plc:reader000000000000000000';
const STRANGER = 'did:plc:stranger0000000000000000';
const SITE = 'https://admin.example.com';

let panel;
let seeded;
let base;
const keys = {};

beforeAll(async () => {
  await closeDb();
  openDb(':memory:');
  forgetList();
  forgetKeys();
  const { demoPanel } = await import('../../scripts/panel-demo.js');
  const owner = process.env.MOD_OWNER_DID;
  for (const did of [owner, READER, STRANGER]) keys[did] = await Secp256k1Keypair.create();
  keys.other = await Secp256k1Keypair.create();
  const readDoc = async (did) => {
    if (!keys[did]) throw new Error('no such account');
    return {
      id: did,
      verificationMethod: [
        { id: `${did}#atproto`, type: 'Multikey', publicKeyMultibase: keys[did].did().slice('did:key:'.length) },
      ],
    };
  };
  ({ panel, seeded } = await demoPanel({
    extraRoster: { allowed: [READER] },
    corsOrigins: [SITE],
    readDoc,
  }));
  base = `http://127.0.0.1:${(await panel.listen()).port}`;
}, 60_000);

afterAll(async () => {
  await panel?.close();
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A service-auth token as a PDS makes one, signed by `key`. */
async function token({
  iss = seeded.owner,
  aud = seeded.bot,
  lxm = LXM.write,
  exp = Math.floor(Date.now() / 1000) + 60,
  key = keys[iss],
} = {}) {
  const head = b64({ typ: 'JWT', alg: 'ES256K' });
  const body = b64({ iss, aud, lxm, exp, iat: Math.floor(Date.now() / 1000), jti: String(Math.random()) });
  const sig = Buffer.from(await key.sign(new TextEncoder().encode(`${head}.${body}`))).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const call = (path, { bearer, body, origin, method } = {}) =>
  fetch(base + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(origin ? { origin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('a token from the account’s own PDS', () => {
  it('signs the owner in, with what the roster allows', async () => {
    const res = await call('/api/me', { bearer: await token() });
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me).toMatchObject({ apiVersion: 1, did: seeded.owner, tier: 'owner', canWrite: true, via: 'atproto' });
  });

  it('writes without the panel’s own-page header, which is for cookies', async () => {
    const t = await token();
    const keep = await call('/api/queue/keep', { bearer: t, body: { did: 'did:plc:demo000601', band: 'CONNECTED' } });
    expect(keep.status).toBe(200);
    expect((await call('/api/queue/reopen', { bearer: t, body: { did: 'did:plc:demo000601' } })).status).toBe(200);
  });

  it('only reads when it was made for reading', async () => {
    const t = await token({ lxm: LXM.read });
    expect((await (await call('/api/me', { bearer: t })).json()).canWrite).toBe(false);
    const res = await call('/api/queue/keep', { bearer: t, body: { did: 'did:plc:demo000601', band: 'CONNECTED' } });
    expect(res.status).toBe(403);
  });

  it('keeps a reader on the roster read-only, whatever the token says', async () => {
    const me = await (await call('/api/me', { bearer: await token({ iss: READER }) })).json();
    expect(me).toMatchObject({ tier: 'reader', canWrite: false });
  });

  it.each([
    ['made for another service', { aud: 'did:plc:someoneelse0000000000000' }, /another service/],
    ['for another method', { lxm: 'com.example.other' }, /not is\.dame/],
    ['out of date', { exp: Math.floor(Date.now() / 1000) - 5 }, /expired/],
    ['living longer than ten minutes', { exp: Math.floor(Date.now() / 1000) + 3600 }, /ten minutes/],
  ])('is refused when %s', async (_, opts, why) => {
    const res = await call('/api/me', { bearer: await token(opts) });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(why);
  });

  it('is refused when another key signed it', async () => {
    const res = await call('/api/me', { bearer: await token({ key: keys.other }) });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/bad signature/);
  });

  it('is refused for an account the bot does not answer, even signed properly', async () => {
    const res = await call('/api/me', { bearer: await token({ iss: STRANGER }) });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/not one the bot answers/);
  });

  it('accepts an audience naming one of the bot’s services', async () => {
    const res = await call('/api/me', { bearer: await token({ aud: `${seeded.bot}#bsky_mod` }) });
    expect(res.status).toBe(200);
  });
});

describe('a panel session token', () => {
  it('comes from a code, in the body and not as a cookie', async () => {
    const code = await issueCode(seeded.owner);
    const res = await fetch(`${base}/api/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-panel-request': '1' },
      body: JSON.stringify({ code, token: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    const { token: t, expiresAt } = await res.json();
    expect(t).toMatch(/^[\w-]{40,}$/);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    const me = await (await call('/api/me', { bearer: t })).json();
    expect(me).toMatchObject({ did: seeded.owner, via: 'token' });

    expect((await call('/api/sign-out', { bearer: t, body: {} })).status).toBe(200);
    expect((await call('/api/me', { bearer: t })).status).toBe(401);
  });

  it('may be asked for from a site the bot allows, and only as a token', async () => {
    const ask = async (body) =>
      fetch(`${base}/api/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-panel-request': '1', origin: SITE },
        body: JSON.stringify({ code: await issueCode(seeded.owner), ...body }),
      });
    const cookie = await ask({});
    expect(cookie.status).toBe(403);
    const ok = await ask({ token: true });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(SITE);
  });

  it('is not given to a site the bot does not allow', async () => {
    const res = await fetch(`${base}/api/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-panel-request': '1', origin: 'https://evil.example' },
      body: JSON.stringify({ code: await issueCode(seeded.owner), token: true }),
    });
    expect(res.status).toBe(403);
  });
});

describe('another site’s page', () => {
  it('is told it may call, when it is named', async () => {
    const res = await call('/api/me', { method: 'OPTIONS', origin: SITE });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('is refused when it is not', async () => {
    const res = await call('/api/me', { method: 'OPTIONS', origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('can read the error when it is refused, so it can say why', async () => {
    const res = await call('/api/me', { origin: SITE });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
  });
});

describe('what an admin page needs', () => {
  let owner;
  let reader;
  beforeAll(async () => {
    owner = await token();
    reader = await token({ iss: READER });
  });

  it('lists the newest adds first when asked', async () => {
    const page = await (await call('/api/list?sort=recent&limit=20', { bearer: owner })).json();
    const at = page.rows.map((r) => r.addedAt || '');
    expect(at).toEqual([...at].sort().reverse());
  });

  it('says who is on the list, for a site’s own use', async () => {
    const out = await (await call('/api/list/members', { bearer: reader })).json();
    expect(out.dids.length).toBeGreaterThan(100);
    expect(out.complete).toBe(true);
  });

  it('pages through scans', async () => {
    const first = await (await call('/api/scans?limit=1', { bearer: owner })).json();
    expect(first.scans).toHaveLength(1);
    expect(first.more).toBe(true);
    const next = await (await call(`/api/scans?limit=1&before=${encodeURIComponent(first.next)}`, { bearer: owner })).json();
    expect(next.scans[0].code).not.toBe(first.scans[0].code);
  });

  it('opens a plan that was not a scan', async () => {
    const log = await (await call('/api/activity?limit=50', { bearer: owner })).json();
    const typed = log.events.find((e) => !e.scan);
    expect(typed).toBeTruthy();
    const res = await call(`/api/scan?code=${typed.code}`, { bearer: owner });
    expect(res.status).toBe(200);
    expect((await res.json()).scan).toBe(false);
  });

  it('gives each queue row a reason and its label', async () => {
    const q = await (await call('/api/queue?limit=5', { bearer: owner })).json();
    expect(q.rows.length).toBeGreaterThan(0);
    for (const r of q.rows) {
      expect(['close', 'closer']).toContain(r.reason);
      expect(r).toHaveProperty('label');
      expect(r).toHaveProperty('quote');
    }
  });

  it('checks a post without keeping anything', async () => {
    const before = await (await call('/api/scans', { bearer: owner })).json();
    const res = await call('/api/check', { bearer: reader, body: { link: 'https://bsky.app/profile/x/post/3abc' } });
    expect(res.status).toBe(200);
    expect((await res.json()).totals.byBand.UNKNOWN).toBe(130);
    const after = await (await call('/api/scans', { bearer: owner })).json();
    expect(after.scans.length).toBe(before.scans.length);
    expect((await call('/api/check', { bearer: owner, body: { link: 'not a post' } })).status).toBe(400);
  });

  it('lets only the owner start a rebuild or a re-score', async () => {
    for (const path of ['/api/graph/rebuild', '/api/rescore']) {
      expect(await (await call(path, { bearer: owner, body: {} })).json()).toEqual({ started: true });
      expect((await call(path, { bearer: reader, body: {} })).status).toBe(403);
      expect((await call(path, { bearer: await token({ lxm: LXM.read }), body: {} })).status).toBe(403);
    }
  });

  it('shows the shield', async () => {
    const s = await (await call('/api/shield', { bearer: reader })).json();
    expect(s).toMatchObject({ running: true, attack: { on: false }, triggers: { mode: 'ask' } });
    expect(s.limits[0].kind).toBe('replies');
  });

  it('runs the owner’s shield commands, and nobody else’s', async () => {
    const up = await call('/api/command', { bearer: owner, body: { command: 'shields up' } });
    expect(up.status).toBe(200);
    expect((await up.json()).action).toBe('shield.up');
    expect((await call('/api/command', { bearer: reader, body: { command: 'shields up' } })).status).toBe(403);
    expect((await call('/api/command', { bearer: reader, body: { command: 'shield status' } })).status).toBe(200);
    const noPost = await call('/api/command', { bearer: owner, body: { command: 'close replies' } });
    expect(noPost.status).toBe(400);
    expect((await noPost.json()).error).toMatch(/Name the post/);
    const watch = await call('/api/command', {
      bearer: owner,
      body: { command: `shield watch at://${seeded.owner}/app.bsky.feed.post/3abc` },
    });
    expect(watch.status).toBe(400);
  });

  it('gives vouch counts for named accounts or the most vouched', async () => {
    const named = await (
      await call('/api/graph/vouches', { bearer: reader, body: { dids: ['did:plc:demo000601', 'did:plc:demo999999'] } })
    ).json();
    expect(named.takenAt).toBeTruthy();
    expect(named.vouches['did:plc:demo000601']).toBeGreaterThan(0);
    expect(named.vouches).not.toHaveProperty('did:plc:demo999999');
    const top = await (await call('/api/graph/vouches', { bearer: reader, body: { min: 3, limit: 5 } })).json();
    const counts = Object.values(top.vouches);
    expect(counts).toHaveLength(5);
    expect(counts.every((n) => n >= 3)).toBe(true);
    const tooMany = Array.from({ length: 1001 }, (_, i) => `did:plc:x${i}`);
    expect((await call('/api/graph/vouches', { bearer: reader, body: { dids: tooMany } })).status).toBe(400);
  });
});
