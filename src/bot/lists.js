// The lists the bot writes to, in multi-list mode (MOD_MULTI_LIST=true).
//
// THE BOT'S REPO IS THE REGISTRY. Every moderation list in the bot account's
// own repo is a list the owner can choose, and nothing else is: a list made
// from a client signed in as the bot shows up here within minutes, and a list
// in anyone else's repo can never be written, because the bot can only write
// to its own repo. No setting names them.
//
// NUMBERS STAY PUT. MOD_LIST_URI is always 1, the primary list: the one the
// weekly re-score reads, and the one every plan written before this mode
// existed went to. The rest follow in the order they were made, so "2" means
// the same list today as it did last week unless a list is deleted.
//
// With the mode off there is one list, MOD_LIST_URI, and nothing asks which.

import { fetchWithTimeout, resolvePds } from '../lib/atproto.js';
import { multiListOn } from '../lib/listChoice.js';
import { listUri, ownerOf } from './listWrite.js';

export { multiListOn };

const MODLIST = 'app.bsky.graph.defs#modlist';
const LIST_COLLECTION = 'app.bsky.graph.list';

/**
 * How long the lists read from the repo are reused. `lists` and `new list`
 * read them afresh; a list made elsewhere is seen within this.
 */
const TTL_MS = 10 * 60_000;
/** listRecords pages read: 1,000 lists, far past any owner's. */
const MAX_PAGES = 10;
/** The longest name `new list` takes. Bluesky allows 64 characters. */
export const MAX_NAME = 64;

const rkeyOf = (uri) => String(uri ?? '').split('/').pop();

/**
 * A name as it is compared: case, spaces, hyphens and underscores ignored, so
 * "Block List", "block-list" and "blocklist" are the same list.
 */
