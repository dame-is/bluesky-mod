// What the bot sets up on its own account, at its first start or from
// `npm run setup`: incoming DMs open, so the owner can reach it without the
// bot following them, and a moderation list to write to. Everything here is
// in the BOT's repo, and running it again changes nothing.

const MODLIST = 'app.bsky.graph.defs#modlist';
const DECLARATION = 'chat.bsky.actor.declaration';

/**
 * Let anyone start a DM with the bot. It still answers only the accounts on
 * its roster. Fields already in the declaration are kept.
 *
 * @returns {Promise<'already'|'opened'>}
 */
export async function ensureDmsOpen(agent) {
  const did = agent.session?.did;
  const declaration = await agent.com.atproto.repo
    .getRecord({ repo: did, collection: DECLARATION, rkey: 'self' })
    .then((r) => r.data.value)
    .catch(() => null);
  if (declaration?.allowIncoming === 'all') return 'already';
  await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: DECLARATION,
    rkey: 'self',
    record: { ...declaration, $type: DECLARATION, allowIncoming: 'all' },
  });
  return 'opened';
}

/** The bot's moderation lists, as { uri, name }. */
export async function moderationLists(agent) {
  const res = await agent.com.atproto.repo.listRecords({
    repo: agent.session?.did,
    collection: 'app.bsky.graph.list',
    limit: 100,
  });
  return (res.data.records || [])
    .filter((r) => r.value?.purpose === MODLIST)
    .map((r) => ({ uri: r.uri, name: r.value?.name || 'untitled' }));
}

/** Create a moderation list on the bot's account. */
export async function createList(agent, name) {
  const created = await agent.com.atproto.repo.createRecord({
    repo: agent.session?.did,
    collection: 'app.bsky.graph.list',
    record: {
      $type: 'app.bsky.graph.list',
      purpose: MODLIST,
      name,
      createdAt: new Date().toISOString(),
    },
  });
  return { uri: created.data.uri, name };
}

/**
 * The list to write to when none is configured: the bot's one moderation
 * list, or a new one when it has none. With several, which one is the owner's
 * call, so this throws and names them.
 *
 * @returns {Promise<{ uri: string, name: string, created: boolean }>}
 */
export async function findOrCreateList(agent, { name = 'Block List' } = {}) {
  const lists = await moderationLists(agent);
  if (lists.length === 1) return { ...lists[0], created: false };
  if (lists.length > 1) {
    throw new Error(
      `the bot has ${lists.length} moderation lists, so set MOD_LIST_URI to the one to use:\n` +
        lists.map((l) => `  MOD_LIST_URI=${l.uri}   ("${l.name}")`).join('\n'),
    );
  }
  return { ...(await createList(agent, name)), created: true };
}

/**
 * Why this configured list cannot be written to, or null when it can: it
 * must be a moderation list in the bot's own repo.
 */
export async function listProblem(agent, uri) {
  const did = agent.session?.did;
  const m = /^at:\/\/(did:[^/]+)\/app\.bsky\.graph\.list\/([^/]+)$/.exec(
    String(uri || ''),
  );
  if (!m) return `MOD_LIST_URI is not a list URI: ${uri}`;
  if (m[1] !== did) {
    return `MOD_LIST_URI is in ${m[1]}'s repo, not the bot's (${did}). The bot can only write to its own lists.`;
  }
  // Only RecordNotFound means the list is gone. Any other failure, from the
  // network or the PDS, is reported as itself.
  const rec = await agent.com.atproto.repo
    .getRecord({ repo: did, collection: 'app.bsky.graph.list', rkey: m[2] })
    .catch((err) => {
      if (err?.error === 'RecordNotFound') return null;
      throw err;
    });
  if (!rec) return `MOD_LIST_URI names a list that does not exist: ${uri}`;
  if (rec.data.value?.purpose !== MODLIST) {
    return 'MOD_LIST_URI is not a moderation list, and only a moderation list can be subscribed to as a block. Leave it empty and the bot makes one.';
  }
  return null;
}
