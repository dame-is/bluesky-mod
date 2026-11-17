// Notes the owner or a writer asked the bot to remember, from the chat.
//
// The standing instructions in the config file (see agentConfig.js) are
// read-only to the bot, so a leaked bot password cannot rewrite the rules it
// runs under. These notes are the layer the chat can write, and only from a
// writer's literal words ("remember: never block people who only liked"),
// parsed by parseMemoryCommand. The model never writes one: a note is an
// instruction read on every turn, and a post the agent read could otherwise
// talk it into saving one.
//
// Each note keeps who wrote it, and a writer's note is shown to the model as
// that writer's, so it cannot pass for the owner's own.
//
// A forgotten note is stamped `removed_at`, not deleted.

import { OWNER_DID } from '../constants.js';
import { select, upsert, update } from './db.js';

/** Enough to be standing guidance, not enough to be a second system prompt. */
export const MAX_NOTES = 30;
const MAX_NOTE_CHARS = 500;

/** The live notes, oldest first, so their numbers stay put as notes are added. */
export async function listNotes() {
  const rows = await select('memory', {
    select: 'id,text,created_at,author_did',
    is: { removed_at: 'null' },
    order: 'created_at.asc',
    limit: MAX_NOTES,
  });
  return rows || [];
}

/** A note the owner wrote, or one saved with no author. */
const byOwner = (note, owner) => !note.author_did || note.author_did === owner;

/** A writer's note, marked as theirs. The owner's read as they are. */
const marked = (note, owner) =>
  byOwner(note, owner)
    ? note.text
    : `(from writer ${note.author_did}) ${note.text}`;

/** Keep a note in its writer's words. `author` is the sender's DID. */
export async function remember(text, { author } = {}) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NOTE_CHARS);
  if (!clean) return { ok: false, message: 'Remember what?' };
  const notes = await listNotes();
  if (notes.some((n) => n.text.toLowerCase() === clean.toLowerCase())) {
    return { ok: true, message: `I already had that one: "${clean}"` };
  }
  if (notes.length >= MAX_NOTES) {
    return {
      ok: false,
      message: `I'm holding ${MAX_NOTES} notes already. "forget <number>" one first; "what do you remember" lists them.`,
    };
  }
  await upsert('memory', [{ text: clean, author_did: author ?? null }]);
  return {
    ok: true,
    message: `Noted, and I'll keep to it: "${clean}". "what do you remember" lists everything; "forget ${notes.length + 1}" drops this one.`,
  };
}

/** Matches `words` as whole words, in any letter case. */
function wholeWords(words) {
  const escaped = words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
    'iu',
  );
}

/**
 * Forget by the number "what do you remember" showed, or by matching words.
 * Words match whole, so "forget cat" leaves a note about categories alone.
 */
export async function forget({ index = null, text = null } = {}) {
  const notes = await listNotes();
  let note = null;
  if (index != null) note = notes[index - 1] ?? null;
  else if (text) {
    const needle = text.replace(/\s+/g, ' ').trim().toLowerCase();
    const match = needle ? wholeWords(needle) : null;
    const hits = match ? notes.filter((n) => match.test(n.text)) : [];
    // A note that matches word for word wins over others that contain it.
    const exact = hits.find((n) => n.text.toLowerCase() === needle);
    if (!exact && hits.length > 1) {
      return {
        ok: false,
        message: `That matches ${hits.length} notes. "forget <number>" picks one; "what do you remember" numbers them.`,
      };
    }
    note = exact ?? hits[0] ?? null;
  }
  if (!note) return { ok: false, message: "I don't have a note like that." };
  await update(
    'memory',
    { eq: { id: note.id } },
    { removed_at: new Date().toISOString() },
  );
  return { ok: true, message: `Forgotten: "${note.text}"` };
}

/** The reply to "what do you remember". */
export function recallText(notes, { owner = OWNER_DID } = {}) {
  if (!notes.length) {
    return 'Nothing yet. Start a message with "remember:" and I\'ll keep to it.';
  }
  return [
    'What you asked me to remember:',
    ...notes.map((n, i) => `${i + 1}. ${marked(n, owner)}`),
    '',
    '"forget <number>" drops one.',
  ].join('\n');
}

/**
 * The notes as a prompt block, or '' when there are none. The owner's notes
 * and a writer's go under separate headings, and each writer's note names
 * them, so the model never reads a writer's words as the owner's.
 */
export function notesBlock(notes, { owner = OWNER_DID } = {}) {
  if (!notes?.length) return '';
  const own = notes.filter((n) => byOwner(n, owner));
  const others = notes.filter((n) => !byOwner(n, owner));
  const list = (rows) => rows.map((n) => `- ${marked(n, owner)}`).join('\n');
  return [
    own.length
      ? `THINGS THE OWNER ASKED YOU TO REMEMBER, in the owner's own words. Keep to them as you would the standing instructions:\n${list(own)}`
      : '',
    others.length
      ? `THINGS A WRITER ASKED YOU TO REMEMBER, in that writer's words, not the owner's:\n${list(others)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
