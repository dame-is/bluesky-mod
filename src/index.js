// The bot: one long-running process.
//
// Three inputs:
//
//   1. chat.bsky.convo.getLog on a 2s poll, the only way to read DMs. Chat
//      lives in the chat service (did:web:api.bsky.chat), not in any repo,
//      so it never reaches the firehose or Jetstream and there is no push.
//   2. Timers: the follow-graph snapshot, the weekly re-score of the list,
//      watched posts, and alerts when one of the owner's posts takes off.
//   3. Jetstream, for the owner's own new follows and list items, so they are
//      protected before the next snapshot (ownerGraph.js). This one writes a
//      row and needs no queue.
//   4. Spacedust, for replies, quotes and mentions aimed at the owner as they
//      happen (spacedust.js). Held in memory (ownerActivity.js) for the
//      alerts, watches and the shield to read; nothing is written from it
//      directly.
//
// The bot never posts in public. Everything it says goes to a DM.
//
// ONE JOB AT A TIME. An answer is a 5-20s model call holding the snapshot in
// memory, and this is meant to run on a small machine. Serialising also means
// a burst of DMs cannot open many harvests against the AppView at once.

import fs from 'node:fs';
import {
  createAtmosphereClient,
  loadAtmosphereTools,
} from './lib/mcp.js';
import { loadReference, makeIo } from './bot/reference.js';
import { loadAgentConfig } from './bot/agentConfig.js';
import { runDmPass, runContinuation } from './bot/dmLoop.js';
import { stopWrites } from './bot/bulkPlan.js';
import { checkModelFor, ESCALATION_MODEL } from './bot/tiers.js';
import { botAgent, chatView } from './bot/botAgent.js';
import { openDb, closeDb, usingPostgres, rpc } from './bot/db.js';
import { snapshotStep, usableSnapshot, UNPROTECTED_LISTS } from './snapshot.js';
import { connectJetstream } from './jetstream.js';
import { connectSpacedust } from './spacedust.js';
import { activity } from './ownerActivity.js';
import { ownerAgent } from './ownerAgent.js';
import { createGates } from './gates.js';
import {
  createClassifier,
  createPostInfo,
  shieldTick,
  onOwnerPost,
  SHIELD_EVERY_MS,
} from './shield.js';
import { setShieldDeps, sendNotice } from './bot/shieldDm.js';
import { startWatch } from './bot/watch.js';
import { loadState, setCursor } from './state.js';
import { ownerGraphHandler, OWNER_GRAPH_COLLECTIONS } from './ownerGraph.js';
import { installProvider, MODELS, modelsEnabled } from './models.js';

import { config, assertConfig } from './config.js';
import { setOwnerHandle } from './constants.js';
import { logger } from './logger.js';
import { maybeRunDrift, ownerConvo } from './drift.js';
import { tickWatches, tickAlerts } from './watching.js';
import { watchedUris } from './bot/watch.js';
import { postFacts, ownPostOptions } from './bot/ownPost.js';
import { isAuthError, createReconnector } from './session.js';
import { acquireLease, acquireDbLease, HEARTBEAT_MS } from './lease.js';
import { ensureDmsOpen, findOrCreateList, listProblem } from './bootstrap.js';
import { diskSpace, isLow, describe as describeDisk } from './disk.js';
import { pruneData } from './retention.js';
import { startPanel } from './panel/attach.js';

const model = MODELS.agent;

let agent = null;
let chat = null;
let botDid = null;

// --- counters ----------------------------------------------------------------
const stats = {
  dmAnswers: 0,
  errors: 0,
};

// --- the reference, held only while it is being used -------------------------
// The vouch table is the largest thing this process holds, and can run to tens
// of thousands of rows. Keeping it to answer a question every few days is the
// wrong trade on a small machine; reloading it takes a second or two.
let cached = null;
let idleTimer = null;

function releaseLater() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!cached) return;
    cached = null;
    logger.info('Released the reference snapshot', {
      heap_mb: (process.memoryUsage().heapUsed / 1048576).toFixed(1),
    });
  }, config.referenceIdleMs);
  if (idleTimer.unref) idleTimer.unref();
}

