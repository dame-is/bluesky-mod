// The accounts no automated path may add: who you follow, who is on the
// lists you made, and anyone protected by hand.

import { get } from '../api.js';
import { h } from '../dom.js';
import { ago, nf } from '/client/format.js';
import { empty, pager, table, who } from '../ui.js';
import { view } from './shared.js';

const PAGE = 50;

export function protectedAccounts(ctx) {
  const offset = Number(ctx.params.get('offset')) || 0;
  const q = ctx.params.get('q') || '';
  return view('Protected', {
    sub: 'Nothing the bot does can add these accounts to the list, including a command you type yourself. The veto is checked again at the moment of every write, and someone you followed a minute ago is covered within seconds.',
    load: () => get('/api/protected', { q, offset, limit: PAGE }),
    draw(data) {
      const search = h('input', { class: 'field', type: 'search', value: q, 'aria-label': 'Find a protected account by DID', placeholder: 'Find by DID' });
      return [
        h(
          'div',
          { class: 'figs' },
          [
            [data.counts.total, 'Protected in all'],
            [data.counts.follows, 'You follow'],
            [data.counts.lists, 'On lists you made'],
            [data.counts.manual, 'Added by hand'],
          ].map(([n, label]) => h('div', { class: 'fig' }, h('span', { class: 'fig-value' }, nf(n)), h('span', { class: 'fig-label' }, label))),
        ),
        h(
          'form',
          { class: 'toolbar', role: 'search', onSubmit: (e) => { e.preventDefault(); ctx.go('/protected', { q: search.value.trim() }); } },
          search,
          h('button', { type: 'submit', class: 'btn' }, 'Find'),
          h('span', { class: 'muted' }, 'To look someone up by handle, use the box at the top of the page.'),
        ),
        data.rows.length
          ? table(
              [
                { head: 'Who', cell: (r) => who(r.did, { onOpen: ctx.openAccount }) },
                { head: 'Why', label: 'Why', cell: (r) => r.reason },
                { head: 'From', label: 'From', cell: (r) => (r.source === 'manual' ? 'Added by hand' : 'Your follows and lists') },
                { head: 'Since', label: 'Since', cell: (r) => h('span', { class: 'nowrap' }, ago(r.addedAt)) },
              ],
              data.rows,
              { onRow: (r) => ctx.openAccount(r.did) },
            )
          : empty(q ? 'No protected account has that DID' : 'Nobody is protected yet', q ? '' : 'The first read of who you follow fills this in, a few minutes after the bot starts. Until then the bot adds nobody.'),
        pager({ offset, limit: PAGE, shown: data.rows.length, more: data.more, onPage: (o) => ctx.go('/protected', { q, offset: o || null }) }),
      ];
    },
  });
}
