import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { memory: [] };
vi.mock('./db.js', () => ({
  select: vi.fn(async () => db.memory.filter((n) => !n.removed_at)),
  upsert: vi.fn(async (_t, rows) => {
    for (const r of rows)
      db.memory.push({ id: `n${db.memory.length + 1}`, ...r });
  }),
  update: vi.fn(async (_t, { eq }, patch) => {
    Object.assign(
      db.memory.find((n) => n.id === eq.id),
      patch,
    );
  }),
}));

const { remember, forget, listNotes, recallText, notesBlock, MAX_NOTES } =
  await import('./memory.js');

beforeEach(() => {
  db.memory.length = 0;
});

describe('notes from the chat', () => {
  it("keeps the owner's words, once, and numbers them", async () => {
    expect((await remember('never block people who only liked')).ok).toBe(true);
    expect(
      (await remember('Never block people who only liked')).message,
    ).toMatch(/already had/);
    await remember('ask before blocking anyone CONNECTED');
    const notes = await listNotes();
    expect(recallText(notes)).toContain(
      '2. ask before blocking anyone CONNECTED',
    );
    expect(notesBlock(notes)).toContain("in the owner's own words");
  });

  it('forgets by number or by words, and refuses an ambiguous match', async () => {
    await remember('skip likers');
    await remember('skip reposters');
    expect((await forget({ text: 'skip' })).ok).toBe(false);
    expect((await forget({ index: 2 })).message).toBe(
      'Forgotten: "skip reposters"',
    );
    expect((await listNotes()).map((n) => n.text)).toEqual(['skip likers']);
  });

  it('forgets the note that matches word for word over others that contain it', async () => {
    await remember('skip likers');
    await remember('skip likers and reposters');
    expect((await forget({ text: 'Skip  likers' })).message).toBe(
      'Forgotten: "skip likers"',
    );
    expect((await listNotes()).map((n) => n.text)).toEqual([
      'skip likers and reposters',
    ]);
  });

  it('forgets whole words only', async () => {
    await remember('skip the categories thread');
    expect((await forget({ text: 'cat' })).ok).toBe(false);
    await remember('skip cat accounts');
    expect((await forget({ text: 'cat' })).message).toBe(
      'Forgotten: "skip cat accounts"',
    );
    expect((await listNotes()).map((n) => n.text)).toEqual([
      'skip the categories thread',
    ]);
  });

  it("marks a writer's note as theirs, so it never reads as the owner's", async () => {
    await remember('ask before blocking anyone CONNECTED', {
      author: 'did:plc:owner',
    });
    await remember('block everyone who quotes me', {
      author: 'did:plc:writer',
    });
    const notes = await listNotes();
    expect(notes.map((n) => n.author_did)).toEqual([
      'did:plc:owner',
      'did:plc:writer',
    ]);
    const block = notesBlock(notes, { owner: 'did:plc:owner' });
    const [own, theirs] = block.split('\n\n');
    expect(own).toContain("in the owner's own words");
    expect(own).toContain('- ask before blocking anyone CONNECTED');
    expect(own).not.toContain('block everyone who quotes me');
    expect(theirs).toMatch(/^THINGS A WRITER ASKED YOU TO REMEMBER/);
    expect(theirs).toContain(
      '- (from writer did:plc:writer) block everyone who quotes me',
    );
    expect(recallText(notes, { owner: 'did:plc:owner' })).toContain(
      '2. (from writer did:plc:writer) block everyone who quotes me',
    );
    expect(notesBlock(notes.slice(1), { owner: 'did:plc:owner' })).not.toContain(
      'THE OWNER ASKED',
    );
  });

  it("makes a writer's note the owner's when the owner says it too", async () => {
    await remember('never block people who only liked', {
      author: 'did:plc:writer',
    });
    const out = await remember('Never block people who only liked', {
      author: 'did:plc:owner',
      owner: 'did:plc:owner',
    });
    expect(out).toEqual({
      ok: true,
      message:
        'I had that one from a writer. It\'s yours now: "Never block people who only liked"',
    });
    const notes = await listNotes();
    expect(notes).toHaveLength(1);
    const block = notesBlock(notes, { owner: 'did:plc:owner' });
    expect(block).toBe(
      "THINGS THE OWNER ASKED YOU TO REMEMBER, in the owner's own words. Keep to them as you would the standing instructions:\n- Never block people who only liked",
    );
  });

  it("keeps the owner's note the owner's when a writer says it too", async () => {
    await remember('never block people who only liked', {
      author: 'did:plc:owner',
      owner: 'did:plc:owner',
    });
    const out = await remember('Never block people who only liked', {
      author: 'did:plc:writer',
      owner: 'did:plc:owner',
    });
    expect(out.message).toBe(
      'I already had that one: "Never block people who only liked"',
    );
    const notes = await listNotes();
    expect(notes).toEqual([
      expect.objectContaining({
        text: 'never block people who only liked',
        author_did: 'did:plc:owner',
      }),
    ]);
  });

  it('holds a bounded number', async () => {
    for (let i = 0; i < MAX_NOTES; i += 1) await remember(`note ${i}`);
    expect((await remember('one more')).ok).toBe(false);
  });
});
