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
//
// The bot never posts in public. Everything it says goes to a DM.
//
// ONE JOB AT A TIME. An answer is a 5-20s model call holding the snapshot in
// memory, and this is meant to run on a small machine. Serialising also means
// a burst of DMs cannot open many harvests against the AppView at once.

import {
  createAtmosphereClient,
  loadAtmosphereTools,
} from './lib/mcp.js';
import { loadReference, makeIo } from './bot/reference.js';
import { loadAgentConfig } from './bot/agentConfig.js';
import { runDmPass } from './bot/dmLoop.js';
import { stopWrites } from './bot/bulkPlan.js';
import { checkModelFor, ESCALATION_MODEL } from './bot/tiers.js';
import { botAgent, chatView } from './bot/botAgent.js';
import { openDb, closeDb } from './bot/db.js';
import { snapshotStep, hasSnapshot, UNPROTECTED_LISTS } from './snapshot.js';
import { connectJetstream } from './jetstream.js';
import { loadState, setCursor } from './state.js';
import { ownerGraphHandler, OWNER_GRAPH_COLLECTIONS } from './ownerGraph.js';
import { installProvider, MODELS, modelsEnabled } from './models.js';

import { config, assertConfig } from './config.js';
import { setOwnerHandle } from './constants.js';
import { logger } from './logger.js';
import { maybeRunDrift, ownerConvo } from './drift.js';
import { tickWatches, tickAlerts } from './watching.js';
import { isAuthError, createReconnector } from './session.js';

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

// --- the DM path -------------------------------------------------------------
let dmTimer = null;
/** When a DM last arrived. The slow loops wait for a quiet minute. */
let lastDmAt = 0;

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
    log: (msg, fields) => logger.info(msg, fields),
  });
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
function runSnapshot({ force = false } = {}) {
  if (snapshotBusy) return;
  if (!force && !quiet()) return;
  snapshotBusy = true;
  const step = () =>
    enqueue('snapshot', async () => {
      let res;
      try {
        res = await snapshotStep();
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
        }),
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
        }),
      );
    }, config.alertEveryMs);
    if (alertTimer.unref) alertTimer.unref();
  }
}

// --- stats -------------------------------------------------------------------
function logStats() {
  logger.info('stats', {
    ...stats,
    reference: cached ? 'held' : 'released',
    queued: pending,
    rss_mb: (process.memoryUsage().rss / 1048576).toFixed(1),
    heap_mb: (process.memoryUsage().heapUsed / 1048576).toFixed(1),
  });
}

// --- start -------------------------------------------------------------------
let statsTimer = null;
let stream = null;
let shuttingDown = false;

async function start() {
  // Inside start(), not at module scope, so a missing environment variable is
  // a readable list in the log instead of an ESM stack trace.
  assertConfig();
  installProvider();
  openDb();
  loadState();

  const session = await connectAtBoot();
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
    scheduleDrift();
    scheduleWatching();
  }

  // Nothing can be scored until the first snapshot exists, so build it now
  // rather than waiting for the hourly check.
  if (!(await hasSnapshot())) {
    logger.info(
      'No follow-graph snapshot yet; building one. This takes a few minutes, and DMs are answered in between.',
    );
    runSnapshot({ force: true });
  }

  scheduleSnapshot();

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
    collections: OWNER_GRAPH_COLLECTIONS,
    onEvent: async (event) => {
      await protect(event);
      if (event?.time_us) setCursor(event.time_us);
    },
  });

  if (config.statsIntervalMs > 0) {
    statsTimer = setInterval(logStats, config.statsIntervalMs);
    if (statsTimer.unref) statsTimer.unref();
  }

  // Warm the tool list at boot so the first question does not pay for it, and
  // so a misconfigured URL shows up now rather than mid-answer.
  await atmosphereTools();

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
  if (driftTimer) clearInterval(driftTimer);
  if (snapshotTimer) clearInterval(snapshotTimer);
  if (watchTimer) clearInterval(watchTimer);
  if (alertTimer) clearInterval(alertTimer);
  if (statsTimer) clearInterval(statsTimer);
  stream?.close();
  // Let an in-flight answer finish rather than leave half a reply posted.
  // Docker waits 10s by default before killing (compose.yaml sets 60s),
  // systemd 90s.
  await Promise.race([chain, new Promise((r) => setTimeout(r, 45_000))]);
  closeDb();
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
