// The first page: how big the list is and who on it is near you, what is
// waiting, what is running, and what changed last.

import { get } from '../api.js';
import { h } from '../dom.js';
import { BANDS, ago, bandName, bytes, clock, nf, plural, postLink, until } from '../lib/format.js';
import { cancelCommand } from '../lib/commands.js';
import { band, chips, confirm, empty, listChips, meter, run, section, table } from '../ui.js';
import { bars, changeCols, legend, listRadar, scanCols, view } from './shared.js';

const SPANS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

export function overview(ctx) {
  const days = SPANS.some((s) => s.value === ctx.params.get('days')) ? ctx.params.get('days') : '30';
  // With several lists, the one this page counts and draws. The main one
  // unless the address names another.
  const { several } = ctx.lists;
  const asked = ctx.params.get('list');
  const shown = several && ctx.lists.all.some((l) => l.rkey === asked) ? asked : ctx.lists.main;
  const list = several ? shown : null;
  const isMain = !several || shown === ctx.lists.main;
  const name = several ? ctx.lists.name(shown) : 'the list';
  const listHref = (extra = '') => `#/list${list && !isMain ? `?list=${list}${extra ? `&${extra}` : ''}` : extra ? `?${extra}` : ''}`;
  const to = (patch) => ctx.go('/', { days: days === '30' ? null : days, list: isMain ? null : list, ...patch });

  return view('Overview', {
    aside: chips(SPANS, days, (v) => to({ days: v === '30' ? null : v }), 'Period'),
    load: async () => {
      const [o, radar, health] = await Promise.all([
        get('/api/overview', { days, list }),
        get('/api/list/radar', { list }),
        get('/api/health'),
      ]);
      return { o, radar, health };
    },
    draw({ o, radar, health }, { reload, onCleanup }) {
      const chart = listRadar(radar, {
        onPick: (p) => ctx.openAccount(p.did),
        onBand: (b) => ctx.go('/list', { band: b, list: isMain ? null : list }),
      });
      onCleanup(() => chart.destroy());
      // Only the main list is re-scored. Another list shows each account
      // where it stood when it was added.
      const scoredWhen = isMain
        ? o.list.asOf ? `As of the re-score ${ago(o.list.asOf)}` : 'Not re-scored yet'
        : 'As each stood when added';

      const source =
        o.list.source === 'repo'
          ? o.list.complete ? null : 'The list is longer than the bot reads in one go, so this is a count of what it reached.'
          : o.list.source === 'rescore'
            ? 'The bot could not read its list just now, so this is the last re-score.'
            : 'The bot could not read its list and has not re-scored it yet, so this is counted from the log.';

      const figures = [
        { value: nf(o.list.total), label: several ? `On ${name}` : 'On the list', note: `${nf(o.week.added)} added and ${nf(o.week.removed)} taken off this week${several ? ', on every list' : ''}`, href: listHref() },
        { value: nf(o.waiting.queue + o.waiting.scans), label: 'Waiting for you', note: `${nf(o.waiting.queue)} in the review queue, ${plural(o.waiting.scans, 'scan')}`, href: o.waiting.queue ? '#/queue' : '#/scans' },
        { value: nf(o.protected.total), label: 'Protected', note: `${nf(o.protected.follows)} you follow, ${nf(o.protected.lists)} on your lists, ${nf(o.protected.manual)} by hand`, href: '#/protected' },
        o.snapshot
          ? { value: o.snapshot.ageDays === 0 ? 'Today' : plural(o.snapshot.ageDays, 'day'), label: o.snapshot.ageDays === 0 ? 'Follow graph read' : 'Since the follow graph was read', note: o.snapshot.scoring === 'simple' ? 'Simple scoring: only who you follow' : 'Full scoring: your follows, and who they follow', href: '#/graph' }
          : { value: 'Building', label: 'Follow graph', note: 'Nothing can be scored until the first one is read', href: '#/graph' },
      ];

      const stop = async (scan) => {
        const ok = await confirm({
          title: `Stop adding the rest of scan ${scan.code}?`,
          body: h('p', null, `${nf(scan.live)} are on the list already and stay there. Undo the scan to take them off.`),
          command: cancelCommand(scan.code),
          yes: 'Stop adding',
        });
        if (ok) await run(cancelCommand(scan.code), { after: () => reload({ quiet: true }) });
      };

      return [
        several ? listChips(ctx.lists, shown, (v) => to({ list: v === ctx.lists.main ? null : v })) : null,
        h(
          'div',
          { class: 'figs' },
          figures.map((f) =>
            h('div', { class: 'fig' }, h('a', { class: 'fig-value', href: f.href }, f.value), h('span', { class: 'fig-label' }, f.label), h('span', { class: 'fig-note' }, f.note)),
          ),
        ),
        source ? h('p', { class: 'note' }, source) : null,

        h(
          'div',
          { class: 'split' },
          h(
            'div',
            { class: 'grow-2' },
            section(
              `Who on ${name} is near you`,
              h('span', { class: 'muted' }, scoredWhen),
              h('div', { class: 'well' }, chart.el, legend()),
            ),
          ),
          h(
            'div',
            { class: 'grow-1' },
            section(
              several ? `${name} by band` : 'The list by band',
              h('a', { href: listHref() }, 'Open the list'),
              h(
                'ul',
                { class: 'bandrows' },
                [...BANDS].reverse().map((b) =>
                  h(
                    'li',
                    null,
                    h('a', { class: 'band', href: listHref(`band=${b}`) }, band(b)),
                    meter(o.list.counts[b] || 0, Math.max(1, o.list.total), { label: `${nf(o.list.counts[b] || 0)} ${bandName(b).toLowerCase()}` }),
                    h('span', { class: 'num' }, nf(o.list.counts[b] || 0)),
                  ),
                ),
              ),
              o.list.counts.UNSCORED ? h('p', { class: 'muted' }, isMain ? `${nf(o.list.counts.UNSCORED)} added since the last re-score have no band yet.` : `${nf(o.list.counts.UNSCORED)} were added without a band.`) : null,
              !isMain
                ? h('p', { class: 'muted' }, o.list.total ? 'The weekly re-score reads your main list only, so nobody on this one is queued for review.' : 'Nobody is on this list yet.')
                : o.waiting.queue
                  ? h('p', null, `${plural(o.waiting.queue, 'account')} on ${name} ${o.waiting.queue === 1 ? 'is' : 'are'} not a stranger to you. `, h('a', { href: '#/queue' }, 'Open the review queue'))
                  : h('p', { class: 'muted' }, o.list.total ? `Everyone on ${name} is a stranger to you, or you have chosen to keep them.` : 'Nobody is on the list yet. Send the bot “block” with a post or a handle, or scan a post.'),
            ),
            section(
              several ? 'Added per day, on every list' : 'Added per day',
              h('span', { class: 'muted' }, `${nf(o.span.added)} added, ${nf(o.span.removed)} taken off`),
              bars(
                o.days.map((d) => ({ day: d.day, value: d.added, title: `${d.day}: ${nf(d.added)} added, ${nf(d.removed)} taken off` })),
                { label: `Accounts added per day over ${o.span.days} days: ${nf(o.span.added)} in all` },
              ),
            ),
            section(
              'Running now',
              null,
              h(
                'div',
                { class: 'rows' },
                o.adding.map((s) =>
                  h(
                    'div',
                    null,
                    h('dt', null, 'Adding scan ', h('a', { class: 'mono', href: `#/scans/${s.code}` }, s.code)),
                    h(
                      'dd',
                      null,
                      `${nf(s.live)} written so far. The next batch goes ${until(s.carrying.nextAt)}. `,
                      ctx.me.canWrite ? h('button', { type: 'button', class: 'btn-text', onClick: () => stop(s) }, 'Stop') : null,
                    ),
                  ),
                ),
                h(
                  'div',
                  null,
                  h('dt', null, 'Writes this hour'),
                  h('dd', null, meter(o.budget.hour.used, o.budget.hour.max, { accent: true, label: `${nf(o.budget.hour.used)} of ${nf(o.budget.hour.max)} points used this hour` }), h('div', null, `${nf(o.budget.hour.used)} of ${nf(o.budget.hour.max)} points`)),
                ),
                h(
                  'div',
                  null,
                  h('dt', null, 'Writes today'),
                  h('dd', null, `${nf(o.budget.day.used)} of ${nf(o.budget.day.max)} points`),
                ),
                o.watches.map((w) =>
                  h(
                    'div',
                    null,
                    h('dt', null, 'Watching'),
                    h(
                      'dd',
                      null,
                      h('a', { href: postLink(w.uri) || '#/watches', target: '_blank', rel: 'noopener noreferrer' }, 'A post'),
                      `, until ${clock(w.until)}. ${nf(w.stats.fresh || 0)} new since the last report${w.stats.hostile ? `, ${nf(w.stats.hostile)} read as hostile` : ''}. `,
                      h('a', { href: '#/watches' }, 'Watches'),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),

        section(
          'Scans waiting for you',
          h('a', { href: '#/scans' }, 'All scans'),
          o.scans.length
            ? table(scanCols(ctx).filter((c) => c.head !== 'State'), o.scans, { onRow: (s) => ctx.go(`/scans/${s.code}`) })
            : empty('No scan is waiting', 'Scan a post to see who engaged with it and how close each is to you.'),
        ),

        h(
          'div',
          { class: 'split' },
          h(
            'div',
            { class: 'grow-2' },
            section(
              'Latest changes',
              h('a', { href: '#/activity' }, 'The whole log'),
              o.changes.length ? table(changeCols(ctx), o.changes) : empty('Nothing yet', 'Every add and removal is recorded here with the words that asked for it.'),
            ),
          ),
          h(
            'div',
            { class: 'grow-1' },
            section(
              'Health',
              h('a', { href: '#/settings' }, 'Settings'),
              h(
                'dl',
                { class: 'rows' },
                h('div', null, h('dt', null, 'DMs'), h('dd', null, health.lastPollAt ? `Read ${ago(health.lastPollAt)}` : 'Not read yet', health.queued ? `. ${plural(health.queued, 'job')} queued` : '')),
                h('div', null, h('dt', null, 'The bot'), h('dd', null, health.bot?.handle ? `@${health.bot.handle}` : 'Not signed in', health.dmMode === 'agent' ? ', agent mode' : ', classic mode')),
                h('div', null, h('dt', null, 'Re-score'), h('dd', null, o.rescoredAt ? `Last ran ${ago(o.rescoredAt)}` : 'Has not run yet')),
                h('div', null, h('dt', null, 'Model'), h('dd', null, health.model || 'None: commands only')),
                h('div', null, h('dt', null, 'Database'), h('dd', null, health.database?.kind || '', health.database?.bytes ? `, ${bytes(health.database.bytes)}` : '')),
                health.disk ? h('div', null, h('dt', null, 'Disk'), h('dd', { class: health.disk.low ? 'error' : null }, `${bytes(health.disk.free)} free of ${bytes(health.disk.total)}`, health.disk.low ? '. Nearly full' : '')) : null,
                health.errors ? h('div', null, h('dt', null, 'Failed jobs'), h('dd', null, `${nf(health.errors)} since the bot started ${ago(health.startedAt)}`)) : null,
              ),
            ),
          ),
        ),
      ];
    },
  });
}
