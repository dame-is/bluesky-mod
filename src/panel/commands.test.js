// The panel's only way to change the list is the bot's own command path.
// These check what it lets through to that path, and what it hands it.

import { describe, it, expect, vi } from 'vitest';

import { checkCommand, runPanelCommand } from './commands.js';

const owner = { tier: 'owner', canWrite: true, did: 'did:plc:owner' };
const writer = { tier: 'writer', canWrite: true, did: 'did:plc:writer' };
const reader = { tier: 'reader', canWrite: false, did: 'did:plc:reader' };

describe('what the panel will run', () => {
  it('takes the commands that change the list or label a plan', () => {
    for (const text of [
      'approve 3f2a1b7c UNKNOWN',
      'approve 3f2a1b7c UNKNOWN,NOTABLE likers',
      'approve 3f2a1b7c hostile UNKNOWN',
      'approve 3f2a1b7c did:plc:abc did:plc:def',
      'cancel 3f2a1b7c',
      'undo 3f2a1b7c',
      'block did:plc:abc',
      'unblock someone.example.social',
      'triage 3f2a1b7c',
    ]) {
      expect(checkCommand(text, owner), text).toMatchObject({ ok: true });
    }
  });

  it('leaves questions and reading to the DMs', () => {
    for (const text of ['read @someone.example.social', 'pulse', 'history', 'help', 'review 3f2a1b7c', 'add likers https://bsky.app/profile/a.example.social/post/3k']) {
      const out = checkCommand(text, owner);
      expect(out.ok, text).toBe(false);
      expect(out.status).toBe(400);
    }
  });

  it('refuses what is not a command at all', () => {
    for (const text of ['', '   ', 'please block everyone who liked this', 'approve\n3f2a1b7c UNKNOWN', 'x'.repeat(5000)]) {
      expect(checkCommand(text, owner).ok).toBe(false);
    }
  });

  it('will not guess which change a bare undo means', () => {
    const out = checkCommand('undo', owner);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('Name the plan');
    expect(checkCommand('undo last', owner).ok).toBe(false);
  });

  it('gives a read-only account the reads and none of the writes', () => {
    for (const text of ['approve 3f2a1b7c UNKNOWN', 'cancel 3f2a1b7c', 'undo 3f2a1b7c', 'block did:plc:abc', 'unblock did:plc:abc']) {
      const out = checkCommand(text, reader);
      expect(out.ok, text).toBe(false);
      expect(out.status).toBe(403);
      expect(out.error).toContain('read-only');
    }
    // Sorting by tone labels a plan and adds nobody, as in a DM.
    expect(checkCommand('triage 3f2a1b7c', reader).ok).toBe(true);
  });
});

const deps = (reply = { text: 'Added 3 to the list.', outcome: 'done' }) => {
  const d = {
    order: [],
    enqueue: vi.fn(async (label, job) => {
      d.order.push(`queued:${label}`);
      return job();
    }),
    writeAgent: () => ({ session: { did: 'did:plc:bot' } }),
    runCommand: vi.fn(async () => {
      d.order.push('ran');
      return reply;
    }),
    lookUp: vi.fn(),
    ownerConvo: vi.fn(async () => 'convo-1'),
    model: async () => 'test/model',
    generate: vi.fn(),
    log: () => {},
  };
  return d;
};

