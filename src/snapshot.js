// Keep the follow-graph snapshot fresh.
//
// Every score reads one number: for an account, how many of the people the
// owner follows also follow them. That takes a follow-list read per account the
// owner follows, roughly 20 requests each, so it is built once a week and kept.
//
// One call to snapshotStep() does as much as fits in its time budget and
// returns what is left, so the bot can keep answering DMs between steps. A run
// moves through these states, and reports which one it is in:
//
//   collecting  circle members still need their follow lists read
//   waiting     every member left failed a moment ago; a later check asks again
//   finalising  all members read; aggregate the staged edges into vouch counts
//   finalised   the vouch counts for this snapshot are written
//   idle        the current snapshot is complete and fresh enough
//
// `restart: true` forces a new snapshot regardless of age.
//
// With MOD_SCORING=simple only the owner's own follows are read, so a
// snapshot is collected and finalised in one step and holds no vouch counts.
// A snapshot taken in the other mode is rebuilt at the next check.

import { OWNER_DID } from './constants.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { resolvePds } from './lib/atproto.js';
import {
  readCircle,
  readCurationMembers,
  indexCircleFollows,
} from './lib/precompute.js';
import {
  select,
  selectAll,
  upsert,
  update,
  rpc,
  count,
  del,
} from './bot/db.js';

/** Curation lists whose members are NOT protected (at:// URIs). */
export const UNPROTECTED_LISTS = String(process.env.MOD_UNPROTECTED_LISTS || '')
  .split(/[\s,]+/)
  .filter(Boolean);

/**
 * Wall-clock budget per step. It bounds when work STOPS BEING STARTED; a
 * request already in flight lands after it. Short, so a DM that arrives during
 * a build waits seconds rather than minutes.
 */
const BUDGET_MS = 25_000;

/**
 * Transient read failures to tolerate before a member is written off. A
 * permanent failure (a deactivated or taken-down account) needs no attempts at
 * all; without a ceiling, one unreachable host holds a snapshot open forever.
 */
const MAX_ATTEMPTS = 3;

/**
 * How long a member whose read failed is left before it is asked again.
 *
 * Attempts are spaced in time, not counted per step. Steps run a quarter of a
 * second apart, so one minute of errors from the AppView would otherwise use
 * up every attempt of every member it touched and write them all off.
 */
const RETRY_GAP_MS = 10 * 60_000;

/**
 * When each member of the snapshot being built last failed, in this process.
 * A restart forgets it, which costs at most an early retry; the attempts
 * themselves are counted in the database.
 */
const lastFailed = { takenAt: null, at: new Map() };

/**
 * Follow lists a step's budget cut short, for the snapshot being built: each
 * member's follows read so far and where to go on from. The next step resumes
 * them there, so a list too long for one step still finishes. A restart
 * forgets them, which costs a re-read from the first page.
 */
let readSoFar = new Map();

/**
 * How far ahead of the clock a snapshot may be dated before it is taken for
 * one written while the clock ran fast.
 */
const CLOCK_SKEW_MS = 5 * 60_000;

const aheadOfClock = () => new Date(Date.now() + CLOCK_SKEW_MS).toISOString();

/**
 * The newest snapshot, leaving out any dated ahead of the clock. Its age cannot
 * be told, so it is never the one kept fresh: a new snapshot is built beside
 * it, scoring goes on reading it meanwhile, and it is dropped once the new one
 * is finalised.
 */
async function currentSnapshot() {
  const rows = await select('circle', {
    select: 'taken_at,scoring',
    where: { taken_at: `lte.${aheadOfClock()}` },
    order: 'taken_at.desc',
    limit: 1,
  });
  return rows?.[0] ?? null;
}

