// The panel in a dry run: it opens, so a host that needs a port open has one,
// and it reads, but nobody can change anything through it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { closeDb, openDb } from '../bot/db.js';
import { issueCode } from './auth.js';
import { forgetList } from './queries.js';

let panel;
let seeded;
let base;
let token;

beforeAll(async () => {
  await closeDb();
  openDb(':memory:');
  forgetList();
  const { demoPanel } = await import('../../scripts/panel-demo.js');
  ({ panel, seeded } = await demoPanel({ readOnly: true }));
  base = `http://127.0.0.1:${(await panel.listen()).port}`;
  const res = await fetch(`${base}/api/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-panel-request': '1' },
    body: JSON.stringify({ code: await issueCode(seeded.owner), token: true }),
  });
  ({ token } = await res.json());
}, 60_000);

afterAll(async () => {
  await panel?.close();
});

const call = (path, body) =>
  fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('the panel in a dry run', () => {
  it('reads as usual', async () => {
    expect((await call('/api/list?limit=3')).status).toBe(200);
    expect((await call('/api/queue')).status).toBe(200);
  });

  it('tells even the owner they cannot write', async () => {
    const me = await (await call('/api/me')).json();
    expect(me).toMatchObject({ tier: 'owner', canWrite: false });
  });

  it('changes nothing', async () => {
    expect((await call('/api/command', { command: 'block did:plc:demo002001' })).status).toBe(403);
    expect((await call('/api/command', { command: 'shield status' })).status).toBe(403);
    expect((await call('/api/queue/keep', { did: 'did:plc:demo000601', band: 'CONNECTED' })).status).toBe(403);
    expect((await call('/api/graph/rebuild', {})).status).toBe(403);
    expect((await call('/api/rescore', {})).status).toBe(403);
    expect((await call('/api/watches/stop', { uri: 'at://x/app.bsky.feed.post/1' })).status).toBe(403);
  });
});
