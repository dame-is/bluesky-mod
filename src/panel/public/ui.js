// The parts every page uses: an account's name and face, a band and a tone
// label, tables, dialogs, toasts, and the one function that runs a command.

import { get, post } from './api.js';
import { h, fill, icon, sr } from './dom.js';
import { bandName, nf, shortDid } from './lib/format.js';
import { bandMark } from './radar.js';

// --- names and faces -------------------------------------------------------------
// The store knows DIDs. Names come from the bot, a page of them at a time,
// and fill in after the row is already on screen.

const known = new Map();
const waiting = new Map();
let timer = null;

/** Forget who is waiting for a name, when the page changes. */
export function resetProfiles() {
  waiting.clear();
}

function wants(did, apply) {
  if (known.has(did)) return apply(known.get(did));
  if (!waiting.has(did)) waiting.set(did, new Set());
  waiting.get(did).add(apply);
  if (!timer) timer = setTimeout(fetchNames, 40);
  return undefined;
}

async function fetchNames() {
  timer = null;
  const dids = [...waiting.keys()].filter((d) => !known.has(d)).slice(0, 100);
  if (!dids.length) return;
  try {
    const { profiles } = await post('/api/profiles', { dids });
    for (const did of dids) {
      const p = profiles[did];
      if (!p) continue;
      known.set(did, p);
      for (const apply of waiting.get(did) || []) apply(p);
      waiting.delete(did);
    }
  } catch {
    // Rows keep their DIDs. A name is a nicety.
  }
  // Whoever could not be named this time is not asked for again in a loop.
  for (const did of dids) waiting.delete(did);
  if ([...waiting.keys()].some((d) => !known.has(d))) timer = setTimeout(fetchNames, 40);
}

/** A profile once it has arrived, or null. */
export const profileOf = (did) => known.get(did) || null;

/** One account's profile, fetched now if it is not held. */
export async function loadProfile(did) {
  if (!known.has(did)) {
    const { profiles } = await post('/api/profiles', { dids: [did] }).catch(() => ({ profiles: {} }));
    if (profiles[did]) known.set(did, profiles[did]);
  }
  return known.get(did) || null;
}

const initials = (text) =>
  String(text || '?')
    .replace(/^@/, '')
    .split(/[\s.]+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

export function avatar(profile, { large = false, fallback = '' } = {}) {
  const box = h('span', { class: `avatar${large ? ' avatar-lg' : ''}`, 'aria-hidden': 'true' });
  const set = (p) => {
    if (p?.avatar) fill(box, h('img', { src: p.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }));
    else fill(box, initials(p?.displayName || p?.handle || fallback));
  };
  set(profile);
  return { el: box, set };
}

/**
 * An account: face, name and handle. A button when `onOpen` is given. Starts
 * with what the caller knows (a handle from the last re-score, or nothing)
 * and fills in when the profile arrives.
 */
export function who(did, { handle = null, onOpen = null } = {}) {
  const face = avatar(null, { fallback: handle || '' });
  const name = h('span', { class: 'who-name' }, handle || shortDid(did));
  const sub = h('span', { class: 'who-handle' }, handle ? '' : '');
  const text = h('span', { class: 'who-text' }, name, sub);
  const el = onOpen
    ? h('button', { type: 'button', class: 'who', onClick: (e) => { e.stopPropagation(); onOpen(did); } }, face.el, text)
    : h('span', { class: 'who' }, face.el, text);
  wants(did, (p) => {
    face.set(p);
    if (p.missing) {
      name.textContent = handle || shortDid(did);
      sub.textContent = 'No longer on Bluesky';
      return;
    }
    name.textContent = p.displayName || p.handle || shortDid(did);
    sub.textContent = p.displayName && p.handle ? `@${p.handle}` : '';
  });
  return el;
}

/**
 * An account as a name in a sentence: "@handle", no face. Fills in like
 * `who` does, and opens the account when `onOpen` is given.
 */
export function whoName(did, { onOpen = null } = {}) {
  const el = onOpen
    ? h('button', { type: 'button', class: 'who-inline', onClick: (e) => { e.stopPropagation(); onOpen(did); } }, shortDid(did))
    : h('span', null, shortDid(did));
  wants(did, (p) => {
    el.textContent = p.handle ? `@${p.handle}` : shortDid(did);
  });
  return el;
}

// --- small things -----------------------------------------------------------------

/** A band: its mark and its name. */
export const band = (b) => h('span', { class: 'band' }, bandMark(b), bandName(b));

/** A model's reading of what someone wrote. Never styled like a band. */
export const tone = (label) =>
  label ? h('span', { class: `tone tone-${label}` }, label) : null;

/** How a scan's accounts split by closeness, as one bar. */
export function closeness(byBand, total) {
  const pct = (n) => `${Math.max(n ? 1.5 : 0, (100 * n) / Math.max(1, total))}%`;
  return h(
    'span',
    { class: 'stack', 'aria-hidden': 'true' },
    ['PROTECTED', 'CONNECTED', 'PERIPHERAL', 'NOTABLE'].map((b) =>
      h('span', { class: `s-${b.toLowerCase()}`, style: { width: pct(byBand[b] || 0) } }),
    ),
  );
}

export function meter(used, max, { accent = false, label } = {}) {
  const pct = Math.min(100, Math.round((100 * used) / Math.max(1, max)));
  return h(
    'div',
    { class: `meter${accent ? ' meter-accent' : ''}`, role: 'img', 'aria-label': label || `${pct} percent` },
    // Something that is there is never drawn as nothing.
    h('span', { style: { width: used > 0 ? `max(3px, ${pct}%)` : '0' } }),
  );
}

export const section = (title, aside, ...children) =>
  h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, title), aside), children);

