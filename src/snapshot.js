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
//   finalising  all members read; aggregate the staged edges into vouch counts
//   finalised   the vouch counts for this snapshot are written
//   idle        the current snapshot is complete and fresh enough
//
// `restart: true` forces a new snapshot regardless of age.

import { OWNER_DID } from './constants.js';
import { config } from './config.js';
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
const UNPROTECTED_LISTS = String(process.env.MOD_UNPROTECTED_LISTS || '')
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

async function currentSnapshot() {
  const rows = await select('circle', {
    select: 'taken_at',
    order: 'taken_at.desc',
    limit: 1,
  });
  return rows?.[0]?.taken_at ?? null;
}

async function startSnapshot(pds) {
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
      where: {
        did: `in.(${stale
          .slice(i, i + 50)
          .map((d) => `"${d}"`)
          .join(',')})`,
      },
    });
  }

  await upsert(
    'circle',
    circle.map((did) => ({ taken_at: takenAt, did })),
  );

  return { takenAt, members: circle.length, protected: rows.length };
}

/**
 * Do one step of the snapshot build.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.restart] start a new snapshot regardless of age
 * @param {number} [opts.budgetMs]
 * @returns {Promise<{state: 'idle'|'collecting'|'finalising'|'finalised'}>}
 */
export async function snapshotStep({
  restart = false,
  budgetMs = BUDGET_MS,
} = {}) {
  const pds = await resolvePds(OWNER_DID);

  let takenAt = await currentSnapshot();
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

  const pendingRows = await select('circle', {
    select: 'did,attempts',
    eq: { taken_at: takenAt },
    is: { follows_indexed_at: 'null' },
    limit: 500,
  });

  if (pendingRows.length) {
    const attemptsByDid = new Map(
      pendingRows.map((r) => [r.did, r.attempts ?? 0]),
    );
    const result = await indexCircleFollows({
      pending: pendingRows.map((r) => r.did),
      budgetMs,
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
    // after MAX_ATTEMPTS.
    for (const { member, permanent } of result.unreadable) {
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

  // Everything read. finalise_snapshot refuses to run on partial data, so a
  // success here means the vouch table is a complete count of this snapshot.
  const written = await rpc('finalise_snapshot', { snapshot: takenAt });
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

/** Is there a finalised snapshot to score against at all? */
export async function hasSnapshot() {
  return (await count('vouch', {})) > 0;
}