/** Delete every snapshot dated ahead of the clock. */
async function dropSnapshotsAhead() {
  const limit = aheadOfClock();
  const ahead = new Set(
    (
      await selectAll('circle', {
        select: 'taken_at',
        where: { taken_at: `gt.${limit}` },
        order: 'taken_at.desc',
      })
    )
      .map((r) => r.taken_at)
      .filter((takenAt) => takenAt > limit),
  );
  for (const takenAt of ahead) {
    logger.warn('Dropped a snapshot dated ahead of the clock', {
      snapshot: takenAt,
      aheadHours: Number(
        ((Date.parse(takenAt) - Date.now()) / 3_600_000).toFixed(1),
      ),
    });
    for (const table of ['vouch', 'circle_follow', 'circle']) {
      await del(table, { eq: { taken_at: takenAt } });
    }
  }
}

async function startSnapshot(pds, { scoring = config.scoring } = {}) {
  const takenAt = new Date().toISOString();
  const circle = await readCircle({ pds, did: OWNER_DID });
  if (!circle.length) throw new Error('read zero follows; refusing to snapshot');

  // The derived protected set is rebuilt with each snapshot rather than
  // appended to, so taking someone off a curation list takes away their
  // protection too. Entries added by hand are left alone, even for someone the
  // owner follows: marked derived, they would lose the veto on an unfollow.
  //
  // THE NEW SET GOES IN BEFORE THE OLD ONE COMES OUT, and all of it before the
  // snapshot exists. Deleting first leaves a window where a failed write turns
  // the veto off for everyone the owner follows. This way a failure leaves the
  // old set whole and no new snapshot, and the next step starts again.
  const curated = await readCurationMembers({
    pds,
    did: OWNER_DID,
    exclude: UNPROTECTED_LISTS,
  });
  const manual = new Set(
    (
      await selectAll('protected', {
        select: 'did',
        eq: { source: 'manual' },
        order: 'did.asc',
      })
    ).map((r) => r.did),
  );
  const followed = new Set(circle);
  const rows = [
    ...circle.map((did) => ({
      did,
      reason: 'you follow them',
      source: 'derived',
    })),
    ...[...curated]
      .filter(([did]) => !followed.has(did))
      .map(([did, reason]) => ({ did, reason, source: 'derived' })),
  ].filter((r) => !manual.has(r.did));
  await upsert('protected', rows);
  const keep = new Set(rows.map((r) => r.did));
  const stale = (
    await selectAll('protected', {
      select: 'did',
      eq: { source: 'derived' },
      order: 'did.asc',
    })
  )
    .map((r) => r.did)
    .filter((did) => !keep.has(did));
  for (let i = 0; i < stale.length; i += 50) {
    await del('protected', {
      eq: { source: 'derived' },
      where: { did: { in: stale.slice(i, i + 50) } },
    });
  }
  // Rows the Jetstream watch added before this read began are covered by it,
  // or came off a list since. Ones added during the read stay until the next.
  await del('protected', {
    eq: { source: 'live' },
    where: { added_at: `lt.${takenAt}` },
  });

  // A simple snapshot reads no follow lists, so every member is done as
  // soon as it is written.
  const indexedAt = scoring === 'simple' ? takenAt : null;
  await upsert(
    'circle',
    circle.map((did) => ({
      taken_at: takenAt,
      did,
      scoring,
      follows_indexed_at: indexedAt,
    })),
  );

  return { takenAt, members: circle.length, protected: rows.length };
}

/**
 * Do one step of the snapshot build.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.restart] start a new snapshot regardless of age
 * @param {number} [opts.budgetMs]
 * @returns {Promise<{state: 'idle'|'collecting'|'waiting'|'finalising'|'finalised', remaining?: number, retryInMs?: number}>}
 *   On 'waiting', `retryInMs` is how long until a member may be asked again.
 */
