import { describe, it, expect } from 'vitest';

import {
  parseQuick,
  isYes,
  isNo,
  bareEmoji,
  parseCardWords,
  parseMemoryCommand,
  parseWatchCommand,
  parseCommand,
} from './command.js';

const POST = 'at://did:plc:author/app.bsky.feed.post/3abc';

describe('the quick lane', () => {
  // The shapes people send: a shared post with "block", a link then "block
  // this account", a typed handle.
  it('takes "block" with one target and nothing else', () => {
    for (const text of [
      'block',
      'Block',
      'block em',
      'block this asshole pls',
      'block them.',
    ]) {
      expect(parseQuick(text, { embedUri: POST })).toMatchObject({
        action: 'list_add',
        actor: 'did:plc:author',
        fromPost: true,
      });
    }
    expect(parseQuick('block @bad.example.social')).toMatchObject({
      action: 'list_add',
      actor: 'bad.example.social',
      fromPost: false,
    });
    expect(
      parseQuick('bsky.app/profile/that... block this account', {
        links: ['https://bsky.app/profile/that.example/post/3abc'],
      }),
    ).toMatchObject({ action: 'list_add', actor: 'that.example' });
    expect(parseQuick('unblock @friend.example.social')).toMatchObject({
      action: 'list_remove',
      actor: 'friend.example.social',
    });
  });

  it('leaves anything more to the agent', () => {
    // Two things at once, two accounts, a typed handle beside an attached
    // post, a reason with its own verb, no verb at all.
    expect(
      parseQuick('block this account and everyone that liked this post', {
        embedUri: POST,
      }),
    ).toBe(null);
    expect(parseQuick('block @a.example.social @b.example.social')).toBe(null);
    expect(parseQuick('block @a.example.social', { embedUri: POST })).toBe(
      null,
    );
    expect(parseQuick('block whoever is replying', { embedUri: POST })).toBe(
      null,
    );
    expect(parseQuick('this one', { embedUri: POST })).toBe(null);
    expect(parseQuick('block')).toBe(null);
  });
});

describe('answers to a question', () => {
  it('reads yes and no as people type them', () => {
    for (const t of [
      'yes',
      'Yes!',
      'y',
      'yep',
      'go ahead',
      'do it',
      '👍',
      'yes please',
    ]) {
      expect(isYes(t)).toBe(true);
    }
    for (const t of [
      'no',
      'nope',
      'cancel',
      'leave it',
      'never mind',
      '👎',
      "don't",
      // A phone keyboard types a curly apostrophe.
      'don’t',
    ]) {
      expect(isNo(t)).toBe(true);
    }
    // A qualified yes is not a yes: it goes to the agent, and the question
    // lapses, so "yes but not @x" cannot run the unqualified version.
    expect(isYes('yes but not @x')).toBe(false);
    expect(isYes('what does that mean')).toBe(false);
  });

  it('reads a thumb in any skin tone, or with the emoji selector', () => {
    // A keyboard set to a skin tone sends one on every thumbs-up.
    for (const t of ['👍🏽', '👍🏻', '👍\u{FE0F}', '👌🏿', '✅\u{FE0F}']) {
      expect(isYes(t)).toBe(true);
    }
    for (const t of ['👎🏾', '👎\u{FE0F}']) expect(isNo(t)).toBe(true);
    expect(isNo('👍🏽')).toBe(false);
    expect(bareEmoji('👍🏽')).toBe('👍');
    expect(bareEmoji('👎\u{FE0F}')).toBe('👎');
    expect(bareEmoji(undefined)).toBe('');
  });
});

describe("a card's words", () => {
  const keys = ['author', 'likers', 'unknowns', 'everyone', 'hostile'];

  it('takes one or several, in the order typed, with synonyms', () => {
    expect(parseCardWords('likers', keys)).toEqual(['likers']);
    expect(parseCardWords('author and likers', keys)).toEqual([
      'author',
      'likers',
    ]);
    expect(parseCardWords('the randos, toxic ones', [...keys])).toBe(null);
    expect(parseCardWords('unknown + hostile', keys)).toEqual([
      'unknowns',
      'hostile',
    ]);
  });

  it('is not an answer if any word is not one of them', () => {
    expect(parseCardWords('block the author', keys)).toBe(null);
    expect(parseCardWords('likers', ['author'])).toBe(null);
  });
});

