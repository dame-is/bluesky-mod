// Adding one account to the list, or taking one off, on the owner's say-so.
//
// Classic mode reaches this only from a parsed command (src/lib/command.js),
// so the target is the owner's literal text and the model has no path here.
// Agent mode reaches it through its write tools, after the write check
// (tiers.js).
//
// The PROTECTED veto is enforced here, at the write, and not only in the
// scorer, so a mistake upstream cannot get past it. The `protected` table
// holds the owner's follows as of the last snapshot, members of their curation
// lists and anyone added by hand, and no automated path may add them. A follow
// made since the snapshot is read live from the AppView at the write. A typed
// command still runs through this system, so it is refused too. The owner can
// still do it by hand in a client. The owner's own account and the bot's are
// never written either.

import crypto from 'node:crypto';

import { APPVIEW, OWNER_DID } from '../constants.js';
import { fetchWithTimeout } from '../lib/atproto.js';
import { resolveActor } from '../lib/target.js';
import { select, upsert } from './db.js';
import { rkeysForWrite, noteListed, noteUnlisted } from './graphFacts.js';
import { closeAdds } from './closeAdds.js';

/**
 * Which list a command acts on: MOD_LIST_URI, a list the moderator account
 * owns. There is no default; config.js refuses to start without it.
 */
export function listUri() {
  return process.env.MOD_LIST_URI || '';
}

/** The DID whose repo an at:// URI points into, or null. */
export function ownerOf(uri) {
  const m = /^at:\/\/(did:[^/]+)\//.exec(String(uri ?? ''));
  return m ? m[1] : null;
}

// A veto that cannot be read is a veto that cannot be honoured, so the write
// is refused. Guessing wrong here blocks someone the owner follows.
const VETO_UNREADABLE =
  'could not read the protected set, so the write is refused rather than risked';
const FOLLOWS_UNREADABLE =
  'could not check who you follow, so the write is refused rather than risked';
// Every snapshot puts the owner's follows in the table, so an empty table
// means none has run yet, not that nobody is protected.
const VETO_EMPTY =
  'the protected set is not built yet, so nothing is added until it is. It builds by itself a few minutes after the bot starts';

/** `getRelationships` takes at most 30 `others` per call. */
const REL_BATCH = 30;

/** did -> reason, for those of these DIDs in the `protected` table. */
async function fromTable(dids) {
  const out = new Map();
  let any;
  try {
    any = await select('protected', { select: 'did', limit: 1 });
    for (let i = 0; i < dids.length; i += 50) {
      const rows = await select('protected', {
        select: 'did,reason',
        where: { did: { in: dids.slice(i, i + 50) } },
      });
      for (const r of rows || []) out.set(r.did, r.reason);
    }
  } catch {
    throw new Error(VETO_UNREADABLE);
  }
  if (!any?.length) throw new Error(VETO_EMPTY);
  return out;
}

/**
 * Which of these DIDs the owner follows, asked of the AppView at the write.
 *
 * The table is as old as the last snapshot, so a follow made since then is
 * only found here. Throws if any batch cannot be read.
 */
async function followedNow(dids) {
  const out = new Set();
  for (let i = 0; i < dids.length; i += REL_BATCH) {
    const q = dids
      .slice(i, i + REL_BATCH)
      .map((d) => `others=${encodeURIComponent(d)}`)
      .join('&');
    let body = null;
    try {
      const res = await fetchWithTimeout(
        `${APPVIEW}/xrpc/app.bsky.graph.getRelationships?actor=${encodeURIComponent(OWNER_DID)}&${q}`,
        { headers: { Accept: 'application/json' } },
      );
      if (res.ok) body = await res.json();
    } catch {
      body = null;
    }
    if (!Array.isArray(body?.relationships)) {
      throw new Error(FOLLOWS_UNREADABLE);
    }
    for (const r of body.relationships) {
      if (r?.did && r.following) out.add(r.did);
    }
  }
  return out;
}

/** Is this DID in the veto set, and why? Throws when that cannot be known. */
async function protectedReason(did) {
  const [table, followed] = await Promise.all([
    fromTable([did]),
    followedNow([did]),
  ]);
  return table.get(did) || (followed.has(did) ? 'you follow them' : null);
}

/**
 * Which of these DIDs may not be added: the `protected` table, the
 * owner's follows as the AppView reports them, and the owner's and the bot's
 * own accounts.
 *
 * For bulk writes, whose bands were scored when the plan was made: someone
 * the owner followed since then is refused here, whatever the plan says.
 * Throws if the table or the follows cannot be read.
 *
 * `follows: false` leaves out the AppView and reads only the table, for a
 * count of what an approval could add. It is not a veto: a follow made since
 * the last snapshot is only found with the AppView.
 *
 * @param {string[]} dids
 * @param {{ follows?: boolean }} [opts]
 * @returns {Promise<Set<string>>}
 */
