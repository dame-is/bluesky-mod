// Configuration, read once at startup and checked loudly.
//
// Values come from the environment: a `.env` file through Docker's env_file
// or systemd's EnvironmentFile, or `node --env-file=.env`. See .env.example
// for the settings most people change.

import { OWNER_DID } from './constants.js';
import { normaliseMode } from './bot/dmLoop.js';
import { rosterFromEnv, parseDids } from './lib/senders.js';
import { modelProblems, modelsEnabled, PROVIDER } from './models.js';

/** Number settings that did not parse, reported by assertConfig. */
const badNumbers = [];

/** The longest delay a Node timer takes. A longer one fires after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * A number setting, or its default when unset. A typo must not reach a timer:
 * setInterval given NaN or 0 fires at once, over and over. `min` and `max`
 * bound a value above 0; 0 itself is allowed unless `positive`.
 */
function num(
  name,
  fallback,
  { positive = false, min = 0, max = Infinity, whole = false } = {},
) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  const inRange = n === 0 ? !positive : n >= min && n <= max;
  if (!Number.isFinite(n) || !inRange || (whole && !Number.isInteger(n))) {
    badNumbers.push(`${name} must be ${wanted({ positive, min, max, whole })}`);
    return fallback;
  }
  return n;
}

/** What num() takes, in words. */
function wanted({ positive, min, max, whole }) {
  const low = min > 0 ? String(min) : positive ? null : '0';
  const range =
    max === Infinity
      ? low ? `, ${low} or more` : ' above 0'
      : low ? ` from ${low} to ${max}` : ` above 0 and at most ${max}`;
  const kind = whole ? 'a whole number' : 'a number';
  return `${!positive && min > 0 ? '0 (off) or ' : ''}${kind}${range}`;
}

/**
 * A delay setting that goes to setTimeout or setInterval. `min` is set where
 * a slip of units (seconds for milliseconds) would turn a slow loop into one
 * that runs back to back against the network.
 */
const delay = (name, fallback, opts = {}) =>
  num(name, fallback, { ...opts, max: MAX_TIMER_MS });

const flag = (v, d) =>
  v == null || v === '' ? d : String(v).trim().toLowerCase() === 'true';

export const config = {
  /** The account the bot works for. Always answered, always may write. */
  ownerDid: OWNER_DID,

  /**
   * Who else is answered, and who may change the list.
   *
   * MOD_ALLOWED_DIDS is read-only: the analyst, lookups, post scans, `review`
   * and `history`. MOD_WRITER_DIDS is empty by default, because talking to the
   * bot and adding someone to a live block list are different powers.
   */
  roster: rosterFromEnv(process.env, OWNER_DID),

  /** Jetstream (see jetstream.js). */
  jetstreamHost:
    process.env.JETSTREAM_HOST || 'jetstream2.us-west.bsky.network',
  reconnectBaseMs: delay('RECONNECT_BASE_MS', 1000, {
    positive: true,
    min: 100,
  }),
  reconnectMaxMs: delay('RECONNECT_MAX_MS', 30_000, {
    positive: true,
    min: 1000,
  }),

  /**
   * Force a reconnect on this interval. The subscription is silent for hours
   * at a time, so "no traffic" cannot be told apart from "the connection died
   * quietly". Reconnecting resumes from the stored cursor and misses nothing.
   * The cycle starts before the handshake (jetstream.js), so the minimum also
   * keeps it well above the time a connection takes to open.
   */
  reconnectEveryMs: delay('RECONNECT_EVERY_MS', 15 * 60_000, {
    positive: true,
    min: 60_000,
  }),

  /**
   * DM poll interval. 2s is 0.5 req/s against a documented 10/s per-IP
   * ceiling, and getLog with a stored cursor returns almost nothing when idle.
   * Going lower buys little, since a model call takes 5-20s.
   */
  dmPollMs: delay('DM_POLL_MS', 2000, { positive: true, min: 1000 }),

  /**
   * How long a loaded snapshot is reused, and how long after the last question
   * it is dropped (index.js).
   */
  referenceTtlMs: num('REFERENCE_TTL_MS', 15 * 60_000),
  referenceIdleMs: delay('REFERENCE_IDLE_MS', 10 * 60_000),

  /** Where the Jetstream cursor and the answered set live. */
  dataDir: process.env.DATA_DIR || 'data',
  cursorFile: process.env.CURSOR_FILE || 'jetstream-cursor.txt',

  /**
   * Who answers a DM by default: "classic" (typed commands, numbered menus,
   * a read-only analyst for everything else) or "agent" (one model with the
   * write tools, talked to in sentences). In agent mode a message starting
   * with "!" still takes the classic path.
   */
  dmMode: normaliseMode(process.env.MOD_DM_MODE),

  /** Which model provider (src/models.js). */
  provider: PROVIDER,

  /**
   * true = classify and log, never post or DM. The DM loop and the timed
   * jobs that write or send stay off (index.js).
   */
  dryRun: flag(process.env.DRY_RUN, false),

  /**
   * The Atmosphere MCP server, which gives the analyst the rest of the
   * network: author feeds, threads, post search, identity history, the
   * atproto docs. Off leaves the bot's own scoring tools, which still answer
   * every scoring question.
   */
  atmosphere: flag(process.env.ATMOSPHERE, true) && modelsEnabled(),
  atmosphereUrl: process.env.ATMOSPHERE_URL || 'https://aturi.to/api/mcp',
  /** How long the tool list is reused before it is fetched again. */
  atmosphereTtlMs: num('ATMOSPHERE_TTL_MS', 6 * 60 * 60_000, {
    positive: true,
  }),

  /** How often to ask whether the follow-graph snapshot needs rebuilding. */
  snapshotCheckMs: delay('SNAPSHOT_CHECK_MS', 60 * 60_000, {
    positive: true,
    min: 60_000,
  }),
  /** Rebuild the snapshot when the newest complete one is older than this. */
  snapshotMaxAgeDays: num('SNAPSHOT_MAX_AGE_DAYS', 7, { positive: true }),

  /**
   * How often to re-score the list and report what moved. A sweep knows one
   * moment of the graph, and a stranger blocked today may be a friend of a
   * friend in a month. 0 turns it off.
   */
  driftEveryHours: num('DRIFT_EVERY_HOURS', 168),
  /** How often to ask whether a re-score is due. */
  driftCheckMs: delay('DRIFT_CHECK_MS', 60 * 60_000, {
    positive: true,
    min: 60_000,
  }),

  /** How often watched posts are read again ("watch this"). 0 turns it off. */
  watchEveryMs: modelsEnabled()
    ? delay('MOD_WATCH_EVERY_MS', 5 * 60_000, { min: 60_000 })
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
      : delay('MOD_ALERT_EVERY_MS', 10 * 60_000, { min: 60_000 }),

  /**
   * How long a network digest may spend reading author feeds. When it runs
   * out, the digest says how many accounts went unread instead of returning a
   * short answer that looks complete.
   */
  pulseBudgetMs: num('PULSE_BUDGET_MS', 45_000, { positive: true }),

  statsIntervalMs: delay('STATS_INTERVAL_MS', 30 * 60_000),
};

