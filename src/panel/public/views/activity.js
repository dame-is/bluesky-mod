// The decision log: every add, removal and undo, newest first, with the
// words that asked for it.

import { get } from '../api.js';
import { chips, empty, pager, table } from '../ui.js';
import { changeCols, view } from './shared.js';

const PAGE = 40;
const FILTERS = [
  { value: null, label: 'Everything' },
  { value: 'added', label: 'Added' },
  { value: 'removed', label: 'Removed' },
  { value: 'undone', label: 'Taken back' },
];

export function activity(ctx) {
  const filter = FILTERS.some((f) => f.value === ctx.params.get('filter')) ? ctx.params.get('filter') : null;
  const offset = Number(ctx.params.get('offset')) || 0;
  return view('Activity', {
    sub: ctx.me.canWrite
      ? 'Every change to the list, by any path: a DM, the agent, a watch or this panel. A batch is one line.'
      : 'Every change to the list. The words that asked for each are the owner’s, and are not shown to a read-only account.',
    load: () => get('/api/activity', { filter, offset, limit: PAGE }),
    draw(data) {
      return [
        chips(FILTERS, filter, (v) => ctx.go('/activity', { filter: v }), 'What to show'),
        data.events.length
          ? table(changeCols(ctx), data.events)
          : empty('Nothing yet', 'Changes appear here as they are made.'),
        pager({ offset, limit: PAGE, shown: data.events.length, more: data.more, onPage: (o) => ctx.go('/activity', { filter, offset: o || null }) }),
      ];
    },
  });
}
