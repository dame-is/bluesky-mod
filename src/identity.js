// Who the owner and the bot are, settled before anything that reads them is
// loaded.
//
// MOD_OWNER_DID and MOD_IDENTIFIER take a handle or a DID. A handle is easier
// to find, and a DID is what the rest of the code reads, so a handle is
// resolved here and the DID it gave is pinned in the data directory. A handle
// can change hands: if it later resolves to a different account, the bot
// refuses to start rather than take a stranger for its owner.
//
// This module reads nothing at import time, because constants.js reads
// MOD_OWNER_DID when it is imported and has to see the DID.

import fs from 'node:fs';
import path from 'node:path';

const DID = /^did:(plc|web):[a-zA-Z0-9._:%-]+$/;
const HANDLE = /^@?([a-z0-9-]+\.)+[a-z0-9-]+$/i;

const PIN_FILE = 'identity.json';

function readPins(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, PIN_FILE), 'utf8'));
  } catch {
    return {};
  }
}

function writePins(dir, pins) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PIN_FILE);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(pins, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

async function resolveHandle(handle, { appview, fetchImpl }) {
  const res = await fetchImpl(
    `${appview}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
  );
  if (res.status === 400) return null;
  if (!res.ok) throw new Error(`the AppView answered ${res.status}`);
  const did = (await res.json())?.did;
  return DID.test(did || '') ? did : null;
}

/**
 * Turn the handle in each of these settings into a DID, in place in `env`.
 * A DID is left as it is. Throws with a sentence for the log when a handle
 * resolves to nobody, or to a different account than the one pinned.
 */
export async function settleIdentities(
  env = process.env,
  {
    dataDir = env.DATA_DIR || 'data',
    appview = (env.APPVIEW_URL || 'https://public.api.bsky.app').replace(/\/$/, ''),
    fetchImpl = fetch,
  } = {},
) {
  const pins = readPins(dataDir);
  let changed = false;
  for (const [name, key, who] of [
    ['MOD_OWNER_DID', 'owner', 'your account'],
    ['MOD_IDENTIFIER', 'bot', "the bot's account"],
  ]) {
    const given = String(env[name] || '').trim();
    if (!given || DID.test(given)) continue;
    if (!HANDLE.test(given)) continue; // assertConfig names it
    const handle = given.replace(/^@/, '').toLowerCase();
    const pinned = pins[key]?.handle === handle ? pins[key].did : null;
    let did;
    try {
      did = await resolveHandle(handle, { appview, fetchImpl });
    } catch (err) {
      // Offline at boot: the DID it gave last time still stands.
      if (pinned) {
        env[name] = pinned;
        continue;
      }
      throw new Error(`could not look up @${handle} for ${name}: ${err.message}`);
    }
    if (!did) {
      throw new Error(`${name} is @${handle}, and no account has that handle`);
    }
    if (pins[key]?.handle === handle && pins[key].did !== did) {
      throw new Error(
        `@${handle} (${name}) now belongs to a different account than when the bot first ran, so it will not start. ` +
          `If ${who} really changed, delete ${PIN_FILE} in the data directory, or set ${name} to the DID.`,
      );
    }
    if (pins[key]?.did !== did) {
      pins[key] = { handle, did };
      changed = true;
    }
    env[name] = did;
  }
  if (changed) writePins(dataDir, pins);
}
