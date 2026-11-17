// How the panel is joined to the running bot.
//
// index.js owns the session, the job queue and the timers. It hands over a
// few hooks, and this file turns them into what server.js asks for, so the
// server itself knows nothing about how the bot is put together and can be
// run against a store with no bot at all (scripts/panel-demo.js).

import fs from 'node:fs';
import path from 'node:path';
import { generateText } from 'ai';

import { config } from '../config.js';
import { OWNER_HANDLE } from '../constants.js';
import { logger } from '../logger.js';
import { MODELS, modelsEnabled } from '../models.js';
import { getCursor } from '../state.js';
import { diskSpace, isLow } from '../disk.js';
import { ownerConvo } from '../drift.js';
import { loadAgentConfig } from '../bot/agentConfig.js';
import { proposePlan } from '../bot/bulkPlan.js';
import { usingPostgres } from '../bot/db.js';
import { runCommand } from '../bot/dmLoop.js';
import { graphFacts, heldListed } from '../bot/graphFacts.js';
import { botLists, multiListOn } from '../bot/lists.js';
import { listNotes } from '../bot/memory.js';
import { checkModelFor, ESCALATION_MODEL } from '../bot/tiers.js';
import { stopWatch } from '../bot/watch.js';
import { createProfiles } from './profiles.js';
import { createPanel } from './server.js';

const REFRESH_LIST_EVERY_MS = 60_000;

/**
 * @param {object} bot
 * @param {Function} bot.queued     (label, job) => Promise of the job's result,
 *                                  run on the bot's one queue
 * @param {Function} bot.agent      () => the bot's session
 * @param {Function} bot.chat       () => the chat view of it
 * @param {Function} bot.reference  async () => the held scoring reference
 * @param {Function} bot.vitals     () => what the process is doing right now
 * @returns {Promise<object|null>} the panel, listening, or null if it could not start
 */
