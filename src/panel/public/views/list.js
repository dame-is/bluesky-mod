// The list itself: the radar of who on it is near you, and everyone on it
// in a table you can search and narrow.

import { get } from '../api.js';
import { h, fill } from '../dom.js';
import { BANDS, FAMILY_WORDS, ago, bandName, compact, nf, viaWords } from '../lib/format.js';
import { band, chips, empty, loading, pager, problem, table, who } from '../ui.js';
import { legend, listRadar, view } from './shared.js';

const PAGE = 50;

export function list(ctx) {
  const chosen = [...BANDS, 'UNSCORED'].includes(ctx.params.get('band')) ? ctx.params.get('band') : null;
  const family = Object.hasOwn(FAMILY_WORDS, ctx.params.get('family')) ? ctx.params.get('family') : null;
  const offset = Number(ctx.params.get('offset')) || 0;
  let q = ctx.params.get('q') || '';
  const to = (patch) => ctx.go('/list', { band: chosen, family, q, offset: null, ...patch });

  return view('The list', {
    sub: 'Everyone the bot has put on its list. A band is where the last re-score found them, which can differ from where they were when they were added.',
    load: () => get('/api/list/radar'),
    draw(radar, { onCleanup }) {
      const chart = listRadar(radar, {
        onPick: (p) => ctx.openAccount(p.did),
        onBand: (b) => to({ band: chosen === b ? null : b }),
        onSector: (k) => to({ family: family === k ? null : k }),
        bands: new Set(chosen ? [chosen] : []),
        chosen: new Set(family ? [family] : []),
      });
      onCleanup(() => chart.destroy());

      const results = h('div', { class: 'section' }, loading());
      const search = h('input', { class: 'field', type: 'search', value: q, 'aria-label': 'Search the list by handle or DID', placeholder: 'Search by handle or DID' });

      async function page() {
        try {
          const data = await get('/api/list', { band: chosen, family, q, offset, limit: PAGE });
          fill(
            results,
            h('p', { class: 'muted', role: 'status' }, `${nf(data.matched)} of ${nf(data.total)}`, chosen ? `, ${bandName(chosen).toLowerCase()}` : '', family ? `, ${FAMILY_WORDS[family].toLowerCase()}` : '', q ? `, matching “${q}”` : '', '. Closest to you first.'),
            data.rows.length
              ? table(
                  [
                    { head: 'Who', cell: (r) => who(r.did, { handle: r.handle, onOpen: ctx.openAccount }) },
                    { head: 'Band now', label: 'Now', cell: (r) => [band(r.band), r.vouches ? h('div', { class: 'cell-sub' }, `${nf(r.vouches)} of your follows`) : null] },
                    { head: 'When added', label: 'When added', cell: (r) => (r.bandThen ? (r.bandThen === r.band ? h('span', { class: 'muted' }, 'The same') : bandName(r.bandThen)) : h('span', { class: 'muted' }, 'Not scored')) },
                    { head: 'Followers', num: true, label: 'Followers', cell: (r) => (r.followers != null ? compact(r.followers) : '') },
                    { head: 'How they got here', label: 'How', cell: (r) => [viaWords(r.via), r.code ? h('div', { class: 'cell-sub mono' }, r.code) : null] },
                    { head: 'Added', label: 'Added', cell: (r) => h('span', { class: 'nowrap' }, r.addedAt ? ago(r.addedAt) : '') },
                  ],
                  data.rows,
                  { onRow: (r) => ctx.openAccount(r.did) },
                )
              : empty('Nobody on the list matches', 'Try another band, or part of a handle.'),
            pager({ offset, limit: PAGE, shown: data.rows.length, total: data.matched, onPage: (o) => to({ offset: o || null }) }),
          );
        } catch (err) {
          fill(results, problem(err, page));
        }
      }
      page();

      return [
        h(
          'div',
          { class: 'split' },
          h('div', { class: 'grow-2' }, h('div', { class: 'well' }, chart.el, legend())),
          h(
            'div',
            { class: 'grow-1' },
            h('div', { class: 'section' },
            h('p', null, radar.asOf ? `Re-scored ${ago(radar.asOf)}. ` : 'Not re-scored yet. ', `${nf(radar.near.length)} of ${nf(radar.total)} are not strangers to you.`),
            h('p', { class: 'muted' }, 'Click a ring to narrow the table to that band, or a label round the edge to narrow it to one way of having been added. Click a mark to open the account.'),
            chips(
              [{ value: null, label: 'Every band', count: radar.total }, ...[...BANDS, 'UNSCORED'].filter((b) => radar.counts[b]).map((b) => ({ value: b, label: bandName(b), count: radar.counts[b] }))],
              chosen,
              (v) => to({ band: v }),
              'Band',
            ),
            chips(
              [{ value: null, label: 'However added' }, ...Object.keys(FAMILY_WORDS).filter((k) => k !== 'none' || radar.far.none).map((k) => ({ value: k, label: FAMILY_WORDS[k] }))],
              family,
              (v) => to({ family: v }),
              'How they got here',
            ),
            h(
              'form',
              { class: 'toolbar', role: 'search', onSubmit: (e) => { e.preventDefault(); q = search.value.trim(); to({ q }); } },
              search,
              h('button', { type: 'submit', class: 'btn' }, 'Search'),
            ),
            ),
          ),
        ),
        results,
      ];
    },
  });
}
