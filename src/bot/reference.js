// The scoring reference, shared by everything that scores.
//
// DMs, public replies, plans and the drift audit all score against the newest
// finalised snapshot and the same thresholds, loaded here and nowhere else,
// so the analyst and a preflight never report different bands for the same
// account on the same day. Bands the analyst cannot change are only worth
// something if they are the same bands.

import { APPVIEW, OWNER_DID } from '../constants.js';
import {
  resolveTarget,
  resolveActor,
} from '../lib/target.js';
import { harvestPost } from '../lib/harvest.js';
import {
  createScorer,
  summarise,
  DEFAULT_THRESHOLDS,
} from '../lib/score.js';
import { referenceFrom } from '../lib/precompute.js';
import { pulse } from '../lib/pulse.js';
import { select, selectAll } from './db.js';
import { listUri } from './listWrite.js';
import { graphFacts, listedView, blockersView } from './graphFacts.js';

/**
 * The newest finalised snapshot, as scorer-shaped lookups.
 *
 * Throws rather than scoring against nothing. An empty vouch table puts every
 * account in UNKNOWN and waves the whole batch through, which is the failure
 * this system exists to prevent, reported as a successful run.
 *
 * @returns {Promise<{ takenAt: string, ref: object, thresholds: object }>}
 */
export async function loadReference() {
  const latest = await select('vouch', {
    select: 'taken_at',
    order: 'taken_at.desc',
    limit: 1,
  });
  const takenAt = latest?.[0]?.taken_at;
  if (!takenAt) {
    throw new Error(
      'the follow-graph snapshot is not built yet. It builds by itself after the bot starts and takes a few minutes; ask again shortly',
    );
  }

  const list = listUri();
  const [vouchRows, circleRows, protectedRows] = await Promise.all([
    selectAll('vouch', {
      select: 'did,vouches',
      eq: { taken_at: takenAt },
      order: 'did.asc',
    }),
    selectAll('circle', {
      select: 'did',
      eq: { taken_at: takenAt },
      order: 'did.asc',
    }),
    selectAll('protected', { select: 'did,reason', order: 'did.asc' }),
    // Who is already on the list and who already blocks the owner, loaded
    // beside the vouches and held for half an hour (graphFacts.js). A failure
    // leaves both unknown rather than empty and wrong.
    graphFacts({ list }).catch(() => null),
  ]);

  const thresholds = DEFAULT_THRESHOLDS;
  return {
    takenAt,
    thresholds,
    ref: {
      ...referenceFrom({
        vouchRows,
        circleDids: circleRows.map((r) => r.did),
        protectedRows,
        listed: listedView(list),
        blockers: blockersView(),
      }),
      thresholds,
    },
  };
}

/**
 * The read-only backends the analyst's tools call.
 *
 * Every one is a SELECT or a public AppView read. There is no backend here
 * that blocks, mutes, lists or approves: the analyst only looks, and
 * `buildTools` in agent.js can only expose what this object offers.
 *
 * Built once per reference load and shared across turns, so a conversation does
 * not re-read the vouch table for every message.
 */
export function makeIo({ ref, takenAt, pulseBudgetMs = 25_000 }) {
  const scorer = createScorer(ref);
  return {
    async preflight(link) {
      const target = await resolveTarget(link);
      const harvest = await harvestPost(target.uri);
      const scores = await scorer.score(harvest.participants.map((p) => p.did));
      const summary = summarise(harvest, scores, { excludeSelf: OWNER_DID });
      return {
        target,
        totals: summary.totals,
        truncated: summary.truncated,
        requiresReview: summary.requiresReview,
        autoEligible: summary.autoEligible.length,
      };
    },
    /** Score many accounts at once. For a watch, which meets them in batches. */
    score: (dids) => scorer.score(dids),
    async lookUp(actor) {
      // Resolve first: score() keys its result by the exact string it is
      // handed, so a handle would come back as an unresolved account rather
      // than as the person it names.
      const did = await resolveActor(actor);
      const scored = await scorer.score([did]);
      return [...scored.values()][0] ?? null;
    },
    /**
     * What a slice of the network is talking about.
     *
     * The circle comes from the snapshot rather than a live getFollows, so a
     * digest reads the same accounts the bands were computed against. Reading
     * every one of their feeds is slow, hence the time budget.
     */
    pulse: (opts = {}) =>
      pulse({
        ...opts,
        circleDids: [...ref.circle],
        budgetMs: opts.budgetMs ?? pulseBudgetMs,
      }),

    referenceStatus: () => ({
      snapshot: takenAt,
      scoredAccounts: ref.vouches.size,
      circleSize: ref.circle.size,
      protectedAccounts: ref.protectedSet.size,
      appview: APPVIEW,
    }),
  };
}
