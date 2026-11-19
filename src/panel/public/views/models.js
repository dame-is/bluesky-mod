// Which models the bot calls, and how many tokens they have used. The bot
// counts tokens, not money: what a token costs is between you and whoever
// serves the model.

import { get } from '../api.js';
import { h } from '../dom.js';
import { compact, nf } from '/client/format.js';
import { chips, empty, section, table } from '../ui.js';
import { bars, view } from './shared.js';

const SPANS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];
const KIND = {
  triage: 'Sorting replies by tone',
  'triage-escalated': 'Second reader of the hostile ones',
  agent: 'Agent mode turns',
  check: 'The write check',
  read: 'Reading an account',
  pulse: 'Digests',
  thread: 'Reading a thread',
  watch: 'Watches',
  analyst: 'Questions',
};

export function models(ctx) {
  const days = SPANS.some((s) => s.value === ctx.params.get('days')) ? ctx.params.get('days') : '30';
  return view('Models and tokens', {
    aside: chips(SPANS, days, (v) => ctx.go('/models', { days: v === '30' ? null : v }), 'Period'),
    load: () => get('/api/models', { days }),
    draw(data) {
      const usageCols = (head, name) => [
        { head, cell: (r) => name(r.name) },
        { head: 'Calls', num: true, label: 'Calls', cell: (r) => nf(r.calls) },
        { head: 'Tokens in', num: true, label: 'In', cell: (r) => nf(r.input) },
        { head: 'Tokens out', num: true, label: 'Out', cell: (r) => nf(r.output) },
      ];
      return [
        h(
          'dl',
          { class: 'rows' },
          h('div', null, h('dt', null, 'Provider'), h('dd', null, data.models ? data.provider : 'None. The bot runs on commands only.')),
          data.models ? h('div', null, h('dt', null, 'Answers DMs'), h('dd', null, h('span', { class: 'mono' }, data.models.agent), data.mode === 'agent' ? ', in agent mode: it holds the write tools' : ', in classic mode: it reads and explains, and holds no write tools')) : null,
          data.models ? h('div', null, h('dt', null, 'Write check'), h('dd', null, h('span', { class: 'mono' }, data.models.check), '. Asked before each write in agent mode whether you asked for exactly that')) : null,
          data.models ? h('div', null, h('dt', null, 'Second reader'), h('dd', null, data.models.escalation ? [h('span', { class: 'mono' }, data.models.escalation), '. Re-reads every post the first reader called hostile'] : 'Not set')) : null,
        ),
        data.total.calls
          ? [
              h(
                'div',
                { class: 'figs' },
                [
                  [compact(data.total.input), 'Tokens in'],
                  [compact(data.total.output), 'Tokens out'],
                  [nf(data.total.calls), 'Calls'],
                ].map(([v, l]) => h('div', { class: 'fig' }, h('span', { class: 'fig-value' }, v), h('span', { class: 'fig-label' }, l))),
              ),
              section(
                'Tokens per day',
                h('span', { class: 'muted' }, 'In and out together'),
                bars(data.days.map((d) => ({ day: d.day, value: d.input + d.output, title: `${d.day}: ${nf(d.input)} in, ${nf(d.output)} out, ${nf(d.calls)} calls` })), { label: `Tokens used per day over ${days} days` }),
              ),
              h(
                'div',
                { class: 'split' },
                h('div', { class: 'grow-1' }, section('By what it was for', null, table(usageCols('Used for', (k) => KIND[k] || k), data.byKind))),
                h('div', { class: 'grow-1' }, section('By model', null, table(usageCols('Model', (m) => h('span', { class: 'mono' }, m)), data.byModel))),
              ),
            ]
          : empty('No model calls in this period', data.models ? 'Counts appear once the bot has answered a question, sorted a scan or run a watch.' : 'Set a model provider in the bot’s environment to turn on questions, agent mode, sorting by tone and watches.'),
      ];
    },
  });
}
