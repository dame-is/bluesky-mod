import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  select: vi.fn(async () => []),
  upsert: vi.fn(async () => 0),
}));

const {
  renderCard,
  cardChoices,
  summaryText,
  noteQuiet,
  takeDueSummaries,
  resetQuiet,
  confirmLine,
  readPending,
  react,
  settle,
} = await import('./chatUx.js');
const { select } = await import('./db.js');

const PLAN = {
  code: '1c2d3e4f',
  uri: 'at://did:plc:author/app.bsky.feed.post/3abc',
  total: 34,
  withText: 19,
  byBand: {
    UNKNOWN: 28,
    PERIPHERAL: 4,
    NOTABLE: 0,
    CONNECTED: 1,
    PROTECTED: 1,
  },
  engagements: { like: 12, repost: 3, quote: 5, reply: 14 },
  alreadyListed: 5,
  blocksYou: 3,
  author: {
    did: 'did:plc:author',
    handle: 'poster.example.social',
    band: 'UNKNOWN',
    followers: 1200,
    blocksYou: true,
    alreadyListed: false,
  },
};

/** The card words shown, the ones that run something. */
const offered = (plan) =>
  cardChoices(plan)
    .filter((o) => o.command && !o.hidden)
    .map((o) => o.key);

describe('the post card', () => {
  it('fits on a phone and answers to words', () => {
    const text = renderCard(PLAN);
    expect(text).toContain(
      '@poster.example.social (UNKNOWN, 1,200 followers, blocks you) wrote this.',
    );
    expect(text).toContain(
      '34 accounts engaged: 12 likes, 3 reposts, 5 quotes, 14 replies.',
    );
    expect(text).toContain(
      'By band: 28 unknown, 4 peripheral, 1 connected, 1 protected.',
    );
    expect(text).toContain('5 already on the list, 3 already block you.');
    expect(text).toContain(
      'Reply with: author · likers · unknowns · everyone · hostile',
    );
    expect(text.length).toBeLessThan(400);
  });

  it('says what it could not read, or that the read was cut short', () => {
    expect(renderCard(PLAN)).not.toContain('part of the post');
    expect(
      renderCard({
        ...PLAN,
        truncated: true,
        unread: [
          { kind: 'like', count: 900 },
          { kind: 'other', count: 1 },
        ],
      }),
    ).toContain(
      'Could not read 900 likes, 1 other engagement, so these counts cover part of the post. Send it again to retry.',
    );
    expect(renderCard({ ...PLAN, truncated: true, unread: [] })).toContain(
      'Not every engagement was read, so these counts cover part of the post.',
    );
  });

  it('never says nobody engaged when what there was could not be read', () => {
    const empty = { ...PLAN, total: 0, engagements: {}, byBand: {} };
    const unread = renderCard({
      ...empty,
      truncated: true,
      unread: [{ kind: 'like', count: 900 }],
    });
    expect(unread).toContain('Could not read 900 likes. Send it again to retry.');
    expect(unread).not.toContain('Nobody has engaged');
    const cut = renderCard({ ...empty, truncated: true, unread: [] });
    expect(cut).toContain('Nobody found so far, and not every engagement was read.');
    expect(cut).not.toContain('retry');
    expect(cut).not.toContain('Nobody has engaged');
    expect(renderCard(empty)).toContain('Nobody has engaged with it yet.');
  });

  it('counts a direct reply once', () => {
    // A direct reply to a first post links to it as parent and as root.
    const text = renderCard({
      ...PLAN,
      engagements: { reply: 3, threadReply: 5 },
    });
    expect(text).toContain('34 accounts engaged: 5 replies.');
  });

  it('offers only what would do something', () => {
    const quiet = {
      ...PLAN,
      withText: 0,
      engagements: { like: 4 },
      byBand: { UNKNOWN: 4 },
      author: { ...PLAN.author, alreadyListed: true },
    };
    // The author is already listed, nobody wrote anything, and "everyone"
    // would be the same as "unknowns".
    expect(offered(quiet)).toEqual(['likers', 'unknowns']);
    expect(renderCard(quiet)).toContain('Reply with: likers · unknowns');
    // The rest are still understood: the reason it is not done, or the same
    // command under another word.
    const extra = Object.fromEntries(
      cardChoices(quiet)
        .filter((o) => !o.command || o.hidden)
        .map((o) => [o.key, o.unavailable ?? o.command]),
    );
    expect(extra).toEqual({
      author: 'already on the list',
      everyone: 'approve 1c2d3e4f UNKNOWN',
      hostile: 'no replies or quotes with words to read',
    });
    expect(cardChoices(PLAN).find((o) => o.key === 'likers').command).toBe(
      'approve 1c2d3e4f likers',
    );
    expect(cardChoices(PLAN).find((o) => o.key === 'everyone').command).toBe(
      'approve 1c2d3e4f UNKNOWN,PERIPHERAL,CONNECTED',
    );
    expect(renderCard(PLAN, { choices: [] })).not.toContain('Reply with');
  });

  it("writes the author by DID, and names them by handle while it verifies", () => {
    // A card is answered up to 30 minutes later, and a handle resolved then
    // can belong to someone else.
    expect(cardChoices(PLAN).find((o) => o.key === 'author')).toMatchObject({
      label: 'Add the author @poster.example.social',
      command: 'list add did:plc:author',
    });
    for (const handle of [null, 'handle.invalid']) {
      const p = { ...PLAN, author: { ...PLAN.author, handle } };
      expect(cardChoices(p).find((o) => o.key === 'author')).toMatchObject({
        label: 'Add the author did:plc:author',
        command: 'list add did:plc:author',
      });
    }
  });

  it('never offers to add a PROTECTED author', () => {
    const p = {
      ...PLAN,
      author: { ...PLAN.author, protectedReason: 'you follow them' },
    };
    expect(offered(p)).not.toContain('author');
    expect(cardChoices(p).find((o) => o.key === 'author')).toEqual({
      key: 'author',
      unavailable: 'protected (you follow them), so not added',
    });
  });
});

