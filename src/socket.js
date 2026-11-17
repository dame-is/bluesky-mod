// A WebSocket that reconnects on its own, for the subscriptions the bot keeps
// open: Jetstream (the owner's own repo) and Spacedust (links pointing at the
// owner).
//
// Both are idle most of the time, and with no traffic a dead connection looks
// like a quiet one. So the socket is recycled on a timer (config
// reconnectEveryMs) as well as on 'close', and each new connection asks for
// its URL afresh, so a stream that resumes from a cursor picks up the latest.
//
// Uses Node 22's built-in WebSocket, so a subscription needs no dependency.

import { config } from './config.js';
import { logger } from './logger.js';

/**
 * @param {object} opts
 * @param {string} opts.name                 for the log
 * @param {() => string} opts.url            asked on every (re)connect
 * @param {(msg: object) => any} opts.onMessage  each parsed frame
 * @param {() => object} [opts.describe]     log fields for a connect
 * @param {() => any} [opts.onOpen]          each time a connection opens
 * @param {() => any} [opts.onDown]          each time one stops: closed by
 *   the server, recycled for liveness, or replaced
 * @returns {{ close(): void, reconnect(): void }}
 *   `reconnect` drops the connection and opens a new one at once, for a
 *   caller whose filter has changed.
 */
export function connectSocket({
  name,
  url,
  onMessage,
  describe = () => ({}),
  onOpen = () => {},
  onDown = () => {},
}) {
  let ws = null;
  let backoff = config.reconnectBaseMs;
  let cycle = null;
  let retryTimer = null;
  let closedByUs = false;
  /** Marks the live socket retired, so its late events are ignored. */
  let retireCurrent = () => {};

  function down() {
    try {
      onDown();
    } catch (err) {
      logger.error('Down handler error', { stream: name, err });
    }
  }

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
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, backoff);
    backoff = Math.min(backoff * 2, config.reconnectMaxMs);
  }

  function connect() {
    if (closedByUs) return;
    let target;
    try {
      target = url();
    } catch (err) {
      logger.error(`Could not build the ${name} URL`, { err, inMs: backoff });
      retry();
      return;
    }
    logger.info(`Connecting to ${name}`, describe());
    let sock;
    try {
      sock = new WebSocket(target);
    } catch (err) {
      // Thrown from a timer, this would end the reconnect loop for good.
      logger.error(`Could not open the ${name} socket`, { err, inMs: backoff });
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
    retireCurrent = () => {
      if (!retired) down();
      retired = true;
    };

    // Armed when the socket is created rather than on 'open', so a handshake
    // that never completes is recycled too.
    cycle = setTimeout(() => {
      if (retired) return;
      retired = true;
      down();
      logger.debug(`Cycling the ${name} connection for liveness`);
      teardown();
      retry();
    }, config.reconnectEveryMs);
    if (cycle.unref) cycle.unref();

    sock.addEventListener('open', () => {
      if (retired) return;
      backoff = config.reconnectBaseMs;
      logger.info(`Connected to ${name}`);
      try {
        onOpen();
      } catch (err) {
        logger.error('Open handler error', { stream: name, err });
      }
    });

    sock.addEventListener('message', (ev) => {
      if (retired) return;
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch (err) {
        logger.debug('Unparseable frame', { stream: name, err: err.message });
        return;
      }
      // Through a promise, so a handler that throws, sync or async, is logged
      // rather than escaping the listener.
      Promise.resolve()
        .then(() => onMessage(msg))
        .catch((err) => logger.error('Event handler error', { stream: name, err }));
    });

    sock.addEventListener('error', (ev) => {
      logger.warn('WebSocket error', { stream: name, err: ev?.message || 'unknown' });
    });

    sock.addEventListener('close', () => {
      if (retired) return;
      retired = true;
      down();
      if (cycle) clearTimeout(cycle);
      cycle = null;
      if (closedByUs) return;
      logger.warn(`${name} closed; reconnecting`, { inMs: backoff });
      retry();
    });
  }

  connect();

  return {
    close() {
      closedByUs = true;
      if (retryTimer) clearTimeout(retryTimer);
      retireCurrent();
      teardown();
    },
    reconnect() {
      if (closedByUs) return;
      retireCurrent();
      teardown();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      backoff = config.reconnectBaseMs;
      connect();
    },
  };
}
