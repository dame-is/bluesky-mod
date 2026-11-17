// The owner's session is refused before anything uses it when it belongs to
// someone else, or when it came from the account password rather than an app
// password.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const OWNER = 'did:plc:owner0000000000000000000';

let stored = null;
let loginAs = OWNER;
let scope = 'com.atproto.appPass';
let logins = 0;
let written = [];

const jwt = (payload) =>
  `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;

vi.mock('./lib/atproto.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolvePds: vi.fn(async () => 'https://pds.example.com'),
}));

vi.mock('./bot/db.js', () => ({
  select: vi.fn(async () => (stored ? [{ session: stored }] : [])),
  upsert: vi.fn(async (table, rows) => written.push([table, rows])),
}));

vi.mock('@atproto/api', () => ({
  AtpAgent: class {
    constructor(opts) {
      this.opts = opts;
      this.session = null;
    }
    async login({ identifier }) {
      logins += 1;
      this.loggedInWith = identifier;
      this.session = { did: loginAs, refreshJwt: 'r', accessJwt: jwt({ scope }) };
      this.opts.persistSession('create', this.session);
    }
    async resumeSession(session) {
      this.session = session;
    }
  },
}));

const { ownerAgent, tokenScope, sessionProblem } = await import('./ownerAgent.js');

beforeEach(() => {
  stored = null;
  loginAs = OWNER;
  scope = 'com.atproto.appPass';
  logins = 0;
  written = [];
});

describe('ownerAgent', () => {
  it('logs in as the owner and keeps the session in its own table', async () => {
    const { via, agent } = await ownerAgent({ ownerDid: OWNER, password: 'abcd-efgh-ijkl-mnop' });
    expect(via).toBe('login');
    expect(agent.loggedInWith).toBe(OWNER);
    expect(written.map(([t]) => t)).toEqual(['owner_session']);
  });

  it('resumes a stored session rather than spending a login', async () => {
    stored = { did: OWNER, refreshJwt: 'r', accessJwt: jwt({ scope }) };
    const { via } = await ownerAgent({ ownerDid: OWNER, password: 'abcd-efgh-ijkl-mnop' });
    expect(via).toBe('resume');
    expect(logins).toBe(0);
  });

  it('refuses a password for another account, and stores nothing', async () => {
    loginAs = 'did:plc:someoneelse';
    await expect(
      ownerAgent({ ownerDid: OWNER, password: 'abcd-efgh-ijkl-mnop' }),
    ).rejects.toMatchObject({ refused: true, message: expect.stringMatching(/not as MOD_OWNER_DID/) });
    expect(written).toEqual([]);
  });

  it('refuses the account password, which has full access', async () => {
    scope = 'com.atproto.access';
    await expect(
      ownerAgent({ ownerDid: OWNER, password: 'abcd-efgh-ijkl-mnop' }),
    ).rejects.toMatchObject({ refused: true, message: expect.stringMatching(/not an app password/) });
    expect(written).toEqual([]);
  });

  it('never resumes a stored session for another account', async () => {
    stored = { did: 'did:plc:someoneelse', refreshJwt: 'r', accessJwt: jwt({ scope }) };
    const { via } = await ownerAgent({ ownerDid: OWNER, password: 'abcd-efgh-ijkl-mnop' });
    expect(via).toBe('login');
  });
});

describe('tokenScope', () => {
  it('reads the scope out of a token, and null out of anything else', () => {
    expect(tokenScope(jwt({ scope: 'com.atproto.appPass' }))).toBe('com.atproto.appPass');
    expect(tokenScope('not-a-jwt')).toBeNull();
    expect(tokenScope(undefined)).toBeNull();
  });

  it('lets a session through when its scope cannot be read', () => {
    expect(sessionProblem({ did: OWNER, accessJwt: 'opaque' }, OWNER)).toBeNull();
  });
});
