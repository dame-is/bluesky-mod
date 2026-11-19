// How the bot is set up and how it is running. All of it is read-only here:
// settings live in the bot's environment and its config file, which is
// mounted read-only so the bot cannot rewrite its own instructions.

import { get } from '../api.js';
import { h } from '../dom.js';
import { ago, bytes, clock, nf, plural } from '/client/format.js';
import { section } from '../ui.js';
import { view } from './shared.js';

const row = (label, ...value) => h('div', null, h('dt', null, label), h('dd', null, value));
const days = (n, forever = 'Forever') => (n ? plural(n, 'day') : forever);
const SHIELD = { off: 'Off', ask: 'Asks you first', auto: 'Acts by itself' };
const every = (ms) => (ms ? `Every ${ms >= 3_600_000 ? plural(Math.round(ms / 3_600_000), 'hour') : plural(Math.round(ms / 60_000), 'minute')}` : 'Off');

export function settings(ctx) {
  return view('Settings', {
    sub: 'Shown here, changed in the bot’s .env file and config/bot.json. A change takes effect when the bot restarts; the config file is read again on each message.',
    load: async () => {
      const [s, health] = await Promise.all([get('/api/settings'), get('/api/health')]);
      return { s, health };
    },
    draw({ s, health }) {
      const cursor = Number(health.jetstreamCursor);
      return [
        h(
          'div',
          { class: 'split' },
          h(
            'div',
            { class: 'grow-1' },
            section(
              'The bot',
              null,
              h(
                'dl',
                { class: 'rows' },
                row('Account', health.bot?.handle ? `@${health.bot.handle}` : 'Not signed in'),
                row('Works for', health.owner?.handle ? `@${health.owner.handle}` : h('span', { class: 'mono' }, health.owner?.did)),
                row('DMs', s.mode === 'agent' ? 'Agent mode: talked to in sentences, with the write tools behind a check' : 'Classic mode: typed commands, and a model that only reads'),
                row('Scoring', s.scoring === 'simple' ? 'Simple' : 'Full'),
                row('Model provider', s.provider === 'none' ? 'None' : s.provider),
                row('Atmosphere lookups', s.atmosphere ? 'On' : 'Off'),
                s.multiList && ctx.lists.all.length
                  ? row('Lists', ctx.lists.all.map((l) => `${l.n}. ${l.name}`).join(', '), '. Any moderation list on the bot account can be chosen')
                  : row('List', h('span', { class: 'mono' }, s.list || 'Not made yet')),
                s.shield
                  ? row(
                      'Shield',
                      `One post: ${SHIELD[s.shield.mode] || s.shield.mode}. Attack mode: ${SHIELD[s.shield.attack] || s.shield.attack}. `,
                      s.shield.canGate ? 'It can close replies and turn quotes off.' : 'It can only tell you: closing replies needs an app password for your own account.',
                      s.shield.stream ? '' : ' The reply stream is off, so it cannot count.',
                    )
                  : null,
                s.dryRun ? row('Dry run', 'On: nothing is written or sent') : null,
              ),
            ),
            section(
              'Timers',
              null,
              h(
                'dl',
                { class: 'rows' },
                row('Follow graph', `Rebuilt when ${plural(s.snapshotMaxAgeDays, 'day')} old`),
                row('Re-score of the list', s.rescoreEveryHours ? `Every ${plural(Math.round(s.rescoreEveryHours / 24), 'day')}` : 'Off'),
                row('Watched posts', every(s.watchEveryMs)),
                row('Your own posts taking off', every(s.alertEveryMs)),
              ),
            ),
            section(
              'What is kept',
              null,
              h(
                'dl',
                { class: 'rows' },
                row('Snapshots', `The newest ${s.keep.snapshots}`),
                row('Re-scores', `The newest ${s.keep.audits}`),
                row('Scans never approved', days(s.keep.unapprovedDays)),
                row('Words behind tone labels', days(s.keep.quotesDays)),
                row('Token counts', days(s.keep.usageDays)),
                row('The decision log', 'Forever. A scan anything was added from is never cleared'),
              ),
            ),
          ),
          h(
            'div',
            { class: 'grow-1' },
            section(
              'Running',
              null,
              h(
                'dl',
                { class: 'rows' },
                row('Started', `${ago(health.startedAt)} (${clock(health.startedAt)})`),
                row('DM log', health.lastPollAt ? `Read ${ago(health.lastPollAt)}` : 'Not read yet', health.lastDmAt ? `. Last message ${ago(health.lastDmAt)}` : ''),
                row('Job queue', health.queued ? `${plural(health.queued, 'job')} waiting` : 'Empty', health.snapshotBusy ? '. A snapshot is being built' : ''),
                row('Answers sent', nf(health.dmAnswers)),
                row('Failed jobs', nf(health.errors)),
                row('Your follows, live', Number.isFinite(cursor) && cursor > 0 ? `Last change seen ${ago(new Date(cursor / 1000).toISOString())}` : 'Listening'),
                row('Database', `${health.database?.kind || ''}${health.database?.bytes ? `, ${bytes(health.database.bytes)}` : ''}`),
                health.disk ? row('Disk', h('span', { class: health.disk.low ? 'error' : null }, `${bytes(health.disk.free)} free of ${bytes(health.disk.total)}${health.disk.low ? '. Nearly full: give it a bigger disk' : ''}`)) : null,
                row('Memory', `${bytes(health.memory?.rss)} in use`),
              ),
            ),
            section(
              'The panel',
              null,
              h('dl', { class: 'rows' }, row('Address', s.panel.url || 'Not set (PANEL_URL)'), row('A sign-in lasts', plural(s.panel.sessionDays, 'day'))),
            ),
            section(
              'The config file',
              null,
              s.file
                ? h(
                    'dl',
                    { class: 'rows' },
                    row('Voice', typeof s.file.style === 'string' ? s.file.style : s.file.style ? 'Set' : 'The built-in one'),
                    row('Standing instructions', typeof s.file.guidance === 'string' ? s.file.guidance : s.file.guidance ? 'Set' : 'None'),
                    row('A post with no words', s.file.barePost === 'author' ? 'Blocks whoever wrote it' : 'Gets a card to choose from'),
                    s.file.model ? row('Model', h('span', { class: 'mono' }, s.file.model)) : null,
                    row('Report templates', s.file.report || s.file.postReport ? 'Custom' : 'The built-in ones'),
                  )
                : h('p', { class: 'muted' }, 'There is no config/bot.json, so the bot uses its built-in voice and limits.'),
            ),
            s.notes
              ? section(
                  'Notes you asked it to remember',
                  null,
                  s.notes.length
                    ? h('ol', { class: 'timeline' }, s.notes.map((n) => h('li', null, h('span', null, n.text), h('span', { class: 'muted' }, `${n.byOwner ? 'You' : 'A writer'}, ${ago(n.at)}`))))
                    : h('p', { class: 'muted' }, 'None. In agent mode, “remember: …” in a DM keeps a note the model reads.'),
                )
              : null,
          ),
        ),
        ctx.me.tier === 'reader' ? h('p', { class: 'muted' }, 'Some of this is shown only to the owner.') : null,
      ];
    },
  });
}
