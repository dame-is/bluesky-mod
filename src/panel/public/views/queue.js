// The review queue: accounts on the list who are not strangers to you, the
// closest first, each with the two decisions that matter.
//
// The weekly re-score fills it. Removing takes the account off the list
// through the bot's unblock; keeping leaves it there and out of this queue
// unless a later re-score puts it closer.

import { get, post } from '../api.js';
import { h, fill } from '../dom.js';
import { BAND_RULE, ago, bandName, compact, nf, viaWords } from '/client/format.js';
import { onList, unblockCommand } from '/client/commands.js';
import { band, chips, empty, pager, run, toast, who } from '../ui.js';
import { view } from './shared.js';

const ORDER = ['PROTECTED', 'CONNECTED', 'PERIPHERAL', 'NOTABLE'];
const PAGE = 30;

function why(item) {
  if (item.band === 'PROTECTED') return item.protectedReason ? `Protected: ${item.protectedReason}. They should not be on this list.` : 'Protected, and still on the list.';
  if (item.vouches) return `${nf(item.vouches)} of the people you follow follow them.`;
  if (item.band === 'NOTABLE') return 'Nobody you follow follows them, but a lot of people do.';
  return BAND_RULE[item.band];
}

export function queue(ctx) {
  const chosen = ORDER.includes(ctx.params.get('band')) ? ctx.params.get('band') : null;
  const offset = Number(ctx.params.get('offset')) || 0;

  return view('Review queue', {
    sub: `Accounts on ${ctx.lists.several ? `your main list, ${ctx.lists.name(ctx.lists.main)},` : 'the list'} who are not strangers to you, as of the last re-score. Most of the list was added as strangers; these are the ones that moved, or were close when they were added.${ctx.lists.several ? ' The re-score reads no other list.' : ''}`,
    load: () => get('/api/queue', { band: chosen, offset, limit: PAGE }),
    draw(data, { reload }) {
      const cards = h('ol', { class: 'cards' });
      const said = h('p', { class: 'muted', role: 'status' }, data.asOf ? `Re-scored ${ago(data.asOf)}.` : 'The list has not been re-scored yet, so nothing can be queued.');
      const tally = { keep: 0, remove: 0 };
      const quiet = () => reload({ quiet: true });

      const decide = async (item, what, card) => {
        for (const b of card.querySelectorAll('button')) b.disabled = true;
        if (what === 'keep') {
          try {
            await post('/api/queue/keep', { did: item.did, band: item.band });
          } catch (err) {
            toast(String(err.message || err), { bad: true });
            return quiet();
          }
          tally.keep += 1;
          toast(`Kept ${item.handle ? `@${item.handle}` : 'that account'} on the list.`, {
            actions: [{ label: 'Undo', run: async () => { await post('/api/queue/reopen', { did: item.did }).catch(() => {}); quiet(); } }],
          });
          window.dispatchEvent(new Event('panel:changed'));
        } else {
          // The queue is the main list's, so that is the list they come off.
          const out = await run(onList(unblockCommand(item.did), ctx.lists.several ? ctx.lists.main : null));
          if (out?.outcome === 'done') tally.remove += 1;
        }
        return quiet();
      };

      const card = (item) => {
        const el = h(
          'li',
          { class: 'card', tabindex: '0', 'aria-label': `${item.handle || item.did}, ${bandName(item.band)}` },
          who(item.did, { handle: item.handle, onOpen: ctx.openAccount }),
          h('p', { class: 'card-why' }, band(item.band), h('span', null, why(item))),
          h(
            'p',
            { class: 'muted' },
            [
              item.bandThen && item.bandThen !== item.band ? `Was ${bandName(item.bandThen).toLowerCase()} when added` : null,
              item.addedAt ? `added ${ago(item.addedAt)}` : null,
              item.via ? viaWords(item.via).toLowerCase() : 'no record of how',
              item.followers != null ? `${compact(item.followers)} followers` : null,
            ]
              .filter(Boolean)
              .join(', '),
          ),
          ctx.me.canWrite
            ? h(
                'div',
                { class: 'card-actions' },
                h('button', { type: 'button', class: 'btn', onClick: () => decide(item, 'keep', el) }, 'Keep on the list'),
                h('button', { type: 'button', class: 'btn btn-danger', onClick: () => decide(item, 'remove', el) }, 'Remove'),
                h('button', { type: 'button', class: 'btn-text', onClick: () => ctx.openAccount(item.did) }, 'Details'),
              )
            : null,
        );
        el.item = item;
        return el;
      };

      fill(cards, data.rows.map(card));
      // Arrows move, K keeps, R removes, Enter opens. Only with a card in
      // focus, so typing anywhere else is never a decision.
      cards.addEventListener('keydown', (e) => {
        const el = e.target.closest('.card');
        if (!el || e.target !== el || e.metaKey || e.ctrlKey || e.altKey) return;
        const all = [...cards.children];
        const i = all.indexOf(el);
        if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); all[Math.min(all.length - 1, i + 1)]?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); all[Math.max(0, i - 1)]?.focus(); }
        else if (e.key === 'Enter') { e.preventDefault(); ctx.openAccount(el.item.did); }
        else if (ctx.me.canWrite && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); decide(el.item, 'keep', el); }
        else if (ctx.me.canWrite && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); decide(el.item, 'remove', el); }
      });

      return [
        chips(
          [{ value: null, label: 'All', count: data.total }, ...ORDER.filter((b) => data.counts[b]).map((b) => ({ value: b, label: bandName(b), count: data.counts[b] }))],
          chosen,
          (v) => ctx.go('/queue', { band: v }),
          'Why they are here',
        ),
        said,
        data.rows.length
          ? cards
          : empty(
              data.total ? 'Nobody in that band is waiting' : 'Nothing is waiting for you',
              data.asOf
                ? 'Everyone on the list is a stranger to you, or you have chosen to keep them. The list is re-scored weekly, and anyone who stops being a stranger shows up here.'
                : 'The first re-score runs within a week of the bot starting.',
            ),
        pager({ offset, limit: PAGE, shown: data.rows.length, total: data.matched, onPage: (o) => ctx.go('/queue', { band: chosen, offset: o || null }) }),
        data.rows.length && ctx.me.canWrite ? h('p', { class: 'muted' }, 'With a card in focus: up and down move, K keeps, R removes, Enter opens the account.') : null,
      ];
    },
  });
}