export async function protectedAmong(dids, { follows = true } = {}) {
  const self = new Set([OWNER_DID, ownerOf(listUri())].filter(Boolean));
  const wanted = [...new Set(dids.filter(Boolean))];
  const out = new Set(wanted.filter((did) => self.has(did)));
  const others = wanted.filter((did) => !self.has(did));
  if (!others.length) return out;
  const [table, followed] = await Promise.all([
    fromTable(others),
    follows ? followedNow(others) : new Set(),
  ]);
  for (const did of table.keys()) out.add(did);
  for (const did of followed) out.add(did);
  return out;
}

/**
 * Add to or remove from the moderation list.
 *
 * @param {object} agent  the moderator account's agent (NOT chat-proxied)
 * @param {'list_add'|'list_remove'} action
 * @param {string} actor  handle, DID or profile link, as the owner typed it
 * @param {object} [opts]
 * @param {string} [opts.raw]   the owner's literal message, for the decision log
 * @param {string} [opts.band]  the band at the time, if it was scored
 * @param {Function} [opts.lookUp]  scores `actor`, when `band` is not given
 * @param {string} [opts.via]   how it was asked for. 'command' is the owner's
 *   typed verb; 'agent' is agent mode acting on what they wrote in words. Both
 *   are their say-so, and the log still has to tell them apart: one is their
 *   literal target and the other is a model's reading of their sentence.
 * @returns {Promise<{ ok: boolean, message: string, did?: string,
 *   changed?: boolean, already?: boolean, vetoed?: string, account?: object,
 *   logged?: boolean }>}
 *   `changed` is whether the list moved; `already` is "was already on / not
 *   on"; `vetoed` is the PROTECTED reason; `account` is the scored account, so
 *   a receipt can say who that was without scoring them a second time.
 *   `logged` is false when the decision log could not be written, so undo
 *   and history cannot see this write.
 */
