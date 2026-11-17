// One scan: everyone who engaged with a post, on the radar, and the place
// where some of them are added to the list.
//
// Nothing is ticked when the page opens. Ticking a ring (or clicking it on
// the radar) says who that would add, names the ones near you, quotes the
// cost, and shows the command the bot will be sent. The button runs that
// command and nothing else.

import { get } from '../api.js';
import { h, fill } from '../dom.js';
import {
  BANDS,
  BAND_RULE,
  KIND_WORDS,
  ago,
  bandName,
  nf,
  plural,
  postAuthor,
  postLink,
  writeCost,
} from '../lib/format.js';
import {
  addable,
  approveByName,
  approveCommand,
  cancelCommand,
  primaryKind,
  selected,
  triageCommand,
  undoCommand,
} from '../lib/commands.js';
import { bandMark } from '../radar.js';
import { band, chips, confirm, empty, pager, run, section, table, tone, who, whoName } from '../ui.js';
import { legend, scanRadar, stateWords, view } from './shared.js';

const PAGE = 50;
const DID_WORDS = { quote: 'Quoted', reply: 'Replied', repost: 'Reposted', like: 'Liked', other: 'Engaged' };
const CLOSE = ['CONNECTED', 'PERIPHERAL', 'NOTABLE'];
const rank = (b) => BANDS.indexOf(b);

