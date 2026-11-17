// Pieces more than one page draws: the frame of a page that loads, the two
// radars, a scan as a table row, a change as a table row, and a bar chart.

import { h, fill } from '../dom.js';
import {
  FAMILY_WORDS,
  KIND_WORDS,
  ago,
  bandName,
  clock,
  dayMonth,
  nf,
  plural,
  postAuthor,
  shortDid,
  viaWords,
} from '../lib/format.js';
import { primaryKind, selected } from '../lib/commands.js';
import { createRadar, bandMark } from '../radar.js';
import { band, closeness, loading, problem, profileOf, tone, who, whoName } from '../ui.js';

/**
 * A page that reads something before it can draw. `load` fetches, `draw`
 * turns what came back into elements. Returns what the router wants, plus
 * `reload`, which reads again and redraws in place.
 */
export function view(title, { sub = null, aside = null, load, draw }) {
  const body = h('div', { class: 'view-body' }, loading());
  const el = h(
    'div',
    { class: 'view' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), sub ? h('p', { class: 'page-sub' }, sub) : null), aside),
    body,
  );
  let alive = true;
  const cleanups = [];
  async function reload({ quiet = false } = {}) {
    if (!quiet) fill(body, loading());
    try {
      const data = await load();
      if (!alive) return;
      for (const c of cleanups.splice(0)) c();
      fill(body, draw(data, { reload, onCleanup: (fn) => cleanups.push(fn) }));
    } catch (err) {
      if (alive) fill(body, problem(err, () => reload()));
    }
  }
  reload();
  return {
    el,
    reload,
    destroy() {
      alive = false;
      for (const c of cleanups.splice(0)) c();
    },
  };
}

// --- the radars --------------------------------------------------------------------

/** What each mark means, under a radar. */
export function legend({ hostile = false, done = false } = {}) {
  return h(
    'div',
    { class: 'legend' },
    ['PROTECTED', 'CONNECTED', 'PERIPHERAL', 'NOTABLE'].map((b) => h('span', null, bandMark(b), bandName(b))),
    h('span', null, bandMark('UNKNOWN'), 'Strangers, drawn as texture'),
    hostile ? h('span', null, h('span', { class: 'legend-big', 'aria-hidden': 'true' }), 'A bigger mark was read as hostile') : null,
    done ? h('span', null, 'A ringed mark is on the list already') : null,
  );
}

const SCAN_SECTORS = [
  ['quote', 'Quoted'],
  ['reply', 'Replied'],
  ['repost', 'Reposted'],
  ['like', 'Liked'],
  ['other', 'Other'],
];

/**
 * The radar of a scan: everyone who engaged with a post, by how close they
 * are to you and what they did.
 *
 * @param {object} scan  what /api/scan returned
 * @param {object} sel   { bands: Set, sectors: Set, hostileOnly: boolean }
 */
export function scanRadar(scan, sel, { onPick, onBand, onSector }) {
  const keyed = scan.rows.map((r) => ({ row: r, kind: primaryKind(r.kinds) }));
  const used = SCAN_SECTORS.filter(([k]) => k !== 'other' || keyed.some((x) => x.kind === 'other'));
  const index = new Map(used.map(([k], i) => [k, i]));
  const sectors = used.map(([key, name]) => {
    const mine = keyed.filter((x) => x.kind === key);
    const far = mine.filter((x) => x.row.band === 'UNKNOWN');
    const hostile = far.filter((x) => x.row.label === 'hostile').length;
    return {
      key,
      name,
      total: nf(mine.length),
      far: far.length,
      farNote: hostile ? `${nf(hostile)} hostile` : '',
      // The bot has no word for an engagement from outside Bluesky's own
      // lexicons, so that slice cannot narrow an approval.
      can: key !== 'other',
    };
  });
  let adding = new Set();
  const points = () => {
    adding = new Set(
      selected(scan.rows, { bands: [...sel.bands], sectors: [...sel.sectors], hostileOnly: sel.hostileOnly }).map((r) => r.did),
    );
    return placedRows();
  };
  const placedRows = () =>
    keyed
      .filter((x) => x.row.band !== 'UNKNOWN')
      .map(({ row, kind }) => ({
        id: row.did,
        band: row.band,
        sector: index.get(kind),
        big: row.label === 'hostile',
        done: row.added || row.listed,
        // With a ring ticked, what is bright is what would be added. With
        // none, only the tone and sector filters dim anything.
        dim: sel.bands.size
          ? !adding.has(row.did)
          : (sel.hostileOnly && row.label !== 'hostile') ||
            (!sel.hostileOnly && sel.sectors.size > 0 && !sel.sectors.has(kind)),
        row,
      }));
  const radar = createRadar({
    label: `Everyone who engaged, placed by how close they are to you. ${plural(scan.total, 'account')}: ${scan.byBand.PROTECTED} protected, ${scan.byBand.CONNECTED} connected, ${scan.byBand.PERIPHERAL} peripheral, ${scan.byBand.NOTABLE} notable and ${nf(scan.byBand.UNKNOWN)} with no connection. The table below lists them.`,
    sectors,
    points: points(),
    bands: sel.bands,
    chosen: sel.hostileOnly ? new Set() : sel.sectors,
    describe: ({ row }) => {
      const p = profileOf(row.did);
      return {
        title: p?.handle ? `@${p.handle}` : shortDid(row.did),
        lines: [
          `${bandName(row.band)}${row.vouches ? `. ${nf(row.vouches)} of the people you follow follow them` : ''}`,
          `${SCAN_SECTORS.find(([k]) => k === primaryKind(row.kinds))[1]} it${row.label ? `, read as ${row.label}` : ''}`,
          row.quote ? `“${row.quote}”` : null,
          row.added ? 'Added by this scan' : row.listed ? 'Already on the list' : null,
        ].filter(Boolean),
      };
    },
    onPick: (p) => onPick(p.row),
    onBand,
    onSector,
  });
  return {
    el: radar.el,
    /** Redraw for a changed selection. */
    select() {
      radar.update({ points: points(), bands: sel.bands, chosen: sel.hostileOnly ? new Set() : sel.sectors });
    },
    destroy: radar.destroy,
  };
}

