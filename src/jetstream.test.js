import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connectJetstream } from './jetstream.js';
import { config } from './config.js';

/**
 * A socket whose peer never answers: close() fires no 'close' event, the way
 * Node's WebSocket stays in CLOSING when the close frame goes unanswered.
 * Tests fire events by hand.
 */
class SilentSocket {
  static made = [];

  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closeCalls = 0;
    SilentSocket.made.push(this);
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  fire(type, ev = {}) {
    for (const fn of this.listeners[type] || []) fn(ev);
  }

  close() {
    this.closeCalls += 1;
  }
}

const made = () => SilentSocket.made;
const WANT = {
  dids: ['did:plc:owner0000000000000000000'],
  collections: ['app.bsky.graph.follow', 'app.bsky.graph.listitem'],
};
const CYCLE = config.reconnectEveryMs + config.reconnectBaseMs;

let stream;

beforeEach(() => {
  SilentSocket.made = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', SilentSocket);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  stream?.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the liveness cycle', () => {
  it('opens a new connection when the old one never reports closing', async () => {
    stream = connectJetstream({ ...WANT, onEvent: () => {} });
    made()[0].fire('open');
    await vi.advanceTimersByTimeAsync(CYCLE);
    expect(made()).toHaveLength(2);
    expect(made()[0].closeCalls).toBe(1);
  });

  it('recycles a connection whose handshake never completes', async () => {
    stream = connectJetstream({ ...WANT, onEvent: () => {} });
    await vi.advanceTimersByTimeAsync(CYCLE);
    expect(made()).toHaveLength(2);
  });

  it('ignores late events from a socket it has replaced', async () => {
    const onEvent = vi.fn();
    stream = connectJetstream({ ...WANT, onEvent });
    made()[0].fire('open');
    await vi.advanceTimersByTimeAsync(CYCLE);
    made()[1].fire('open');

    made()[0].fire('message', { data: JSON.stringify({ time_us: 1 }) });
    made()[0].fire('close');
    await vi.advanceTimersByTimeAsync(config.reconnectMaxMs);
    expect(onEvent).not.toHaveBeenCalled();
    // No second connection from the late 'close'.
    expect(made()).toHaveLength(2);

    // The current socket still cycles on its own timer.
    await vi.advanceTimersByTimeAsync(config.reconnectEveryMs);
    expect(made()).toHaveLength(3);
  });

  it('still reconnects once when the server closes the socket', async () => {
    const onEvent = vi.fn();
    stream = connectJetstream({ ...WANT, onEvent });
    made()[0].fire('open');
    made()[0].fire('message', { data: JSON.stringify({ time_us: 1 }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(onEvent).toHaveBeenCalledTimes(1);

    made()[0].fire('close');
    await vi.advanceTimersByTimeAsync(config.reconnectBaseMs);
    expect(made()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(config.reconnectMaxMs);
    expect(made()).toHaveLength(2);
  });

  it('opens nothing after close()', async () => {
    stream = connectJetstream({ ...WANT, onEvent: () => {} });
    made()[0].fire('open');
    stream.close();
    made()[0].fire('close');
    await vi.advanceTimersByTimeAsync(CYCLE * 2);
    expect(made()).toHaveLength(1);
  });
});

describe('the subscription', () => {
  it('asks only for the given repos and record types', () => {
    stream = connectJetstream({ ...WANT, onEvent: () => {} });
    const url = new URL(made()[0].url);
    expect(url.searchParams.getAll('wantedDids')).toEqual(WANT.dids);
    expect(url.searchParams.getAll('wantedCollections')).toEqual(
      WANT.collections,
    );
  });
});
