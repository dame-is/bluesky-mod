// The few values everything else reads at import time.
//
// The owner is whoever runs this bot: the account it answers, whose follows
// decide who is PROTECTED. It comes from the environment rather than from a
// constant so the same code serves anyone who runs it.

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
 * The owner's handle, for prompts and messages. Resolved from the DID at
 * startup (setOwnerHandle) because a handle can change and the DID cannot;
 * MOD_OWNER_HANDLE is only a starting value.
 */
export let OWNER_HANDLE = process.env.MOD_OWNER_HANDLE || '';

export function setOwnerHandle(handle) {
  if (handle) OWNER_HANDLE = String(handle);
}
