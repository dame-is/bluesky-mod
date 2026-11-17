// Signing in to the panel: a code from a DM, exchanged once for a session
// whose powers are read from the roster on every request.

import { describe, it, expect, beforeEach } from 'vitest';

import { openDb, closeDb, select } from '../bot/db.js';
import { makeRoster } from '../lib/senders.js';
import {
  CODE_TTL_MS,
  attemptLimiter,
  codeMessage,
  endSession,
  endSessionsFor,
  formatCode,
  issueCode,
  pruneAuth,
  readCode,
  redeemCode,
  sessionFor,
  sessionsFor,
  tierOf,
} from './auth.js';

const OWNER = 'did:plc:owner0000000000000000000';
const WRITER = 'did:plc:writer000000000000000000';
const READER = 'did:plc:reader000000000000000000';
const roster = makeRoster({ owner: OWNER, writers: [WRITER], allowed: [READER] });

beforeEach(async () => {
  await closeDb();
  openDb(':memory:');
});

describe('who a DID is to the bot', () => {
  it('names the owner, a writer and a reader, and nobody else', () => {
    expect(tierOf(OWNER, roster)).toBe('owner');
    expect(tierOf(WRITER, roster)).toBe('writer');
    expect(tierOf(READER, roster)).toBe('reader');
    expect(tierOf('did:plc:stranger', roster)).toBe(null);
    expect(tierOf(null, roster)).toBe(null);
  });
});

describe('a code as someone types it', () => {
  it('reads eight digits however they are spaced', () => {
    expect(readCode('4821 9357')).toBe('48219357');
    expect(readCode(' 4821-9357 ')).toBe('48219357');
    expect(readCode('48219357')).toBe('48219357');
  });

  it('is nothing when it is not eight digits', () => {
    for (const bad of ['', '4821 935', '4821 93577', 'abcd efgh', null, '４８２１９３５７']) {
      expect(readCode(bad)).toBe(null);
    }
  });

  it('is shown in two groups of four', () => {
    expect(formatCode('00219357')).toBe('0021 9357');
  });
});

describe('the bot\'s reply to "panel"', () => {
  it('says the code, how long it lasts, and where to type it when known', () => {
    const text = codeMessage('48219357', { url: 'https://mod.example.com' });
    expect(text).toContain('4821 9357');
    expect(text).toContain('https://mod.example.com');
    expect(text).toContain('ten minutes');
    expect(codeMessage('48219357')).toContain("the panel's sign-in page");
  });
});

