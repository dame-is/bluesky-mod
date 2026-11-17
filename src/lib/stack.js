// Replies laid out for a chat bubble a phone shows a few words wide: who it
// is about, one summary line, then short "label: value" rows in groups, with
// a blank line between groups. A sentence that packs six numbers wraps into
// a block nobody reads; one number per row is read at a glance.

/** 6816 -> "6.8k", 1234567 -> "1.2m"; under 1,000 exact. */
export function compact(n) {
  if (n === null || n === undefined || n === '') return '-';
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  const short = (x, unit) =>
    `${(Math.round(x * 10) / 10).toString().replace(/\.0$/, '')}${unit}`;
  if (abs >= 1e6) return short(v / 1e6, 'm');
  if (abs >= 1e4) return `${Math.round(v / 1e3)}k`;
  if (abs >= 1e3) return short(v / 1e3, 'k');
  return String(Math.round(v));
}

/** 1868 -> "1,868". */
export const count = (n) => Number(n || 0).toLocaleString('en-US');

/**
 * "label: value" rows, leaving out any whose value is missing or zero, so a
 * card on a post nobody reposted has no "reposters: 0".
 */
export function rows(pairs) {
  return pairs
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== 0)
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? count(v) : v}`)
    .join('\n');
}

/** Groups joined by a blank line, empty ones dropped. */
export function stack(...groups) {
  return groups
    .flat()
    .filter((g) => g && String(g).trim())
    .join('\n\n');
}

/**
 * The line under an account's name: its band, its reach, and what already
 * stands between it and the owner. "connected, 6.8k followers, on list".
 */
export function accountLine(a) {
  return [
    a.band ? String(a.band).toLowerCase() : null,
    typeof a.followers === 'number' ? `${compact(a.followers)} followers` : null,
    a.blocksYou ? 'blocks you' : null,
    a.alreadyListed ? 'on list' : null,
    a.protectedReason ? `protected: ${a.protectedReason}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** A short date and time: "Nov 17, 9:02 PM". */
export function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