export const empty = (title, text) => h('p', { class: 'empty' }, h('strong', null, title), text);

export const loading = (what = 'Loading.') => h('p', { class: 'muted', role: 'status' }, what);

export function problem(err, retry) {
  return h(
    'p',
    { class: 'error', role: 'alert' },
    String(err?.message || err),
    retry ? [' ', h('button', { type: 'button', class: 'btn-text', onClick: retry }, 'Try again')] : null,
  );
}

/** Pressed-or-not buttons that choose one of a few things. */
export function chips(options, value, onChange, label) {
  return h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': label },
    options.map((o) =>
      h(
        'button',
        { type: 'button', class: 'chip', 'aria-pressed': String(o.value === value), onClick: () => onChange(o.value) },
        o.label,
        o.count != null ? h('span', { class: 'chip-n' }, nf(o.count)) : null,
      ),
    ),
  );
}

/**
 * A table. `cols`: [{ head, cell: (row) => node or text, num?, label? }].
 * `label` is what a phone shows before the cell once the table is stacked.
 */
export function table(cols, rows, { stack = true, onRow = null, rowClass = null } = {}) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: stack ? 'stackable' : null },
      h('thead', null, h('tr', null, cols.map((c) => h('th', { scope: 'col', class: c.num ? 'num' : null }, c.head)))),
      h(
        'tbody',
        null,
        rows.map((row) =>
          h(
            'tr',
            {
              class: [onRow ? 'row-link' : '', rowClass ? rowClass(row) : ''].join(' ').trim() || null,
              onClick: onRow ? (e) => !e.target.closest('button, a, input, label') && onRow(row) : null,
            },
            cols.map((c) => h('td', { class: c.num ? 'num' : null, 'data-label': c.label || null }, c.cell(row))),
          ),
        ),
      ),
    ),
  );
}

/** Earlier and later, for a list longer than a page. */
export function pager({ offset, limit, shown, total = null, more = null, onPage }) {
  const hasMore = more ?? (total != null && offset + shown < total);
  if (!offset && !hasMore) return null;
  return h(
    'div',
    { class: 'pager' },
    offset ? h('button', { type: 'button', class: 'btn btn-small', onClick: () => onPage(Math.max(0, offset - limit)) }, 'Back') : null,
    hasMore ? h('button', { type: 'button', class: 'btn btn-small', onClick: () => onPage(offset + limit) }, 'More') : null,
    total != null ? h('span', null, `${nf(offset + 1)} to ${nf(offset + shown)} of ${nf(total)}`) : null,
  );
}

// --- toasts -----------------------------------------------------------------------

let toasts = null;

/** Say what happened, at the foot of the page, with one thing to do about it. */
export function toast(text, { bad = false, actions = [] } = {}) {
  if (!toasts) {
    toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toasts);
  }
  const close = () => el.remove();
  const el = h(
    'div',
    { class: `toast${bad ? ' toast-bad' : ''}` },
    h('span', null, text),
    h(
      'span',
      { class: 'toolbar' },
      actions.map((a) => h('button', { type: 'button', class: 'btn-text', onClick: () => { close(); a.run(); } }, a.label)),
      h('button', { type: 'button', class: 'btn-text', onClick: close }, 'Dismiss'),
    ),
  );
  toasts.append(el);
  setTimeout(close, bad || actions.length ? 20_000 : 8000);
}

// --- dialogs ----------------------------------------------------------------------

/**
 * Open something over the page. Escape and a click outside close it, focus
 * goes into it and comes back where it was. Returns a function that closes it.
 */
