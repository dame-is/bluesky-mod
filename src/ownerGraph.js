// The owner's own follows and curation lists, kept current between snapshots.
//
// The weekly snapshot is what PROTECTED is built from, so without this someone
// the owner added to a curation list on Monday could be blocked until Sunday.
// The write-time veto asks the AppView about follows, but nothing asks about
// list membership. So the bot subscribes to the owner's own repo on Jetstream
// for new follows and list items, and protects their subjects at once.
//
// ONLY ADDS. A Jetstream delete carries no record, so an unfollow or a removal
// from a list says nothing about who it was. Protection stays until the next
// snapshot rebuilds the set, which is the safe direction to be wrong in.
//
// Rows written here are marked `live`, apart from the snapshot's `derived`
// ones, so a row that arrives before the first snapshot cannot make the write
// gate believe the protected set is built (listWrite.js).

import { select, upsert } from './bot/db.js';
import { isDid } from './lib/target.js';
import { fetchWithTimeout } from './lib/atproto.js';
import { APPVIEW } from './constants.js';

export const OWNER_GRAPH_COLLECTIONS = [
  'app.bsky.graph.follow',
  'app.bsky.graph.listitem',
];

const CURATELIST = 'app.bsky.graph.defs#curatelist';

/**
 * Is this list one whose members are protected, and what is it called? A list
 * that cannot be read counts as one: protecting someone a little too long is
 * the safe mistake, and the next snapshot corrects it.
 */
async function readList(uri, { fetchImpl = fetchWithTimeout } = {}) {
  try {
    const res = await fetchImpl(
      `${APPVIEW}/xrpc/app.bsky.graph.getList?list=${encodeURIComponent(uri)}&limit=1`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return { curation: true, name: 'a list that could not be read' };
    const list = (await res.json())?.list;
    return {
      curation: list?.purpose === CURATELIST,
      name: list?.name || 'untitled',
    };
  } catch {
    return { curation: true, name: 'a list that could not be read' };
  }
}

/**
 * The Jetstream handler. `excluded` are curation lists whose members are not
 * protected (MOD_UNPROTECTED_LISTS); `onProtect` is told when a row is added,
 * so a held copy of the scoring reference can be dropped.
 */
export function ownerGraphHandler({
  ownerDid,
  excluded = [],
  onProtect = () => {},
  log = () => {},
  fetchImpl,
}) {
  const skip = new Set(excluded);
  const lists = new Map();

  async function listInfo(uri) {
    if (!lists.has(uri)) lists.set(uri, await readList(uri, { fetchImpl }));
    return lists.get(uri);
  }

  return async function onEvent(event) {
    if (event?.kind !== 'commit' || event.did !== ownerDid) return;
    const c = event.commit;
    if (c?.operation !== 'create') return;
    const subject = c.record?.subject;
    let reason = null;
    if (c.collection === 'app.bsky.graph.follow') {
      reason = 'you follow them';
    } else if (c.collection === 'app.bsky.graph.listitem') {
      const list = String(c.record?.list || '');
      if (!list.startsWith(`at://${ownerDid}/`) || skip.has(list)) return;
      const info = await listInfo(list);
      if (!info.curation) return;
      reason = `list:${info.name}`;
    } else {
      return;
    }
    if (!isDid(subject) || subject === ownerDid) return;

    // A row already there, by hand or from the snapshot, keeps its source:
    // marked live, a hand-added row would be cleared by the next snapshot.
    const existing = await select('protected', {
      select: 'did',
      eq: { did: subject },
      limit: 1,
    });
    if (existing?.length) return;
    await upsert('protected', [{ did: subject, reason, source: 'live' }]);
    onProtect(subject);
    log('Protected an account the owner just added', { did: subject, reason });
  };
}
