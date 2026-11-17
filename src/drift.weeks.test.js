// The re-score over several weeks, against the real store: what each account
// is compared with, when a run is due, and what happens to a brief that could
// not be sent.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const LIST = 'at://did:plc:bot0000000000000000000000/app.bsky.graph.list/3list';
process.env.MOD_LIST_URI = LIST;

/** What the scorer says about each account this week. */
const bands = new Map();
const missing = new Set();

vi.mock('./bot/reference.js', () => ({
  loadReference: async () => ({ ref: {}, thresholds: {}, takenAt: 't' }),
}));
vi.mock('./lib/score.js', () => ({
  createScorer: () => ({
    score: async (dids) =>
      new Map(
        dids.map((did) => [
          did,
          {
            band: bands.get(did) ?? 'UNKNOWN',
            // The AppView has no profile, so no handle, for an account it
            // left out.
            handle: missing.has(did) ? null : did.slice(8),
            missing: missing.has(did),
            vouches: 0,
          },
        ]),
      ),
  }),
}));

const { maybeRunDrift } = await import('./drift.js');
const { closeDb, upsert, select } = await import('./bot/db.js');
const { config } = await import('./config.js');

const members = [];
const listReads = vi.fn();
const agent = {
  com: {
    atproto: {
      repo: {
        listRecords: async () => {
          listReads();
          return {
            data: {
              records: members.map((subject, i) => ({
                uri: `at://did:plc:bot0000000000000000000000/app.bsky.graph.listitem/r${i}`,
                value: { list: LIST, subject },
              })),
            },
          };
        },
      },
    },
  },
};

const chatState = { down: false, sent: [], menus: [] };
const chat = {
  chat: {
    bsky: {
      convo: {
        sendMessage: async ({ convoId, message }) => {
          if (chatState.down) throw new Error('UpstreamFailure');
          // The numbered menu stored for this convo as each message goes.
          const [row] = await select('dm_choice', {
            select: 'options',
            eq: { convo_id: convoId },
          });
          chatState.menus.push(row?.options ?? null);
          chatState.sent.push(message.text);
          return { data: {} };
        },
      },
    },
  },
};

/** One check, at this moment. */
function checkAt(iso) {
  vi.setSystemTime(new Date(iso));
  return maybeRunDrift(agent, chat, 'convo1');
}

/** A live add of `did`, logged with `band` the way a write logs it. */
async function addedAs(did, band) {
  const now = new Date().toISOString();
  const plan = `plan-${did}`;
  await upsert('plan', [{ id: plan, created_at: now, approved_at: now }]);
  await upsert('decision', [
    { plan_id: plan, did, band, action: 'list_add', acted_at: now },
  ]);
}

const A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'did:plc:cccccccccccccccccccccccc';

beforeEach(() => {
  closeDb();
  bands.clear();
  missing.clear();
  members.length = 0;
  listReads.mockClear();
  chatState.down = false;
  chatState.sent = [];
  chatState.menus = [];
  config.driftEveryHours = 168;
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  config.driftEveryHours = 168;
});

describe('an account with no earlier audit', () => {
  it('is compared with the band it was added under, so the first audit reports it', async () => {
    vi.setSystemTime(new Date('2026-11-01T09:00:00Z'));
    members.push(A, B);
    await addedAs(A, 'UNKNOWN');
    await addedAs(B, 'UNKNOWN');
    bands.set(B, 'PERIPHERAL');
    const body = await checkAt('2026-11-01T12:00:00Z');
    expect(body).toContain(`@${B.slice(8)} is now PERIPHERAL`);
    expect(body).not.toContain(A.slice(8));
  });

  it('is reported when it was added between audits and the owner follows it by the next', async () => {
    members.push(A);
    expect(await checkAt('2026-11-01T12:00:00Z')).toBe(null);

    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    members.push(B);
    await addedAs(B, 'UNKNOWN');
    bands.set(B, 'PROTECTED');
    expect(await checkAt('2026-11-08T12:00:00Z')).toContain(
      `@${B.slice(8)} is now PROTECTED`,
    );

    // Said once: the next audit compares it with this one.
    expect(await checkAt('2026-11-15T12:00:00Z')).toBe(null);
  });

  it('counts an add typed without a score, or one with no record, as a stranger', async () => {
    vi.setSystemTime(new Date('2026-11-01T09:00:00Z'));
    members.push(A, B);
    await addedAs(A, 'UNSCORED');
    bands.set(A, 'CONNECTED');
    bands.set(B, 'CONNECTED');
    const body = await checkAt('2026-11-01T12:00:00Z');
    expect(body).toContain(`@${A.slice(8)} is now CONNECTED`);
    expect(body).toContain(`@${B.slice(8)} is now CONNECTED`);
  });
});

describe('a member that becomes PROTECTED', () => {
  it('is reported from any band, once', async () => {
    vi.setSystemTime(new Date('2026-11-01T09:00:00Z'));
    members.push(C);
    await addedAs(C, 'NOTABLE');
    bands.set(C, 'NOTABLE');
    expect(await checkAt('2026-11-01T12:00:00Z')).toBe(null);

    bands.set(C, 'PROTECTED');
    expect(await checkAt('2026-11-08T12:00:00Z')).toContain(
      `@${C.slice(8)} is now PROTECTED`,
    );
    expect(await checkAt('2026-11-15T12:00:00Z')).toBe(null);
  });
});