export function openOver(content, { sheet = false, onClose = null } = {}) {
  const before = document.activeElement;
  const scrim = h('div', { class: 'scrim' }, content);
  const close = () => {
    document.removeEventListener('keydown', onKey);
    scrim.remove();
    if (before?.isConnected) before.focus();
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key !== 'Tab') return;
    // Keep Tab inside what is open.
    const stops = [...content.querySelectorAll('button, a[href], input, select, textarea')].filter((x) => !x.disabled);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  document.addEventListener('keydown', onKey);
  content.setAttribute('role', 'dialog');
  content.setAttribute('aria-modal', 'true');
  if (sheet) content.classList.add('sheet');
  document.body.append(scrim);
  (content.querySelector('[data-focus]') || content.querySelector('button, input'))?.focus();
  return close;
}

/**
 * Ask before something that changes the list. Resolves true only on the
 * button that says what will happen; Cancel has the focus when it opens.
 */
export function confirm({ title, body = null, command = null, yes, danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value) => { answered = true; close(); resolve(value); };
    const content = h(
      'div',
      { class: 'dialog', 'aria-label': title },
      h('h2', null, title),
      body,
      command ? h('p', { class: 'muted' }, 'The bot will run: ', h('span', { class: 'mono' }, command)) : null,
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', 'data-focus': true, onClick: () => answer(false) }, 'Cancel'),
        h('button', { type: 'button', class: `btn ${danger ? 'btn-danger-fill' : 'btn-primary'}`, onClick: () => answer(true) }, yes),
      ),
    );
    const close = openOver(content, { onClose: () => { if (!answered) resolve(false); } });
  });
}

// --- several lists -----------------------------------------------------------------

/**
 * Which of the bot's lists a write goes to. Nothing is chosen when it opens:
 * the bot does not guess a list, and neither does the page.
 */
export function listPicker(lists, { onChange = null } = {}) {
  return h(
    'select',
    { class: 'field', required: true, 'aria-label': 'Which list', onChange: (e) => onChange?.(e.target.value) },
    h('option', { value: '' }, 'Choose a list'),
    lists.all.map((l) => h('option', { value: l.rkey }, l.name)),
  );
}

/** One of the bot's lists as chips, to choose which a page shows. */
export const listChips = (lists, value, onChange) =>
  chips(lists.all.map((l) => ({ value: l.rkey, label: l.name })), value, onChange, 'List');

/**
 * The bot's own question, asked here where a DM would wait for a number.
 * Resolves with the option chosen, or null.
 */
function choose(text, options) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value) => { answered = true; close(); resolve(value); };
    const content = h(
      'div',
      { class: 'dialog', 'aria-label': 'Which list' },
      h('h2', null, text),
      h('p', { class: 'muted' }, 'Nothing has changed yet.'),
      h('div', { class: 'choices' }, options.map((o) => h('button', { type: 'button', class: 'btn', onClick: () => answer(o) }, o.label))),
      h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn', 'data-focus': true, onClick: () => answer(null) }, 'Cancel')),
    );
    const close = openOver(content, { onClose: () => { if (!answered) resolve(null); } });
  });
}

// --- the one way to change the list -----------------------------------------------

/**
 * Send a command to the bot and say what it answered. The bot's reply is its
 * own receipt, so it is shown as it is. `after` runs once the command is
 * done, whatever it did, so the page can read the store again.
 *
 * @returns {Promise<object|null>} what the bot answered, or null if it failed
 */
export async function run(command, { after = null } = {}) {
  // What a follow-up runs, in order: "Every list" is one command per list.
  const each = async (commands) => {
    let last = null;
    for (const c of commands) last = await run(c, { after });
    return last;
  };
  try {
    const out = await post('/api/command', { command });
    if (out.choice) {
      // The bot asked which list and did nothing.
      const picked = await choose(out.text, out.options);
      return picked ? each(picked.commands) : out;
    }
    // One press beside the receipt, and only for the way back: an option
    // that adds anyone is not offered here (src/panel/commands.js).
    toast(out.text || 'Done.', {
      bad: out.outcome === 'failed',
      actions: (out.options || []).filter((o) => o.takesBack).slice(0, 1).map((o) => ({ label: o.label, run: () => each(o.commands) })),
    });
    window.dispatchEvent(new Event('panel:changed'));
    await after?.(out);
    return out;
  } catch (err) {
    toast(String(err.message || err), { bad: true });
    return null;
  }
}

/** A close button for a sheet or dialog head. */
export const closeButton = (onClick) =>
  h('button', { type: 'button', class: 'btn btn-icon', onClick, 'aria-label': 'Close' }, icon('close'));

export { get, post, sr };
