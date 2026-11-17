// Trust and distance for one account, relative to you.
//
// This answers "what am I about to do, and who will notice", not "does this
// person deserve it". Nothing here reads a post or judges behaviour. It
// measures social proximity, which is a proxy for blast radius, not for harm.
//
// Signals such as a default handle, lexicon diversity and verification are
// left out. They separate a block list from your follows mostly by measuring
// resemblance to your own circle, and against strangers who engaged with one
// post they fire on almost everyone.
//
// The bands rest on one number: how many of the people you follow also follow
// this account. Read it in one direction only. A vouch is good evidence to
// leave someone alone; no vouch is no evidence at all, because most harmless
// strangers have none either.

import { APPVIEW, OWNER_DID } from '../constants.js';
import { fetchWithTimeout } from './atproto.js';

/** `getRelationships` takes at most 30 `others` per call. */
const REL_BATCH = 30;

/** `getProfiles` takes at most 25 actors per call. */
const PROFILE_BATCH = 25;

export const BANDS = [
  'PROTECTED',
  'CONNECTED',
  'PERIPHERAL',
  'NOTABLE',
  'UNKNOWN',
];

/**
 * Default thresholds. The gate should be nearly frictionless on strangers and
 * hard to get past for people near you.
 */
export const DEFAULT_THRESHOLDS = {
  connectedVouches: 3,
  connectedVouchesWithReach: 1,
  connectedReach: 5000,
  notableReach: 10000,
  notableActivityPostsPerDay: 20,
  notableActivityReach: 2000,
};

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * A 0 to 99 sorting key. Higher means more embedded in your world.
 *
 * It orders a review list; the band does the gating. The weights are blunt on
 * purpose, since finer ones would claim a precision the data does not have.
 * PROTECTED accounts get 100 so they always sort to the top.
 *
 * A missing, unparseable or future createdAt counts as no tenure rather than
 * a negative one.
 */
export function trustScore({
  vouches = 0,
  followers = 0,
  ageDays = 0,
  mutual = false,
  followsYou = false,
}) {
  const vouchTerm = 55 * Math.min(1, Math.log1p(vouches) / Math.log1p(12));
  const reachTerm = 25 * Math.min(1, Math.log10(1 + followers) / 5);
  const tenureTerm = 10 * clamp((Number(ageDays) || 0) / 365, 0, 1);
  const tieTerm = mutual ? 10 : followsYou ? 5 : 0;
  return clamp(Math.round(vouchTerm + reachTerm + tenureTerm + tieTerm), 0, 99);
}

/**
 * Assign a band. Vetoes win over everything.
 *
 * `protectedReason` being set is the whole of PROTECTED. The caller's protected
 * set (your follows, curation lists, manual entries) decides it, so there is
 * one place to look when asking why someone was spared.
 */
export function assignBand(f, thresholds = DEFAULT_THRESHOLDS) {
  if (f.protectedReason) return 'PROTECTED';
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const vouches = f.vouches || 0;
  const followers = f.followers || 0;
  if (
    vouches >= t.connectedVouches ||
    (vouches >= t.connectedVouchesWithReach && followers >= t.connectedReach)
  ) {
    return 'CONNECTED';
  }
  if (vouches >= 1) return 'PERIPHERAL';
  if (
    followers >= t.notableReach ||
    ((f.postsPerDay || 0) >= t.notableActivityPostsPerDay &&
      followers >= t.notableActivityReach)
  ) {
    return 'NOTABLE';
  }
  return 'UNKNOWN';
}

/**
 * Graph distance, as far as the precomputed sets can see it.
 *
 * 0  you follow them
 * 1  at least one account you follow follows them
 * 2  they are somewhere in the one-hop neighbourhood's own reach
 * 3  no connection found within what was precomputed
 *
 * 3 means "not found", not "three hops away". A real distance of 3 or more
 * would mean walking the follow graph of every account in the neighbourhood,
 * which costs far more than a number the bands do not use is worth.
 */
export function distanceFrom({ inCircle, vouches, inNeighbourhood }) {
  if (inCircle) return 0;
  if (vouches > 0) return 1;
  if (inNeighbourhood) return 2;
  return 3;
}

/** Pauses before asking the AppView again: two more tries after the first. */
const RETRY_DELAYS_MS = [1000, 3000];

/**
 * The array under `field` in an AppView answer, or a throw.
 *
 * A failed request is not an empty answer. Read as one, a rate limit would
 * turn every account in the batch into an unfollowed stranger with no
 * profile: UNKNOWN in a plan, and "gone" in the weekly re-score. So a 408, a
 * 429, a 5xx, a timeout or a dropped connection is asked again after a pause,
 * and a request that still fails throws, so nothing is scored from it.
 */