export async function snapshotStep({
  restart = false,
  budgetMs = BUDGET_MS,
} = {}) {
  const pds = await resolvePds(OWNER_DID);

  const current = await currentSnapshot();
  if (config.scoring === 'simple') {
    return simpleStep(pds, current, { restart });
  }
  let takenAt = current?.scoring === 'full' ? current.taken_at : null;
  let started = null;

  if (takenAt && !restart) {
    const pending = await count('circle', {
      eq: { taken_at: takenAt },
      is: { follows_indexed_at: 'null' },
    });
    const ageDays = (Date.now() - Date.parse(takenAt)) / 86_400_000;
    const vouches = await count('vouch', { eq: { taken_at: takenAt } });

    // Complete means AGGREGATED, not merely collected: with every member read
    // and no vouch rows yet, there is nothing to score against, so it falls
    // through to the finalise branch below, which is idempotent.
    const finalised = vouches > 0;
    // A snapshot that came to nothing (no vouches and no edges left to
    // aggregate) is never scored against (reference.js). It is rebuilt after
    // a day, since finalising it again changes nothing.
    const empty =
      !finalised &&
      (await count('circle_follow', { eq: { taken_at: takenAt } })) === 0;
    const maxAge = finalised
      ? config.snapshotMaxAgeDays
      : empty
        ? Math.min(1, config.snapshotMaxAgeDays)
        : Infinity;

    if (pending === 0 && ageDays >= maxAge) {
      started = await startSnapshot(pds);
      takenAt = started.takenAt;
    } else if (pending === 0 && finalised) {
      return {
        state: 'idle',
        snapshot: takenAt,
        vouches,
        ageDays: Number(ageDays.toFixed(2)),
      };
    }
  } else {
    started = await startSnapshot(pds);
    takenAt = started.takenAt;
  }

  if (lastFailed.takenAt !== takenAt) {
    lastFailed.takenAt = takenAt;
    lastFailed.at = new Map();
    readSoFar = new Map();
  }
  // Fewest attempts first, so members not yet tried are not stuck behind
  // ones waiting out their pause.
  const pendingRows = await select('circle', {
    select: 'did,attempts',
    eq: { taken_at: takenAt },
    is: { follows_indexed_at: 'null' },
    order: 'attempts.asc',
    limit: 500,
  });
  const now = Date.now();
  const sinceFailed = (did) => now - (lastFailed.at.get(did) ?? -Infinity);
  const due = pendingRows.filter((r) => sinceFailed(r.did) >= RETRY_GAP_MS);

  if (pendingRows.length && !due.length) {
    // Everyone left failed a moment ago. Asking again now would spend their
    // attempts on the same outage, so stop and let a later check come back.
    return {
      state: 'waiting',
      snapshot: takenAt,
      started,
      remaining: pendingRows.length,
      retryInMs: Math.max(
        0,
        RETRY_GAP_MS - Math.max(...pendingRows.map((r) => sinceFailed(r.did))),
      ),
    };
  }

  if (due.length) {
    const attemptsByDid = new Map(due.map((r) => [r.did, r.attempts ?? 0]));
    const result = await indexCircleFollows({
      pending: due.map((r) => r.did),
      budgetMs,
      resume: readSoFar,
      writeEdges: (edges) =>
        upsert(
          'circle_follow',
          edges.map((e) => ({
            taken_at: takenAt,
            member_did: e.member,
            target_did: e.target,
          })),
        ),
      markDone: (member) =>
        update(
          'circle',
          { eq: { taken_at: takenAt, did: member } },
          { follows_indexed_at: new Date().toISOString() },
        ),
    });

    // A member that cannot be read contributes nothing and must not hold the
    // snapshot open. Permanent failures are closed out at once, transient ones
    // after MAX_ATTEMPTS, each at least RETRY_GAP_MS after the last.
    for (const { member, permanent } of result.unreadable) {
      lastFailed.at.set(member, Date.now());
      const attempts = (attemptsByDid.get(member) ?? 0) + 1;
      if (permanent || attempts >= MAX_ATTEMPTS) {
        await update(
          'circle',
          { eq: { taken_at: takenAt, did: member } },
          {
            follows_indexed_at: new Date().toISOString(),
            attempts,
            unreadable: permanent
              ? 'account inactive or removed'
              : `unreadable after ${attempts} attempts`,
          },
        );
      } else {
        await update(
          'circle',
          { eq: { taken_at: takenAt, did: member } },
          { attempts },
        );
      }
    }

    // Report what the DATABASE says is left, not what the in-memory queue
    // drained to. Those differ exactly when a member is consumed but not
    // completed.
    const stillPending = await count('circle', {
      eq: { taken_at: takenAt },
      is: { follows_indexed_at: 'null' },
    });
    return {
      state: stillPending > 0 ? 'collecting' : 'finalising',
      snapshot: takenAt,
      started,
      ...result,
      remaining: stillPending,
      unreadable: result.unreadable.length,
    };
  }

  // Every member read or written off. finalise_snapshot refuses to run while
  // any is pending, and no follow list cut short by a failed page is staged,
  // so a count here is low only by the members written off (counted below)
  // and by follows past the 1,500 each member is read to.
  const written = await rpc('finalise_snapshot', {
    snapshot: takenAt,
    keep: config.keep.snapshots,
  });
  await dropSnapshotsAhead();
  const gaps = await count('circle', {
    eq: { taken_at: takenAt },
    not_null: 'unreadable',
  });
  return {
    state: 'finalised',
    snapshot: takenAt,
    vouches: written,
    // These members contributed no edges, so every vouch count is a slight
    // undercount, and that is worth knowing.
    unreadableMembers: gaps,
  };
}

