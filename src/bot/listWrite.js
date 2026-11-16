// Adding one account to the list, or taking one off, on the owner's say-so.
//
// Classic mode reaches this only from a parsed command (src/lib/command.js),
// so the target is the owner's literal text and the model has no path here.
// Agent mode reaches it through its write tools, after the write check
// (tiers.js).
//
// The PROTECTED veto is enforced here, at the write, and not only in the
// scorer, so a mistake upstream cannot get past it. The `protected` table
// holds the owner's follows, members of their curation lists and anyone added
// by hand, and no automated path may add them. A typed command still runs
// through this system, so it is refused too. The owner can still do it by
// hand in a client.

import crypto from 'node:crypto';

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

function ownerOf(uri) {
  const m = /^at:\/\/(did:[^/]+)\//.exec(String(uri ?? ''));
  return m ? m[1] : null;
}

// A veto table that cannot be read is a veto that cannot be honoured, so the
// write is refused. Guessing wrong here blocks someone the owner follows.
const VETO_UNREADABLE =
  'could not read the protected set, so the write is refused rather than risked';

/** Is this DID in the veto set, and why? */
async function protectedReason(did) {
  try {
    const rows = await select('protected', {
      select: 'reason',
      eq: { did },
    });
    return rows?.[0]?.reason ?? null;
  } catch {
    throw new Error(VETO_UNREADABLE);
  }
}

/**
 * Which of these DIDs are in the veto set now.
 *
 * For bulk writes, whose bands were scored when the plan was made: someone
 * the owner followed since then is PROTECTED now, whatever the plan says.
 * Throws if the table cannot be read.
 *
 * @param {string[]} dids
 * @returns {Promise<Set<string>>}
 */
export async function protectedAmong(dids) {
  const wanted = [...new Set(dids.filter(Boolean))];
  const out = new Set();
  for (let i = 0; i < wanted.length; i += 50) {
    const chunk = wanted.slice(i, i + 50);
    let rows;
    try {
      rows = await select('protected', {
        select: 'did',
        where: { did: `in.(${chunk.map((d) => `"${d}"`).join(',')})` },
      });
    } catch {
      throw new Error(VETO_UNREADABLE);
    }
    for (const r of rows || []) out.add(r.did);
  }
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
 *   changed?: boolean, already?: boolean, vetoed?: string, account?: object }>}
 *   `changed` is whether the list moved; `already` is "was already on / not
 *   on"; `vetoed` is the PROTECTED reason; `account` is the scored account, so
 *   a receipt can say who that was without scoring them a second time.
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

  let did;
  try {
    did = await resolveActor(actor);
  } catch {
    return {
      ok: false,
      message: `I could not resolve ${actor} to an account.`,
    };
  }

  // Scored before the write, so the log records what the gate saw rather than
  // UNSCORED, and the decision can be replayed. Best effort: a scoring failure
  // must not stop the owner acting.
  //
  // In parallel with the veto and the membership check. The membership check
  // is one Constellation request (rkeysForWrite in graphFacts.js), and walks
  // the repo only when Constellation cannot answer.
  const [account, reason, rkeys] = await Promise.all([
    !band && lookUp
      ? Promise.resolve(lookUp(actor)).catch(() => null)
      : Promise.resolve(null),
    action === 'list_add' ? protectedReason(did) : null,
    rkeysForWrite(uri, did),
  ]);
  const scored = band || account?.band || null;

  if (action === 'list_add') {
    if (reason) {
      return {
        ok: false,
        did,
        vetoed: reason,
        account,
        message:
          `${actor} is PROTECTED (${reason}). You follow them, or they are on one of your curation lists. ` +
          'No automated path acts on those, including this one. Do it in your client if you mean it.',
      };
    }
    // `rkeys` is null when membership could not be read. That still writes: a
    // duplicate listitem is a cheaper mistake than a block that did not happen.
    if (rkeys?.length) {
      return {
        ok: true,
        did,
        already: true,
        changed: false,
        account,
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
    await log(did, 'list_add', raw, scored, via);
    return {
      ok: true,
      did,
      changed: true,
      account,
      message: `Added ${actor} to the list.`,
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
  await log(did, 'list_remove', raw, scored, via);
  return {
    ok: true,
    did,
    changed: true,
    account,
    message: `Removed ${actor} from the list.`,
  };
}

/**
 * Record the write where "why am I on your list" is answered.
 *
 * A command is a plan of one, approved at the moment it was typed, so it goes
 * in `plan` + `decision` like every other action. `note` keeps the owner's
 * literal words: "the owner typed this sentence on this date" is the whole
 * answer, with nothing to reconstruct.
 *
 * Best effort. A write that is not logged is bad; refusing to write because
 * the log is down is worse, and the repo itself is the record.
 */
async function log(did, action, raw, band, via = 'command') {
  try {
    const planId = crypto.randomUUID();
    await upsert('plan', [
      {
        id: planId,
        created_at: new Date().toISOString(),
        approved_at: new Date().toISOString(),
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
        acted_at: new Date().toISOString(),
        approved_via: via,
      },
    ]);
  } catch {
    /* the repo is the record; the log is the convenience */
  }
}