async function getList(url, field, { fetchImpl, signal, delays, what }) {
  for (let attempt = 0; ; attempt += 1) {
    let why;
    let retryable = true;
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (res.ok) {
        const list = (await res.json())?.[field];
        if (Array.isArray(list)) return list;
        why = 'an answer with no list in it';
      } else {
        why = `HTTP ${res.status}`;
        retryable =
          res.status === 408 || res.status === 429 || res.status >= 500;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      why = 'no answer';
    }
    if (!retryable || attempt >= delays.length) {
      throw new Error(
        `could not read ${what} from Bluesky (${why}), so nothing was scored. Try again in a minute`,
      );
    }
    await new Promise((r) => setTimeout(r, delays[attempt]));
  }
}

/** The bot's own DID: the repo that holds MOD_LIST_URI. */
const botDid = (env = process.env) =>
  /^at:\/\/(did:[^/]+)\//.exec(String(env.MOD_LIST_URI ?? ''))?.[1] ?? null;

/**
 * Build a scorer over a set of precomputed reference data.
 *
 * Everything the scorer needs about you is injected rather than fetched, so it
 * runs the same against test fixtures and against the database.
 *
 * @param {object} ref
 * @param {Map<string, number>} ref.vouches       did -> how many of your circle follow them
 * @param {Set<string>} ref.circle                accounts you follow
 * @param {Map<string, string>} ref.protectedSet  did -> reason ("you follow them", "list:Friends")
 * @param {Set<string>} [ref.neighbourhood]       the one-hop reach, for distance 2
 * @param {Set<string>} [ref.alreadyListed]       already on the mod list
 * @param {Set<string>} [ref.blockers]            accounts that block you
 * @param {object} [ref.thresholds]
 */
export function createScorer(
  ref,
  {
    fetchImpl = fetchWithTimeout,
    appview = APPVIEW,
    retryDelaysMs = RETRY_DELAYS_MS,
  } = {},
) {
  const {
    vouches = new Map(),
    circle = new Set(),
    protectedSet = new Map(),
    neighbourhood = new Set(),
    alreadyListed = new Set(),
    blockers = new Set(),
    thresholds = DEFAULT_THRESHOLDS,
  } = ref;

  async function profiles(dids, signal) {
    const out = new Map();
    for (let i = 0; i < dids.length; i += PROFILE_BATCH) {
      const q = dids
        .slice(i, i + PROFILE_BATCH)
        .map((d) => `actors=${encodeURIComponent(d)}`)
        .join('&');
      const found = await getList(
        `${appview}/xrpc/app.bsky.actor.getProfiles?${q}`,
        'profiles',
        { fetchImpl, signal, delays: retryDelaysMs, what: 'profiles' },
      );
      for (const p of found) if (p?.did) out.set(p.did, p);
    }
    return out;
  }

  /**
   * Mutual-follow state between you and each account, in batches of 30.
   *
   * `getRelationships` needs no auth, so the scorer never holds a session to
   * answer the question that matters most for a veto.
   */
  async function relationships(dids, signal) {
    const out = new Map();
    for (let i = 0; i < dids.length; i += REL_BATCH) {
      const batch = dids.slice(i, i + REL_BATCH);
      const q = batch.map((d) => `others=${encodeURIComponent(d)}`).join('&');
      const found = await getList(
        `${appview}/xrpc/app.bsky.graph.getRelationships?actor=${encodeURIComponent(OWNER_DID)}&${q}`,
        'relationships',
        {
          fetchImpl,
          signal,
          delays: retryDelaysMs,
          what: 'who you follow',
        },
      );
      for (const r of found) {
        if (!r?.did) continue;
        out.set(r.did, {
          youFollow: Boolean(r.following),
          followsYou: Boolean(r.followedBy),
        });
      }
    }
    return out;
  }

  return {
    /**
     * Score a list of DIDs.
     *
     * Throws when the AppView cannot be read for any batch, rather than
     * scoring part of the list from defaults. `missing` on a result means the
     * profiles answer came back and left that account out.
     *
     * @returns {Promise<Map<string, object>>} did -> { band, trust, distance, ... }
     */
    async score(dids, { signal } = {}) {
      const unique = [...new Set(dids)];
      const bot = botDid();
      const [profs, rels] = await Promise.all([
        profiles(unique, signal),
        relationships(unique, signal),
      ]);

      const out = new Map();
      for (const did of unique) {
        const p = profs.get(did);
        const rel = rels.get(did) || { youFollow: false, followsYou: false };
        const v = vouches.get(did) || 0;
        const created = Date.parse(p?.createdAt ?? '');
        const ageDays = Number.isFinite(created)
          ? Math.round((Date.now() - created) / 86400000)
          : null;
        const followers = p?.followersCount ?? 0;
        const mutual = rel.youFollow && rel.followsYou;

        // A follow the snapshot has not caught up with still protects, so the
        // live relationship counts as well as the injected set. The owner's
        // own account and the bot's are never added either, so nothing
        // offers to add them.
        const protectedReason =
          protectedSet.get(did) ||
          (rel.youFollow ? 'you follow them' : null) ||
          (circle.has(did) ? 'in your circle snapshot' : null) ||
          (did === OWNER_DID ? 'your own account' : null) ||
          (did === bot ? 'this bot' : null);

        const features = {
          vouches: v,
          followers,
          follows: p?.followsCount ?? 0,
          posts: p?.postsCount ?? 0,
          ageDays,
          postsPerDay:
            ageDays && ageDays > 1 && p?.postsCount
              ? Number((p.postsCount / ageDays).toFixed(2))
              : null,
          mutual,
          followsYou: rel.followsYou,
          youFollow: rel.youFollow,
          protectedReason,
        };

        out.set(did, {
          did,
          handle: p?.handle ?? null,
          displayName: p?.displayName ?? null,
          missing: !p,
          band: assignBand(features, thresholds),
          trust: protectedReason ? 100 : trustScore(features),
          distance: distanceFrom({
            inCircle: rel.youFollow || circle.has(did),
            vouches: v,
            inNeighbourhood: neighbourhood.has(did),
          }),
          alreadyListed: alreadyListed.has(did),
          // They cannot reply to or quote the owner while the block stands. The
          // list still matters to everyone subscribed to it.
          blocksYou: blockers.has(did),
          ...features,
        });
      }
      return out;
    },
  };
}

