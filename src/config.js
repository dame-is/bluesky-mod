// Configuration, read once at startup and validated loudly.
//
// Values come from the environment: a `.env` file through Docker's env_file
// or systemd's EnvironmentFile, or `node --env-file=.env`. See .env.example
// for every setting, commented.

import { OWNER_DID } from './constants.js';
import { normaliseMode } from './bot/dmLoop.js';
import { rosterFromEnv, parseDids } from './lib/senders.js';
import { modelProblems, modelsEnabled, PROVIDER, MODELS } from './models.js';

const num = (v, d) => (v == null || v === '' ? d : Number(v));
const flag = (v, d) =>
  v == null || v === '' ? d : String(v).trim().toLowerCase() === 'true';

export const config = {
  /** The account the bot works for. Always answered, always may write. */
  ownerDid: OWNER_DID,

  /**
   * Who else is answered, and who may change the list.
   *
   * MOD_ALLOWED_DIDS is read-only: the analyst, lookups, post scans, `review`
   * and `history`. MOD_WRITER_DIDS is the upgrade path and is empty by default,
   * because being able to talk to the bot and being able to add someone to a
   * live block list are different powers with very different costs.
   *
   * Both surfaces (DMs and public mentions) consult this one object, so a
   * change to who is answered cannot move one boundary and leave the other.
   */
  roster: rosterFromEnv(process.env, OWNER_DID),

  /**
   * Jetstream, for public mentions. Filtered at the transport to the roster's
   * own posts, so it is a trickle rather than the firehose.
   */
  jetstreamHost:
    process.env.JETSTREAM_HOST || 'jetstream2.us-west.bsky.network',
  reconnectBaseMs: num(process.env.RECONNECT_BASE_MS, 1000),
  reconnectMaxMs: num(process.env.RECONNECT_MAX_MS, 30_000),

  /**
   * Force a reconnect on this interval.
   *
   * The subscription is filtered to a few DIDs, so the socket is silent for
   * hours at a time and "no traffic" cannot be told apart from "the connection
   * died quietly". Reconnecting resumes from the stored cursor, so a cycle
   * costs nothing and misses nothing.
   */
  reconnectEveryMs: num(process.env.RECONNECT_EVERY_MS, 15 * 60_000),

  /**
   * DM poll interval.
   *
   * 2s is 0.5 req/s against a documented 10/s per-IP ceiling, and getLog with a
   * stored cursor returns almost nothing when idle. Going lower buys little: a
   * model call takes 5-20s, so 2s to 500ms moves felt latency by under 10%.
   */
  dmPollMs: num(process.env.DM_POLL_MS, 2000),

  /**
   * How long a loaded snapshot is reused, and how long after the last question
   * it is dropped. The vouch table can run to tens of thousands of rows, and
   * holding it forever to answer a question every few days is the wrong trade
   * on a small machine; reloading it takes a second or two.
   */
  referenceTtlMs: num(process.env.REFERENCE_TTL_MS, 15 * 60_000),
  referenceIdleMs: num(process.env.REFERENCE_IDLE_MS, 10 * 60_000),

  /** Where the Jetstream resume point and the answered set live. */
  stateDir: process.env.STATE_DIR || process.env.DATA_DIR || 'data',
  cursorFile: process.env.CURSOR_FILE || 'jetstream-cursor.txt',
  answeredFile: process.env.ANSWERED_FILE || 'answered.json',
  answeredKeep: num(process.env.ANSWERED_KEEP, 500),

  /**
   * Who answers a DM by default: "classic" (typed commands, numbered menus,
   * a read-only analyst for everything else) or "agent" (one model with the
   * write tools, talked to in sentences). In agent mode a message starting
   * with "!" still takes the classic path. Public replies are unaffected.
   */
  dmMode: normaliseMode(process.env.MOD_DM_MODE),

  /** The agent's model, when it should differ from the analyst's. */
  operatorModel: process.env.MOD_OPERATOR_MODEL || null,

  /** Which model provider, and which models (src/models.js). */
  provider: PROVIDER,
  models: MODELS,

  /** true = classify and log, never post or DM. */
  dryRun: flag(process.env.DRY_RUN, false),

  /**
   * Answer public mentions at all. Off leaves the DM loop running alone. Also
   * off when there is no model, since the public path is the analyst.
   */
  publicReplies: flag(process.env.PUBLIC_REPLIES, true) && modelsEnabled(),

  /**
   * The Atmosphere MCP server, which gives the analyst the rest of the network:
   * author feeds, threads, post search, identity history, the atproto docs.
   * Off leaves it with the bot's own scoring tools, which still answer every
   * scoring question, just not "what have they been posting about".
   */
  atmosphere: flag(process.env.ATMOSPHERE, true) && modelsEnabled(),
  atmosphereUrl: process.env.ATMOSPHERE_URL || 'https://aturi.to/api/mcp',
  /** How long the tool list is reused before it is fetched again. */
  atmosphereTtlMs: num(process.env.ATMOSPHERE_TTL_MS, 6 * 60 * 60_000),

  /**
   * How often to ask whether the follow-graph snapshot needs rebuilding. It is
   * rebuilt when older than SNAPSHOT_MAX_AGE_DAYS (7), so this is cheap.
   */
  snapshotCheckMs: num(process.env.SNAPSHOT_CHECK_MS, 60 * 60_000),

  /**
   * How often to re-score the list and report what moved.
   *
   * Weekly by default. A sweep knows one moment of the graph, and the graph
   * keeps moving: a stranger blocked today may be a friend of a friend in a
   * month. 0 turns it off.
   */
  driftEveryHours: num(process.env.DRIFT_EVERY_HOURS, 168),
  /** How often to ask whether a drift run is due. */
  driftCheckMs: num(process.env.DRIFT_CHECK_MS, 60 * 60_000),

  /**
   * How often watched posts are read again ("watch this"). Each read waits for
   * the DMs to have been quiet for a minute, so a burst of blocks never sits
   * behind a harvest. 0 turns watching off.
   */
  watchEveryMs: modelsEnabled()
    ? num(process.env.MOD_WATCH_EVERY_MS, 5 * 60_000)
    : 0,
  /**
   * How often the owner's own recent posts are checked for a sudden run of
   * quotes and replies, which gets a DM offering to watch it. MOD_ALERTS=off
   * stops it; MOD_ALERT_THRESHOLD (default 15 in an hour) sets what counts.
   */
  alertEveryMs:
    String(process.env.MOD_ALERTS || 'on').toLowerCase() === 'off' ||
    !modelsEnabled()
      ? 0
      : num(process.env.MOD_ALERT_EVERY_MS, 10 * 60_000),

  /**
   * How long a network digest may spend reading author feeds. A fan-out over a
   * couple of hundred accounts measured about 9 seconds, so 45s is headroom
   * for a slow day. When it IS spent, the digest says how many accounts went
   * unread instead of returning a short answer that looks complete.
   */
  pulseBudgetMs: num(process.env.PULSE_BUDGET_MS, 45_000),

  statsIntervalMs: num(process.env.STATS_INTERVAL_MS, 30 * 60_000),
};