export function scan(ctx) {
  const [code] = ctx.args;

  return view(`Scan ${code}`, {
    load: () => get('/api/scan', { code }),
    draw(data, { reload, onCleanup }) {
      const rows = [...data.rows].sort((a, b) => rank(a.band) - rank(b.band) || (b.trust ?? 0) - (a.trust ?? 0));
      const sel = { bands: new Set(), sectors: new Set(), hostileOnly: false };
      const filters = { band: null, tone: null, open: false, offset: 0 };
      const picked = new Set();
      const read = data.labels.hostile + data.labels.arguing + data.labels.neutral;
      const unread = data.withText - read;
      const after = () => reload({ quiet: true });

      const panel = h('div', { class: 'section' });
      const people = h('div', { class: 'section' });

      const radar = scanRadar(data, sel, {
        onPick: (row) => ctx.openAccount(row.did),
        onBand: (b) => toggle(sel.bands, b),
        onSector: (k) => {
          sel.hostileOnly = false;
          toggle(sel.sectors, k);
        },
      });
      onCleanup(() => radar.destroy());

      function toggle(set, key) {
        if (set.has(key)) set.delete(key);
        else set.add(key);
        radar.select();
        drawPanel();
      }

      const current = () => ({ bands: [...sel.bands], sectors: [...sel.sectors], hostileOnly: sel.hostileOnly });

      async function addSelection() {
        const chosen = selected(rows, current());
        const command = approveCommand(code, current());
        const near = chosen.filter((r) => CLOSE.includes(r.band));
        const ok = await confirm({
          title: `Add ${plural(chosen.length, 'person', 'people')} to the block list?`,
          body: h(
            'div',
            { class: 'section' },
            h('p', null, near.length ? `${nf(near.length)} of them ${near.length === 1 ? 'is' : 'are'} not a stranger to you.` : 'Nobody you follow follows any of them.'),
            h('p', { class: 'muted' }, 'Anyone protected is left out, whatever is ticked. One undo takes the whole batch back.'),
          ),
          command,
          yes: `Add ${nf(chosen.length)} to the list`,
          danger: true,
        });
        if (ok) await run(command, { after });
      }

      async function addPicked() {
        const dids = [...picked];
        const ok = await confirm({
          title: `Add the ${plural(dids.length, 'account')} you picked?`,
          body: h('p', { class: 'muted' }, 'Recorded as accounts you looked at, not as a band you approved.'),
          command: approveByName(code, dids)[0] + (dids.length > 25 ? ' …' : ''),
          yes: `Add ${nf(dids.length)} to the list`,
          danger: true,
        });
        if (!ok) return;
        for (const command of approveByName(code, dids)) await run(command);
        after();
      }

      function drawPanel() {
        const chosen = selected(rows, current());
        const command = approveCommand(code, current());
        const near = chosen.filter((r) => CLOSE.includes(r.band));
        const cost = writeCost(chosen.length);
        const pendingIn = (b) => rows.filter((r) => r.band === b && addable(r)).length;
        const hostileIn = (b) => rows.filter((r) => r.band === b && r.label === 'hostile').length;

        fill(
          panel,
          section(
            'Rings to add',
            h('span', { class: 'muted' }, 'Nothing is added until you say so'),
            h(
              'div',
              { class: 'ringlist' },
              BANDS.map((b) => {
                const locked = b === 'PROTECTED';
                const total = data.byBand[b] || 0;
                const pending = locked ? 0 : pendingIn(b);
                const hostile = hostileIn(b);
                return h(
                  'label',
                  { class: `ring${locked ? ' is-locked' : ''}` },
                  h('input', {
                    type: 'checkbox',
                    checked: sel.bands.has(b),
                    disabled: locked || !pending,
                    onChange: () => toggle(sel.bands, b),
                  }),
                  bandMark(b),
                  h('span', { class: 'ring-text' }, h('span', { class: 'ring-name' }, bandName(b)), h('small', null, BAND_RULE[b])),
                  h(
                    'span',
                    { class: 'ring-n' },
                    nf(total),
                    h('small', null, [pending !== total && !locked ? `${nf(pending)} left to add` : null, hostile ? `${nf(hostile)} hostile` : null].filter(Boolean).join(', ')),
                  ),
                );
              }),
            ),
            read
              ? h(
                  'label',
                  { class: 'check' },
                  h('input', {
                    type: 'checkbox',
                    checked: sel.hostileOnly,
                    onChange: (e) => {
                      sel.hostileOnly = e.target.checked;
                      if (sel.hostileOnly) sel.sectors.clear();
                      radar.select();
                      drawPanel();
                    },
                  }),
                  'Only the ones whose reply or quote read as hostile',
                )
              : null,
            sel.sectors.size && !sel.hostileOnly
              ? h('p', { class: 'muted' }, `Narrowed to those who ${[...sel.sectors].map((k) => DID_WORDS[k].toLowerCase()).join(' or ')} it. Click a corner of the radar to change that.`)
              : null,
          ),

          h(
            'div',
            { class: 'about-to' },
            chosen.length
              ? [
                  h('p', { class: 'about-to-line' }, `You are about to add ${plural(chosen.length, 'person', 'people')}. `, near.length ? `${nf(near.length)} of them ${near.length === 1 ? 'is' : 'are'} not a stranger to you.` : 'Nobody you follow follows any of them.'),
                  near.length
                    ? h(
                        'div',
                        null,
                        h('p', { class: 'muted' }, 'Read these names first, closest to you at the top:'),
                        h('ul', { class: 'timeline' }, near.slice(0, 5).map((r) => h('li', null, who(r.did, { onOpen: ctx.openAccount }), h('span', { class: 'muted' }, bandName(r.band), r.vouches ? `, ${nf(r.vouches)} of your follows` : '', r.label ? `, read as ${r.label}` : '')))),
                        near.length > 5 ? h('p', { class: 'muted' }, `and ${nf(near.length - 5)} more, in the table below.`) : null,
                      )
                    : null,
                  h('p', { class: 'muted' }, `${nf(cost.writes)} writes, ${nf(cost.points)} points, ${cost.time}.`, chosen.length > 500 ? ' The bot adds 500 at a time and carries on by itself.' : '', ' One undo takes it back.'),
                  h('p', { class: 'muted' }, 'The bot will run: ', h('span', { class: 'mono' }, command)),
                  ctx.me.canWrite
                    ? h('div', { class: 'toolbar' }, h('button', { type: 'button', class: 'btn btn-danger-fill', onClick: addSelection }, `Add ${nf(chosen.length)} to the list`))
                    : h('p', { class: 'note' }, 'This account is read-only here, so it cannot add anyone.'),
                ]
              : h('p', { class: 'muted' }, sel.bands.size ? 'Nobody in what is ticked is left to add.' : 'Tick a ring, or click one on the radar, to see who it would add.'),
          ),

          h(
            'div',
            { class: 'toolbar' },
            ctx.me.hasModel && unread > 0
              ? h('button', { type: 'button', class: 'btn', onClick: () => run(triageCommand(code), { after }) }, read ? `Read the other ${nf(unread)}` : `Read what the ${nf(unread)} wrote`)
              : null,
            ctx.me.canWrite && data.live > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn',
                    onClick: async () => {
                      const ok = await confirm({ title: `Take the ${plural(data.live, 'account')} this scan added back off the list?`, command: undoCommand(code), yes: `Take ${nf(data.live)} back off` });
                      if (ok) await run(undoCommand(code), { after });
                    },
                  },
                  `Take back the ${nf(data.live)} added`,
                )
              : null,
            ctx.me.canWrite && (data.state === 'waiting' || data.state === 'adding')
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn',
                    onClick: async () => {
                      const ok = await confirm({ title: data.state === 'adding' ? 'Stop adding the rest?' : 'Cancel this scan?', body: h('p', { class: 'muted' }, 'A cancel takes nobody off the list. It records that you chose not to act.'), command: cancelCommand(code), yes: data.state === 'adding' ? 'Stop adding' : 'Cancel the scan' });
                      if (ok) await run(cancelCommand(code), { after });
                    },
                  },
                  data.state === 'adding' ? 'Stop adding' : 'Cancel the scan',
                )
              : null,
          ),
          !read && data.withText && !ctx.me.hasModel ? h('p', { class: 'muted' }, 'Sorting replies by tone needs a model, and none is set up.') : null,
        );
      }

      function drawPeople() {
        const match = rows.filter(
          (r) =>
            (!filters.band || r.band === filters.band) &&
            (!filters.tone || (filters.tone === 'none' ? !r.label : r.label === filters.tone)) &&
            (!filters.open || addable(r)),
        );
        const shown = match.slice(filters.offset, filters.offset + PAGE);
        const set = (patch) => {
          Object.assign(filters, { offset: 0 }, patch);
          drawPeople();
        };
        const cols = [
          ...(ctx.me.canWrite
            ? [{
                head: h('span', { class: 'sr' }, 'Pick'),
                cell: (r) =>
                  h('input', {
                    type: 'checkbox',
                    class: 'pick',
                    'aria-label': 'Pick this account',
                    checked: picked.has(r.did),
                    disabled: !addable(r),
                    onChange: (e) => {
                      if (e.target.checked) picked.add(r.did);
                      else picked.delete(r.did);
                      drawBar();
                    },
                  }),
              }]
            : []),
          { head: 'Who', cell: (r) => who(r.did, { onOpen: ctx.openAccount }) },
          { head: 'Band', label: 'Band', cell: (r) => [band(r.band), r.vouches ? h('div', { class: 'cell-sub' }, `${nf(r.vouches)} of your follows`) : null] },
          { head: 'Did', label: 'Did', cell: (r) => DID_WORDS[primaryKind(r.kinds)] },
          { head: 'What they wrote, as the model read it', cell: (r) => (r.label ? [tone(r.label), r.quote ? h('div', { class: 'quote' }, `“${r.quote}”`) : null] : r.hasText ? h('span', { class: 'muted' }, 'Not read') : '') },
          { head: 'State', label: 'State', cell: (r) => (r.added ? 'Added' : r.undone ? 'Added, then taken back' : r.listed ? 'Already on the list' : r.protected ? 'Protected' : r.blocksYou ? h('span', { class: 'muted' }, 'Blocks you') : '') },
        ];
        const bar = h('div');
        function drawBar() {
          fill(
            bar,
            picked.size
              ? h(
                  'div',
                  { class: 'actionbar', role: 'region', 'aria-label': 'Picked accounts' },
                  h('span', null, `${plural(picked.size, 'account')} picked`),
                  h(
                    'span',
                    { class: 'toolbar' },
                    h('button', { type: 'button', class: 'btn', onClick: () => { picked.clear(); drawPeople(); } }, 'Clear'),
                    h('button', { type: 'button', class: 'btn btn-danger-fill', onClick: addPicked }, `Add ${nf(picked.size)} by name`),
                  ),
                )
              : null,
          );
        }
        fill(
          people,
          h('div', { class: 'section-head' }, h('h2', null, 'Everyone in this scan'), h('span', { class: 'muted' }, `${nf(match.length)} of ${nf(rows.length)}, closest to you first`)),
          h(
            'div',
            { class: 'toolbar' },
            chips(
              [{ value: null, label: 'Every band' }, ...BANDS.filter((b) => data.byBand[b]).map((b) => ({ value: b, label: bandName(b), count: data.byBand[b] }))],
              filters.band,
              (v) => set({ band: v }),
              'Band',
            ),
          ),
          h(
            'div',
            { class: 'toolbar' },
            read
              ? chips(
                  [
                    { value: null, label: 'Any tone' },
                    { value: 'hostile', label: 'Hostile', count: data.labels.hostile },
                    { value: 'arguing', label: 'Arguing', count: data.labels.arguing },
                    { value: 'neutral', label: 'Neutral', count: data.labels.neutral },
                    { value: 'none', label: 'No label' },
                  ],
                  filters.tone,
                  (v) => set({ tone: v }),
                  'Tone',
                )
              : null,
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: filters.open, onChange: (e) => set({ open: e.target.checked }) }), 'Only those still to add'),
          ),
          shown.length
            ? table(cols, shown, { rowClass: (r) => (r.added || r.listed ? 'is-done' : '') })
            : empty('Nobody matches', 'Change the band or the tone above.'),
          pager({ offset: filters.offset, limit: PAGE, shown: shown.length, total: match.length, onPage: (offset) => { filters.offset = offset; drawPeople(); } }),
          bar,
        );
        drawBar();
      }

      drawPanel();
      drawPeople();

      const author = postAuthor(data.uri);
      const link = postLink(data.uri);
      return [
        h(
          'p',
          { class: 'page-sub' },
          data.kind === 'everyone' ? 'Everyone who engaged with ' : `${KIND_WORDS[data.kind] || 'A scan'} of `,
          author === ctx.me.owner?.did ? 'your post' : ['a post by ', whoName(author, { onOpen: ctx.openAccount })],
          link ? [' (', h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'open it'), ')'] : null,
          `. ${plural(data.total, 'account')}, scanned ${ago(data.createdAt)}. ${stateWords(data)}.`,
          data.truncated ? ' The post was too busy to read in full, so some likes are missing.' : '',
        ),
        data.words.length ? h('p', { class: 'muted' }, 'Approved with: ', data.words.map((w, i) => [i ? ', ' : '', h('span', { class: 'mono' }, w)])) : null,
        h(
          'div',
          { class: 'split' },
          h('div', { class: 'grow-2' }, h('div', { class: 'well' }, radar.el, legend({ hostile: read > 0, done: data.added > 0 || data.alreadyListed > 0 }))),
          h('div', { class: 'grow-1' }, panel),
        ),
        people,
      ];
    },
  });
}
