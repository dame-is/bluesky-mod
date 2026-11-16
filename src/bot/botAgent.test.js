// The guard that matters here is the account check. A DID and an app password
// from two different accounts is an easy copy-paste mistake: login succeeds,
// because the password is valid for someone, and every write afterwards lands
// in a repo nobody meant to touch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const BOT = 'did:plc:bot';
const OTHER = 'did:plc:someoneelse';

let sessionRow = null;
let loginAs = BOT;

let resolvedPds = 'https://pds.example.com';
let pdsThrows = false;

vi.mock('../lib/atproto.js', () => ({
  resolvePds: vi.fn(async () => {
    if (pdsThrows) throw new Error('plc unreachable');
    return resolvedPds;
  }),
}));

vi.mock('./db.js', () => ({
  select: vi.fn(async () => (sessionRow ? [{ session: sessionRow }] : [])),
  upsert: vi.fn(async () => null),
}));

vi.mock('@atproto/api', () => ({
  AtpAgent: class {
    constructor(opts) {
      this.opts = opts;
      this.session = null;
    }
    async login() {
      this.session = {
        did: loginAs,
        handle: 'bot.example.com',
        refreshJwt: 'r',
      };
      this.opts?.persistSession?.('create', this.session);
      return { data: this.session };
    }
    async resumeSession(session) {
      if (!session?.refreshJwt) throw new Error('dead');
      this.session = { ...session, did: session.did ?? loginAs };
      return { data: this.session };
    }
    withProxy() {
      return this;
    }
    get service() {
      return this.opts?.service;
    }
  },
}));

const { botAgent } = await import('./botAgent.js');

beforeEach(() => {
  sessionRow = null;
  loginAs = BOT;
  resolvedPds = 'https://pds.example.com';
  pdsThrows = false;
  process.env.MOD_IDENTIFIER = BOT;
  process.env.MOD_APP_PASSWORD = 'pw';
});

afterEach(() => {
  delete process.env.MOD_IDENTIFIER;
  delete process.env.MOD_APP_PASSWORD;
  delete process.env.MOD_SERVICE;
});

describe('botAgent', () => {
  it('logs in when there is no stored session', async () => {
    const { agent, via } = await botAgent();
    expect(via).toBe('login');
    expect(agent.session.did).toBe(BOT);
  });

  it('resumes a stored session instead of spending a createSession', async () => {
    // createSession is capped at 300 a day per account; a refresh is not.
    sessionRow = { did: BOT, refreshJwt: 'r' };
    const { via } = await botAgent();
    expect(via).toBe('resume');
  });

  it('falls back to login when the stored refresh token is dead', async () => {
    sessionRow = { did: BOT };
    const { via } = await botAgent();
    expect(via).toBe('login');
  });

  it('refuses when the password authenticates as a different account', async () => {
    loginAs = OTHER;
    await expect(botAgent()).rejects.toThrow(/belong to different accounts/);
  });

  it('never resumes a stored session for a different account', async () => {
    // Left over from a misconfigured run. Resuming it would act as the wrong
    // account, or fail the account check even after the password is fixed.
    sessionRow = { did: OTHER, refreshJwt: 'r' };
    const { agent, via } = await botAgent();
    expect(via).toBe('login');
    expect(agent.session.did).toBe(BOT);
  });

  it('accepts a handle identifier, and cannot check it', async () => {
    // A handle still works; it gives up the account check, which is why
    // src/config.js asks for the DID.
    process.env.MOD_IDENTIFIER = 'bot.example.com';
    loginAs = OTHER;
    const { agent } = await botAgent();
    expect(agent.session.did).toBe(OTHER);
  });

  it('authenticates at the PDS that holds the account', async () => {
    // atproto has no central login. bsky.social answers "Invalid identifier
    // or password" for an account it does not host, which reads as a bad app
    // password.
    const { agent } = await botAgent();
    expect(agent.opts.service).toBe('https://pds.example.com');
  });

  it('falls back to bsky.social when the directory cannot be reached', async () => {
    pdsThrows = true;
    const { agent } = await botAgent();
    expect(agent.opts.service).toBe('https://bsky.social');
  });

  it('lets MOD_SERVICE override the lookup', async () => {
    process.env.MOD_SERVICE = 'https://pds.local/';
    const { agent } = await botAgent();
    expect(agent.opts.service).toBe('https://pds.local');
  });

  it('cannot resolve a PDS from a handle, and says so by falling back', async () => {
    process.env.MOD_IDENTIFIER = 'bot.example.com';
    loginAs = OTHER;
    const { agent } = await botAgent();
    expect(agent.opts.service).toBe('https://bsky.social');
  });

  it('errors clearly when nothing is configured', async () => {
    delete process.env.MOD_IDENTIFIER;
    delete process.env.MOD_APP_PASSWORD;
    await expect(botAgent()).rejects.toThrow(/must be configured/);
  });
});
