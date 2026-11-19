// The panel: the frame around every page, and which page is showing.
//
// Pages are addressed in the hash (#/scans/3f2a1b7c), so Back goes back, a
// page can be bookmarked, and the server only ever serves one file. An
// account opened over a page is in the address too (?account=did:...), so
// Back closes it.

import { get, post, ApiError } from './api.js';
import { h, fill, icon } from './dom.js';
import { nf } from '/client/format.js';
import { blockCommand, onList } from '/client/commands.js';
import { listPicker, openOver, resetProfiles, run, toast } from './ui.js';
import { openAccount } from './views/account.js';
import { signIn } from './views/signin.js';
import * as views from './views/index.js';

const app = document.getElementById('app');

/** Each place in the rail: where it goes, what it is called, what it counts. */
const NAV = [
  [{ path: '/', label: 'Overview' }],
  [
    { path: '/queue', label: 'Review queue', count: (c) => c.queue },
    { path: '/scans', label: 'Scans', count: (c) => c.scans },
    // What is being watched is told to someone who may write, as in a DM.
    { path: '/watches', label: 'Watches', count: (c) => c.watches, writers: true },
  ],
  [
    // With several lists the number would be one list's, so there is none.
    { path: '/list', label: (l) => (l.several ? 'Lists' : 'The list'), count: (c, l) => (l.several ? null : c.list) },
    { path: '/protected', label: 'Protected', count: (c) => c.protected },
    { path: '/activity', label: 'Activity' },
  ],
  [
    { path: '/graph', label: 'Follow graph' },
    { path: '/models', label: 'Models and tokens' },
    { path: '/people', label: 'People' },
    { path: '/settings', label: 'Settings' },
  ],
];

const ROUTES = [
  [/^\/$/, views.overview],
  [/^\/queue$/, views.queue],
  [/^\/scans$/, views.scans],
  [/^\/scans\/([0-9a-f]{8})$/, views.scan],
  [/^\/watches$/, views.watches],
  [/^\/list$/, views.list],
  [/^\/protected$/, views.protectedAccounts],
  [/^\/activity$/, views.activity],
  [/^\/graph$/, views.graph],
  [/^\/models$/, views.models],
  [/^\/people$/, views.people],
  [/^\/settings$/, views.settings],
];

function readHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { path: path || '/', params: new URLSearchParams(query) };
}

/** Go to a page, or change this page's parameters. */
export function go(path, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, v);
  const next = `#${path}${q.size ? `?${q}` : ''}`;
  if (next === location.hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = next;
}

let me = null;
/**
 * The bot's lists. `several` is true only when a write has to say which:
 * MOD_MULTI_LIST is on and the bot has more than one.
 */
let lists = { several: false, all: [], main: null, name: () => 'the list' };
let counts = {};
let current = null;
let closeSheet = null;
let shown = '';
const railLinks = new Map();
let rail = null;
let page = null;
let tabbar = null;

async function refreshCounts() {
  try {
    const o = await get('/api/overview', { days: 7 });
    counts = {
      queue: o.waiting.queue,
      scans: o.waiting.scans,
      watches: o.watches.length,
      list: o.list.total,
      protected: o.protected.total,
    };
  } catch {
    counts = {};
  }
  for (const [item, el] of railLinks) {
    const n = item.count?.(counts, lists);
    el.textContent = n == null || n === 0 ? '' : nf(n);
  }
  for (const el of tabbar?.querySelectorAll('[data-count]') || []) {
    const n = counts[el.dataset.count];
    el.textContent = n ? nf(n) : '';
  }
}

