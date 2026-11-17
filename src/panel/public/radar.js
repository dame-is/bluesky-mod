// The radar: who is near you, drawn as rings.
//
// One component, used for a scan (who engaged with a post) and for the list
// (who is on it). It draws on a canvas and puts its words, the labels and
// the callout, in ordinary elements over it. The well it sits in is dark in
// either theme, which is what lets "closer is brighter" read at a glance.
//
// It can be pointed at, clicked and walked with the arrow keys. It is still
// a picture: every number in it is also in a table beside or below it, and
// that table is what a screen reader is given.

import { h, fill } from './dom.js';
import { nf } from './lib/format.js';
import {
  EDGES,
  nearest,
  place,
  ringAt,
  sectorAngles,
  texture,
  walkOrder,
} from './lib/radar-layout.js';

/** The well's own colours. Not the page's: it is dark in both themes. */
export const WELL = {
  bg: '#0c1420',
  outer: '#172334',
  rule: '#5f7390',
  axis: '#2a384b',
  ink: '#e8edf3',
  dim: '#a9b6c6',
  chosen: '#ffd166',
  PROTECTED: '#e8edf3',
  CONNECTED: '#ffd166',
  PERIPHERAL: '#f08c4a',
  NOTABLE: '#7fb3ff',
  UNKNOWN: '#6b7d95',
};

const RING_BAND = { PROTECTED: 'PROTECTED', CONNECTED: 'CONNECTED', PERIPHERAL: 'PERIPHERAL', OUTER: 'UNKNOWN' };

/**
 * @param {object} opts
 * @param {string} opts.label         what the picture shows, for a screen reader
 * @param {Array<{ key: string, name: string, total: string|number, far: number,
 *   farNote?: string, can?: boolean }>} opts.sectors
 *        the slices, clockwise from the top; `far` is how many strangers
 * @param {Array<{ id: string, band: string, sector: number, big?: boolean,
 *   dim?: boolean, done?: boolean }>} opts.points   everyone who is not a stranger
 * @param {Set<string>} [opts.bands]      bands ticked, drawn as chosen rings
 * @param {Set<string>} [opts.chosen]     sector keys ticked
 * @param {Function} [opts.describe]  (point) => { title, lines: string[] }
 * @param {Function} [opts.onPick]    (point) => void, on click or Enter
 * @param {Function} [opts.onBand]    (band) => void, on a click in a ring
 * @param {Function} [opts.onSector]  (key) => void, on a sector's label
 */
