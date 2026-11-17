// Build the reference data every scoring decision reads.
//
// One number does the work: for any account, how many of the people the owner
// follows also follow them. Computing it once per snapshot turns it into a
// lookup instead of an API call per account, and freezes it, so a decision can
// be replayed against the graph as it stood that day.
//
// It takes one follow list per account the owner follows, which is too much
// work to hold the bot's one job queue. So a run spends a time budget, stops
// cleanly, and resumes on the next step (see src/snapshot.js). Edges are staged
// raw and aggregated in one SQL statement at the end, so an interrupted run
// leaves a partial edge set rather than a vouch table that looks finished and
// is wrong.

import { APPVIEW, OWNER_DID } from '../constants.js';
import { fetchWithTimeout } from './atproto.js';

/** `getFollows` pages at 100. */
const PAGE = 100;

/**
 * Follow-list pages to read per circle member: the first 1,500 accounts they
 * follow. A member who follows more contributes a truncated set, which
 * understates vouches for accounts deep in their list. An understated vouch
 * can drop an account to UNKNOWN, the band approved without a named look, so
 * this cap is a known gap in coverage, kept to bound the cost of a snapshot.
 */
const MAX_PAGES = 15;

/**
 * `listRecords` pages to read from the owner's own repo before giving up.
 *
 * These reads decide who is PROTECTED, and the snapshot replaces the protected
 * set with what they return. So a read that cannot finish throws instead of
 * returning part of the answer, and the old set stays in place.
 */
const MAX_RECORD_PAGES = 1000;

/** How many follow lists to fetch at once. */
const CONCURRENCY = 8;

/**
 * Fetch JSON, separating a failure that will never succeed from one that
 * might.
 *
 * An account that is deactivated, taken down or gone answers 400 from
 * getFollows and always will, and retrying it forever would hold the snapshot
 * open. Every other failure (a 429, any 5xx, a 401 or 403 from something in
 * between, a 404 or a 408) is worth coming back for.
 *
 * @returns {{ body: object|null, permanent: boolean }}
 */
async function getJson(url, fetchImpl, signal, tries = 3) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (res.ok) return { body: await res.json(), permanent: false };
      if (res.status === 400) return { body: null, permanent: true };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  return { body: null, permanent: false };
}

/**
 * Every account `did` follows, up to MAX_PAGES.
 *
 * Reads the AppView rather than the PDS: `getFollows` needs no auth and no PLC
 * lookup to find the host. The AppView filters by viewer, which rules it out
 * for harvesting, but these calls are unauthenticated and so have no viewer.
 *
 * `failed` is set when a page could not be read, the first or a later one.
 * `complete: false` without it means the page cap or the deadline cut it.
 * When the deadline cut it, `resume` holds what was read and where to go on
 * from, and passing it back as `from` continues the same read.
 */
