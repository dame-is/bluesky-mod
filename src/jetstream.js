// One filtered Jetstream subscription, reconnecting on its own.
//
// FILTERED TO THE ROSTER. Jetstream filters by `wantedCollections` and
// `wantedDids`, and `wantedDids` matches a record's AUTHOR, not its subject.
// Here that is exactly right: the only posts this bot acts on are written by
// accounts on the roster. The alternative is the whole post firehose,
// gigabytes a day, to find a handful of posts we could ask for by name.
//
// EVERY ANSWERED DID MUST BE HERE, or that account's mentions never arrive:
// the transport drops them before `classify` sees them, with nothing in the
// log to say why.
//
// The socket is idle almost all the time, and with no traffic a dead
// connection looks like a quiet one. So config carries a forced reconnect
// interval, and each reconnect resumes from the stored cursor.
//
// Uses Node 22's built-in WebSocket, so the subscription needs no dependency.

import { config } from './config.js';
import { logger } from './logger.js';
import { getCursor } from './state.js';

function buildUrl() {
  const params = new URLSearchParams();
  params.append('wantedCollections', 'app.bsky.feed.post');
  // One parameter per DID, which is how Jetstream expects a repeated filter.
  // Some hosts sit behind an edge that rejects a long URL with a 414, which
  // is why the default host is us-west. Mind the length if the roster grows.
  for (const did of config.roster.all) params.append('wantedDids', did);
  const cursor = getCursor();
  if (cursor) params.append('cursor', cursor);
  return `wss://${config.jetstreamHost}/subscribe?${params}`;
}

export function connectJetstream({ onEvent }) {
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
    const url = buildUrl();
    logger.info('Connecting to Jetstream', {
      host: config.jetstreamHost,
      dids: config.roster.all.join(','),
      resumingFrom: getCursor() ?? '(live tail)',
    });
    try {
      ws = new WebSocket(url);
    } catch (err) {
      // Thrown from a timer, this would end the reconnect loop for good.
      logger.error('Could not open the Jetstream socket', {
        err,
        inMs: backoff,
      });
      retry();
      return;
    }

    ws.addEventListener('open', () => {
      backoff = config.reconnectBaseMs;
      logger.info('Connected to Jetstream', { host: config.jetstreamHost });
      // Recycle the socket on a timer: the only way to notice a connection
      // that died without a close frame on a stream this quiet.
      cycle = setTimeout(() => {
        logger.debug('Cycling the Jetstream connection for liveness');
        teardown();
      }, config.reconnectEveryMs);
      if (cycle.unref) cycle.unref();
    });

    ws.addEventListener('message', (ev) => {
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

    ws.addEventListener('error', (ev) => {
      logger.warn('WebSocket error', { err: ev?.message || 'unknown' });
    });

    ws.addEventListener('close', () => {
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
