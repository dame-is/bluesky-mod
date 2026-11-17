// Names and faces for the DIDs the panel shows.
//
// The store keeps DIDs. A handle, a display name and an avatar come from the
// AppView's public getProfiles, 25 at a time, and are held for a while so a
// page of a table does not ask again on every visit. Best effort, like
// handlesFor in bulkPlan.js: an account that cannot be fetched still has a
// DID and a band, and the panel shows those.
//
// Everything a profile holds was written by the account it describes. The
// panel only ever sets it as text (public/dom.js).

import { APPVIEW } from '../constants.js';
import { fetchWithTimeout } from '../lib/atproto.js';

const BATCH = 25;
const HOLD_MS = 30 * 60_000;
const MAX_HELD = 5000;
/** The most one request may ask for: two pages of a table. */
export const MAX_PER_REQUEST = 100;

const DID = /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/;

const cut = (text, max) => {
  const s = String(text ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

function shape(p) {
  return {
    did: p.did,
    handle: p.handle || null,
    displayName: cut(p.displayName, 80) || null,
    description: cut(p.description, 300) || null,
    // Only the AppView's own image host, so a profile cannot point the
    // owner's browser at a server its author runs.
    avatar: /^https:\/\/cdn\.bsky\.app\//.test(p.avatar || '') ? p.avatar : null,
    followers: p.followersCount ?? null,
    follows: p.followsCount ?? null,
    posts: p.postsCount ?? null,
    createdAt: p.createdAt || null,
  };
}

export function createProfiles({
  fetchImpl = fetchWithTimeout,
  appview = APPVIEW,
  now = Date.now,
} = {}) {
  const held = new Map();

  return async function profiles(dids) {
    const wanted = [...new Set((dids || []).filter((d) => DID.test(String(d))))].slice(
      0,
      MAX_PER_REQUEST,
    );
    const t = now();
    const out = {};
    const missing = [];
    for (const did of wanted) {
      const hit = held.get(did);
      if (hit && t - hit.at < HOLD_MS) out[did] = hit.profile;
      else missing.push(did);
    }
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const q = batch.map((d) => `actors=${encodeURIComponent(d)}`).join('&');
      try {
        const res = await fetchImpl(`${appview}/xrpc/app.bsky.actor.getProfiles?${q}`);
        if (!res.ok) continue;
        const body = await res.json();
        const found = new Map((body?.profiles || []).map((p) => [p.did, shape(p)]));
        for (const did of batch) {
          // An account the AppView has no profile for is remembered as gone,
          // so it is not asked for again on every page.
          const profile = found.get(did) || { did, missing: true };
          held.set(did, { at: t, profile });
          out[did] = profile;
        }
      } catch {
        // Left out of the answer: the panel shows the DID.
      }
    }
    if (held.size > MAX_HELD) {
      for (const key of [...held.keys()].slice(0, held.size - MAX_HELD)) held.delete(key);
    }
    return out;
  };
}