/**
 * One step in simple mode: if the newest snapshot is simple and fresh there is
 * nothing to do, and otherwise a new one is read and finalised at once.
 *
 * Finalising a simple snapshot writes no vouches. It also drops what full
 * scoring left behind, the vouch counts and any follow lists read for a build
 * that did not finish, since choosing simple scoring is choosing not to keep
 * them.
 */
async function simpleStep(pds, current, { restart }) {
  if (current?.scoring === 'simple' && !restart) {
    const ageDays = (Date.now() - Date.parse(current.taken_at)) / 86_400_000;
    if (ageDays < config.snapshotMaxAgeDays) {
      return {
        state: 'idle',
        snapshot: current.taken_at,
        vouches: 0,
        ageDays: Number(ageDays.toFixed(2)),
      };
    }
  }
  const started = await startSnapshot(pds, { scoring: 'simple' });
  const takenAt = started.takenAt;
  await rpc('finalise_snapshot', {
    snapshot: takenAt,
    keep: config.keep.snapshots,
  });
  const full = new Set(
    (
      await selectAll('circle', {
        select: 'taken_at',
        eq: { scoring: 'full' },
        order: 'taken_at.desc',
      })
    ).map((r) => r.taken_at),
  );
  for (const old of full) {
    for (const table of ['vouch', 'circle_follow', 'circle']) {
      await del(table, { eq: { taken_at: old } });
    }
  }
  await dropSnapshotsAhead();
  lastFailed.takenAt = null;
  readSoFar = new Map();
  return {
    state: 'finalised',
    snapshot: takenAt,
    started,
    vouches: 0,
    unreadableMembers: 0,
  };
}

/**
 * The snapshot to score against: the newest finalised one, full or simple.
 * Null before any is built.
 *
 * A full snapshot is finalised once it has vouch counts, and one that came to
 * none is never scored against. A simple one is finalised as it is written.
 * While a build in the other mode runs, the snapshot before it is used.
 *
 * @returns {Promise<{ takenAt: string, scoring: 'full'|'simple' } | null>}
 */
export async function usableSnapshot() {
  const [vouched, simple] = await Promise.all([
    select('vouch', {
      select: 'taken_at',
      order: 'taken_at.desc',
      limit: 1,
    }),
    select('circle', {
      select: 'taken_at',
      eq: { scoring: 'simple' },
      order: 'taken_at.desc',
      limit: 1,
    }),
  ]);
  const full = vouched?.[0]?.taken_at ?? null;
  const light = simple?.[0]?.taken_at ?? null;
  if (!full && !light) return null;
  if (!light || (full && full > light)) {
    return { takenAt: full, scoring: 'full' };
  }
  return { takenAt: light, scoring: 'simple' };
}