function buildShell() {
  railLinks.clear();
  const link = (item) => {
    const count = h('span', { class: 'nav-count' });
    railLinks.set(item, count);
    const label = typeof item.label === 'function' ? item.label(lists) : item.label;
    return h('a', { class: 'nav-link', href: `#${item.path}`, 'data-path': item.path }, h('span', null, label), count);
  };
  rail = h(
    'nav',
    { class: 'rail', 'aria-label': 'Sections' },
    h('div', { class: 'rail-head' }, h('div', { class: 'rail-name' }, 'Block List'), h('div', { class: 'rail-sub' }, me.bot?.handle || 'the bot')),
    NAV.map((group) => h('div', { class: 'nav-group' }, group.filter((item) => !item.writers || me.canWrite).map(link))),
    h(
      'div',
      { class: 'rail-foot' },
      h('strong', null, me.dryRun ? 'Dry run: nothing is written' : 'Answering DMs'),
      h('span', { class: 'muted' }, me.owner?.handle ? `Working for ${me.owner.handle}` : ''),
      h('span', { class: 'muted' }, me.tier === 'reader' ? 'You are read-only here' : `Signed in as ${me.tier === 'owner' ? 'the owner' : 'a writer'}`),
      h('button', { type: 'button', class: 'btn-text', onClick: signOut }, 'Sign out'),
    ),
  );
  rail.addEventListener('click', (e) => {
    if (e.target.closest('a')) rail.classList.remove('is-open');
  });

  const search = h('input', {
    class: 'field',
    type: 'search',
    'aria-label': 'Find an account or a scan code',
    placeholder: 'Find an account or a scan code',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const topbar = h(
    'div',
    { class: 'topbar' },
    h('button', { type: 'button', class: 'btn btn-icon topbar-menu', 'aria-label': 'Sections', onClick: () => rail.classList.toggle('is-open') }, icon('menu')),
    h(
      'form',
      {
        class: 'topbar-search',
        role: 'search',
        onSubmit: (e) => {
          e.preventDefault();
          const text = search.value.trim();
          if (!text) return;
          if (/^[0-9a-f]{8}$/i.test(text)) go(`/scans/${text.toLowerCase()}`);
          else showAccount(text);
          search.value = '';
        },
      },
      search,
    ),
    h(
      'div',
      { class: 'topbar-actions' },
      me.canWrite ? h('button', { type: 'button', class: 'btn', onClick: askBlock }, 'Block an account') : null,
      h('button', { type: 'button', class: 'btn btn-primary', onClick: askScan }, 'Scan a post'),
    ),
  );
  page = h('main', { class: 'page', id: 'page', tabindex: '-1' });
  tabbar = h(
    'nav',
    { class: 'tabbar', 'aria-label': 'Sections' },
    [
      ['/', 'Overview'],
      ['/queue', 'Queue', 'queue'],
      ['/scans', 'Scans', 'scans'],
      ['/list', 'List'],
    ].map(([path, label, count]) => h('a', { class: 'tab', href: `#${path}`, 'data-path': path }, label, count ? h('small', { 'data-count': count }) : null)),
    h('button', { type: 'button', class: 'tab', onClick: () => rail.classList.toggle('is-open') }, 'More'),
  );
  const skip = h('button', { type: 'button', class: 'btn skip', onClick: () => page.focus() }, 'Skip to the page');
  fill(app, skip, h('div', { class: 'shell' }, rail, h('div', { class: 'main' }, topbar, page), tabbar));
}

/** The context every page is given. */
const ctx = () => ({
  me,
  lists,
  go,
  openAccount: showAccount,
  /** Read the store again and redraw this page, after something changed. */
  refresh: () => show({ force: true }),
});

function showAccount(actor) {
  const { path, params } = readHash();
  params.set('account', actor);
  location.hash = `#${path}?${params}`;
}

function show({ force = false } = {}) {
  const { path, params } = readHash();
  const account = params.get('account');
  params.delete('account');
  const key = `${path}?${params}`;

  for (const el of document.querySelectorAll('[data-path]')) {
    const on = el.dataset.path === '/' ? path === '/' : path.startsWith(el.dataset.path);
    if (on) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }

  if (force || key !== shown) {
    shown = key;
    current?.destroy?.();
    resetProfiles();
    const match = ROUTES.map(([re, view]) => [path.match(re), view]).find(([m]) => m);
    if (!match) {
      current = null;
      fill(page, h('div', { class: 'page-head' }, h('h1', null, 'There is nothing at that address')), h('p', null, h('a', { href: '#/' }, 'Go to the overview')));
    } else {
      const [m, view] = match;
      current = view({ ...ctx(), params, args: m.slice(1) });
      fill(page, current.el);
      if (!force) window.scrollTo(0, 0);
    }
  }

  // The account sheet follows the address, so Back closes it.
  closeSheet?.();
  closeSheet = null;
  if (account) {
    const sheet = openAccount(account, ctx());
    let closing = false;
    const close = openOver(sheet.el, {
      sheet: true,
      onClose: () => {
        // Closed by hand: take it out of the address too.
        if (closing) return;
        closeSheet = null;
        const now = readHash();
        if (now.params.get('account')) {
          now.params.delete('account');
          history.replaceState(null, '', `#${now.path}${now.params.size ? `?${now.params}` : ''}`);
        }
      },
    });
    sheet.onClose(close);
    closeSheet = () => { closing = true; close(); };
  }
}

async function askBlock() {
  const input = h('input', { class: 'field', type: 'text', required: true, 'data-focus': true, autocomplete: 'off', spellcheck: 'false', placeholder: 'someone.bsky.social' });
  const picker = lists.several ? listPicker(lists) : null;
  const done = await new Promise((resolve) => {
    let answered = false;
    const finish = (v) => { answered = true; close(); resolve(v); };
    const content = h(
      'form',
      {
        class: 'dialog',
        'aria-label': 'Block an account',
        onSubmit: (e) => {
          e.preventDefault();
          const actor = input.value.trim();
          finish(actor ? onList(blockCommand(actor), picker?.value) : '');
        },
      },
      h('h2', null, 'Block an account'),
      h('label', { class: 'label' }, 'A handle, a DID or a profile link', input, h('small', null, 'Someone you follow, or on one of your curation lists, is refused, as in a DM.')),
      picker ? h('label', { class: 'label' }, 'Which list', picker) : null,
      h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn', onClick: () => finish('') }, 'Cancel'), h('button', { type: 'submit', class: 'btn btn-danger-fill' }, lists.several ? 'Add to that list' : 'Add to the list')),
    );
    const close = openOver(content, { onClose: () => { if (!answered) resolve(''); } });
  });
  if (done) await run(done, { after: () => show({ force: true }) });
}

async function askScan() {
  const link = h('input', { class: 'field', type: 'url', 'data-focus': true, autocomplete: 'off', placeholder: 'https://bsky.app/profile/…/post/…' });
  const kind = h(
    'select',
    { class: 'field' },
    [['everyone', 'Everyone who engaged'], ['likers', 'Likers'], ['reposters', 'Reposters'], ['repliers', 'Repliers'], ['quoters', 'Quoters']].map(([v, l]) => h('option', { value: v }, l)),
  );
  const status = h('p', { class: 'muted', role: 'status' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Scan');
  let close = () => {};
  const content = h(
    'form',
    {
      class: 'dialog',
      'aria-label': 'Scan a post',
      onSubmit: async (e) => {
        e.preventDefault();
        if (!link.value.trim()) return;
        submit.disabled = true;
        status.textContent = 'Collecting who engaged and scoring them. A busy post takes a minute.';
        try {
          const { code } = await post('/api/scans', { link: link.value.trim(), kind: kind.value });
          close();
          go(`/scans/${code}`);
          refreshCounts();
        } catch (err) {
          status.textContent = String(err.message || err);
          status.className = 'error';
          submit.disabled = false;
        }
      },
    },
    h('h2', null, 'Scan a post'),
    h('label', { class: 'label' }, 'A link to the post', link),
    h('label', { class: 'label' }, 'Who to collect', kind),
    h('p', { class: 'muted' }, 'A scan adds nobody. It shows who engaged and how close each is to you, and waits.'),
    status,
    h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn', onClick: () => close() }, 'Cancel'), submit),
  );
  close = openOver(content);
}

async function signOut() {
  await post('/api/sign-out', {}).catch(() => {});
  boot();
}

async function boot() {
  try {
    me = await get('/api/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return fill(app, signIn({ onDone: boot }).el);
    return fill(app, h('p', { class: 'boot error', role: 'alert' }, String(err.message || err), ' ', h('button', { type: 'button', class: 'btn-text', onClick: boot }, 'Try again')));
  }
  // Which lists there are decides what a write has to say. If they cannot be
  // read the page still opens, as for a bot with one; the pages that need
  // them say why they cannot load.
  try {
    const got = await get('/api/lists');
    const all = got.lists || [];
    lists = {
      several: Boolean(got.multi) && all.length > 1,
      all,
      main: all[0]?.rkey || null,
      name: (rkey) => all.find((l) => l.rkey === rkey)?.name || 'a list that is gone',
    };
  } catch {
    lists = { several: false, all: [], main: null, name: () => 'the list' };
  }
  buildShell();
  shown = '';
  show();
  refreshCounts();
  return undefined;
}

window.addEventListener('hashchange', () => me && show());
window.addEventListener('panel:changed', () => me && refreshCounts());
window.addEventListener('panel:signed-out', () => {
  if (!me) return;
  me = null;
  closeSheet?.();
  toast('You are signed out. Send the bot "panel" for a new code.', { bad: true });
  fill(app, signIn({ onDone: boot }).el);
});

boot();
