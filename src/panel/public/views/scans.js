// Every scan, by what state it is in.

import { get } from '../api.js';
import { h } from '../dom.js';
import { chips, empty, table } from '../ui.js';
import { scanCols, view } from './shared.js';

const STATES = [
  ['waiting', 'Waiting for you'],
  ['adding', 'Adding'],
  ['added', 'Added'],
  ['undone', 'Taken back'],
  ['cancelled', 'Cancelled'],
];

export function scans(ctx) {
  const state = STATES.some(([s]) => s === ctx.params.get('state')) ? ctx.params.get('state') : null;
  return view('Scans', {
    sub: 'A scan collects everyone who engaged with a post and scores how close each is to you. It adds nobody until you approve part of it.',
    load: () => get('/api/scans', { state }),
    draw(data) {
      return [
        chips(
          [{ value: null, label: 'All' }, ...STATES.filter(([s]) => data.counts[s]).map(([value, label]) => ({ value, label, count: data.counts[value] }))],
          state,
          (v) => ctx.go('/scans', { state: v }),
          'State',
        ),
        data.scans.length
          ? table(scanCols(ctx), data.scans, { onRow: (s) => ctx.go(`/scans/${s.code}`) })
          : empty(state ? 'No scan in that state' : 'No scans yet', h('span', null, 'Use “Scan a post” above, or share a post with the bot in a DM.')),
      ];
    },
  });
}
