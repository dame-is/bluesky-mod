// Values other modules read at import time.
//
// The owner is whoever runs this bot: the account it answers, and whose follows
// decide who is PROTECTED.

export const OWNER_DID = process.env.MOD_OWNER_DID || '';

/** The public, unauthenticated Bluesky AppView. */
export const APPVIEW = (
  process.env.APPVIEW_URL || 'https://public.api.bsky.app'
).replace(/\/$/, '');

export const PLC_DIRECTORY = (
  process.env.PLC_DIRECTORY_URL || 'https://plc.directory'
).replace(/\/$/, '');

/** Backlinks index (microcosm). Used to find who engaged with a post. */
export const CONSTELLATION_URL = (
  process.env.CONSTELLATION_URL || 'https://constellation.microcosm.blue'
).replace(/\/$/, '');

/**
 * The owner's handle, for prompts and messages. Read from the DID at startup
 * (setOwnerHandle), because a handle can change and the DID cannot.
 */
export let OWNER_HANDLE = '';

export function setOwnerHandle(handle) {
  if (handle) OWNER_HANDLE = String(handle);
}
