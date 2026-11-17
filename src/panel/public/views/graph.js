// What the bands rest on: the snapshot of who you follow and who they
// follow, and the weekly re-scores of the list against it.

import { get } from '../api.js';
import { h } from '../dom.js';
import { BANDS, ago, bandName, clock, nf, plural } from '../lib/format.js';
import { empty, section, table } from '../ui.js';
import { view } from './shared.js';

export function graph() {
  return view('Follow graph', {
    sub: 'A band answers one question: if you blocked this account, who would notice? It comes from how many of the people you follow also follow them, read from a snapshot the bot rebuilds weekly.',
    load: () => get('/api/graph'),
    draw(data) {
      const s = data.snapshot;
      const n = data.newest;
      return [
        section(
          'The snapshot',
          null,
          h(
            'dl',
            { class: 'rows' },
            h('div', null, h('dt', null, 'In use'), h('dd', null, s ? `Read ${ago(s.takenAt)} (${clock(s.takenAt)})` : 'None yet. Nothing can be scored, and nobody is added, until the first one is read.')),
            s ? h('div', null, h('dt', null, 'Scoring'), h('dd', null, s.scoring === 'simple' ? 'Simple: who you follow, and whether an account follows you. There is no peripheral band.' : 'Full: who you follow, and who each of them follows.')) : null,
            n ? h('div', null, h('dt', null, 'You follow'), h('dd', null, plural(n.circle, 'account'), n.unreadable ? `. ${plural(n.unreadable, 'account')} could not be read, so their vouches are missing` : '')) : null,
            s && s.scoring === 'full' ? h('div', null, h('dt', null, 'Accounts with a vouch'), h('dd', null, `${nf(s.vouches)}: everyone at least one of your follows follows`)) : null,
            n?.building ? h('div', null, h('dt', null, 'Rebuilding'), h('dd', null, `${nf(n.circle - n.pending)} of ${nf(n.circle)} read. DMs are answered in between.`)) : null,
            h('div', null, h('dt', null, 'Protected'), h('dd', null, `${nf(data.protected.total)}: ${nf(data.protected.follows)} you follow, ${nf(data.protected.lists)} on lists you made, ${nf(data.protected.manual)} by hand. `, h('a', { href: '#/protected' }, 'See them'))),
          ),
        ),
        section(
          'Re-scores of the list',
          h('span', { class: 'muted' }, 'Newest first'),
          data.audits.length
            ? table(
                [
                  { head: 'Ran', cell: (a) => [h('div', { class: 'cell-main' }, ago(a.startedAt)), h('div', { class: 'cell-sub' }, clock(a.startedAt))] },
                  { head: 'Scored', num: true, label: 'Scored', cell: (a) => `${nf(a.scored)} of ${nf(a.total)}` },
                  ...BANDS.map((b) => ({ head: bandName(b), num: true, label: bandName(b), cell: (a) => nf(a.bands[b] || 0) })),
                  { head: 'State', label: 'State', cell: (a) => (a.finishedAt ? 'Reported' : 'Not reported yet') },
                ],
                data.audits,
              )
            : empty('The list has not been re-scored yet', 'The first runs within a week of the bot starting, and DMs you only what moved.'),
        ),
      ];
    },
  });
}
