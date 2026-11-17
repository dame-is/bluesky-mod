// Where the Jetstream subscription got to, kept on disk so a restart resumes
// from there instead of missing what happened while the bot was down.

import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { logger } from './logger.js';

const cursorPath = path.resolve(config.dataDir, config.cursorFile);

let lastCursor = null;

/**
 * Write through a temporary file and a rename, so a crash mid-write leaves the
 * old file whole.
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
  logger.info('State loaded', { cursor: lastCursor ?? '(live tail)' });
  return { cursor: lastCursor };
}

export function getCursor() {
  return lastCursor;
}

/** Remember the stream position once an event has been handled. */
export function setCursor(timeUs) {
  if (timeUs == null) return;
  lastCursor = String(timeUs);
  try {
    writeAtomic(cursorPath, lastCursor);
  } catch (err) {
    logger.error('Could not save cursor', { err });
  }
}
