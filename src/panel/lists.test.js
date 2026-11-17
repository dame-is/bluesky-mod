// The panel over HTTP for a bot with several lists (MOD_MULTI_LIST): which
// list a page shows, which list a write goes to, and the bot's "Which list?"
// carried to the page instead of guessed. Over the invented store, with the
// stand-in bot from scripts/panel-demo.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { closeDb, openDb, select } from '../bot/db.js';
import { findPlan } from '../bot/bulkPlan.js';
import { issueCode } from './auth.js';
import { forgetList } from './queries.js';

const READER = 'did:plc:reader000000000000000000';
const MAIN = '3mdemolist';
const SPAM = '3mdemospam';
const TROLLS = '3mdemotroll';

let panel;
let seeded;
let base;
let cookie;
let reader;
const before = process.env.MOD_MULTI_LIST;

const get = async (path, as = cookie) => {
  const res = await fetch(base + path, { headers: { cookie: as } });
  return { status: res.status, body: await res.json() };
};
const run = async (command, as = cookie) => {
  const res = await fetch(`${base}/api/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-panel-request': '1', cookie: as },
    body: JSON.stringify({ command }),
  });
  return { status: res.status, body: await res.json() };
};
const signIn = async (did) => {
  const res = await fetch(`${base}/api/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-panel-request': '1' },
    body: JSON.stringify({ code: await issueCode(did) }),
  });
  return res.headers.get('set-cookie').split(';')[0];
};

beforeAll(async () => {
  process.env.MOD_MULTI_LIST = 'true';
  await closeDb();
  openDb(':memory:');
  forgetList();
  const { demoPanel } = await import('../../scripts/panel-demo.js');
  ({ panel, seeded } = await demoPanel({ extraRoster: { allowed: [READER] } }));
  base = `http://127.0.0.1:${(await panel.listen()).port}`;
  cookie = await signIn(seeded.owner);
  reader = await signIn(READER);
}, 60_000);

afterAll(async () => {
  await panel?.close();
  if (before === undefined) delete process.env.MOD_MULTI_LIST;
  else process.env.MOD_MULTI_LIST = before;
});

describe('which lists there are', () => {
  it('are the bot\'s, the main one first, by record key and not by address', async () => {
    const { body } = await get('/api/lists');
    expect(body).toEqual({
      multi: true,
      lists: [
        { rkey: MAIN, name: 'Block List', n: 1 },
        { rkey: SPAM, name: 'Spam', n: 2 },
        { rkey: TROLLS, name: 'Trolls', n: 3 },
      ],
    });
  });
});

describe('a page for one list', () => {
  it('shows the main list unless another is named', async () => {
    const [unnamed, main, spam] = [
      await get('/api/list?limit=1'),
      await get(`/api/list?limit=1&list=${MAIN}`),
      await get(`/api/list?limit=1&list=${SPAM}`),
    ];
    expect(unnamed.body.total).toBe(main.body.total);
    expect(spam.body.total).toBe(61);
    expect(main.body.total).toBeGreaterThan(8000);
    expect((await get(`/api/list/radar?list=${TROLLS}`)).body).toMatchObject({ total: 30, near: [] });
    expect((await get(`/api/overview?list=${SPAM}`)).body.list.total).toBe(61);
  });

  it('refuses a list that is not there, and never shows the main one in its place', async () => {
    for (const path of ['/api/list?list=3mgone', '/api/list/radar?list=3mgone', '/api/overview?list=3mgone']) {
      const { status, body } = await get(path);
      expect(status, path).toBe(404);
      expect(body.error).toContain('no list with that key');
    }
  });

  it('keeps the review queue to the main list', async () => {
    const queue = await get('/api/queue?limit=100');
    const spam = new Set((await get(`/api/list?list=${SPAM}&limit=200`)).body.rows.map((r) => r.did));
    expect(queue.body.total).toBeGreaterThan(0);
    expect(queue.body.rows.some((r) => spam.has(r.did))).toBe(false);
  });

  it('names the list on a scan, on the log and on an account', async () => {
    expect((await get(`/api/scan?code=${seeded.codes.pileon}`)).body.list).toBe(TROLLS);
    expect((await get(`/api/scan?code=${seeded.codes.pilot}`)).body.list).toBe(null);
    // Approved before the lists were told apart: the main list.
    expect((await get(`/api/scan?code=${seeded.codes.sweep}`)).body.list).toBe(MAIN);
    const log = (await get('/api/activity?limit=100')).body.events;
    expect(log.every((e) => [MAIN, SPAM, TROLLS].includes(e.list))).toBe(true);
    const account = (await get('/api/account?actor=did:plc:demo065000')).body;
    expect(account.onLists.map((l) => l.list)).toEqual([SPAM]);
    expect(account.entries[0].list).toBe(SPAM);
  });
});

