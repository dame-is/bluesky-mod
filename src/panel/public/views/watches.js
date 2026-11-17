// Posts the bot is reading again every few minutes for new quotes and
// replies. A watch is started in a DM ("watch this"); it can be stopped here.

import { get, post } from '../api.js';
import { h } from '../dom.js';
import { ago, clock, nf, postAuthor, postLink, until } from '../lib/format.js';
import { confirm, empty, section, table, toast, whoName } from '../ui.js';
import { view } from './shared.js';

const MODE = {
  ask: 'Tells you what came in, and asks before adding anyone',
  auto: 'Adds the ones read as hostile, and holds anyone near you for a yes',
};

export function watches(ctx) {
  return view('Watches', {
    sub: 'A watch reads a post’s new quotes and replies for a day and tells you by DM what came in. Start one by sending the bot “watch this” with the post.',
    load: () => get('/api/watches'),
    draw(data, { reload }) {
      const postCell = (w) => {
        const author = postAuthor(w.uri);
        const link = postLink(w.uri);
        return [
          h('div', { class: 'cell-main' }, author === ctx.me.owner?.did ? 'Your post' : ['A post by ', whoName(author, { onOpen: ctx.openAccount })]),
          link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Open it') : null,
        ];
      };
      const seen = (w) => [
        `${nf(w.stats.seen || 0)} read`,
        w.stats.hostile ? `, ${nf(w.stats.hostile)} as hostile` : '',
        w.stats.added ? `, ${nf(w.stats.added)} added` : '',
      ];
      const stop = async (w) => {
        const ok = await confirm({ title: 'Stop watching this post?', body: h('p', { class: 'muted' }, 'Nothing it added comes off the list.'), yes: 'Stop watching' });
        if (!ok) return;
        try {
          await post('/api/watches/stop', { uri: w.uri });
          toast('Stopped watching.');
          window.dispatchEvent(new Event('panel:changed'));
        } catch (err) {
          toast(String(err.message || err), { bad: true });
        }
        reload({ quiet: true });
      };
      return [
        section(
          'Watching now',
          null,
          data.live.length
            ? table(
                [
                  { head: 'Post', cell: postCell },
                  { head: 'What it does', label: 'Does', cell: (w) => MODE[w.mode] || w.mode },
                  { head: 'So far', label: 'So far', cell: seen },
                  { head: 'Last read', label: 'Last read', cell: (w) => (w.lastCheckedAt ? ago(w.lastCheckedAt) : 'Not yet') },
                  { head: 'Ends', label: 'Ends', cell: (w) => until(w.until) },
                  { head: 'Scan', label: 'Scan', cell: (w) => (w.code ? h('a', { class: 'mono', href: `#/scans/${w.code}` }, w.code) : '') },
                  ...(ctx.me.canWrite ? [{ head: h('span', { class: 'sr' }, 'Stop'), cell: (w) => h('button', { type: 'button', class: 'btn btn-small', onClick: () => stop(w) }, 'Stop') }] : []),
                ],
                data.live,
              )
            : empty('Nothing is being watched', 'The bot offers to watch one of your posts when it suddenly takes off.'),
        ),
        data.ended.length
          ? section(
              'Ended',
              null,
              table(
                [
                  { head: 'Post', cell: postCell },
                  { head: 'In all', label: 'In all', cell: seen },
                  { head: 'Started', label: 'Started', cell: (w) => clock(w.createdAt) },
                  { head: 'Ended', label: 'Ended', cell: (w) => clock(w.stoppedAt || w.until) },
                  { head: 'Scan', label: 'Scan', cell: (w) => (w.code ? h('a', { class: 'mono', href: `#/scans/${w.code}` }, w.code) : '') },
                ],
                data.ended,
              ),
            )
          : null,
      ];
    },
  });
}
