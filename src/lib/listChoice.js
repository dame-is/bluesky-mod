// Which list a command names, read from the owner's own words. No model, no
// network: the parsers in command.js call this, and the registry
// (src/bot/lists.js) decides at run time which of the bot's lists a word
// means.
//
// MULTI-LIST MODE ONLY. With MOD_MULTI_LIST off there is one list and nothing
// here is read, so a message parses exactly as it did before the mode existed:
// "block @x to spam" is still two words too many and is asked back.
//
// Two ways to name a list:
//
//   list:<word>        the canonical token. Every menu this codebase builds
//                      writes `list:<rkey>`, so an option re-parses to the
//                      same list whatever the lists are called by then.
//   to|on|onto|into <word>
//                      the way a person types it, and only as the last two
//                      words, so it is never confused with a target: "block
//                      @x to spam", "approve 1c2d3e4f UNKNOWN on 2".
//
// The word is carried as typed. A word that names no list is not guessed at:
// the command is not run, and the owner is asked which list they meant.

/** Is multi-list mode on? Read at call time, so a test can turn it on. */
export function multiListOn(env = process.env) {
  const v = String(env.MOD_MULTI_LIST ?? '')
    .trim()
    .toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

const TOKEN = /^list[:=](\S+)$/i;
const PREPOSITION = /^(to|on|onto|into)$/i;
/**
 * A word that can name a list: a number, or a name typed without spaces.
 * Never a handle, a DID or a link, which hold a dot or a colon.
 */
const LIST_WORD = /^[\p{L}\p{N}_-]{1,40}$/u;

/** A word without the punctuation a sentence leaves on it. */
const bare = (word) => String(word ?? '').replace(/[),.?!:;]+$/, '');

/**
 * The text without the list it names, and the list as typed.
 *
 * `conflict` is set when the text names two different lists with the
 * canonical token, which is refused rather than settled by order.
 *
 * @returns {{ text: string, list: string|null, conflict: boolean }}
 */
export function splitListChoice(text) {
  const words = String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const named = [];
  const kept = [];
  for (const w of words) {
    const m = TOKEN.exec(bare(w));
    if (m) named.push(m[1]);
    else kept.push(w);
  }
  const distinct = [...new Set(named.map((n) => n.toLowerCase()))];
  if (distinct.length > 1) {
    return { text: kept.join(' '), list: null, conflict: true };
  }
  if (named.length) {
    return { text: kept.join(' '), list: named[0], conflict: false };
  }
  // "... to spam": the last two words only.
  if (kept.length >= 3) {
    const prep = kept[kept.length - 2];
    const word = bare(kept[kept.length - 1]);
    if (PREPOSITION.test(prep) && LIST_WORD.test(word)) {
      return {
        text: kept.slice(0, -2).join(' '),
        list: word,
        conflict: false,
      };
    }
  }
  return { text: kept.join(' '), list: null, conflict: false };
}

/** The text with any list it names taken out. */
export const withoutListChoice = (text) => splitListChoice(text).text;

/**
 * A command string with `list:<key>` on the end, in place of any list it
 * named. What every "Which list?" option runs.
 */
export function withListToken(command, key) {
  return `${withoutListChoice(command)} list:${key}`;
}

/** The list a command string names with the canonical token, or null. */
export function listTokenOf(command) {
  const { list, conflict } = splitListChoice(command);
  return conflict ? null : list;
}