export async function followsOf(
  did,
  {
    fetchImpl = fetchWithTimeout,
    signal,
    appview = APPVIEW,
    deadline = Infinity,
    from = null,
  } = {},
) {
  const out = [...(from?.dids ?? [])];
  let cursor = from?.cursor;
  for (let page = from?.pages ?? 0; page < MAX_PAGES; page += 1) {
    // Checked per page, not per member. A long follow list is fifteen
    // sequential requests with retries behind each, so a budget enforced only
    // between members could overrun by tens of seconds, and every DM queued
    // behind the step would wait that long too.
    if (Date.now() >= deadline)
      return {
        dids: out,
        complete: false,
        aborted: true,
        permanent: false,
        resume: { dids: out, cursor, pages: page },
      };
    const url =
      `${appview}/xrpc/app.bsky.graph.getFollows?actor=${encodeURIComponent(did)}&limit=${PAGE}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const { body, permanent } = await getJson(url, fetchImpl, signal);
    if (!body) {
      return {
        dids: out,
        complete: false,
        aborted: false,
        permanent,
        failed: true,
      };
    }
    for (const f of body.follows || []) if (f?.did) out.push(f.did);
    cursor = body.cursor;
    if (!cursor)
      return { dids: out, complete: true, aborted: false, permanent: false };
  }
  return { dids: out, complete: false, aborted: false, permanent: false };
}

/** Every record in one collection of a repo, or a throw. */
async function listAllRecords({ pds, did, collection, fetchImpl, signal }) {
  const out = [];
  let cursor;
  for (let page = 0; page < MAX_RECORD_PAGES; page += 1) {
    const url =
      `${pds}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(did)}` +
      `&collection=${collection}&limit=100` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const { body } = await getJson(url, fetchImpl, signal);
    if (!body) throw new Error(`could not read ${collection} from ${pds}`);
    out.push(...(body.records || []));
    cursor = body.cursor;
    if (!cursor) return out;
  }
  throw new Error(
    `more than ${MAX_RECORD_PAGES * 100} ${collection} records; refusing a partial read`,
  );
}

/**
 * Read the accounts the owner follows, straight from the PDS.
 *
 * The PDS rather than the AppView because this is the authoritative list: a
 * follow record that exists but has not been indexed yet still counts, since
 * the owner made it.
 */
export async function readCircle({
  pds,
  did = OWNER_DID,
  fetchImpl = fetchWithTimeout,
  signal,
} = {}) {
  const records = await listAllRecords({
    pds,
    did,
    collection: 'app.bsky.graph.follow',
    fetchImpl,
    signal,
  });
  return [
    ...new Set(records.map((r) => r?.value?.subject).filter(Boolean)),
  ];
}

/**
 * Index the follow lists of circle members that have not been done yet.
 *
 * The caller supplies `pending` (members still to do) and two sinks, so this
 * runs the same against the database and against a Map in a test. Stops when
 * the time budget is spent and reports what is left.
 *
 * `partial` lists members whose follow list was cut short by the page cap.
 * Their edges are kept and they are marked done. A member with a page that
 * kept failing is reported in `unreadable` instead, with nothing written.
 *
 * A member the time budget stops partway is left in `resume`, with what was
 * read of it, and a later run given the same map goes on from there. So a
 * follow list longer than one budget is read over several runs, a page or
 * more each, rather than from its first page every time.
 *
 * @param {object} opts
 * @param {string[]} opts.pending           circle members with no follow list yet
 * @param {(edges: Array<{member: string, target: string}>) => Promise<void>} opts.writeEdges
 * @param {(member: string) => Promise<void>} opts.markDone
 * @param {number} [opts.budgetMs]          wall-clock budget for this run
 * @param {Map<string, object>} [opts.resume] member -> a read the budget cut short
 * @returns {Promise<{indexed: number, remaining: number, edges: number, partial: string[], unreadable: Array<{member: string, permanent: boolean}>}>}
 */
export async function indexCircleFollows({
  pending,
  writeEdges,
  markDone,
  budgetMs = 45_000,
  resume = new Map(),
  fetchImpl = fetchWithTimeout,
  signal,
  onProgress,
}) {
  const started = Date.now();
  // Members already part-read go first, so what is held for them is finished
  // and let go.
  const queue = [
    ...pending.filter((m) => resume.has(m)),
    ...pending.filter((m) => !resume.has(m)),
  ];
  const partial = [];
  const unreadable = [];
  let indexed = 0;
  let edges = 0;
  let stopped = false;

  const deadline = started + budgetMs;

  async function worker() {
    while (!stopped) {
      if (Date.now() >= deadline) {
        stopped = true;
        return;
      }
      const member = queue.shift();
      if (!member) return;
      const read = await followsOf(member, {
        fetchImpl,
        signal,
        deadline,
        from: resume.get(member),
      });
      const { dids, complete, aborted, permanent, failed } = read;
      if (aborted) {
        // Out of budget mid-member. Write and mark nothing: a follow list cut
        // short by the clock would understate this member's vouches for the
        // life of the snapshot. What was read is held for the next run.
        resume.set(member, read.resume);
        stopped = true;
        return;
      }
      resume.delete(member);
      if (failed) {
        // A page could not be read, the first or a later one. Write and mark
        // nothing, for the same reason as the clock: a follow list cut short
        // by a failed page would understate this member's vouches for the
        // life of the snapshot. Reporting whether the failure is permanent
        // lets the caller stop asking about an account that will answer 400
        // forever; a transient one is left for a later step.
        unreadable.push({ member, permanent });
        continue;
      }
      if (!complete) partial.push(member);
      const rows = [...new Set(dids)].map((target) => ({ member, target }));
      await writeEdges(rows);
      await markDone(member);
      indexed += 1;
      edges += rows.length;
      onProgress?.({ indexed, remaining: queue.length, member });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, worker),
  );

  return { indexed, remaining: queue.length, edges, partial, unreadable };
}

/**
 * Everyone on a curation list the owner made.
 *
 * These join the follows in the protected set. Putting someone on a curation
 * list is a deliberate choice, many people curate far more accounts than they
 * follow, and an account the owner chose to collect should never be swept up
 * by a tool reacting to one post.
 *
 * Moderation lists are excluded, since a modlist makes the opposite claim. So
 * is any list named in `exclude`: a list filled automatically ("everyone who
 * replied to me this month") is a curation list in form only, because nobody
 * chose its members.
 */
export async function readCurationMembers({
  pds,
  did = OWNER_DID,
  exclude = [],
  fetchImpl = fetchWithTimeout,
  signal,
} = {}) {
  const read = (collection) =>
    listAllRecords({ pds, did, collection, fetchImpl, signal });

  const lists = await read('app.bsky.graph.list');
  const generated = new Set(exclude);
  const curation = new Set(
    lists
      .filter((r) => r.value?.purpose === 'app.bsky.graph.defs#curatelist')
      .map((r) => r.uri)
      .filter((uri) => !generated.has(uri)),
  );
  const nameByUri = new Map(
    lists.map((r) => [r.uri, r.value?.name || 'untitled']),
  );

  const items = await read('app.bsky.graph.listitem');
  const out = new Map();
  for (const r of items) {
    const listUri = r.value?.list;
    const subject = r.value?.subject;
    if (!subject || !curation.has(listUri)) continue;
    // First list wins the reason, so the label stays stable rather than
    // flipping with listRecords ordering between runs.
    if (!out.has(subject)) {
      out.set(subject, `list:${nameByUri.get(listUri)}`);
    }
  }
  return out;
}

/**
 * Turn a finalised snapshot into the lookup structures the scorer takes.
 *
 * @param {Array<{did: string, vouches: number}>} vouchRows
 * @param {string[]} circleDids
 * @param {Array<{did: string, reason: string}>} protectedRows
 */
export function referenceFrom({
  vouchRows = [],
  circleDids = [],
  protectedRows = [],
  // Set-likes the caller keeps current (graphFacts.js), used as they are
  // rather than copied, so the bot's own writes show up without a reload.
  listed = null,
  blockers = null,
} = {}) {
  return {
    vouches: new Map(vouchRows.map((r) => [r.did, r.vouches])),
    circle: new Set(circleDids),
    protectedSet: new Map(protectedRows.map((r) => [r.did, r.reason])),
    // Everyone a circle member follows is one hop out, and the vouch table
    // already lists exactly that set, so distance 2 needs no crawl of its own.
    neighbourhood: new Set(vouchRows.map((r) => r.did)),
    alreadyListed: listed ?? new Set(),
    // Accounts that already block the owner. A block is a public record in
    // the blocker's own repo, read through Constellation.
    blockers: blockers ?? new Set(),
  };
}