export async function startPanel(bot) {
  const startedAt = new Date().toISOString();
  const listUri = () => process.env.MOD_LIST_URI || null;
  const activeModel = async () =>
    modelsEnabled() ? (await loadAgentConfig())?.model || MODELS.agent : null;

  /** list -> when the panel last asked for it to be brought up to date. */
  const refreshedAt = new Map();
  async function members(list = listUri()) {
    if (!list) return null;
    let held = heldListed(list);
    if (!held) {
      // Nothing walked yet: read the list once, on the queue like every
      // other read of the network.
      await bot.queued('panel-list', () => graphFacts({ list })).catch(() => null);
      held = heldListed(list);
    } else if (Date.now() - (refreshedAt.get(list) || 0) > REFRESH_LIST_EVERY_MS) {
      // Held: answer from it now, and let the queue bring it up to date when
      // it is due (graphFacts decides that).
      refreshedAt.set(list, Date.now());
      bot.queued('panel-list', () => graphFacts({ list })).catch(() => {});
    }
    if (!held) return null;
    return { dids: [...held.listed.keys()], complete: held.complete, at: held.at };
  }

  // The bot's lists, numbered as its "Which list?" menus number them. Read
  // from the bot's PDS without a session and held for ten minutes
  // (src/bot/lists.js), so it does not wait its turn on the queue.
  const lists = async () => ({ multi: multiListOn(), lists: await botLists() });

  function status() {
    const agent = bot.agent();
    const model = modelsEnabled() ? MODELS.agent : null;
    return {
      startedAt,
      now: new Date().toISOString(),
      ...bot.vitals(),
      bot: { did: agent?.session?.did || null, handle: agent?.session?.handle || null },
      owner: { did: config.ownerDid, handle: OWNER_HANDLE || null },
      list: listUri(),
      dryRun: config.dryRun,
      dmMode: config.dmMode,
      scoring: config.scoring,
      provider: config.provider,
      model,
      models: model
        ? { agent: model, check: checkModelFor(model), escalation: ESCALATION_MODEL || null }
        : null,
      jetstreamCursor: getCursor(),
    };
  }

  async function health() {
    let disk = null;
    try {
      const space = await diskSpace(config.dataDir);
      disk = { ...space, low: isLow(space) };
    } catch {
      disk = null;
    }
    let database = { kind: usingPostgres() ? 'Postgres' : 'SQLite', bytes: null };
    if (!usingPostgres()) {
      const file =
        process.env.DATABASE_PATH || path.join(config.dataDir, 'bluesky-mod.db');
      try {
        database = { ...database, bytes: fs.statSync(file).size };
      } catch {
        // An in-memory store has no file.
      }
    }
    const mem = process.memoryUsage();
    return {
      ...status(),
      disk,
      database,
      memory: { rss: mem.rss, heap: mem.heapUsed },
      intervals: {
        dmPollMs: config.dmPollMs,
        driftEveryHours: config.driftEveryHours,
        snapshotMaxAgeDays: config.snapshotMaxAgeDays,
        watchEveryMs: config.watchEveryMs,
        alertEveryMs: config.alertEveryMs,
      },
    };
  }

  /** The settings worth showing. Nothing here is a secret, and nothing here
   *  can be changed from the panel: they live in the environment. */
  async function settings(session) {
    const file = await loadAgentConfig();
    const owner = session.tier === 'owner';
    return {
      mode: config.dmMode,
      scoring: config.scoring,
      dryRun: config.dryRun,
      provider: config.provider,
      atmosphere: config.atmosphere,
      database: usingPostgres() ? 'Postgres' : 'SQLite',
      list: listUri(),
      multiList: multiListOn(),
      // What the shield is set to do. Its gates need the owner's own app
      // password; without one it can only say what it sees.
      shield: {
        mode: config.shield.mode,
        attack: config.shield.attack.mode,
        canGate: config.shield.canGate,
        stream: Boolean(config.stream),
      },
      keep: config.keep,
      rescoreEveryHours: config.driftEveryHours,
      snapshotMaxAgeDays: config.snapshotMaxAgeDays,
      watchEveryMs: config.watchEveryMs,
      alertEveryMs: config.alertEveryMs,
      panel: { url: config.panel.url || null, sessionDays: config.panel.sessionDays },
      // The config file is the owner's standing instructions to the bot.
      file: file
        ? {
            style: owner ? file.style || null : Boolean(file.style),
            guidance: owner ? file.guidance || null : Boolean(file.guidance),
            openers: Boolean(file.openers),
            report: Boolean(file.report),
            postReport: Boolean(file.postReport),
            model: file.model || null,
            limits: file.limits || null,
            barePost: file.barePost || null,
          }
        : null,
      notes: session.canWrite
        ? (await listNotes()).map((n) => ({
            text: n.text,
            at: n.created_at,
            byOwner: !n.author_did || n.author_did === config.ownerDid,
          }))
        : null,
    };
  }

  const panel = createPanel({
    settings: config.panel,
    roster: config.roster,
    log: (msg, fields) => logger.info(msg, fields),
    deps: {
      enqueue: bot.queued,
      writeAgent: bot.agent,
      runCommand,
      proposePlan,
      lookUp: async (actor) => (await bot.reference()).io.lookUp(actor),
      ownerConvo: () => ownerConvo(bot.chat()),
      model: activeModel,
      generate: generateText,
      lists,
      members,
      profiles: createProfiles(),
      stopWatch: (uri) => stopWatch({ target: uri }),
      status,
      health,
      settings,
      log: (msg, fields) => logger.info(msg, fields),
    },
  });

  try {
    await panel.listen();
  } catch (err) {
    logger.error('The panel could not start; the bot carries on without it', {
      port: config.panel.port,
      host: config.panel.host,
      err: String(err?.message || err),
    });
    return null;
  }
  logger.info('The panel is listening', {
    at: config.panel.url || `http://${config.panel.host}:${config.panel.port}`,
    signIn: 'send the bot "panel" in a DM for a code',
  });
  return panel;
}
