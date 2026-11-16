// A small leveled logger with no dependencies.
//
// Per-event lines stay at debug, so the default info level is quiet enough to
// leave running on a small disk.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

const asked = (process.env.LOG_LEVEL || 'info').toLowerCase();
const level = Object.hasOwn(LEVELS, asked) ? asked : 'info';
const threshold = LEVELS[level];
const asJson = String(process.env.LOG_JSON || 'false').toLowerCase() === 'true';

/**
 * A field value JSON can hold. An Error becomes its message, since
 * JSON.stringify turns one into {}, and anything that cannot be serialised
 * (a cycle, a BigInt) becomes a string rather than throwing out of a log call.
 */
function printable(v) {
  if (v instanceof Error) return v.message;
  try {
    JSON.stringify(v);
    return v;
  } catch {
    return String(v);
  }
}

function emit(lvl, msg, fields) {
  if (LEVELS[lvl] > threshold) return;
  const out = lvl === 'error' || lvl === 'warn' ? console.error : console.log;
  const entries = Object.entries(fields || {}).map(([k, v]) => [
    k,
    printable(v),
  ]);
  if (asJson) {
    out(JSON.stringify({ level: lvl, msg, ...Object.fromEntries(entries) }));
    return;
  }
  let line = `[${lvl.toUpperCase()}] ${msg}`;
  if (entries.length) {
    const shown = entries.map(([k, v]) =>
      typeof v === 'object' && v !== null
        ? `${k}=${JSON.stringify(v)}`
        : `${k}=${v}`,
    );
    line += ` { ${shown.join(', ')} }`;
  }
  out(line);
}

export const logger = {
  error: (msg, fields) => emit('error', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  debug: (msg, fields) => emit('debug', msg, fields),
  trace: (msg, fields) => emit('trace', msg, fields),
  level,
};