describe('exchanging a code', () => {
  it('gives a session once, and never twice', async () => {
    const code = await issueCode(OWNER);
    const first = await redeemCode(formatCode(code), { roster });
    expect(first.did).toBe(OWNER);
    expect(first.token.length).toBeGreaterThan(30);
    expect(await redeemCode(code, { roster })).toBe(null);
  });

  it('gives one session when the same code arrives twice at once', async () => {
    const code = await issueCode(OWNER);
    const both = await Promise.all([redeemCode(code, { roster }), redeemCode(code, { roster })]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });

  it('refuses a wrong code and one that has run out', async () => {
    const now = Date.now();
    const code = await issueCode(OWNER, { now });
    const wrong = code === '00000000' ? '00000001' : '00000000';
    expect(await redeemCode(wrong, { roster, now })).toBe(null);
    expect(await redeemCode(code, { roster, now: now + CODE_TTL_MS + 1 })).toBe(null);
  });

  it('keeps only the newest code for an account', async () => {
    const old = await issueCode(OWNER);
    const fresh = await issueCode(OWNER);
    if (old !== fresh) expect(await redeemCode(old, { roster })).toBe(null);
    expect(await redeemCode(fresh, { roster })).not.toBe(null);
  });

  it('gives nothing to someone who has left the roster since asking', async () => {
    const code = await issueCode(READER);
    const smaller = makeRoster({ owner: OWNER });
    expect(await redeemCode(code, { roster: smaller })).toBe(null);
  });

  it('stores hashes, never the code or the token', async () => {
    const code = await issueCode(OWNER);
    const { token } = await redeemCode(code, { roster });
    const stored = JSON.stringify([
      await select('panel_code', {}),
      await select('panel_session', {}),
    ]);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(token);
  });
});

describe('a session', () => {
  const signIn = async (did, opts = {}) =>
    redeemCode(await issueCode(did), { roster, ...opts });

  it('carries what its account may do today', async () => {
    const owner = await sessionFor((await signIn(OWNER)).token, { roster });
    expect(owner).toMatchObject({ did: OWNER, tier: 'owner', canWrite: true });
    const reader = await sessionFor((await signIn(READER)).token, { roster });
    expect(reader).toMatchObject({ did: READER, tier: 'reader', canWrite: false });
  });

  it('follows the roster: a writer made a reader loses the write', async () => {
    const { token } = await signIn(WRITER);
    const demoted = makeRoster({ owner: OWNER, allowed: [WRITER] });
    expect((await sessionFor(token, { roster: demoted })).canWrite).toBe(false);
    expect(await sessionFor(token, { roster: makeRoster({ owner: OWNER }) })).toBe(null);
  });

  it('ends when its time is up', async () => {
    const now = Date.now();
    const { token } = await signIn(OWNER, { now, sessionDays: 1 });
    expect(await sessionFor(token, { roster, now: now + 23 * 3600_000 })).not.toBe(null);
    expect(await sessionFor(token, { roster, now: now + 25 * 3600_000 })).toBe(null);
  });

  it('is nothing for a cookie nobody issued', async () => {
    for (const bad of [null, '', 'nope', 'x'.repeat(500), 42]) {
      expect(await sessionFor(bad, { roster })).toBe(null);
    }
  });

  it('signs out one browser, or all of them', async () => {
    const a = await signIn(OWNER);
    const b = await signIn(OWNER);
    expect(await sessionsFor(OWNER)).toHaveLength(2);
    await endSession(a.token);
    expect(await sessionFor(a.token, { roster })).toBe(null);
    expect(await sessionFor(b.token, { roster })).not.toBe(null);
    await endSessionsFor(OWNER);
    expect(await sessionFor(b.token, { roster })).toBe(null);
  });

  it('lists sessions without anything that could be used as one', async () => {
    const { token } = await signIn(OWNER);
    const [listed] = await sessionsFor(OWNER);
    expect(listed.id).toHaveLength(12);
    expect(JSON.stringify(listed)).not.toContain(token);
  });

  it('is cleared with its code once both are out of date', async () => {
    const now = Date.now();
    await signIn(OWNER, { now, sessionDays: 1 });
    await issueCode(WRITER, { now });
    await pruneAuth({ now: now + 2 * 86400_000 });
    expect(await select('panel_session', {})).toHaveLength(0);
    expect(await select('panel_code', {})).toHaveLength(0);
  });
});

describe('the limit on wrong codes', () => {
  it('stops one address after five, and lets it back after the window', () => {
    const limiter = attemptLimiter({ max: 5, windowMs: 1000 });
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.allowed('1.2.3.4', 100)).toBe(true);
      limiter.failed('1.2.3.4', 100);
    }
    expect(limiter.allowed('1.2.3.4', 200)).toBe(false);
    expect(limiter.allowed('5.6.7.8', 200)).toBe(true);
    expect(limiter.allowed('1.2.3.4', 1200)).toBe(true);
  });

  it('stops everyone when many addresses share a search', () => {
    const limiter = attemptLimiter({ max: 2, windowMs: 1000 });
    for (let i = 0; i < 10; i += 1) limiter.failed(`10.0.0.${i}`, 100);
    expect(limiter.allowed('10.9.9.9', 200)).toBe(false);
  });
});
