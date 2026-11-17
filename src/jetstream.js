// One filtered Jetstream subscription, reconnecting on its own.
//
// FILTERED AT THE TRANSPORT. Jetstream filters by `wantedCollections` and
// `wantedDids`, and `wantedDids` matches a record's AUTHOR, not its subject.
// The bot only needs records from the owner's own repo (ownerGraph.js), so it
// asks for exactly those rather than reading the whole firehose. Links that
// point AT the owner, written in other people's repos, come from Spacedust
// instead (spacedust.js).
//
// The socket is idle almost all the time, and with no traffic a dead
// connection looks like a quiet one. So the connection is recycled on a timer
// (socket.js), and each reconnect resumes from the stored cursor.

import { config } from './config.js';
import { getCursor } from './state.js';
import { connectSocket } from './socket.js';

function buildUrl({ dids, collections }) {
  const params = new URLSearchParams();
  // One parameter per value, which is how Jetstream expects a repeated filter.
  for (const c of collections) params.append('wantedCollections', c);
  for (const did of dids) params.append('wantedDids', did);
  const cursor = getCursor();
  if (cursor) params.append('cursor', cursor);
  return `wss://${config.jetstreamHost}/subscribe?${params}`;
}

/**
 * @param {object} opts
 * @param {string[]} opts.dids         whose repos to follow
 * @param {string[]} opts.collections  which record types
 * @param {Function} opts.onEvent      called with each parsed event
 */
export function connectJetstream({ dids, collections, onEvent }) {
  return connectSocket({
    name: 'Jetstream',
    url: () => buildUrl({ dids, collections }),
    onMessage: onEvent,
    describe: () => ({
      host: config.jetstreamHost,
      dids: dids.join(','),
      collections: collections.join(','),
      resumingFrom: getCursor() ?? '(live tail)',
    }),
  });
}
