// On/off settings. Only these spellings count, so a value like DRY_RUN=1 or
// MOD_ALERTS=false means what it says, and anything else stops the bot at
// startup with the setting named, rather than quietly meaning "off".

const YES = new Set(['true', '1', 'yes', 'on']);
const NO = new Set(['false', '0', 'no', 'off']);

/** Settings whose value was not a recognised on/off word. */
export const badFlags = [];

export function readFlag(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (YES.has(v)) return true;
  if (NO.has(v)) return false;
  badFlags.push(`${name} must be true or false, not "${raw}"`);
  return fallback;
}
