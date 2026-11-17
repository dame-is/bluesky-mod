// Building the page.
//
// One rule, and it is why this file exists: nothing the panel shows is ever
// set as markup. Handles, display names, bios and quotes were written by the
// people they describe, some of whom the owner is about to block. `h` makes
// elements and puts strings in as text nodes, and nothing in the panel uses
// innerHTML.

/**
 * An element. `props` sets attributes and listeners; children are elements,
 * strings (text), arrays of either, or nothing.
 *
 *   h('button', { class: 'btn', onClick: go, 'aria-pressed': 'true' }, 'Go')
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') {
      // Set through the CSSOM, which the page's content policy allows where
      // an inline style attribute is not.
      for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, String(v));
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  add(el, children);
  return el;
}

function add(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) add(el, child);
    else if (child instanceof Node) el.append(child);
    else el.append(document.createTextNode(String(child)));
  }
}

/** Replace everything inside `el`. */
export function fill(el, ...children) {
  el.replaceChildren();
  add(el, children);
  return el;
}

/** Text that only a screen reader gets. */
export const sr = (text) => h('span', { class: 'sr' }, text);

/** A stroke icon, drawn here so the page loads no images of its own. */
export function icon(name, size = 18) {
  const paths = {
    search: 'M11 11m-6.5 0a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0 -13 0M16 16l4.5 4.5',
    menu: 'M4 7h16M4 12h16M4 17h16',
    close: 'M6 6l12 12M18 6L6 18',
    out: 'M14 5h5v5M19 5l-8 8M11 6H6v12h12v-5',
    chevron: 'M9 6l6 6l-6 6',
  };
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', paths[name] || '');
  svg.append(path);
  return svg;
}
