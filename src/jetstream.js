// One filtered Jetstream subscription, reconnecting on its own.
//
// FILTERED AT THE TRANSPORT. Jetstream filters by `wantedCollections` and
// `wantedDids`, and `wantedDids` matches a record's AUTHOR, not its subject.
// The bot only needs records from the owner's own repo (ownerGraph.js), so it
// asks for exactly those rather than reading the whole firehose.
//
// The socket is idle almost all the time, and with no traffic a dead
// connection looks like a quiet one. So config carries a forced reconnect
// interval, and each reconnect resumes from the stored cursor.
//
// Uses Node 22's built-in WebSocket, so the subscription needs no dependency.

import { config } from './config.js';
import { logger } from './logger.js';
import { getCursor } from './state.js';

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
  let ws = null;
  let backoff = config.reconnectBaseMs;
  let cycle = null;
  let closedByUs = false;

  function teardown() {
    if (cycle) clearTimeout(cycle);
    cycle = null;
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
  }

  function retry() {
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, config.reconnectMaxMs);
  }

  function connect() {
    if (closedByUs) return;
    const url = buildUrl({ dids, collections });
    logger.info('Connecting to Jetstream', {
      host: config.jetstreamHost,
      dids: dids.join(','),
      resumingFrom: getCursor() ?? '(live tail)',
    });
    let sock;
    try {
      sock = new WebSocket(url);
    } catch (err) {
      // Thrown from a timer, this would end the reconnect loop for good.
      logger.error('Could not open the Jetstream socket', {
        err,
        inMs: backoff,
      });
      retry();
      return;
    }
    ws = sock;

    // Each socket hands over to the next once, on its 'close' or on the
    // liveness cycle, whichever comes first, and is ignored after that. Node's
    // WebSocket fires no 'close' while a peer that has gone silent leaves the
    // close frame unanswered, so the cycle cannot wait for one; and a 'close'
    // that does arrive late must not open a second connection, clear the next
    // socket's timer or pass on a stale event.
    let retired = false;

    // Recycle the socket on a timer: the only way to notice a connection that
    // died without a close frame on a stream this quiet. Armed when the socket
    // is created rather than on 'open', so a handshake that never completes is
    // recycled too.
    cycle = setTimeout(() => {
      if (retired) return;
      retired = true;
      logger.debug('Cycling the Jetstream connection for liveness');
      teardown();
      retry();
    }, config.reconnectEveryMs);
    if (cycle.unref) cycle.unref();

    sock.addEventListener('open', () => {
      if (retired) return;
      backoff = config.reconnectBaseMs;
      logger.info('Connected to Jetstream', { host: config.jetstreamHost });
    });

    sock.addEventListener('message', (ev) => {
      if (retired) return;
      let event;
      try {
        event = JSON.parse(
          typeof ev.data === 'string' ? ev.data : String(ev.data),
        );
      } catch (err) {
        logger.debug('Unparseable frame', { err: err.message });
        return;
      }
      // Through a promise, so a handler that throws, sync or async, is logged
      // rather than escaping the listener.
      Promise.resolve()
        .then(() => onEvent(event))
        .catch((err) => logger.error('Event handler error', { err }));
    });

    sock.addEventListener('error', (ev) => {
      logger.warn('WebSocket error', { err: ev?.message || 'unknown' });
    });

    sock.addEventListener('close', () => {
      if (retired) return;
      retired = true;
      if (cycle) clearTimeout(cycle);
      cycle = null;
      if (closedByUs) return;
      logger.warn('Jetstream closed; reconnecting', { inMs: backoff });
      retry();
    });
  }

  connect();

  return {
    close() {
      closedByUs = true;
      teardown();
    },
  };
}
