// On-disk state: where the Jetstream stream got to, and which mentions have
// been answered.
//
// Jetstream replays from a cursor and this process reconnects on a timer, so
// the same mention arrives again as a matter of course. The answered set is
// what stops a replay from posting a second public reply under someone else's
// thread. A mention is marked before it is answered: one missed answer is
// better than one duplicate public reply.

import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { logger } from './logger.js';

const cursorPath = path.resolve(config.dataDir, config.cursorFile);
const answeredPath = path.resolve(config.dataDir, config.answeredFile);

let answered = new Set();
let lastCursor = null;

/**
 * Write through a temporary file and a rename, so a crash mid-write leaves the
 * old file whole. A truncated answered set would forget what was answered.
 */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function loadState() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  try {
    const raw = fs.readFileSync(cursorPath, 'utf8').trim();
    if (raw) lastCursor = raw;
  } catch {
    // No cursor is the normal first run.
  }
  try {
    const raw = JSON.parse(fs.readFileSync(answeredPath, 'utf8'));
    if (Array.isArray(raw)) answered = new Set(raw);
  } catch {
    answered = new Set();
  }
  logger.info('State loaded', {
    cursor: lastCursor ?? '(live tail)',
    answered: answered.size,
  });
  return { cursor: lastCursor, answered: answered.size };
}

export function getCursor() {
  return lastCursor;
}

/**
 * Remember the stream position as soon as an event is seen, not after the work
 * it caused. Replaying an event here could mean a second public post, and the
 * answered set covers the replay a reconnect causes anyway.
 */
export function setCursor(timeUs) {
  if (timeUs == null) return;
  lastCursor = String(timeUs);
  try {
    writeAtomic(cursorPath, lastCursor);
  } catch (err) {
    logger.error('Could not save cursor', { err });
  }
}

export function hasAnswered(uri) {
  return answered.has(uri);
}

export function markAnswered(uri) {
  answered.add(uri);
  if (answered.size > config.answeredKeep) {
    // Insertion-ordered, so the oldest go first.
    answered = new Set([...answered].slice(-config.answeredKeep));
  }
  try {
    writeAtomic(answeredPath, JSON.stringify([...answered]));
  } catch (err) {
    logger.error('Could not save the answered set', { err });
  }
}