// bot/operator.js and lib/agent.js read their deadlines themselves (they
// cannot import this module, which imports them through dmLoop.js), so they
// are checked here too. A whole-turn deadline of 0 would end every agent turn
// at once, while 0 turns a per-call watchdog off. All four must be whole
// numbers: AbortSignal.timeout throws on a fraction, and operator.js reads
// its deadlines as whole numbers and uses its default for anything else.
delay('MOD_OPERATOR_TIMEOUT_MS', null, { positive: true, whole: true });
delay('MOD_OPERATOR_CALL_TIMEOUT_MS', null, { whole: true });
delay('MOD_ESCALATION_CALL_TIMEOUT_MS', null, { whole: true });
delay('MOD_MODEL_TIMEOUT_MS', null, { positive: true, whole: true });

const DID = /^did:(plc|web):[a-zA-Z0-9._:%-]+$/;
const LIST = /^at:\/\/(did:[^/]+)\/app\.bsky\.graph\.list\/[^/]+$/;

/**
 * What is wrong with the owner's and the bot's identities. npm run setup
 * checks these before it logs in, because it writes to whichever account it
 * logs in as.
 */
export function identityProblems(env = process.env) {
  const problems = [];
  if (!DID.test(env.MOD_OWNER_DID || '')) {
    problems.push('MOD_OWNER_DID must be your own account\'s DID (did:plc:...)');
  }
  // A DID rather than a handle: a handle can change hands, and a DID can be
  // checked against the session that comes back.
  if (!DID.test(env.MOD_IDENTIFIER || '')) {
    problems.push('MOD_IDENTIFIER must be the bot account\'s DID (did:plc:...)');
  }
  if (!env.MOD_APP_PASSWORD) {
    problems.push('MOD_APP_PASSWORD must be an app password for the bot account, with DM access');
  }
  if (env.MOD_OWNER_DID && env.MOD_OWNER_DID === env.MOD_IDENTIFIER) {
    problems.push(
      'MOD_IDENTIFIER is the same account as MOD_OWNER_DID; it and MOD_APP_PASSWORD must belong to the bot account, not yours',
    );
  }
  return problems;
}

/** Everything wrong with the environment, as one error. */
export function assertConfig(env = process.env) {
  const problems = identityProblems(env);
  if (!LIST.test(env.MOD_LIST_URI || '')) {
    problems.push(
      'MOD_LIST_URI must be the at:// URI of a list the bot account owns (npm run setup creates one)',
    );
  } else if (LIST.exec(env.MOD_LIST_URI)[1] !== env.MOD_IDENTIFIER) {
    // The bot can only write to its own repo, and a write elsewhere fails with
    // a permission error that explains nothing.
    problems.push(
      'MOD_LIST_URI must name a list in the BOT account\'s repo (its at:// URI starts with MOD_IDENTIFIER)',
    );
  }
  problems.push(...modelProblems(env));
  if (config.dmMode === 'agent' && !modelsEnabled()) {
    problems.push('MOD_DM_MODE=agent needs a model provider; set one or use classic mode');
  }
  // parseDids drops an entry that is not a DID, so a typo in an allowlist
  // would otherwise be an account that is never answered, with nothing in the
  // log to say why.
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
  problems.push(...badNumbers);
  if (problems.length) {
    throw new Error(
      `the configuration is not usable:\n  - ${problems.join('\n  - ')}`,
    );
  }
}