async function reference() {
  if (cached && Date.now() - cached.loadedAt < config.referenceTtlMs) {
    releaseLater();
    return cached;
  }
  const started = Date.now();
  const { ref, takenAt } = await loadReference();
  cached = {
    ref,
    takenAt,
    io: makeIo({ ref, takenAt, pulseBudgetMs: config.pulseBudgetMs }),
    loadedAt: Date.now(),
  };
  logger.info('Loaded the reference snapshot', {
    snapshot: takenAt,
    scored: ref.vouches.size,
    circle: ref.circle.size,
    ms: Date.now() - started,
  });
  releaseLater();
  return cached;
}

// --- the Atmosphere toolset, refreshed on a long TTL -------------------------
// Small (a few dozen schemas, no rows), so it is held rather than released. A
// failure is not fatal: the bot's own tools answer every scoring question.
//
// A FAILED LOAD IS REMEMBERED TOO, for a few minutes. Otherwise every 2s DM
// poll would wait up to 20s on a server that is down.
const ATMOSPHERE_RETRY_MS = 5 * 60_000;
let atmoTools = {};
let atmoNextAt = 0;

async function atmosphereTools() {
  if (!config.atmosphere) return {};
  if (Date.now() < atmoNextAt) return atmoTools;
  atmoTools = await loadAtmosphereTools({
    client: createAtmosphereClient({ url: config.atmosphereUrl }),
    log: (msg, fields) => logger.info(msg, fields),
  });
  atmoNextAt =
    Date.now() +
    (Object.keys(atmoTools).length
      ? config.atmosphereTtlMs
      : ATMOSPHERE_RETRY_MS);
  return atmoTools;
}

// --- the session, and getting it back ----------------------------------------
/**
 * Log in (resuming the stored session where possible) and swap the result in.
 * Everything reads `agent` and `chat` when it runs, so the next job uses it.
 */
async function connect() {
  // Only once this session is in use: a stale stored session expiring inside
  // botAgent's own resume is handled there, by logging in.
  let inUse = false;
  const session = await botAgent({
    onExpired: () => {
      if (inUse) reconnector.reconnect('the session expired');
    },
  });
  inUse = true;
  agent = session.agent;
  chat = chatView(agent);
  botDid = agent.session?.did;
  return session;
}

const reconnector = createReconnector({
  connect,
  log: (level, msg, fields) => logger[level](msg, fields),
});

/** The reconnector's schedule (session.js), for the first connect. */
const BOOT_FIRST_WAIT_MS = 30_000;
const BOOT_MAX_WAIT_MS = 15 * 60_000;

/**
 * The first connect, retried in this process after any failure. Exiting would
 * hand the retry to Docker or systemd, which restart within seconds, and with
 * a dead session every restart spends a createSession, which is capped at 30
 * per 5 minutes and 300 a day.
 */
