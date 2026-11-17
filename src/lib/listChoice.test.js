import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  multiListOn,
  splitListChoice,
  withListToken,
  listTokenOf,
} from './listChoice.js';
import { parseCommand, parseQuick, isWrite } from './command.js';

const AUTHOR = 'did:plc:author0000000000000000000';
const POST = `at://${AUTHOR}/app.bsky.feed.post/3kpost`;

describe('splitListChoice', () => {
  it('takes the canonical token from anywhere, and leaves the rest', () => {
    expect(splitListChoice('block @x.bsky.social list:3k2abc')).toEqual({
      text: 'block @x.bsky.social',
      list: '3k2abc',
      conflict: false,
    });
    expect(splitListChoice('approve 1c2d3e4f list=2 UNKNOWN').list).toBe('2');
  });

  it('reads "to", "on", "onto" and "into" only as the last two words', () => {
    expect(splitListChoice('block @x.bsky.social to spam')).toMatchObject({
      text: 'block @x.bsky.social',
      list: 'spam',
    });
    expect(splitListChoice('approve 1c2d3e4f UNKNOWN on 2')).toMatchObject({
      text: 'approve 1c2d3e4f UNKNOWN',
      list: '2',
    });
    expect(splitListChoice('block this into trolls.')).toMatchObject({
      text: 'block this',
      list: 'trolls',
    });
    // Not at the end: not a list.
    expect(splitListChoice('block to spam @x.bsky.social').list).toBeNull();
  });

  it('never reads an account or a link as a list', () => {
    expect(splitListChoice('block on @x.bsky.social').list).toBeNull();
    expect(splitListChoice('unblock them to x.bsky.social').list).toBeNull();
    expect(
      splitListChoice('add likers to https://bsky.app/profile/a/post/b').list,
    ).toBeNull();
    // Two words are not enough to hold a verb, a target and a list.
    expect(splitListChoice('block spam').list).toBeNull();
  });

  it('refuses two different canonical lists rather than picking one', () => {
    expect(splitListChoice('block @x.bsky.social list:a list:b')).toMatchObject({
      list: null,
      conflict: true,
    });
    // The same one twice is one list.
    expect(splitListChoice('block @x.bsky.social list:a list:A').conflict).toBe(
      false,
    );
  });

  it('puts the canonical token on a command in place of any list it named', () => {
    expect(withListToken('approve 1c2d3e4f UNKNOWN to spma', '3krkey')).toBe(
      'approve 1c2d3e4f UNKNOWN list:3krkey',
    );
    expect(withListToken('list add did:plc:a list:old', 'new')).toBe(
      'list add did:plc:a list:new',
    );
    expect(listTokenOf('list add did:plc:a list:3k')).toBe('3k');
  });
});

describe('the parser with one list (multi-list mode off)', () => {
  beforeEach(() => {
    delete process.env.MOD_MULTI_LIST;
  });

  it('reads a block that names a list exactly as before: too many words', () => {
    expect(multiListOn()).toBe(false);
    const cmd = parseCommand('block @x.bsky.social to spam');
    expect(cmd.action).toBe('list_add');
    expect(cmd.needsTarget).toBe(true);
    expect(cmd.list).toBeUndefined();
    expect(parseQuick('block @x.bsky.social to spam')).toBeNull();
  });

  it('still parses the list verbs, so they can say the mode is off', () => {
    expect(parseCommand('lists').action).toBe('lists');
    expect(parseCommand('new list Spam').action).toBe('new_list');
  });
});

describe('the parser in multi-list mode', () => {
  beforeEach(() => {
    process.env.MOD_MULTI_LIST = 'true';
  });
  afterEach(() => {
    delete process.env.MOD_MULTI_LIST;
  });

  it('reads the target as it would with one list, and carries the list as typed', () => {
    const cmd = parseCommand('block @x.bsky.social to spam');
    expect(cmd).toMatchObject({
      action: 'list_add',
      actor: 'x.bsky.social',
      list: 'spam',
      needsTarget: false,
      raw: 'block @x.bsky.social to spam',
    });
    expect(parseCommand('list add did:plc:abc list:3k2').list).toBe('3k2');
    expect(parseCommand('unblock @x.bsky.social on all').list).toBe('all');
  });

  it('reads the author of an attached post with a list named, and does not ask', () => {
    const cmd = parseCommand('block this to 2', { embedUri: POST });
    expect(cmd).toMatchObject({
      actor: AUTHOR,
      fromPost: true,
      confirm: false,
      list: '2',
    });
  });

  it('carries a list on an approval and a scan', () => {
    const approve = parseCommand('approve 1c2d3e4f UNKNOWN,NOTABLE to spam');
    expect(approve).toMatchObject({
      code: '1c2d3e4f',
      bands: ['UNKNOWN', 'NOTABLE'],
      list: 'spam',
      needsTarget: false,
    });
    const scan = parseCommand('add likers to spam', { embedUri: POST });
    expect(scan).toMatchObject({ action: 'plan', target: POST, list: 'spam' });
  });

  it('leaves verbs that write to no list alone', () => {
    // "to work" stays part of what a digest is about.
    const pulse = parseCommand('pulse about going to work');
    expect(pulse.focus).toBe('going to work');
    expect(pulse.list).toBeUndefined();
    expect(parseCommand('history @x.bsky.social').list).toBeUndefined();
  });

  it('marks two lists named at once', () => {
    expect(
      parseCommand('block @x.bsky.social list:a list:b').listConflict,
    ).toBe(true);
  });

  it('lets the quick lane name a list too', () => {
    expect(parseQuick('block @x.bsky.social to spam')).toMatchObject({
      action: 'list_add',
      actor: 'x.bsky.social',
      list: 'spam',
    });
    expect(parseQuick('block to trolls', { embedUri: POST })).toMatchObject({
      actor: AUTHOR,
      fromPost: true,
      list: 'trolls',
    });
    // Without a list it is the quick lane it always was.
    expect(parseQuick('block @x.bsky.social').list).toBeNull();
  });

  it('parses "lists" and "new list" as their own verbs', () => {
    expect(parseCommand('lists').action).toBe('lists');
    expect(parseCommand('show my lists').action).toBe('lists');
    expect(isWrite(parseCommand('lists'))).toBe(false);
    const made = parseCommand('new list called Spam Accounts');
    expect(made).toMatchObject({ action: 'new_list', name: 'Spam Accounts' });
    expect(isWrite(made)).toBe(true);
    expect(parseCommand('create a list Trolls').name).toBe('Trolls');
    expect(parseCommand('new list').needsTarget).toBe(true);
    // A question about lists is not the command.
    expect(parseCommand('lists of people who quote me')).toBeNull();
  });
});
