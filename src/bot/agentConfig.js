// How the bot is steered: its voice, report templates and limits, read from
// an optional JSON file (MOD_CONFIG_FILE, default ./config/bot.json).
//
// The bot never writes this file. Whoever takes over the bot should not also
// get to rewrite the instructions it runs under, so compose.yaml mounts the
// file read-only.
//
// `style` replaces the voice block and `guidance` is appended after the rules
// as standing instructions. Neither can remove what the bands mean, the
// untrusted-input handling or the length budgets. Those come earlier in the
// same prompt and stay in version control, because they keep the decision log
// replayable and the reply well-formed (systemPromptFor in src/lib/agent.js).
//
// A file that stops parsing, or cannot be read, keeps the last good copy. A
// broken edit should not drop the bot back to its defaults mid-conversation,
// since a silent change of register is easy to miss for a week. Each distinct
// failure is logged once.
//
// Every field is optional:
//
//   {
//     "style": "How it writes. Replaces the built-in voice.",
//     "guidance": "Standing instructions, appended after the rules.",
//     "openers": "First lines it may use, one per line.",
//     "report": "The account report template.",
//     "postReport": "The post scan template.",
//     "model": "a model id, overriding MOD_AGENT_MODEL",
//     "limits": { "maxTurns": 12, "maxSteps": 12, "historyHours": 4, "reviewRows": 40 },
//     "barePost": "card"   (or "author"; agent mode only)
//   }

import fs from 'node:fs';
import path from 'node:path';

/** Long enough to be a voice, short enough not to be a second system prompt. */
const MAX_FIELD_CHARS = 2000;

/**
 * The numeric knobs, and the range each is allowed.
 *
 * Clamped, not just defaulted. Unlike voice, these have a bill attached: a
 * typo in maxSteps is a runaway loop rather than an awkward sentence. The file
 * can move them within these ranges and no further.
 */
export const LIMITS = {
  /** Conversation turns kept as history. */
  maxTurns: { min: 1, max: 40, def: 12 },
  /** Tool-loop steps. Every step resends the system prompt and the tools. */
  maxSteps: { min: 1, max: 20, def: 12 },
  /** How old a DM can be and still count as this conversation. 0 disables. */
  historyHours: { min: 0, max: 168, def: 4 },
  /** Accounts named in a preflight result. */
  reviewRows: { min: 1, max: 40, def: 40 },
};

/**
 * What a post sent with no words means: the card (counts, and words to answer
 * with) or a block of whoever wrote it, through the quick lane.
 */
const BARE_POST = ['card', 'author'];
const barePostOf = (v) => (BARE_POST.includes(v) ? v : 'card');

/**
 * A model id, loosely: `provider/model` for a gateway, a bare name for a
 * direct provider or a local server (`name:tag`). A malformed value is
 * dropped: falling back to the default model is recoverable, and a 400 on
 * every turn is not.
 */
const MODEL_SHAPE = /^[a-z0-9][a-z0-9._:/-]{0,120}$/i;

/**
 * A limit as a number, or NaN when the file gives none. Only a number or a
 * non-blank string counts: Number(null), Number('') and Number(false) are 0,
 * which would clamp to the minimum instead of taking the default.
 */
const limitValue = (v) =>
  typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')
    ? Number(v)
    : NaN;

export function clampLimits(raw) {
  const out = {};
  for (const [key, spec] of Object.entries(LIMITS)) {
    const v = limitValue(raw?.[key]);
    out[key] = Number.isFinite(v)
      ? Math.min(spec.max, Math.max(spec.min, Math.round(v)))
      : spec.def;
  }
  return out;
}

/** Trim and cap a field. Templates get a longer cap than voice fields. */
const clip = (v, max = MAX_FIELD_CHARS) =>
  String(v ?? '')
    .trim()
    .slice(0, max);

/** Where the file is looked for. */
function configPath(env = process.env) {
  return env.MOD_CONFIG_FILE || path.join(process.cwd(), 'config', 'bot.json');
}

/**
 * The parsed config, or null when there is nothing in it worth applying.
 * Exported for tests; the bot calls loadAgentConfig.
 */
export function parseConfig(value) {
  if (!value || typeof value !== 'object') return null;
  const model = String(value.model || '').trim();
  const out = {
    style: clip(value.style),
    guidance: clip(value.guidance),
    openers: clip(value.openers),
    report: clip(value.report, 4000),
    postReport: clip(value.postReport, 4000),
    model: MODEL_SHAPE.test(model) ? model : '',
    limits: value.limits ? clampLimits(value.limits) : null,
    barePost: barePostOf(value.barePost),
  };
  const has =
    out.style ||
    out.guidance ||
    out.openers ||
    out.report ||
    out.postReport ||
    out.model ||
    out.limits ||
    out.barePost === 'author';
  return has ? out : null;
}

let lastGood = null;
let lastError = null;

/** Log a failure once, until a different one happens or the file reads. */
function warnOnce(log, msg, { file, err }) {
  const text = String(err?.message || err);
  if (text === lastError) return;
  lastError = text;
  log(msg, { file, err: text });
}

/**
 * The effective configuration: the file if it reads, the last good copy if it
 * stopped reading, and null to mean "use the built-in defaults".
 *
 * Never throws. Losing the register is cosmetic; losing the answer is not.
 */
export async function loadAgentConfig({
  file = configPath(),
  readFile = (f) => fs.readFileSync(f, 'utf8'),
  log = (msg, fields) => console.warn(msg, fields),
} = {}) {
  let text;
  try {
    text = readFile(file);
  } catch (err) {
    // No file is the normal state, not an error.
    if (err?.code === 'ENOENT') {
      lastGood = null;
      lastError = null;
      return null;
    }
    warnOnce(log, 'The config file cannot be read; keeping the last good copy', {
      file,
      err,
    });
    return lastGood;
  }
  try {
    const parsed = parseConfig(JSON.parse(text));
    lastGood = parsed;
    lastError = null;
    return parsed;
  } catch (err) {
    warnOnce(log, 'The config file does not parse; keeping the last good copy', {
      file,
      err,
    });
    return lastGood;
  }
}

/** Forget the remembered copy. For tests. */
export function resetAgentConfig() {
  lastGood = null;
  lastError = null;
}