export function createRadar(opts) {
  let state = { bands: new Set(), chosen: new Set(), points: [], sectors: [], ...opts };
  let placed = [];
  let dust = [];
  let order = [];
  let hover = null;
  let size = 0;

  const canvas = h('canvas', { class: 'radar-canvas', 'aria-hidden': 'true' });
  const labels = h('div', { class: 'radar-labels' });
  const callout = h('div', { class: 'radar-callout', hidden: true });
  const said = h('div', { class: 'sr', 'aria-live': 'polite' });
  const stage = h(
    'div',
    {
      class: 'radar-stage',
      tabindex: '0',
      role: 'group',
      'aria-label': `${state.label} Arrow keys move between the accounts near you; Enter opens one.`,
    },
    canvas,
    labels,
    callout,
  );
  const root = h('div', { class: 'radar' }, stage, said);

  /** The circle's radius as a share of the square: room left for labels. */
  const reach = () => (state.sectors.length === 4 ? 0.47 : 0.4);
  const centre = () => size / 2;
  const px = (v) => centre() + v * reach() * size;

  function layout() {
    placed = place(state.points, state.sectors.length);
    dust = texture(state.sectors.map((s) => s.far || 0));
    order = walkOrder(placed);
    drawLabels();
  }

  function drawLabels() {
    const slices = sectorAngles(state.sectors.length);
    const four = state.sectors.length === 4;
    fill(
      labels,
      state.sectors.map((s, i) => {
        const on = state.chosen.has(s.key);
        const words = [
          h('span', { class: 'radar-sector-name' }, s.name),
          h('span', { class: 'radar-sector-total' }, String(s.total)),
        ];
        const cls = `radar-sector${four ? ` radar-corner-${i}` : ''}`;
        const el =
          state.onSector && s.can !== false
            ? h('button', { type: 'button', class: cls, 'aria-pressed': String(on), onClick: () => state.onSector(s.key) }, words)
            : h('div', { class: cls }, words);
        if (!four) {
          const a = slices[i].mid;
          el.style.setProperty('left', `${50 + Math.cos(a) * (reach() + 0.055) * 100}%`);
          el.style.setProperty('top', `${50 + Math.sin(a) * (reach() + 0.055) * 100}%`);
          el.classList.add('radar-sector-free');
        }
        return el;
      }),
      state.sectors.map((s, i) => {
        if (!s.far) return null;
        const a = slices[i].mid;
        const r = 0.775 * reach();
        return h(
          'div',
          {
            class: 'radar-far',
            style: { left: `${50 + Math.cos(a) * r * 100}%`, top: `${50 + Math.sin(a) * r * 100}%` },
          },
          h('span', { class: 'radar-far-n' }, `${nf(s.far)} ${s.far === 1 ? 'stranger' : 'strangers'}`),
          s.farNote ? h('span', null, s.farNote) : null,
        );
      }),
      h('div', { class: 'radar-you' }, 'You'),
    );
  }

  function draw() {
    const rect = stage.getBoundingClientRect();
    size = Math.round(rect.width);
    if (!size) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (canvas.width !== size * dpr) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    const c = centre();
    const R = reach() * size;
    const circle = (r) => {
      g.beginPath();
      g.arc(c, c, r * R, 0, Math.PI * 2);
    };
    const on = (band) => state.bands.has(band);

    // The outer ring, where the strangers are.
    circle(EDGES.OUTER);
    g.fillStyle = on('UNKNOWN') ? '#1d2d44' : WELL.outer;
    g.fill();
    // The inner rings, each over the one outside it.
    for (const [ring, band] of [['PERIPHERAL', 'PERIPHERAL'], ['CONNECTED', 'CONNECTED'], ['PROTECTED', 'PROTECTED']]) {
      circle(EDGES[ring]);
      g.fillStyle = on(band) ? '#1c2a22' : WELL.bg;
      g.fill();
    }
    // Their edges. A chosen ring is drawn in the chosen colour on the edge
    // away from you.
    g.lineWidth = 1;
    for (const ring of ['OUTER', 'PERIPHERAL', 'CONNECTED']) {
      circle(EDGES[ring]);
      const chosen = on(RING_BAND[ring]);
      g.strokeStyle = chosen ? WELL.chosen : WELL.rule;
      g.lineWidth = chosen ? 2 : 1;
      g.stroke();
    }
    // Protected: a dashed edge, because nothing crosses it.
    circle(EDGES.PROTECTED);
    g.setLineDash([3, 4]);
    g.strokeStyle = WELL.ink;
    g.lineWidth = 1;
    g.stroke();
    g.setLineDash([]);

    // The slices.
    g.strokeStyle = WELL.axis;
    g.lineWidth = 1;
    for (const s of sectorAngles(state.sectors.length)) {
      g.beginPath();
      g.moveTo(c + Math.cos(s.start) * EDGES.PROTECTED * R, c + Math.sin(s.start) * EDGES.PROTECTED * R);
      g.lineTo(c + Math.cos(s.start) * R, c + Math.sin(s.start) * R);
      g.stroke();
    }

    // Strangers, as texture. Dimmed where a filter leaves a slice out.
    const sectorDim = (i) => state.chosen.size > 0 && !state.chosen.has(state.sectors[i]?.key);
    for (const d of dust) {
      g.globalAlpha = sectorDim(d.sector) ? 0.3 : 1;
      g.fillStyle = WELL.UNKNOWN;
      g.fillRect(px(d.x) - 1, px(d.y) - 1, 2, 2);
    }
    g.globalAlpha = 1;

    // Everyone else, one mark each. Smaller ones first so a big one is on top.
    for (const p of [...placed].sort((a, b) => Number(a.big) - Number(b.big))) {
      g.globalAlpha = p.dim ? 0.28 : 1;
      mark(g, p, px(p.x), px(p.y));
    }
    g.globalAlpha = 1;

    if (hover) {
      g.beginPath();
      g.arc(px(hover.x), px(hover.y), (hover.big ? 7 : 5) * grain() + 5, 0, Math.PI * 2);
      g.strokeStyle = WELL.ink;
      g.lineWidth = 2;
      g.stroke();
    }

    // You.
    g.beginPath();
    g.arc(c, c, 5, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
  }

  /** Marks shrink with the picture, so a phone's radar is not a blot. */
  const grain = () => Math.max(0.6, Math.min(1, size / 560));

  function mark(g, p, x, y) {
    const r = (p.big ? 7 : 4) * grain();
    if (p.band === 'PROTECTED') {
      g.beginPath();
      g.arc(x, y, r - 0.5, 0, Math.PI * 2);
      g.strokeStyle = WELL.PROTECTED;
      g.lineWidth = 1.6;
      g.stroke();
      return;
    }
    g.fillStyle = WELL[p.band] || WELL.UNKNOWN;
    g.beginPath();
    if (p.band === 'NOTABLE') {
      const d = r + 1;
      g.moveTo(x, y - d);
      g.lineTo(x + d, y);
      g.lineTo(x, y + d);
      g.lineTo(x - d, y);
      g.closePath();
    } else {
      g.arc(x, y, r, 0, Math.PI * 2);
    }
    g.fill();
    // Already on the list: ringed, so it reads as done and not as to do.
    if (p.done) {
      g.beginPath();
      g.arc(x, y, r + 2.5, 0, Math.PI * 2);
      g.strokeStyle = WELL.ink;
      g.lineWidth = 1.2;
      g.stroke();
    }
  }

  function point(p, { announce = false } = {}) {
    hover = p;
    draw();
    if (!p || !state.describe) {
      callout.hidden = true;
      return;
    }
    const { title, lines } = state.describe(p);
    fill(callout, h('strong', null, title), lines.map((l) => h('span', null, l)));
    callout.hidden = false;
    const x = px(p.x);
    const y = px(p.y);
    const right = x < size * 0.56;
    callout.style.setProperty('left', right ? `${x + 14}px` : 'auto');
    callout.style.setProperty('right', right ? 'auto' : `${size - x + 14}px`);
    callout.style.setProperty('top', `${Math.max(4, Math.min(size - 110, y - 22))}px`);
    if (announce) said.textContent = [title, ...lines].join('. ');
  }

  /** Where a pointer is, in the layout's units. */
  function at(ev) {
    const rect = stage.getBoundingClientRect();
    const R = reach() * rect.width;
    return {
      x: (ev.clientX - rect.left - rect.width / 2) / R,
      y: (ev.clientY - rect.top - rect.height / 2) / R,
      within: 11 / R,
    };
  }

  stage.addEventListener('pointermove', (ev) => {
    const { x, y, within } = at(ev);
    const hit = nearest(placed, x, y, within);
    const ring = ringAt(Math.hypot(x, y));
    stage.style.setProperty(
      'cursor',
      hit && state.onPick ? 'pointer' : state.onBand && ring && ring !== 'PROTECTED' ? 'pointer' : 'default',
    );
    if (hit !== hover) point(hit);
  });
  stage.addEventListener('pointerleave', () => {
    if (document.activeElement !== stage) point(null);
  });
  stage.addEventListener('click', (ev) => {
    if (ev.target.closest('button')) return;
    const { x, y, within } = at(ev);
    const hit = nearest(placed, x, y, within);
    if (hit && state.onPick) return state.onPick(hit);
    const ring = ringAt(Math.hypot(x, y));
    // A click in a ring ticks its band. Never the protected ring.
    if (ring && ring !== 'PROTECTED' && state.onBand) state.onBand(RING_BAND[ring]);
    return undefined;
  });
  stage.addEventListener('keydown', (ev) => {
    if (ev.target !== stage || !order.length) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
    if (step) {
      ev.preventDefault();
      const i = hover ? order.indexOf(hover) : step > 0 ? -1 : 0;
      point(order[(i + step + order.length) % order.length], { announce: true });
    } else if ((ev.key === 'Enter' || ev.key === ' ') && hover && state.onPick) {
      ev.preventDefault();
      state.onPick(hover);
    } else if (ev.key === 'Escape') {
      point(null);
    }
  });
  stage.addEventListener('blur', () => point(null));

  const watcher = new ResizeObserver(() => draw());
  watcher.observe(stage);
  layout();

  return {
    el: root,
    /** Change what is shown. Marks keep their places. */
    update(next) {
      const moved = next.points || next.sectors;
      state = { ...state, ...next };
      hover = hover && placed.includes(hover) && !moved ? hover : null;
      if (moved) layout();
      else drawLabels();
      if (!hover) callout.hidden = true;
      draw();
    },
    destroy() {
      watcher.disconnect();
    },
  };
}

/** A band's mark as an element, for a legend or a table cell. */
export function bandMark(band) {
  return h('span', { class: `mark mark-${String(band || 'unscored').toLowerCase()}`, 'aria-hidden': 'true' });
}