/**
 * The radar of the list: everyone on it who is not a stranger, by how close
 * they are to you now and how they came to be on it.
 *
 * @param {object} data  what /api/list/radar returned
 */
export function listRadar(data, { onPick, onBand, onSector = null, bands = new Set(), chosen = new Set() }) {
  const keys = ['name', 'band', 'label', 'agent', 'none'].filter(
    (k) => k !== 'none' || data.far.none || data.near.some((p) => p.family === 'none'),
  );
  const index = new Map(keys.map((k, i) => [k, i]));
  const sectors = keys.map((key) => {
    const near = data.near.filter((p) => p.family === key).length;
    const far = data.far[key] || 0;
    return { key, name: FAMILY_WORDS[key], total: nf(near + far), far };
  });
  const radar = createRadar({
    label: `Everyone on the list, placed by how close they are to you now. ${plural(data.total, 'account')}, of whom ${nf(data.near.length)} are not strangers. The table lists them.`,
    sectors,
    points: data.near.map((p) => ({ id: p.did, band: p.band, sector: index.get(p.family), dim: p.kept, p })),
    bands,
    chosen,
    describe: ({ p }) => ({
      title: p.handle ? `@${p.handle}` : shortDid(p.did),
      lines: [
        `${bandName(p.band)}${p.vouches ? `. ${nf(p.vouches)} of the people you follow follow them` : ''}`,
        `On the list: ${FAMILY_WORDS[p.family].toLowerCase()}`,
        p.kept ? 'You chose to keep them on it' : null,
      ].filter(Boolean),
    }),
    onPick: (pt) => onPick(pt.p),
    onBand,
    onSector,
  });
  return radar;
}

// --- rows --------------------------------------------------------------------------

/** What a scan is of: whose post, and a link to it. */
export function postCell(scan, ctx) {
  const author = postAuthor(scan.uri);
  const mine = author && author === ctx.me.owner?.did;
  return [
    h('div', { class: 'cell-main' }, KIND_WORDS[scan.kind] || 'Scan'),
    h(
      'div',
      { class: 'cell-sub' },
      mine ? 'Your post' : author ? ['A post by ', whoName(author, { onOpen: ctx.openAccount })] : 'A post',
    ),
  ];
}

const STATE_WORDS = {
  waiting: 'Waiting for you',
  adding: 'Adding',
  added: 'Added',
  cancelled: 'Cancelled',
  undone: 'Taken back',
};

export function stateWords(scan) {
  if (scan.state === 'adding') return `Adding: ${nf(scan.live)} so far`;
  if (scan.state === 'added') return `${nf(scan.live)} added`;
  return STATE_WORDS[scan.state] || scan.state;
}

