// How much room the data directory has left, so a full disk is noticed
// before SQLite starts refusing writes.
//
// The database grows with the owner's follow graph: a snapshot is a row per
// account anyone they follow follows, and the build holds every follow edge
// for a while before it is counted. docs/DEPLOY.md has sizes per host.

import fs from 'node:fs/promises';

const MB = 1024 * 1024;

/** Free and total bytes on the filesystem that holds `dir`. */
export async function diskSpace(dir) {
  const s = await fs.statfs(dir);
  return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
}

/**
 * Low means under a tenth of the disk, but never under 256 MB, which a
 * snapshot build can need for itself, and never over 2 GB, which on a big
 * disk is plenty.
 */
export function isLow({ free, total }) {
  const floor = Math.min(2048 * MB, Math.max(256 * MB, total * 0.1));
  return free < floor;
}

/** "180 MB free of 1 GB". */
export function describe({ free, total }) {
  const size = (b) =>
    b >= 1024 * MB
      ? `${(Math.round((b / (1024 * MB)) * 10) / 10).toString()} GB`
      : `${Math.round(b / MB)} MB`;
  return `${size(free)} free of ${size(total)}`;
}