const DID = /^did:(plc|web):[a-zA-Z0-9._:%-]+$/;
const LIST = /^at:\/\/(did:[^/]+)\/app\.bsky\.graph\.list\/[^/]+$/;

/** Everything wrong with the environment, as one error. */
export function assertConfig(env = process.env) {
  const problems = [];
  if (!DID.test(env.MOD_OWNER_DID || '')) {
    problems.push('MOD_OWNER_DID must be your own account\'s DID (did:plc:...)');
  }
  // A DID rather than a handle: a handle is rented, so renaming the bot would
  // break its login from inside a process nobody is watching, and a DID can be
  // checked against the session that comes back.
  if (!DID.test(env.MOD_IDENTIFIER || '')) {
    problems.push('MOD_IDENTIFIER must be the bot account\'s DID (did:plc:...)');
  }
  if (!env.MOD_APP_PASSWORD) {
    problems.push('MOD_APP_PASSWORD must be an app password for the bot account, with DM access');
  }
  if (!LIST.test(env.MOD_LIST_URI || '')) {
    problems.push(
      'MOD_LIST_URI must be the at:// URI of a list the bot account owns (npm run setup creates one)',
    );
  } else if (LIST.exec(env.MOD_LIST_URI)[1] !== env.MOD_IDENTIFIER) {
    // The bot can only write to its own repo. Pointing at a list somewhere
    // else makes every write fail with a permission error that explains
    // nothing, so say it here instead.
    problems.push(
      'MOD_LIST_URI must name a list in the BOT account\'s repo (its at:// URI starts with MOD_IDENTIFIER)',
    );
  }
  if (env.MOD_OWNER_DID && env.MOD_OWNER_DID === env.MOD_IDENTIFIER) {
    problems.push('MOD_OWNER_DID and MOD_IDENTIFIER are the same account; the bot would answer itself');
  }
  problems.push(...modelProblems(env));
  if (config.dmMode === 'agent' && !modelsEnabled()) {
    problems.push('MOD_DM_MODE=agent needs a model provider; set one or use classic mode');
  }
  // A DID that fails to parse is DROPPED by parseDids rather than carried, so a
  // typo in an allowlist would otherwise be silent: an account that is simply
  // never answered, with nothing in the log to say why.
  for (const name of ['MOD_ALLOWED_DIDS', 'MOD_WRITER_DIDS']) {
    const given = String(env[name] ?? '')
      .split(/[\s,]+/)
      .filter(Boolean);
    const kept = parseDids(env[name]);
    if (given.length !== kept.length) {
      const bad = given.filter((g) => !kept.includes(g));
      problems.push(`${name} has entries that are not DIDs: ${bad.join(', ')}`);
    }
  }
  if (env.MOD_IDENTIFIER && config.roster.all.includes(env.MOD_IDENTIFIER)) {
    problems.push('the bot account is on its own roster, so it would answer itself');
  }
  if (problems.length) {
    throw new Error(
      `the configuration is not usable:\n  - ${problems.join('\n  - ')}`,
    );
  }
}