describe('running one', () => {
  it('runs on the bot\'s queue, as the parsed command, with the session\'s powers', async () => {
    const d = deps();
    const out = await runPanelCommand('approve 3f2a1b7c UNKNOWN', owner, d);
    expect(out).toMatchObject({ ok: true, outcome: 'done', text: 'Added 3 to the list.' });
    expect(d.order).toEqual(['queued:panel', 'ran']);
    const [cmd, agent, opts] = d.runCommand.mock.calls[0];
    expect(cmd).toMatchObject({ action: 'approve', code: '3f2a1b7c', bands: ['UNKNOWN'], raw: 'approve 3f2a1b7c UNKNOWN' });
    expect(agent.session.did).toBe('did:plc:bot');
    expect(opts).toMatchObject({ canWrite: true, convoId: 'convo-1', model: 'test/model' });
  });

  it('never carries PROTECTED, whatever the request spells', async () => {
    const d = deps();
    await runPanelCommand('approve 3f2a1b7c PROTECTED,UNKNOWN', owner, d);
    expect(d.runCommand.mock.calls[0][0].bands).toEqual(['UNKNOWN']);
    await runPanelCommand('approve 3f2a1b7c PROTECTED', owner, d);
    // The parser refuses it and says why; the runner is handed that refusal.
    expect(d.runCommand.mock.calls[1][0]).toMatchObject({ needsTarget: true });
    expect(d.runCommand.mock.calls[1][0].refusal).toContain('PROTECTED is never added');
  });

  it('only the owner has a conversation to hear when a long approval is done', async () => {
    const d = deps();
    await runPanelCommand('approve 3f2a1b7c UNKNOWN', writer, d);
    expect(d.ownerConvo).not.toHaveBeenCalled();
    expect(d.runCommand.mock.calls[0][2].convoId).toBe(null);
  });

  it('does not reach the queue when the command is refused', async () => {
    const d = deps();
    const out = await runPanelCommand('block did:plc:abc', reader, d);
    expect(out).toMatchObject({ ok: false, status: 403 });
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it('passes on only the follow-ups the panel could run', async () => {
    const d = deps({
      text: 'Added 3 to the list.',
      outcome: 'done',
      options: [
        { label: 'Undo all 3', command: 'undo 3f2a1b7c' },
        { label: 'Show me the record', command: 'history' },
      ],
    });
    const out = await runPanelCommand('approve 3f2a1b7c UNKNOWN', owner, d);
    expect(out.options).toEqual([
      { label: 'Undo all 3', command: 'undo 3f2a1b7c', commands: ['undo 3f2a1b7c'], takesBack: true },
    ]);
    expect(out.choice).toBe(false);
  });

  it('marks a follow-up that adds anyone, so the page never offers it as one press', async () => {
    // What the bot offers after a read: the first thing the panel could run
    // is "add the hostile ones".
    const d = deps({
      text: 'Read 40 of the 88 accounts on 3f2a1b7c.',
      outcome: null,
      options: [
        { label: 'Show me some of the 37 hostile ones', command: 'review 3f2a1b7c hostile' },
        { label: 'Add the 37 hostile ones', command: 'approve 3f2a1b7c hostile asof=2026-11-17T14:00:00.000Z' },
        { label: 'Do nothing', command: 'cancel 3f2a1b7c' },
      ],
    });
    const out = await runPanelCommand('triage 3f2a1b7c', owner, d);
    expect(out.options.map((o) => [o.label, o.takesBack])).toEqual([
      ['Add the 37 hostile ones', false],
      ['Do nothing', false],
    ]);
    expect(out.choice).toBe(false);
    // An unblock's "put them back" adds too.
    const back = await runPanelCommand('unblock did:plc:abc', owner, deps({
      text: 'Removed them.',
      outcome: 'done',
      options: [{ label: 'Put them back', command: 'list add did:plc:abc' }],
    }));
    expect(back.options[0].takesBack).toBe(false);
  });
});

describe('the bot asking which list', () => {
  const before = process.env.MOD_MULTI_LIST;
  const which = {
    text: 'Which list for @pest.example.social?',
    outcome: null,
    options: [
      { label: 'Block List', command: 'list add did:plc:abc list:3kmain', commands: ['list add did:plc:abc list:3kmain'] },
      { label: 'Spam', command: 'list add did:plc:abc list:3kspam', commands: ['list add did:plc:abc list:3kspam'] },
    ],
  };

  it('is handed to the page as a question, with everything each answer runs', async () => {
    process.env.MOD_MULTI_LIST = 'true';
    try {
      const out = await runPanelCommand('block did:plc:abc', owner, deps(which));
      expect(out.choice).toBe(true);
      expect(out.options.map((o) => o.commands)).toEqual([
        ['list add did:plc:abc list:3kmain'],
        ['list add did:plc:abc list:3kspam'],
      ]);
      // "Every list" is one command per list, and all of them are kept.
      const off = await runPanelCommand('unblock did:plc:abc', owner, deps({
        text: 'They are on 2 of your lists. Which should they come off?',
        outcome: null,
        options: [
          { label: 'Spam', command: 'list remove did:plc:abc list:3kspam', commands: ['list remove did:plc:abc list:3kspam'] },
          { label: 'Every list', command: 'list remove did:plc:abc list:3kmain', commands: ['list remove did:plc:abc list:3kmain', 'list remove did:plc:abc list:3kspam'] },
        ],
      }));
      expect(off.choice).toBe(true);
      expect(off.options[1].commands).toHaveLength(2);
    } finally {
      if (before === undefined) delete process.env.MOD_MULTI_LIST;
      else process.env.MOD_MULTI_LIST = before;
    }
  });

  it('drops an answer if any command in it is one the panel does not run', async () => {
    process.env.MOD_MULTI_LIST = 'true';
    try {
      const out = await runPanelCommand('block did:plc:abc', owner, deps({
        ...which,
        options: [
          which.options[0],
          { label: 'Both', command: 'list add did:plc:abc list:3kmain', commands: ['list add did:plc:abc list:3kmain', 'watch at://x/app.bsky.feed.post/3k 24h auto list:3kmain'] },
        ],
      }));
      expect(out.options.map((o) => o.label)).toEqual(['Block List']);
    } finally {
      if (before === undefined) delete process.env.MOD_MULTI_LIST;
      else process.env.MOD_MULTI_LIST = before;
    }
  });

  it('is not what a receipt with a way back is', async () => {
    const out = await runPanelCommand('block did:plc:abc', owner, deps({
      text: 'Added them.',
      outcome: 'done',
      options: [{ label: 'Undo that', command: 'list remove did:plc:abc' }],
    }));
    expect(out.choice).toBe(false);
  });
});