describe('a write that names no list', () => {
  const stranger = 'did:plc:demo072000';

  it('is not done: the bot asks which, and the page is handed the question', async () => {
    const { status, body } = await run(`block ${stranger}`);
    expect(status).toBe(200);
    expect(body.choice).toBe(true);
    expect(body.outcome).toBe(null);
    expect(body.text).toContain('Which list');
    expect(body.options.map((o) => o.label)).toEqual(['Block List', 'Spam', 'Trolls']);
    expect(body.options[1].commands).toEqual([`list add ${stranger} list:${SPAM}`]);
    // An answer to it adds someone, so it is never one press on a receipt.
    expect(body.options.every((o) => o.takesBack === false)).toBe(true);
    expect((await get(`/api/account?actor=${stranger}`)).body.onLists).toEqual([]);
  });

  it('is done when it names one, on that list and no other', async () => {
    const { body } = await run(`block ${stranger} list:${SPAM}`);
    expect(body).toMatchObject({ outcome: 'done', choice: false });
    expect(body.text).toContain('to Spam');
    // The way back names the same list.
    expect(body.options).toEqual([
      expect.objectContaining({ command: `list remove ${stranger} list:${SPAM}`, takesBack: true }),
    ]);
    expect((await get(`/api/account?actor=${stranger}`)).body.onLists.map((l) => l.list)).toEqual([SPAM]);
    expect((await get(`/api/list?list=${MAIN}&q=${stranger}`)).body.matched).toBe(0);
  });

  it('asks which to take someone off when they are on two, with every list as one answer', async () => {
    await run(`block ${stranger} list:${TROLLS}`);
    const { body } = await run(`unblock ${stranger}`);
    expect(body.choice).toBe(true);
    expect(body.options.map((o) => o.label)).toEqual(['Spam', 'Trolls', 'Every list']);
    expect(body.options[2].commands).toEqual([
      `list remove ${stranger} list:${SPAM}`,
      `list remove ${stranger} list:${TROLLS}`,
    ]);
    expect((await get(`/api/account?actor=${stranger}`)).body.onLists).toHaveLength(2);
    // One list named: off that one, still on the other.
    expect((await run(`unblock ${stranger} list:${TROLLS}`)).body.outcome).toBe('done');
    expect((await get(`/api/account?actor=${stranger}`)).body.onLists.map((l) => l.list)).toEqual([SPAM]);
  });
});

describe('approving a scan', () => {
  it('asks which list when no approval has bound it, and binds it to the one named', async () => {
    const code = seeded.codes.hottake;
    const asked = (await run(`approve ${code} NOTABLE`)).body;
    expect(asked.choice).toBe(true);
    expect(asked.options[2].commands).toEqual([`approve ${code} NOTABLE list:${TROLLS}`]);
    expect((await findPlan(code)).list_uri ?? null).toBe(null);

    const done = (await run(`approve ${code} NOTABLE list:${TROLLS}`)).body;
    expect(done.outcome).toBe('done');
    expect(done.text).toContain('to Trolls');
    expect((await get(`/api/scan?code=${code}`)).body.list).toBe(TROLLS);
    const rows = await select('decision', { eq: { plan_id: (await findPlan(code)).id, action: 'list_add' }, where: { acted_at: 'not.is.null' } });
    expect(rows).toHaveLength(2);
    // Those two are on Trolls and not on the main list.
    const trolls = (await get(`/api/list?list=${TROLLS}&limit=200`)).body.rows.map((r) => r.did);
    expect(rows.every((r) => trolls.includes(r.did))).toBe(true);
    expect((await get(`/api/list?list=${MAIN}&q=${rows[0].did}`)).body.matched).toBe(0);
  });

  it('goes where the scan went once it is bound, and is refused another list', async () => {
    const code = seeded.codes.hottake;
    const refused = (await run(`approve ${code} PERIPHERAL list:${SPAM}`)).body;
    expect(refused).toMatchObject({ outcome: null, choice: false });
    expect(refused.text).toContain('adds to Trolls');
    const done = (await run(`approve ${code} PERIPHERAL`)).body;
    expect(done.outcome).toBe('done');
    expect(done.text).toContain('to Trolls');
  });
});

describe('a read-only account', () => {
  it('sees the lists and each list, and can write to none', async () => {
    expect((await get('/api/lists', reader)).body.lists).toHaveLength(3);
    expect((await get(`/api/list?list=${SPAM}&limit=1`, reader)).body.total).toBeGreaterThan(0);
    for (const command of [`block did:plc:demo072001 list:${SPAM}`, 'block did:plc:demo072001', `unblock did:plc:demo065000 list:${SPAM}`]) {
      expect((await run(command, reader)).status, command).toBe(403);
    }
  });
});