describe('an account that has gone', () => {
  it('is reported once, not at every audit', async () => {
    members.push(A, B);
    missing.add(B);
    expect(await checkAt('2026-11-01T12:00:00Z')).toContain(
      '1 account is gone',
    );
    expect(await checkAt('2026-11-08T12:00:00Z')).toBe(null);
  });
});

describe('a brief that could not be sent', () => {
  it('goes out at the next check, without a second re-score', async () => {
    members.push(A);
    expect(await checkAt('2026-11-01T12:00:00Z')).toBe(null);

    bands.set(A, 'PROTECTED');
    chatState.down = true;
    await expect(checkAt('2026-11-08T12:00:00Z')).rejects.toThrow(
      /UpstreamFailure/,
    );
    const [row] = await select('brief', {
      select: 'body,sent_at',
      order: 'for_date.desc',
      limit: 1,
    });
    expect(row.body).toContain('is now PROTECTED');
    expect(row.sent_at).toBe(null);

    chatState.down = false;
    const reads = listReads.mock.calls.length;
    expect(await checkAt('2026-11-08T13:00:00Z')).toContain(
      `@${A.slice(8)} is now PROTECTED`,
    );
    expect(chatState.sent).toHaveLength(1);
    expect(listReads.mock.calls.length).toBe(reads);

    // Sent, so it is not sent again.
    expect(await checkAt('2026-11-08T14:00:00Z')).toBe(null);
    expect(chatState.sent).toHaveLength(1);
  });

  it('is not the baseline while it has not gone, so the next run still names who moved', async () => {
    members.push(A);
    expect(await checkAt('2026-11-01T12:00:00Z')).toBe(null);

    bands.set(A, 'PROTECTED');
    chatState.down = true;
    await expect(checkAt('2026-11-08T12:00:00Z')).rejects.toThrow();
    await expect(checkAt('2026-11-08T13:00:00Z')).rejects.toThrow();

    chatState.down = false;
    expect(await checkAt('2026-11-15T12:00:00Z')).toContain(
      `@${A.slice(8)} is now PROTECTED`,
    );
  });
});

describe('a brief going out', () => {
  it('clears the numbered menu first, so a number sent after it cannot answer an older menu', async () => {
    members.push(A);
    expect(await checkAt('2026-11-01T12:00:00Z')).toBe(null);

    await upsert('dm_choice', [
      {
        convo_id: 'convo1',
        options: [{ label: 'Add @x.test to the list', command: 'list add @x.test' }],
      },
    ]);
    bands.set(A, 'PROTECTED');
    expect(await checkAt('2026-11-08T12:00:00Z')).toContain('is now PROTECTED');
    expect(chatState.menus).toEqual([[]]);
  });
});

describe('a clock that ran fast', () => {
  it('does not hold off the re-score, or keep its audit as the baseline, once it is put right', async () => {
    members.push(A);
    // The clock is a year fast: the run and its audit are dated a year ahead.
    expect(await checkAt('2027-11-01T12:00:00Z')).toBe(null);
    expect(listReads).toHaveBeenCalledTimes(1);

    // Put right the next day. The brief dated ahead says nothing about when
    // the last run was, so a run is due.
    expect(await checkAt('2026-11-02T12:00:00Z')).toBe(null);
    expect(listReads).toHaveBeenCalledTimes(2);
    // And counts from that run, not again at every check.
    await checkAt('2026-11-02T13:00:00Z');
    expect(listReads).toHaveBeenCalledTimes(2);

    bands.set(A, 'CONNECTED');
    expect(await checkAt('2026-11-09T12:00:00Z')).toContain(
      `@${A.slice(8)} is now CONNECTED`,
    );
    // Said once: the audit dated ahead is no longer the newest.
    expect(await checkAt('2026-11-16T12:00:00Z')).toBe(null);
  });
});

describe('when the next run is due', () => {
  it('counts from the moment of the last run, not the start of its day', async () => {
    members.push(A);
    await checkAt('2026-11-16T23:30:00Z');
    expect(listReads).toHaveBeenCalledTimes(1);
    await checkAt('2026-11-23T00:30:00Z');
    expect(listReads).toHaveBeenCalledTimes(1);
    await checkAt('2026-11-23T23:31:00Z');
    expect(listReads).toHaveBeenCalledTimes(2);
  });

  it('runs once per DRIFT_EVERY_HOURS when that is under a day', async () => {
    config.driftEveryHours = 12;
    members.push(A, B);
    missing.add(B);
    await checkAt('2026-11-16T13:00:00Z');
    await checkAt('2026-11-16T14:00:00Z');
    await checkAt('2026-11-16T15:00:00Z');
    expect(listReads).toHaveBeenCalledTimes(1);
    expect(chatState.sent).toHaveLength(1);
    await checkAt('2026-11-17T01:00:00Z');
    expect(listReads).toHaveBeenCalledTimes(2);
  });
});