/**
 * A harvest without these accounts, its totals counted again without them.
 *
 * The owner, the bot and the post's author can all show up among a post's
 * participants: the author by gating replies or answering in their own
 * thread, the owner or the bot by replying there. None of them is one of the
 * people who engaged with the post.
 */
export function withoutSelves(harvest, dids) {
  const skip = new Set(dids.filter(Boolean));
  const participants = harvest.participants.filter((p) => !skip.has(p.did));
  const engagements = {};
  for (const p of participants) {
    for (const [k, n] of Object.entries(p.engagements || {})) {
      engagements[k] = (engagements[k] || 0) + n;
    }
  }
  return {
    ...harvest,
    participants,
    totals: {
      ...harvest.totals,
      participants: participants.length,
      engagements,
    },
  };
}

/**
 * Join a harvest to scores and summarise it, in the shape replies render from.
 *
 * `requiresReview` is everything that is not UNKNOWN: the list a person is
 * expected to read. Keeping it short is the constraint on every threshold
 * above. If it is routinely longer than a screen the thresholds are wrong,
 * because a review nobody reads is not a review.
 */
export function summarise(harvest, scores, { excludeSelf = null } = {}) {
  const rows = harvest.participants
    .filter((p) => p.did !== excludeSelf)
    .map((p) => ({ ...p, ...(scores.get(p.did) || { band: 'UNKNOWN' }) }));

  const byBand = Object.fromEntries(BANDS.map((b) => [b, 0]));
  for (const r of rows) byBand[r.band] = (byBand[r.band] || 0) + 1;

  const requiresReview = rows
    .filter((r) => r.band !== 'UNKNOWN')
    .sort((a, b) => b.trust - a.trust);

  return {
    uri: harvest.uri,
    harvestedAt: harvest.harvestedAt,
    truncated: harvest.truncated,
    // Engagement kinds the harvest could not read, with how many records
    // each held, so a reply can say what is missing as well as that it is.
    unread: harvest.unread ?? [],
    totals: {
      ...harvest.totals,
      participants: rows.length,
      byBand,
      reviewReach: requiresReview.reduce((n, r) => n + (r.followers || 0), 0),
      // An account already listed needs no add, and one that blocks the
      // owner already cannot reach them.
      alreadyListed: rows.filter((r) => r.alreadyListed).length,
      blocksYou: rows.filter((r) => r.blocksYou).length,
    },
    rows,
    requiresReview,
    autoEligible: rows.filter((r) => r.band === 'UNKNOWN'),
  };
}
