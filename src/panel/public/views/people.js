// Who the bot answers, and where you are signed in to the panel.

import { get, post } from '../api.js';
import { h } from '../dom.js';
import { ago, clock, dayMonth } from '../lib/format.js';
import { confirm, section, table, who } from '../ui.js';
import { view } from './shared.js';

const TIER = {
  owner: ['Owner', 'Everything'],
  writer: ['Writer', 'Everything, including changing the list'],
  reader: ['Read-only', 'Everything that does not change the list. Sees bands and what was done, not the words that asked for it'],
};

export function people(ctx) {
  return view('People', {
    sub: 'The bot answers the accounts on its roster and nobody else, in DMs and here alike. The roster is set in the bot’s environment (MOD_OWNER_DID, MOD_WRITER_DIDS, MOD_ALLOWED_DIDS) and changes when the bot restarts.',
    load: () => get('/api/people'),
    draw(data, { reload }) {
      const everywhere = async () => {
        const ok = await confirm({ title: 'Sign out of the panel everywhere?', body: h('p', { class: 'muted' }, 'Every browser signed in as you, this one included, will need a new code from the bot.'), yes: 'Sign out everywhere' });
        if (!ok) return;
        await post('/api/sign-out-everywhere', {}).catch(() => {});
        location.reload();
      };
      return [
        section(
          ctx.me.tier === 'owner' ? 'Who the bot answers' : 'You',
          null,
          table(
            [
              { head: 'Who', cell: (p) => who(p.did, { onOpen: ctx.openAccount }) },
              { head: 'May', label: 'May', cell: (p) => [h('div', { class: 'cell-main' }, TIER[p.tier][0]), h('div', { class: 'cell-sub' }, TIER[p.tier][1])] },
              { head: 'DID', label: 'DID', cell: (p) => h('span', { class: 'mono' }, p.did) },
            ],
            data.people,
          ),
        ),
        section(
          'Where you are signed in',
          h('button', { type: 'button', class: 'btn btn-small', onClick: everywhere }, 'Sign out everywhere'),
          table(
            [
              { head: 'Signed in', cell: (s) => [clock(s.createdAt), s.id === data.current ? h('span', { class: 'cell-sub' }, '  This browser') : null] },
              { head: 'Last used', label: 'Last used', cell: (s) => (s.lastSeenAt ? ago(s.lastSeenAt) : '') },
              { head: 'Ends', label: 'Ends', cell: (s) => dayMonth(s.expiresAt) },
            ],
            data.sessions,
          ),
          h('p', { class: 'muted' }, 'A sign-in is a code the bot sent you by DM. To sign in somewhere else, send it “panel” again. ', h('button', { type: 'button', class: 'btn-text', onClick: reload }, 'Refresh')),
        ),
      ];
    },
  });
}