export async function applyCommand(
  agent,
  action,
  actor,
  { raw = '', band = null, lookUp = null, via = 'command' } = {},
) {
  // Anything else would fall through to the removal below.
  if (action !== 'list_add' && action !== 'list_remove') {
    throw new Error(`applyCommand: unknown action ${action}`);
  }
  const uri = listUri();
  const bot = agent.session?.did;

  // config.js checks this at start. Checked again here because a permission
  // failure from the PDS would say nothing useful.
  if (ownerOf(uri) !== bot) {
    return {
      ok: false,
      message:
        'MOD_LIST_URI is not a list this account owns, so I cannot write to it.',
    };
  }

  // The reason is kept: "no account found" and "the AppView answered 503"
  // call for different things from the owner.
  let did;
  try {
    did = await resolveActor(actor);
  } catch (err) {
    const why = String(err?.message || err).replace(/\.$/, '');
    return {
      ok: false,
      message: `I could not resolve ${actor}: ${why}.`,
    };
  }

  // A post the owner shared of their own, or a mention of the bot, names one
  // of these as its author. Neither belongs on the list.
  if (action === 'list_add' && (did === OWNER_DID || did === bot)) {
    return {
      ok: false,
      did,
      message:
        did === OWNER_DID
          ? `${actor} is your own account, so I have not added it. If you meant someone else, name them.`
          : `${actor} is this bot's own account, so I have not added it.`,
    };
  }

  // Scored before the write, so the log records what the gate saw rather than
  // UNSCORED, and the decision can be replayed. Best effort: a scoring failure
  // must not stop the owner acting.
  //
  // In parallel with the veto (the table and one AppView request) and the
  // membership check. The membership check is one Constellation request
  // (rkeysForWrite in graphFacts.js), and walks the repo only when
  // Constellation cannot answer.
  const [account, reason, rkeys] = await Promise.all([
    !band && lookUp
      ? Promise.resolve(lookUp(actor)).catch(() => null)
      : Promise.resolve(null),
    action === 'list_add' ? protectedReason(did) : null,
    rkeysForWrite(uri, did),
  ]);
  const scored = band || account?.band || null;

  if (action === 'list_add') {
    // What the lookup saw counts as well, so an account the bot has just
    // called PROTECTED is never written.
    const vetoed = reason || account?.protectedReason || null;
    if (vetoed) {
      return {
        ok: false,
        did,
        vetoed,
        account,
        message:
          `${actor} is PROTECTED (${vetoed}). You follow them, or they are on one of your curation lists. ` +
          'No automated path acts on those, including this one. Do it in your client if you mean it.',
      };
    }
    // `rkeys` is null when membership could not be read. That still writes: a
    // duplicate listitem is a cheaper mistake than a block that did not happen.
    if (rkeys?.length) {
      // Recorded although nothing is written, so an undo of the plan that put
      // them on first leaves them where the owner's own words put them.
      const logged = await log(did, 'list_add', raw, scored, via, {
        already: true,
      });
      return {
        ok: true,
        did,
        already: true,
        changed: false,
        account,
        logged,
        message: `${actor} was already on the list.`,
      };
    }
    const created = await agent.com.atproto.repo.createRecord({
      repo: bot,
      collection: 'app.bsky.graph.listitem',
      record: {
        $type: 'app.bsky.graph.listitem',
        subject: did,
        list: uri,
        createdAt: new Date().toISOString(),
      },
    });
    noteListed(
      uri,
      did,
      String(created?.data?.uri || '')
        .split('/')
        .pop(),
    );
    const logged = await log(did, 'list_add', raw, scored, via);
    return {
      ok: true,
      did,
      changed: true,
      account,
      logged,
      message: logged
        ? `Added ${actor} to the list.`
        : `Added ${actor} to the list, but I could not record it, so undo and history will not find it. "unblock ${actor}" takes it back.`,
    };
  }

  if (rkeys === null) {
    return {
      ok: false,
      did,
      account,
      message: `I could not check whether ${actor} is on the list, so I changed nothing.`,
    };
  }
  if (!rkeys.length) {
    return {
      ok: true,
      did,
      already: true,
      changed: false,
      account,
      message: `${actor} was not on the list.`,
    };
  }
  // Every copy: an account two plans both added has two listitems.
  for (const rkey of rkeys) {
    try {
      await agent.com.atproto.repo.deleteRecord({
        repo: bot,
        collection: 'app.bsky.graph.listitem',
        rkey,
      });
    } catch (err) {
      // Constellation can lag a deletion. Already gone is the outcome asked for.
      if (!/not ?found|could not locate/i.test(String(err?.message || err))) {
        throw err;
      }
    }
  }
  noteUnlisted(uri, did);
  // Close the decisions that put them on, or "undo last" keeps choosing the
  // plan that added them. Best effort, like the log below: the listitems are
  // already gone, and that is what the owner asked for.
  await closeAdds(did, raw || 'unblocked').catch(() => {});
  const logged = await log(did, 'list_remove', raw, scored, via);
  return {
    ok: true,
    did,
    changed: true,
    account,
    logged,
    message: logged
      ? `Removed ${actor} from the list.`
      : `Removed ${actor} from the list, but I could not record it, so history will not show it.`,
  };
}

/**
 * The next number in the order changes reached the list. A bare "undo" reads
 * the newest change by it rather than by acted_at, which a clock stepped back
 * would put out of order. One process writes, through one job queue, so
 * reading the highest is enough.
 */
export async function nextActedSeq() {
  const [top] =
    (await select('decision', {
      select: 'acted_seq',
      where: { acted_seq: 'not.is.null' },
      order: 'acted_seq.desc',
      limit: 1,
    })) || [];
  return (top?.acted_seq ?? 0) + 1;
}

/**
 * Record the write where "why am I on your list" is answered.
 *
 * A command is a plan of one, approved at the moment it was typed, so it goes
 * in `plan` + `decision` like every other action. `note` keeps the owner's
 * literal words: "the owner typed this sentence on this date" is the whole
 * answer, with nothing to reconstruct. `already` marks an add of someone who
 * was on the list already, for which nothing was written.
 *
 * Runs after the write, so a log that is down does not stop the owner
 * acting. Undo, history and "why is this person on the list" read only the
 * log, though, so a write it misses is invisible to them. It is tried twice
 * under one plan id, so a first try that wrote the plan row and not the
 * decision leaves one plan rather than two. Returns whether it was recorded,
 * for the receipt to say so when it was not.
 */
async function log(
  did,
  action,
  raw,
  band,
  via = 'command',
  { already = false } = {},
) {
  const planId = crypto.randomUUID();
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const seq = await nextActedSeq();
      await upsert('plan', [
        {
          id: planId,
          created_at: now,
          approved_at: now,
          approved_bands: [via],
          note: raw,
        },
      ]);
      await upsert('decision', [
        {
          plan_id: planId,
          did,
          band: band || 'UNSCORED',
          action,
          acted_at: now,
          acted_seq: seq,
          approved_via: via,
          ...(already ? { already_listed: true } : {}),
        },
      ]);
      return true;
    } catch {
      // A lock another writer held may have cleared by the second try.
    }
  }
  return false;
}