async function connectAtBoot() {
  for (let failures = 1; ; failures += 1) {
    try {
      return await connect();
    } catch (err) {
      const waitMs = Math.min(
        BOOT_MAX_WAIT_MS,
        BOOT_FIRST_WAIT_MS * 2 ** (failures - 1),
      );
      logger.error('Could not log in as the bot; trying again', {
        err: String(err?.message || err),
        retryInS: Math.round(waitMs / 1000),
      });
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/**
 * What the bot needs on its own account: incoming DMs open, and a moderation
 * list. With no MOD_LIST_URI it finds its one list or makes one, and says so
 * in the log; a dry run writes nothing, so it only says what it would do.
 * A configured list that cannot be written to stops the start.
 */
async function settleBotAccount() {
  if (process.env.MOD_LIST_URI) {
    const problem = await listProblem(agent, process.env.MOD_LIST_URI);
    if (problem) throw new Error(problem);
  } else if (config.dryRun) {
    logger.info('DRY_RUN: no MOD_LIST_URI, and a dry run makes no list');
  } else {
    const list = await findOrCreateList(agent, {
      name: process.env.MOD_LIST_NAME || undefined,
    });
    process.env.MOD_LIST_URI = list.uri;
    const rkey = list.uri.split('/').pop();
    logger.info(
      list.created ? 'Made a moderation list for the bot' : 'Using the bot\'s moderation list',
      {
        name: list.name,
        uri: list.uri,
        subscribe: `https://bsky.app/profile/${agent.session?.did}/lists/${rkey}`,
      },
    );
  }
  if (!config.dryRun) {
    try {
      if ((await ensureDmsOpen(agent)) === 'opened') {
        logger.info('Opened the bot\'s DMs to everyone; it still answers only the roster');
      }
    } catch (err) {
      logger.warn('Could not open the bot\'s DMs', { err: err.message });
    }
  }
}

// --- the owner's session, for the shield's gates only ------------------------
// Opt-in (MOD_OWNER_APP_PASSWORD). Used through gates.js and nothing else,
// which writes only threadgates and postgates on the owner's own posts.
let ownerSession = null;
/** Why the owner's password cannot be used, once it has been refused. */
let ownerRefused = null;

async function connectOwner() {
  let inUse = false;
  const session = await ownerAgent({
    ownerDid: config.ownerDid,
    password: process.env.MOD_OWNER_APP_PASSWORD,
    onExpired: () => {
      if (inUse) ownerReconnector.reconnect('the owner session expired');
    },
  });
  inUse = true;
  ownerSession = session.agent;
  return session;
}

const ownerReconnector = createReconnector({
  connect: connectOwner,
  log: (level, msg, fields) => logger[level](msg, { ...fields, session: 'owner' }),
});

/**
 * The first owner login. A refusal (another account's password, or the
 * account password itself) is final: the shield runs without gates and says
 * why. Anything else is retried on the reconnector's back-off, and the gates
 * report "not connected" meanwhile.
 */
async function connectOwnerAtBoot() {
  try {
    const s = await connectOwner();
    logger.info('Owner session ready, for the shield\'s gates only', { via: s.via });
  } catch (err) {
    if (err?.refused) {
      ownerRefused = String(err.message);
      logger.error('Not using MOD_OWNER_APP_PASSWORD', { err: ownerRefused });
      return;
    }
    logger.error('Could not log in as the owner for the shield; trying again', {
      err: String(err?.message || err),
    });
    ownerReconnector.reconnect('boot');
  }
}

// --- one job at a time -------------------------------------------------------
let chain = Promise.resolve();
let pending = 0;

function enqueue(label, job) {
  pending += 1;
  chain = chain
    .then(async () => {
      try {
        await job();
      } catch (err) {
        stats.errors += 1;
        logger.error('Job failed', { label, err });
        // A dead session fails every job the same way until someone logs in
        // again, so the first one to notice asks for that.
        if (isAuthError(err)) {
          reconnector.reconnect(`${label}: ${String(err?.message || err)}`);
        }
      } finally {
        pending -= 1;
      }
    })
    // The count is already settled in `finally`; this only keeps one bad job
    // from breaking the chain for every job after it.
    .catch(() => {});
  return chain;
}

/**
 * Queue a job and hand back what it returned, for the web panel, which has a
 * browser waiting on the answer. A job that throws is the caller's to
 * report, so it is not counted as a failed job, unless the session died,
 * which the queue has to hear about to log in again.
 */
function queued(label, job) {
  return new Promise((resolve, reject) => {
    enqueue(label, async () => {
      try {
        resolve(await job());
      } catch (err) {
        reject(err);
        if (isAuthError(err)) throw err;
      }
    });
  });
}

// --- the DM path -------------------------------------------------------------
let dmTimer = null;
/** When a DM last arrived. The slow loops wait for a quiet minute. */
let lastDmAt = 0;
/** When the DM log was last read, for the panel's health page. */
let lastPollAt = 0;
/** The web panel, when PANEL_PORT is set (src/panel). */
let panel = null;

async function pollDms() {
  const res = await runDmPass({
    chat,
    writeAgent: agent,
    // Lazy: almost every poll finds nothing, and loading the snapshot on each
    // one would keep the idle timer from ever releasing it.
    getIo: async () => (await reference()).io,
    extraTools: await atmosphereTools(),
    model,
    botDid,
    roster: config.roster,
    mode: config.dmMode,
    // "panel" in a DM is answered with a sign-in code while there is a panel.
    signIn: panel ? (did) => panel.codeFor(did) : null,
    log: (msg, fields) => logger.info(msg, fields),
  });
  lastPollAt = Date.now();
  if (res.answered) {
    stats.dmAnswers += res.answered;
    lastDmAt = Date.now();
  }
}

function scheduleDmPoll() {
  dmTimer = setInterval(() => {
    // Skipped while anything is queued or in flight. Noticing a message 2s
    // into a 15s answer changes nothing, and polls stacked behind that answer
    // would then fire back to back against the chat service.
    if (pending > 0 || shuttingDown) return;
    enqueue('dm', pollDms);
  }, config.dmPollMs);
  if (dmTimer.unref) dmTimer.unref();
}

// --- approvals carrying on by themselves -------------------------------------
let carryTimer = null;
/** How often to look for the next batch of a big approval. */
const CARRY_EVERY_MS = 15_000;

/**
 * One batch at a time, and only with nothing else queued, so DMs come first.
 * Not held for a quiet minute: the owner asked for this and is waiting on it.
 */
function scheduleContinuations() {
  carryTimer = setInterval(() => {
    if (pending > 0 || shuttingDown) return;
    enqueue('continue', () =>
      runContinuation({
        chat,
        writeAgent: agent,
        log: (msg, fields) => logger.info(msg, fields),
      }),
    );
  }, CARRY_EVERY_MS);
  if (carryTimer.unref) carryTimer.unref();
}

// --- the slow jobs wait for a quiet minute -----------------------------------
const QUIET_FOR_MS = 60_000;

/**
 * Nothing queued, and no DM for a minute. Anything long waits for this,
 * because while it runs the DM poll skips itself, and an evening of "block"
 * must not sit behind a harvest or a re-score.
 */
const quiet = () =>
  pending === 0 && !shuttingDown && Date.now() - lastDmAt >= QUIET_FOR_MS;

// --- the follow-graph snapshot -----------------------------------------------
let snapshotTimer = null;
let snapshotBusy = false;

/**
 * Build or refresh the snapshot, one budgeted step per queued job, so DMs are
 * answered between steps. `force` skips the quiet check, for the first build
 * after install, when nothing can be scored until it exists.
 */
function runSnapshot({ force = false, restart = false } = {}) {
  if (snapshotBusy) return false;
  if (!force && !quiet()) return false;
  snapshotBusy = true;
  // Only the first step starts afresh; the rest carry on with what it began.
  let fresh = restart;
  const step = () =>
    enqueue('snapshot', async () => {
      let res;
      try {
        res = await snapshotStep({ restart: fresh });
        fresh = false;
      } catch (err) {
        snapshotBusy = false;
        throw err;
      }
      // Every member left failed a moment ago: come back once the first of
      // them may be asked again, rather than at the next hourly check.
      if (res.state === 'waiting') {
        logger.info('Snapshot waiting to ask again', {
          remaining: res.remaining,
          retryInMs: res.retryInMs,
        });
        if (!shuttingDown) setTimeout(step, res.retryInMs + 1000);
        return;
      }
      if (res.state === 'collecting' || res.state === 'finalising') {
        logger.info('Snapshot step', {
          state: res.state,
          remaining: res.remaining,
          indexed: res.indexed,
          unreadable: res.unreadable,
          partial: res.partial?.length,
        });
        if (!shuttingDown) {
          // A DM poll goes in ahead of the next step, so a message sent during
          // the build waits one step at most. The poll timer alone would skip
          // nearly every tick, since a step is almost always queued.
          if (dmTimer) enqueue('dm', pollDms);
          setTimeout(step, 250);
        }
        return;
      }
      snapshotBusy = false;
      if (res.state === 'finalised') {
        // A new snapshot means new scores; drop the held one.
        cached = null;
        logger.info('Snapshot finalised', {
          snapshot: res.snapshot,
          vouches: res.vouches,
          unreadableMembers: res.unreadableMembers,
        });
      }
    });
  step();
  return true;
}

function scheduleSnapshot() {
  snapshotTimer = setInterval(() => runSnapshot(), config.snapshotCheckMs);
  if (snapshotTimer.unref) snapshotTimer.unref();
}

// --- the weekly re-score -----------------------------------------------------
let driftTimer = null;

function scheduleDrift() {
  if (!config.driftEveryHours) {
    logger.info('Drift audits are off');
    return;
  }
  const tick = () => {
    // Only once the DMs are quiet: a re-score is minutes of AppView calls, and
    // the DM poll waits for all of them.
    if (!quiet()) return;
    enqueue('drift', async () => {
      const convoId = await ownerConvo(chat);
      const body = await maybeRunDrift(agent, chat, convoId);
      if (body) logger.info('Sent a drift brief');
    });
  };
  driftTimer = setInterval(tick, config.driftCheckMs);
  if (driftTimer.unref) driftTimer.unref();
}

// --- watched posts, and the owner's own posts taking off ---------------------
let watchTimer = null;
let alertTimer = null;

function scheduleWatching() {
  if (config.watchEveryMs > 0) {
    watchTimer = setInterval(() => {
      if (!quiet()) return;
      // On the config file's model when it names one, as the DMs are, since a
      // watch's triage can add people.
      enqueue('watch', async () =>
        tickWatches({
          chat,
          agent,
          reference,
          model: (await loadAgentConfig())?.model || model,
          everyMs: config.watchEveryMs,
          log: (msg, fields) => logger.info(msg, fields),
          activity: config.stream ? activity : null,
        }).finally(() => dust?.refresh()),
      );
    }, config.watchEveryMs);
    if (watchTimer.unref) watchTimer.unref();
  }
  if (config.alertEveryMs > 0) {
    alertTimer = setInterval(() => {
      if (!quiet()) return;
      enqueue('alerts', () =>
        tickAlerts({
          chat,
          convoFor: () => ownerConvo(chat),
          log: (msg, fields) => logger.info(msg, fields),
          activity: config.stream ? activity : null,
          menuFor: async (uri) => ownPostOptions(await postFacts(uri, { deps: shieldDeps })),
        }),
      );
    }, config.alertEveryMs);
    if (alertTimer.unref) alertTimer.unref();
  }
}

// --- the shield ---------------------------------------------------------------
let shieldTimer = null;
let shieldQueued = false;
let shieldDeps = null;

function buildShield() {
  const gates =
    config.shield.canGate && !ownerRefused
      ? createGates({ getAgent: () => ownerSession, ownerDid: config.ownerDid })
      : null;
  shieldDeps = {
    cfg: config.shield,
    gates,
    gatesProblem: ownerRefused ? `Not using MOD_OWNER_APP_PASSWORD: ${ownerRefused}` : null,
    activity,
    // Bands from the same scorer as every scan. With no snapshot yet this
    // throws, and nothing counts as a stranger.
    outsideAmong: createClassifier({
      score: async (dids) => (await reference()).io.score(dids),
    }),
    postInfo: createPostInfo({ gates }),
    // Ask mode: the watch puts the hostile ones to the owner with a 👍.
    startWatch:
      config.watchEveryMs > 0
        ? async (uri, convoId = null) =>
            startWatch({
              convoId: convoId || (await ownerConvo(chat)),
              target: uri,
              hours: 24,
              auto: false,
            })
        : null,
    notify: async (msg) => sendNotice(chat, await ownerConvo(chat), msg),
    streaming: config.stream,
    dryRun: config.dryRun,
    log: (msg, fields) => logger.info(msg, fields),
  };
  setShieldDeps(shieldDeps);
  if (!config.stream && (config.shield.mode !== 'off' || config.shield.attack.mode !== 'off')) {
    logger.warn(
      'MOD_STREAM is off, so the shield cannot count replies and quotes; only "shields up" and the commands work',
    );
  }
}

/**
 * Every minute, through the job queue but without waiting for a quiet
 * minute: a pile-on is exactly when the DMs are busy. One queued at a time.
 * Cheap when nothing is happening: two reads of the store.
 */
function scheduleShield() {
  shieldTimer = setInterval(() => {
    if (shuttingDown || shieldQueued) return;
    shieldQueued = true;
    enqueue('shield', async () => {
      try {
        const { fired } = await shieldTick(shieldDeps);
        if (fired.length) logger.info('Shield', { fired: fired.join(', ') });
      } catch (err) {
        // The owner's session failing is the owner's to reconnect, never the
        // bot's, which is what the queue does with an auth error it is handed.
        if (!err?.fromOwner) throw err;
        if (isAuthError(err)) {
          ownerReconnector.reconnect(`shield: ${String(err?.message || err)}`);
        }
        logger.error('Shield tick failed on the owner session', {
          err: String(err?.message || err),
        });
      } finally {
        shieldQueued = false;
      }
    });
  }, SHIELD_EVERY_MS);
  if (shieldTimer.unref) shieldTimer.unref();
}

// --- room on the data disk ---------------------------------------------------
let diskTimer = null;
let diskWarnedAt = 0;
const DISK_CHECK_MS = 60 * 60_000;
const DISK_WARN_EVERY_MS = 24 * 60 * 60_000;

/**
 * Hourly: when the data disk runs low, say so in the log and, once a day, by
 * DM, before SQLite starts refusing writes. Reading the disk is not a job and
 * waits for nothing; the DM goes through the queue like any other.
 */
function scheduleDiskCheck() {
  const check = async () => {
    let space;
    try {
      space = await diskSpace(config.dataDir);
    } catch {
      return;
    }
    if (!isLow(space)) return;
    logger.error('The data disk is nearly full', { space: describeDisk(space) });
    if (config.dryRun || Date.now() - diskWarnedAt < DISK_WARN_EVERY_MS) return;
    diskWarnedAt = Date.now();
    enqueue('disk', async () => {
      const convoId = await ownerConvo(chat);
      await chat.chat.bsky.convo.sendMessage({
        convoId,
        message: {
          text: `The bot's data disk is nearly full: ${describeDisk(space)}. Give it a bigger disk before writes start failing; docs/DEPLOY.md says how for each host.`,
        },
      });
    });
  };
  check();
  diskTimer = setInterval(check, DISK_CHECK_MS);
  if (diskTimer.unref) diskTimer.unref();
}

// --- retention ---------------------------------------------------------------
// What the database keeps (MOD_KEEP_*), cleared a few minutes after start and
// then once a day.
let retentionTimer = null;
const RETENTION_EVERY_MS = 24 * 60 * 60_000;
const RETENTION_FIRST_MS = 5 * 60_000;

function scheduleRetention() {
  const run = () =>
    enqueue('retention', async () => {
      const res = await pruneData();
      if (res.audits || res.plans) logger.info('Cleared old data', res);
    });
  retentionTimer = setTimeout(function again() {
    run();
    retentionTimer = setTimeout(again, RETENTION_EVERY_MS);
    if (retentionTimer.unref) retentionTimer.unref();
  }, RETENTION_FIRST_MS);
  if (retentionTimer.unref) retentionTimer.unref();
}

// --- stats -------------------------------------------------------------------
function logStats() {
  logger.info('stats', {
    ...stats,
    reference: cached ? 'held' : 'released',
    streamed: activity.size(),
    queued: pending,
    rss_mb: (process.memoryUsage().rss / 1048576).toFixed(1),
    heap_mb: (process.memoryUsage().heapUsed / 1048576).toFixed(1),
  });
}

// --- start -------------------------------------------------------------------
let statsTimer = null;
let stream = null;
let dust = null;
let lease = null;

/**
 * Wait until no other copy holds this data directory, or this Postgres
 * database (lease.js). Waiting rather than exiting, so a restart policy does
 * not turn a second copy into a loop of failed starts.
 */
async function holdLease() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const shared = usingPostgres();
  for (;;) {
    const got = shared
      ? await acquireDbLease({ call: rpc })
      : acquireLease({ dir: config.dataDir });
    if (got.ok) return got;
    logger.error(
      shared
        ? 'Another copy of the bot is running on this database; waiting for it to stop'
        : 'Another copy of the bot is running on this data directory; waiting for it to stop',
      {
        host: got.holder?.host,
        pid: got.holder?.pid,
        lastSeenS: Math.round((Date.now() - got.holder?.heartbeatAt) / 1000),
      },
    );
    await new Promise((r) => setTimeout(r, HEARTBEAT_MS));
  }
}
let shuttingDown = false;

async function start() {
  // Inside start(), not at module scope, so a missing environment variable is
  // a readable list in the log instead of an ESM stack trace.
  assertConfig();
  installProvider();
  await openDb();
  lease = await holdLease();
  loadState();

  const session = await connectAtBoot();
  await settleBotAccount();
  if (config.shield.canGate) await connectOwnerAtBoot();
  buildShield();
  try {
    const owner = await agent.app.bsky.actor.getProfile({ actor: config.ownerDid });
    setOwnerHandle(owner.data.handle);
  } catch (err) {
    logger.warn('Could not read the owner profile', { err: err.message });
  }
  logger.info('Moderator session ready', {
    did: botDid,
    handle: agent.session?.handle,
    via: session.via,
  });

  // Probe the chat service once at boot. An app password made without "Allow
  // access to your direct messages" is simply excluded from chat.bsky.*, so
  // the DM loop would find nothing and report success forever.
  try {
    await chat.chat.bsky.convo.getLog({});
    logger.info('Chat access confirmed');
  } catch (err) {
    logger.error(
      'Chat access FAILED: the app password is probably missing DM access. ' +
        'Bluesky: Settings -> Privacy and Security -> App Passwords, with ' +
        '"Allow access to your direct messages" ticked. The DM loop will find nothing.',
      { err: err.message },
    );
  }

  // A dry run never posts or DMs. The DM loop, the re-score, watches and
  // alerts all send DMs or write to the list, so they stay off.
  if (config.dryRun) {
    logger.info('DRY_RUN: DMs, the re-score, watches and alerts are off');
  } else {
    // The first poll is queued here, ahead of any snapshot step. On a first
    // start it records where the DM log ends at this moment, so a message
    // sent from then on, such as a "help" during the first build, is answered
    // rather than filed as history.
    enqueue('dm', pollDms);
    scheduleDmPoll();
    scheduleContinuations();
    scheduleDrift();
    scheduleWatching();
  }

  // Nothing can be scored until the first snapshot exists, so build it now
  // rather than waiting for the hourly check. The same goes for a change of
  // MOD_SCORING, which is made by restarting with it.
  const usable = await usableSnapshot();
  if (!usable) {
    logger.info(
      config.scoring === 'simple'
        ? 'No follow-graph snapshot yet; reading who you follow.'
        : 'No follow-graph snapshot yet; building one. This takes a few minutes, and DMs are answered in between.',
    );
    runSnapshot({ force: true });
  } else if (usable.scoring !== config.scoring) {
    logger.info('Scoring changed; building a new snapshot', {
      from: usable.scoring,
      to: config.scoring,
    });
    runSnapshot({ force: true });
  }

  scheduleSnapshot();
  scheduleShield();
  scheduleDiskCheck();
  scheduleRetention();

  const protect = ownerGraphHandler({
    ownerDid: config.ownerDid,
    excluded: UNPROTECTED_LISTS,
    // The held reference has the old protected set; the next use reloads it.
    onProtect: () => {
      cached = null;
    },
    log: (msg, fields) => logger.info(msg, fields),
  });
  stream = connectJetstream({
    dids: [config.ownerDid],
    // The owner's posts too: in attack mode a new one is gated as it lands.
    collections: [...OWNER_GRAPH_COLLECTIONS, 'app.bsky.feed.post'],
    onEvent: async (event) => {
      await protect(event);
      await onOwnerPost(event, shieldDeps).catch((err) => {
        if (err?.fromOwner && isAuthError(err)) {
          ownerReconnector.reconnect('gating a new post');
        }
        logger.error('Could not gate a new post', { err: String(err?.message || err) });
      });
      if (event?.time_us) setCursor(event.time_us);
    },
  });

  if (config.stream) {
    dust = connectSpacedust({
      subjectDids: [config.ownerDid],
      subjects: watchedUris,
      onLink: (msg) => activity.record(msg),
      // No replay: what was said while the socket was down is not known, so
      // the tracker counts its window from when the stream came back.
      onOpen: (subjects) => activity.opened(subjects),
      onDown: () => activity.closed(),
    });
  }

  if (config.statsIntervalMs > 0) {
    statsTimer = setInterval(logStats, config.statsIntervalMs);
    if (statsTimer.unref) statsTimer.unref();
  }

  // Warm the tool list at boot so the first question does not pay for it, and
  // so a misconfigured URL shows up now rather than mid-answer.
  await atmosphereTools();

  // The web panel. Signing in is a DM, and a dry run reads none, so it stays
  // off then. A port that cannot be opened is logged and the bot carries on.
  if (config.panel.port && config.dryRun) {
    logger.info('DRY_RUN: the panel is off, since signing in to it is a DM');
  } else if (config.panel.port) {
    panel = await startPanel({
      queued,
      agent: () => agent,
      chat: () => chat,
      reference,
      // The panel's buttons for a new snapshot and a re-score now. Each starts
      // the work and returns; it runs on the queue between DMs, and a failure
      // is logged like any other job's.
      rebuild: () =>
        runSnapshot({ force: true, restart: true })
          ? { started: true }
          : { started: false, reason: 'A snapshot is already being built.' },
      rescore: () => {
        enqueue('drift', async () => {
          const convoId = await ownerConvo(chat);
          const body = await maybeRunDrift(agent, chat, convoId, { force: true });
          if (body) logger.info('Sent a drift brief');
        });
        return { started: true };
      },
      vitals: () => ({
        queued: pending,
        dmAnswers: stats.dmAnswers,
        errors: stats.errors,
        lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
        lastDmAt: lastDmAt ? new Date(lastDmAt).toISOString() : null,
        snapshotBusy,
        reference: cached ? 'held' : 'released',
      }),
    });
  }

  // The config file's model, when it names one, takes the place of the
  // environment's for DMs and the write check.
  const fileModel = (await loadAgentConfig())?.model;
  logger.info('Bot started', {
    owner: config.ownerDid,
    answering: config.roster.all.length,
    writers: config.roster.allWriters.length,
    atmosphere: config.atmosphere ? Object.keys(atmoTools).length : 'off',
    dmPollMs: config.dmPollMs,
    driftEveryHours: config.driftEveryHours,
    dryRun: config.dryRun,
    provider: config.provider,
    model: modelsEnabled() ? fileModel || model : '(none: commands only)',
    dmMode: config.dmMode,
    check: checkModelFor(fileModel || model),
    escalation: ESCALATION_MODEL,
    watchEveryMs: config.watchEveryMs,
    alertEveryMs: config.alertEveryMs,
    shield: config.shield.mode,
    attack: config.shield.attack.mode,
    gates: shieldDeps?.gates ? 'on' : ownerRefused ? 'refused' : 'off',
    logLevel: logger.level,
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  // No new approval batch starts; one already sent can finish and be
  // recorded within the wait below.
  stopWrites();
  logger.info('Shutting down', { signal });
  if (dmTimer) clearInterval(dmTimer);
  if (carryTimer) clearInterval(carryTimer);
  if (driftTimer) clearInterval(driftTimer);
  if (snapshotTimer) clearInterval(snapshotTimer);
  if (watchTimer) clearInterval(watchTimer);
  if (alertTimer) clearInterval(alertTimer);
  if (shieldTimer) clearInterval(shieldTimer);
  if (statsTimer) clearInterval(statsTimer);
  if (diskTimer) clearInterval(diskTimer);
  if (retentionTimer) clearTimeout(retentionTimer);
  stream?.close();
  dust?.close();
  await panel?.close().catch(() => {});
  // Let an in-flight answer finish rather than leave half a reply posted.
  // Docker waits 10s by default before killing (compose.yaml sets 60s),
  // systemd 90s.
  await Promise.race([chain, new Promise((r) => setTimeout(r, 45_000))]);
  await lease?.release();
  await closeDb();
  logStats();
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  stats.errors += 1;
  logger.error('uncaughtException', { err });
});
process.on('unhandledRejection', (err) => {
  stats.errors += 1;
  logger.error('unhandledRejection', { err });
});

start().catch((err) => {
  logger.error('Failed to start', { err });
  process.exit(1);
});