export const nameKey = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[\s\-_.'"’]+/g, '');

/**
 * Read the list records in the bot's repo from its PDS. Unauthenticated, as
 * graphFacts.js walks the list, so a caller with no session can still say
 * which lists there are.
 */
async function readFromPds(bot) {
  const pds = await resolvePds(bot);
  const records = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const q = new URLSearchParams({
      repo: bot,
      collection: LIST_COLLECTION,
      limit: '100',
    });
    if (cursor) q.set('cursor', cursor);
    const res = await fetchWithTimeout(
      `${pds}/xrpc/com.atproto.repo.listRecords?${q}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) throw new Error(`listRecords failed: ${res.status}`);
    const body = await res.json();
    records.push(...(body.records || []));
    cursor = body.cursor;
    if (!cursor || !(body.records || []).length) break;
  }
  return records;
}

let reader = readFromPds;
let cache = null; // { at, lists }

/** For tests: read list records from here instead of the bot's PDS. */
export function setListReader(fn) {
  reader = fn || readFromPds;
  cache = null;
}

/** Forget the held lists, so the next read goes to the repo. */
export function resetLists() {
  cache = null;
}

/**
 * The primary first, then the rest by when they were made. Records that are
 * not moderation lists, or not in the bot's repo, are left out.
 */
function order(records, primary) {
  const bot = ownerOf(primary);
  const mine = records
    .filter(
      (r) =>
        r?.value?.purpose === MODLIST &&
        ownerOf(r.uri) === bot &&
        String(r.uri).includes(`/${LIST_COLLECTION}/`),
    )
    .map((r) => ({
      uri: r.uri,
      rkey: rkeyOf(r.uri),
      name: String(r.value?.name || '').trim() || 'untitled',
      createdAt: String(r.value?.createdAt || ''),
    }));
  const first = mine.find((l) => l.uri === primary) || {
    uri: primary,
    rkey: rkeyOf(primary),
    name: 'main list',
    createdAt: '',
  };
  const rest = mine
    .filter((l) => l.uri !== primary)
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.rkey.localeCompare(b.rkey),
    );
  return [first, ...rest].map((l, i) => ({ ...l, n: i + 1 }));
}

/**
 * The lists a write may go to, numbered from 1.
 *
 * With multi-list mode off, only MOD_LIST_URI. With it on, every moderation
 * list in the bot's repo. A read that fails falls back to what was read last;
 * with nothing read yet it throws, because guessing the primary list for a
 * write the owner meant for another is the mistake this mode exists to
 * prevent.
 *
 * @param {{ refresh?: boolean, now?: number }} [opts]
 * @returns {Promise<Array<{ uri: string, rkey: string, name: string, n: number }>>}
 */
export async function botLists({ refresh = false, now = Date.now() } = {}) {
  const primary = listUri();
  if (!multiListOn()) {
    return [{ uri: primary, rkey: rkeyOf(primary), name: 'the list', n: 1 }];
  }
  if (!refresh && cache && now - cache.at < TTL_MS) return cache.lists;
  try {
    const lists = order(await reader(ownerOf(primary)), primary);
    cache = { at: now, lists };
    return lists;
  } catch (err) {
    if (cache) return cache.lists;
    throw new Error(
      `I could not read your lists (${String(err?.message || err).slice(0, 120)}), so I changed nothing`,
    );
  }
}

/**
 * The URIs of every list, for a read that only reports ("on one of your
 * lists"). Never throws: a read that fails reports on the primary list.
 */
export async function listUris() {
  try {
    return (await botLists()).map((l) => l.uri);
  } catch {
    return [listUri()];
  }
}

/** The list held for this URI, from the last read, or null. */
export function heldList(uri) {
  const lists = cache?.lists || [];
  return lists.find((l) => l.uri === uri) || null;
}

/** A list's name for a reply, from the last read. */
export function listName(uri) {
  if (!multiListOn()) return 'the list';
  return heldList(uri)?.name || (uri === listUri() ? 'your main list' : 'that list');
}

/**
 * The list a typed word means.
 *
 *   a number      that list's place (1 is the primary)
 *   an rkey       exactly, which is what menus write
 *   "all"         every list, where the caller allows it (unblock)
 *   a name        case, spaces and hyphens ignored; a unique start of one
 *                 name counts ("block" for "Block List")
 *
 * @returns {{ list?: object, all?: true, error?: string }}
 */
export function resolveList(word, lists, { allowAll = false } = {}) {
  const raw = String(word ?? '').trim();
  if (!raw) return { error: 'Name a list.' };
  if (allowAll && /^(all|every|everywhere|both)$/i.test(raw)) {
    return { all: true };
  }
  if (/^\d{1,3}$/.test(raw)) {
    const n = Number(raw);
    const list = lists.find((l) => l.n === n);
    return list
      ? { list }
      : { error: `There is no list ${n}; you have ${lists.length}.` };
  }
  const byKey = lists.find((l) => l.rkey === raw);
  if (byKey) return { list: byKey };
  const key = nameKey(raw);
  if (!key) return { error: `I don't have a list called "${raw.slice(0, 40)}".` };
  const exact = lists.filter((l) => nameKey(l.name) === key);
  if (exact.length === 1) return { list: exact[0] };
  const starts = lists.filter((l) => nameKey(l.name).startsWith(key));
  if (exact.length > 1 || starts.length > 1) {
    return {
      error: `"${raw.slice(0, 40)}" could be more than one of your lists.`,
    };
  }
  if (starts.length === 1) return { list: starts[0] };
  return { error: `I don't have a list called "${raw.slice(0, 40)}".` };
}

/** The lists as a numbered block, for "lists" and for a refusal. */
export function listsText(lists) {
  return lists
    .map((l) => `${l.n}. ${l.name}${l.n === 1 ? ' (main)' : ''}`)
    .join('\n');
}

/**
 * The "Which list?" menu: one option per list, each running `commandsFor`
 * the list. `commands` holds every command an option runs; `command` is the
 * first, which is what the gate for read-only senders reads.
 *
 * @param {Array} lists
 * @param {(list: object) => string[]} commandsFor
 * @param {{ all?: string[] }} [opts] an extra option for every list at once
 */
export function listMenu(lists, commandsFor, { all = null } = {}) {
  const options = lists.map((l) => {
    const commands = commandsFor(l);
    return { label: l.name, command: commands[0], commands };
  });
  if (all?.length) {
    options.push({ label: 'Every list', command: all[0], commands: all });
  }
  return options;
}

/**
 * Make a moderation list on the bot's account. A name already in use, with
 * case and spacing ignored, is refused: two lists the owner cannot tell apart
 * by name are two lists a word cannot choose between.
 *
 * @returns {Promise<{ ok: boolean, message: string, list?: object }>}
 */
export async function createList(agent, name) {
  const clean = String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  if (!clean) {
    return { ok: false, message: 'Give the list a name: "new list Spam".' };
  }
  if (clean.length > MAX_NAME) {
    return {
      ok: false,
      message: `That name is ${clean.length} characters; a list name can be at most ${MAX_NAME}.`,
    };
  }
  if (/^\d+$/.test(clean) || /^(all|every|everywhere|both)$/i.test(clean)) {
    return {
      ok: false,
      message: `"${clean}" would read as a list number or as every list. Pick another name.`,
    };
  }
  const bot = agent?.session?.did;
  if (!bot || bot !== ownerOf(listUri())) {
    return {
      ok: false,
      message: 'MOD_LIST_URI is not a list this account owns, so I cannot make lists beside it.',
    };
  }
  const lists = await botLists({ refresh: true });
  const taken = lists.find((l) => nameKey(l.name) === nameKey(clean));
  if (taken) {
    return {
      ok: false,
      message: `You already have a list called "${taken.name}" (number ${taken.n}).`,
      list: taken,
    };
  }
  const created = await agent.com.atproto.repo.createRecord({
    repo: bot,
    collection: LIST_COLLECTION,
    record: {
      $type: LIST_COLLECTION,
      purpose: MODLIST,
      name: clean,
      createdAt: new Date().toISOString(),
    },
  });
  const uri = created?.data?.uri;
  // Read again so the new list takes its number. A read that lags the write
  // still gets it, last.
  cache = null;
  let fresh = await botLists({ refresh: true }).catch(() => lists);
  if (uri && !fresh.some((l) => l.uri === uri)) {
    fresh = [
      ...fresh,
      { uri, rkey: rkeyOf(uri), name: clean, createdAt: '', n: fresh.length + 1 },
    ];
    cache = { at: Date.now(), lists: fresh };
  }
  const list = fresh.find((l) => l.uri === uri) || null;
  const rkey = rkeyOf(uri);
  return {
    ok: true,
    list,
    message:
      `Made a list called "${clean}"${list ? `, number ${list.n}` : ''}. ` +
      'Subscribe to it from your own account to have it take effect: ' +
      `https://bsky.app/profile/${bot}/lists/${rkey}`,
    link: `https://bsky.app/profile/${bot}/lists/${rkey}`,
  };
}