/** The columns of a table of scans. */
export function scanCols(ctx) {
  return [
    { head: 'Scan', cell: (s) => h('a', { class: 'mono', href: `#/scans/${s.code}` }, s.code) },
    { head: 'Post', cell: (s) => postCell(s, ctx) },
    { head: 'Engaged', num: true, label: 'Engaged', cell: (s) => nf(s.total) },
    {
      head: 'Closeness',
      cell: (s) => [
        closeness(s.byBand, s.total),
        h(
          'div',
          { class: 'cell-sub' },
          [
            s.byBand.PROTECTED ? `${s.byBand.PROTECTED} protected` : null,
            s.byBand.CONNECTED ? `${s.byBand.CONNECTED} connected` : null,
            !s.byBand.PROTECTED && !s.byBand.CONNECTED && s.byBand.PERIPHERAL ? `${s.byBand.PERIPHERAL} peripheral` : null,
          ]
            .filter(Boolean)
            .join(', ') || 'All strangers',
        ),
      ],
    },
    {
      head: 'Read as hostile',
      label: 'Read as hostile',
      cell: (s) => {
        const read = s.labels.hostile + s.labels.arguing + s.labels.neutral;
        if (!s.withText) return h('span', { class: 'muted' }, 'Nothing written');
        return read ? `${nf(s.labels.hostile)} of ${nf(read)} read` : h('span', { class: 'muted' }, 'Not read yet');
      },
    },
    { head: 'State', label: 'State', cell: (s) => stateWords(s) },
    { head: 'When', label: 'Scanned', cell: (s) => h('span', { class: 'nowrap' }, ago(s.createdAt)) },
  ];
}

/** One line of the log, in words. */
function whatHappened(e, ctx) {
  const many = e.n > 1;
  const from = e.scan ? [' from scan ', h('a', { class: 'mono', href: `#/scans/${e.code}` }, e.code)] : null;
  const one = e.did ? who(e.did, { onOpen: ctx.openAccount }) : null;
  if (e.kind === 'undone') {
    return [h('span', { class: 'cell-main' }, many ? `Took back ${nf(e.n)}` : 'Took back'), from, one ? h('div', null, one) : null];
  }
  if (e.kind === 'removed') {
    return [h('span', { class: 'cell-main' }, many ? `Removed ${nf(e.n)}` : 'Removed'), one ? h('div', null, one) : null];
  }
  const wroteNothing = e.already === e.n;
  return [
    h('span', { class: 'cell-main' }, wroteNothing ? 'Asked again, already listed' : many ? `Added ${nf(e.n)}` : 'Added'),
    from,
    one ? h('div', null, one) : null,
    e.undone ? h('div', { class: 'cell-sub' }, e.undone === e.n ? 'Since taken back' : `${nf(e.undone)} since taken back`) : null,
  ];
}

/** The columns of a table of changes. */
export function changeCols(ctx) {
  return [
    { head: 'When', cell: (e) => h('span', { class: 'nowrap muted' }, clock(e.at)) },
    { head: 'What happened', cell: (e) => whatHappened(e, ctx) },
    { head: 'Band', label: 'Band', cell: (e) => (e.band && e.band !== 'UNSCORED' ? band(e.band) : h('span', { class: 'muted' }, e.band ? 'Not scored' : 'Mixed')) },
    { head: 'How', label: 'How', cell: (e) => (e.kind === 'undone' ? 'An undo' : viaWords(e.via)) },
    ...(ctx.me.canWrite
      ? [{ head: 'The words that asked for it', cell: (e) => e.words.map((w) => h('div', { class: 'words' }, `“${w}”`)) }]
      : []),
  ];
}

// --- a bar chart -------------------------------------------------------------------

/**
 * Bars for a run of days. `days`: [{ day, value, title }]. The tallest bar
 * and today's carry their numbers; the rest say theirs on hover.
 */
export function bars(days, { label }) {
  const max = Math.max(1, ...days.map((d) => d.value));
  const top = days.reduce((best, d, i) => (d.value > days[best].value ? i : best), 0);
  return h(
    'figure',
    { class: 'section', role: 'img', 'aria-label': label },
    h(
      'div',
      { class: 'bars' },
      days.map((d, i) => {
        const last = i === days.length - 1;
        const tagged = d.value > 0 && (i === top || last);
        return h(
          'div',
          {
            class: `bar${last ? ' bar-now' : ''}`,
            title: d.title,
            style: { height: d.value ? `${Math.max(1.5, (100 * d.value) / max)}%` : '0' },
          },
          tagged ? h('span', { class: `bar-tag ${i > days.length / 2 ? 'bar-tag-right' : 'bar-tag-left'}` }, nf(d.value)) : null,
        );
      }),
    ),
    h(
      'div',
      { class: 'bars-axis', 'aria-hidden': 'true' },
      h('span', null, dayMonth(days[0].day)),
      h('span', null, dayMonth(days[Math.floor(days.length / 2)].day)),
      h('span', null, 'Today'),
    ),
  );
}

export { tone };