describe('the burst summary', () => {
  beforeEach(() => resetQuiet());

  it('waits for a quiet minute, and skips a burst of one', () => {
    noteQuiet('c1', { action: 'list_add', handle: 'a.test' }, 0);
    noteQuiet('c2', { action: 'list_add', handle: 'b.test' }, 0);
    noteQuiet('c2', { action: 'list_add', handle: 'c.test' }, 30_000);
    expect(takeDueSummaries({ now: 60_000 })).toEqual([]);
    const due = takeDueSummaries({ now: 95_000 });
    expect(due.map((d) => d.convoId)).toEqual(['c2']);
    // c1 was taken too, and dropped: its ✅ said everything.
    expect(takeDueSummaries({ now: 999_999 })).toEqual([]);
  });

  it('says who, what was already there, and who already blocks you', () => {
    const text = summaryText({
      firstAt: 0,
      lastAt: 20 * 60_000,
      items: [
        { action: 'list_add', handle: 'a.test', blocksYou: true },
        { action: 'list_add', handle: 'b.test' },
        { action: 'list_add', handle: 'c.test', already: true },
        { action: 'list_remove', handle: 'd.test' },
      ],
    });
    expect(text).toContain('Blocked 2 in the last 20 min: @a.test, @b.test.');
    expect(text).toContain('1 was already on the list: @c.test.');
    expect(text).toContain('Unblocked 1: @d.test.');
    expect(text).toContain('1 of them already blocks you');
    expect(text).toContain('"unblock @handle" takes one back.');
  });
});

describe('confirmations and reactions', () => {
  it('says exactly what a thumbs-up will do', () => {
    expect(confirmLine(['add @a.test to the list'])).toBe(
      '👍 or "yes" to: add @a.test to the list',
    );
    expect(confirmLine(['x', 'y'])).toBe(
      '👍 or "yes" to do all of this:\n1. x\n2. y',
    );
    expect(confirmLine([])).toBe('');
  });

  it('treats a question with no readable time as expired', async () => {
    const commands = ['list add @a.test'];
    select.mockResolvedValueOnce([{ pending: { commands } }]);
    expect(await readPending('c')).toBe(null);
    select.mockResolvedValueOnce([
      { pending: { commands, created_at: new Date().toISOString() } },
    ]);
    expect(await readPending('c')).toMatchObject({ commands });
  });

  it('treats a question dated well ahead of the clock as expired', async () => {
    // Stored while the clock ran fast; it would stay live for a year.
    const commands = ['list add @a.test'];
    const at = (ms) => new Date(Date.now() + ms).toISOString();
    select.mockResolvedValueOnce([
      { pending: { commands, created_at: at(365 * 86_400_000) } },
    ]);
    expect(await readPending('c')).toBe(null);
    select.mockResolvedValueOnce([
      { pending: { commands, created_at: at(60_000) } },
    ]);
    expect(await readPending('c')).toMatchObject({ commands });
  });

  it('never throws over a reaction', async () => {
    const chat = {
      chat: {
        bsky: {
          convo: {
            addReaction: vi
              .fn()
              .mockRejectedValue(new Error('ReactionLimitReached')),
            removeReaction: vi.fn(async () => ({})),
          },
        },
      },
    };
    expect(await react(chat, 'c', 'm', '👀')).toBe(false);
    expect(await react({}, 'c', 'm', '👀')).toBe(false);
    await settle(chat, 'c', 'm', 'done');
    expect(chat.chat.bsky.convo.removeReaction).toHaveBeenCalledWith({
      convoId: 'c',
      messageId: 'm',
      value: '👀',
    });
    expect(chat.chat.bsky.convo.addReaction).toHaveBeenLastCalledWith({
      convoId: 'c',
      messageId: 'm',
      value: '✅',
    });
  });
});

describe('a card on a post mostly dealt with already', () => {
  it('offers only what would add someone new', () => {
    const plan = {
      ...PLAN,
      author: { ...PLAN.author, alreadyListed: true },
      fresh: {
        total: 1,
        byBand: {
          UNKNOWN: 0,
          PERIPHERAL: 0,
          NOTABLE: 0,
          CONNECTED: 1,
          PROTECTED: 0,
        },
        likers: 0,
      },
    };
    // All but one CONNECTED account are on the list: no likers, no unknowns,
    // and "everyone" means that one account.
    expect(offered(plan)).toEqual(['everyone', 'hostile']);
    expect(cardChoices(plan)[0].command).toBe('approve 1c2d3e4f CONNECTED');
  });
});
