// `history <name>` through the real runCommand and historyFor against an
// in-memory database. History rows do not name accounts, so a name the parser
// cannot read must not be answered with the whole record.

import { describe, it, expect, beforeEach } from 'vitest';

const db = await import('../bot/db.js');
const { runCommand } = await import('../bot/dmLoop.js');
const { parseCommand } = await import('./command.js');

const ID = 'abcd1234-0000-4000-8000-000000000000';
const ADDED = 'did:plc:added000000000000000000';
const agent = { session: { did: 'did:plc:bot' } };

beforeEach(async () => {
  db.closeDb();
  db.openDb(':memory:');
  await db.upsert('plan', [
    { id: ID, created_at: new Date().toISOString(), note: 'bulk everyone' },
  ]);
  await db.upsert('decision', [
    {
      plan_id: ID,
      did: ADDED,
      band: 'UNKNOWN',
      action: 'list_add',
      acted_at: new Date().toISOString(),
      approved_via: 'band',
    },
  ]);
});

describe('history with a name', () => {
  it('asks back a name it cannot read', async () => {
    for (const text of ['history alice', 'history of someone']) {
      const out = await runCommand(parseCommand(text), agent, {});
      expect(out.text, text).toMatch(/^I could not read "/);
      expect(out.text, text).not.toMatch(/changes? on record/);
    }
  });

  it('reads the DID a review row prints for an account with no handle', async () => {
    const out = await runCommand(
      parseCommand('history @did:plc:someoneelse0000000000000'),
      agent,
      {},
    );
    expect(out.text).toBe('Nothing recorded for them.');
    const theirs = await runCommand(
      parseCommand(`history @${ADDED}`),
      agent,
      {},
    );
    expect(theirs.text).toMatch(/^1 changes? on record/);
  });

  it('still shows the whole record when no name is given', async () => {
    const out = await runCommand(parseCommand('history'), agent, {});
    expect(out.text).toMatch(/^1 changes? on record/);
  });
});
