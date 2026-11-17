import { describe, it, expect } from 'vitest';
import { parseShieldCommand, shieldCommandText, isShieldCommand } from './shieldCommand.js';
import { parseCommand } from './command.js';

const POST = 'at://did:plc:owner0000000000000000000/app.bsky.feed.post/3kpost';
const LINK = 'https://bsky.app/profile/me.example.com/post/3kpost';

const p = (text, opts) => parseShieldCommand(text, opts);

describe('parseShieldCommand', () => {
  it('reads status, up and down in the ways people say them', () => {
    for (const t of ['shield', 'shields', 'shield status', 'attack mode?', 'is the shield on?']) {
      expect(p(t)?.action).toBe('status');
    }
    for (const t of ['shields up', 'attack mode', 'attack mode on', 'lockdown', 'lock down', 'lock everything down', 'please shields up']) {
      expect(p(t)?.action).toBe('up');
    }
    for (const t of ['shields down', 'stand down', 'all clear', 'attack mode off', 'lift the lockdown', 'end lockdown']) {
      expect(p(t)?.action).toBe('down');
    }
  });

  it('reads how long a lockdown lasts', () => {
    expect(p('shields up for 12h').hours).toBe(12);
    expect(p('lockdown for 2 days').hours).toBe(48);
    expect(p('attack mode 6 hours').hours).toBe(6);
    expect(p('shields up').hours).toBeNull();
  });

  it('reads replies and quotes on a post from the message', () => {
    expect(p('close replies', { embedUri: POST })).toMatchObject({ action: 'close', post: POST, needsPost: false });
    expect(p(`lock the replies on ${LINK}`)).toMatchObject({ action: 'close', post: LINK });
    expect(p('open replies', { links: [LINK] })).toMatchObject({ action: 'open', post: LINK });
    expect(p(`no quotes ${POST}`)).toMatchObject({ action: 'quotesOff', post: POST });
    expect(p('disable quotes')).toMatchObject({ action: 'quotesOff', needsPost: true });
    expect(p('quotes on', { embedUri: POST }).action).toBe('quotesOn');
    expect(p('turn on quote posts', { embedUri: POST }).action).toBe('quotesOn');
    expect(p('keep it closed', { embedUri: POST }).action).toBe('keep');
  });

  it('reads who may still reply after "to"', () => {
    expect(p(`close replies ${POST} to followers`).rule).toEqual(['followers']);
    expect(p('close replies to my followers and people i follow', { embedUri: POST }).rule).toEqual(['following', 'followers']);
    expect(p('lock replies to nobody', { embedUri: POST }).rule).toEqual(['nobody']);
    expect(p('close replies', { embedUri: POST }).rule).toBeNull();
    expect(p('close replies to friends', { embedUri: POST }).ruleError).toMatch(/friends/);
  });

  it('is not a command for ordinary messages and for the list commands', () => {
    for (const t of ['block @someone.example.com', 'what are the replies saying?', 'help', 'undo', 'watch this', 'quoters', 'add quoters', 'close friends']) {
      expect(p(t)).toBeNull();
    }
  });

  it('is not a command when it says more than the command does', () => {
    // Read as "close replies" these would act on a post nobody named, for a
    // reason the words do not give.
    for (const t of [
      'stop replies from that guy',
      'disable quotes for @someone.example.com',
      'lock replies if it gets worse',
      'shields up and block them all',
      'open replies tomorrow',
    ]) {
      expect(p(t, { embedUri: POST })).toBeNull();
    }
    // Filler around the post is fine.
    expect(p('close replies on this post please', { embedUri: POST })?.action).toBe('close');
    expect(p('shields up on everything for 2 days')?.hours).toBe(48);
  });

  it('marks what changes something', () => {
    expect(p('shield').write).toBe(false);
    expect(p('shields up').write).toBe(true);
  });
});

describe('shieldCommandText', () => {
  it('parses back to the same command, for menus and stored questions', () => {
    const cases = [
      { action: 'status' },
      { action: 'up' },
      { action: 'up', hours: 12 },
      { action: 'down' },
      { action: 'close', post: POST },
      { action: 'close', post: POST, rule: ['followers', 'mentioned'] },
      { action: 'open', post: POST },
      { action: 'quotesOff', post: POST },
      { action: 'quotesOn', post: POST },
      { action: 'keep', post: POST },
      { action: 'watch', post: POST },
    ];
    for (const c of cases) {
      const back = parseShieldCommand(shieldCommandText(c));
      expect(back.action).toBe(c.action);
      if (c.post) expect(back.post).toBe(c.post);
      if (c.rule) expect(back.rule).toEqual(c.rule);
      if (c.hours) expect(back.hours).toBe(c.hours);
      expect(isShieldCommand(shieldCommandText(c))).toBe(true);
    }
  });

  it('never reads as a list command, so a stored one cannot add anyone', () => {
    for (const action of ['close', 'open', 'quotesOff', 'quotesOn', 'keep', 'watch']) {
      expect(parseCommand(shieldCommandText({ action, post: POST }))).toBeNull();
    }
    expect(parseCommand('shields up')).toBeNull();
    expect(parseCommand('shields down')).toBeNull();
  });
});

describe('guard and unguard', () => {
  const U = 'at://did:plc:owner0000000000000000000/app.bsky.feed.post/3abc';

  it('reads a guard with its post, how long, and whether it acts or asks', () => {
    expect(parseShieldCommand(`guard ${U}`)).toMatchObject({ action: 'guard', post: U, hours: null, mode: null, write: true });
    expect(parseShieldCommand('guard this for 2 days', { embedUri: U })).toMatchObject({ post: U, hours: 48 });
    expect(parseShieldCommand('guard it, just tell me', { embedUri: U })).toMatchObject({ mode: 'ask' });
    expect(parseShieldCommand(`guard ${U} for 12h auto`)).toMatchObject({ hours: 12, mode: 'auto' });
    expect(parseShieldCommand('set up a trigger on this', { embedUri: U })).toMatchObject({ action: 'guard', post: U });
    expect(parseShieldCommand('guard')).toMatchObject({ action: 'guard', needsPost: true });
  });

  it('reads stopping one', () => {
    expect(parseShieldCommand(`unguard ${U}`)).toMatchObject({ action: 'unguard', post: U });
    expect(parseShieldCommand('stop guarding this', { embedUri: U })).toMatchObject({ action: 'unguard', post: U });
  });

  it('is not a guard when it says more than one', () => {
    expect(parseShieldCommand('guard my friend from trolls')).toBeNull();
  });

  it('round-trips through its canonical text', () => {
    for (const c of [
      { action: 'guard', post: U, hours: 72, mode: 'ask' },
      { action: 'guard', post: U, hours: 72, mode: null },
      { action: 'unguard', post: U },
    ]) {
      expect(parseShieldCommand(shieldCommandText(c))).toMatchObject({
        action: c.action,
        post: U,
        ...(c.action === 'guard' ? { hours: c.hours, mode: c.mode } : {}),
      });
    }
  });
});