describe('memory commands', () => {
  it("keeps the owner's words, and reads questions as questions", () => {
    expect(
      parseMemoryCommand('remember: never block people who only liked'),
    ).toEqual({
      action: 'remember',
      text: 'never block people who only liked',
    });
    expect(parseMemoryCommand('remember that CONNECTED means ask me')).toEqual({
      action: 'remember',
      text: 'CONNECTED means ask me',
    });
    expect(parseMemoryCommand('remember when we blocked them?')).toBe(null);
    expect(parseMemoryCommand('forget 2')).toEqual({
      action: 'forget',
      index: 2,
      text: null,
    });
    expect(parseMemoryCommand('forget about the likers thing')).toEqual({
      action: 'forget',
      index: null,
      text: 'the likers thing',
    });
    expect(parseMemoryCommand('what do you remember?')).toEqual({
      action: 'recall',
    });
    expect(parseMemoryCommand('remembering is hard')).toBe(null);
  });

  it('does not read "forget that" as a note to drop', () => {
    // It means "never mind". Read as a search, "that" would match a note such
    // as "never block accounts that only liked" and remove it.
    for (const t of [
      'forget that',
      'forget this.',
      'forget it!',
      'forget about it',
      'forget that one',
      'forget all of it',
      'forget everything',
    ]) {
      expect(parseMemoryCommand(t)).toBe(null);
    }
    expect(parseMemoryCommand('forget that likers note')).toEqual({
      action: 'forget',
      index: null,
      text: 'likers note',
    });
  });

  it('does not save "remember this" as a note', () => {
    // It means keep this post or person in mind, which is the agent's.
    // Saved, "this" would be listed in every later turn's prompt.
    for (const t of [
      'remember this',
      'remember this.',
      'remember that',
      'remember that!',
      'remember him',
      'remember this post',
      'remember that post',
      'remember this one',
      'remember this guy',
    ]) {
      expect(parseMemoryCommand(t), t).toBe(null);
    }
    expect(parseMemoryCommand('remember this: skip likers')).toEqual({
      action: 'remember',
      text: 'this: skip likers',
    });
    // A colon makes a note whatever it holds.
    expect(parseMemoryCommand('remember: this')).toEqual({
      action: 'remember',
      text: 'this',
    });
  });

  it('leaves a question with an instruction after it to the agent', () => {
    expect(
      parseMemoryCommand('remember the post I sent earlier? add the quoters'),
    ).toBe(null);
    // With a colon it is plainly a note, question mark or not.
    expect(
      parseMemoryCommand('remember: ignore anyone who only replies "why?"'),
    ).toEqual({
      action: 'remember',
      text: 'ignore anyone who only replies "why?"',
    });
  });
});

describe('watch commands', () => {
  it('reads a window and whether to block, and nothing else', () => {
    expect(parseWatchCommand('watch this', { embedUri: POST })).toEqual({
      action: 'watch',
      target: POST,
      hours: 24,
      auto: false,
    });
    expect(
      parseWatchCommand('watch this for 2 days and block the hostile ones', {
        embedUri: POST,
      }),
    ).toMatchObject({ hours: 48, auto: true });
    expect(parseWatchCommand('keep an eye on this for 12h')).toMatchObject({
      hours: 12,
      auto: false,
    });
    expect(parseWatchCommand('stop watching')).toEqual({
      action: 'unwatch',
      target: null,
    });
    expect(parseWatchCommand('what are you watching?')).toEqual({
      action: 'watches',
    });
    // Saying not to block names the verb too, and must not turn blocking on.
    for (const text of [
      "watch this but don't block anyone",
      'watch this, do not block them',
      'watch this but not automatically',
      "watch this, I don't want you to block anyone",
      'watch this but won’t add them',
    ]) {
      expect(parseWatchCommand(text, { embedUri: POST }), text).toMatchObject({
        action: 'watch',
        auto: false,
      });
    }
    // A negation in another clause leaves the request to block alone.
    expect(
      parseWatchCommand('watch this, not sure how long, block the hostile ones', {
        embedUri: POST,
      }),
    ).toMatchObject({ auto: true });
    // A warning with a post attached is not a request to watch it.
    expect(
      parseWatchCommand('watch out, this one is nasty', { embedUri: POST }),
    ).toBe(null);
  });

  it('watches only a post, never a list or a feed', () => {
    const list = 'at://did:plc:abc/app.bsky.graph.list/3abc';
    expect(parseWatchCommand(`watch ${list}`)).toMatchObject({
      action: 'watch',
      target: null,
    });
    expect(
      parseWatchCommand('watch this', { embedUri: list }),
    ).toMatchObject({ action: 'watch', target: null });
  });

  it('keeps a list or a feed named in "stop watching", so no watch matches it', () => {
    // A null target stops the newest watch, which is not what was named.
    const list = 'at://did:plc:abc/app.bsky.graph.list/3abc';
    const feed = 'at://did:plc:abc/app.bsky.feed.generator/hot';
    expect(parseWatchCommand(`stop watching ${list}`)).toEqual({
      action: 'unwatch',
      target: list,
    });
    expect(
      parseWatchCommand('stop watching', { links: [`${feed}`] }),
    ).toEqual({ action: 'unwatch', target: feed });
    expect(parseWatchCommand('unwatch this', { embedUri: list })).toEqual({
      action: 'unwatch',
      target: list,
    });
    expect(parseWatchCommand(`stop watching ${POST}`)).toEqual({
      action: 'unwatch',
      target: POST,
    });
  });
});

describe('approving by what people did', () => {
  it('reads an engagement kind on approve', () => {
    expect(parseCommand('approve 1c2d3e4f likers')).toMatchObject({
      action: 'approve',
      code: '1c2d3e4f',
      bands: [],
      kinds: ['likers'],
    });
    expect(parseCommand('approve 1c2d3e4f UNKNOWN')).toMatchObject({
      kinds: [],
    });
  });
});
