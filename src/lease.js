// One copy of the bot per data directory.
//
// Two copies would answer every DM twice, run every re-score and watch twice,
// and, sharing a database, fail each other's writes on a lock and report
// written accounts as failed. So the running copy holds a lease: a file in the
// data directory with a heartbeat. Another copy that finds a fresh heartbeat
// waits instead of starting.
//
// A heartbeat rather than a PID check, because a copy in another container
// has a PID this one cannot see, and a container restarted after a crash gets
// the same PID it had before. A lease whose heartbeat is older than STALE_MS
// was left by a copy that stopped without letting go, and is taken over. One
// written by this same host and PID is this process's own from before a
// restart, and is taken over at once.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HEARTBEAT_MS = 20_000;
export const STALE_MS = 90_000;

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function write(file, body) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body));
  fs.renameSync(tmp, file);
}

/**
 * Try to take the lease. On success the heartbeat runs until `release()`.
 *
 * @returns {{ ok: true, release: () => void }
 *         | { ok: false, holder: { host: string, pid: number, heartbeatAt: number } }}
 */
export function acquireLease({
  dir,
  now = () => Date.now(),
  host = os.hostname(),
  pid = process.pid,
} = {}) {
  const file = path.join(dir, 'bot.lease');
  const held = read(file);
  const mine = (l) => l?.host === host && l?.pid === pid;
  if (held && !mine(held) && now() - Number(held.heartbeatAt) < STALE_MS) {
    return { ok: false, holder: held };
  }
  const startedAt = now();
  write(file, { host, pid, startedAt, heartbeatAt: startedAt });
  // Two copies that both saw a stale lease both wrote; the rename that landed
  // last holds it, and the other finds that out here.
  if (!mine(read(file))) return { ok: false, holder: read(file) };

  const timer = setInterval(() => {
    const current = read(file);
    if (current && !mine(current)) return;
    try {
      write(file, { host, pid, startedAt, heartbeatAt: now() });
    } catch {
      // A missed beat is retried on the next one; three in a row go stale.
    }
  }, HEARTBEAT_MS);
  if (timer.unref) timer.unref();

  return {
    ok: true,
    release() {
      clearInterval(timer);
      if (mine(read(file))) {
        try {
          fs.unlinkSync(file);
        } catch {
          // Already gone.
        }
      }
    },
  };
}

/**
 * The same lease, held in the database, for a Postgres database that copies
 * on different hosts can all reach. A file only stops copies that share a
 * disk. `call` is db.js's rpc.
 *
 * @returns {Promise<{ ok: true, release: () => Promise<void> }
 *         | { ok: false, holder: { host: string, pid: number, heartbeatAt: number } }>}
 */
export async function acquireDbLease({
  call,
  now = () => Date.now(),
  host = os.hostname(),
  pid = process.pid,
  name = 'bot',
} = {}) {
  const holder = `${host}:${pid}`;
  const iso = (ms) => new Date(ms).toISOString();
  const held = await call('take_lease', {
    name,
    holder,
    now: iso(now()),
    staleBefore: iso(now() - STALE_MS),
  });
  if (held?.holder !== holder) {
    const at = String(held?.holder ?? '').lastIndexOf(':');
    return {
      ok: false,
      holder: {
        host: at > 0 ? held.holder.slice(0, at) : held?.holder,
        pid: at > 0 ? Number(held.holder.slice(at + 1)) : null,
        heartbeatAt: Date.parse(held?.heartbeat_at),
      },
    };
  }
  const timer = setInterval(() => {
    // A missed beat is retried on the next one; three in a row go stale.
    call('beat_lease', { name, holder, now: iso(now()) }).catch(() => {});
  }, HEARTBEAT_MS);
  if (timer.unref) timer.unref();
  return {
    ok: true,
    async release() {
      clearInterval(timer);
      await call('drop_lease', { name, holder }).catch(() => {});
    },
  };
}
