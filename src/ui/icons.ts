// Central icon set. The chrome is icon-first (Obsidian/VS Code style): controls
// render a glyph and carry their name in a hover/tap tooltip plus an aria-label.
// Icons are inline SVG using currentColor, so they follow the theme and the
// active/hover button states with no extra styling.
//
// A small set of glyphs deliberately stay as text (heading "#" levels, the page
// number, the notes count) because they encode a value, not an action.

const NS = "http://www.w3.org/2000/svg";

interface IconDef {
  // Inner SVG markup. Stroke styling is applied on the root unless `filled`.
  body: string;
  // Solid icons (occlusion box, play, star) fill with currentColor and skip the
  // stroke attributes; mixed icons set fill/stroke inline instead.
  filled?: boolean;
}

const ICONS = {
  // Navigation / shell
  home: { body: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/>' },
  "panel-left": { body: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>' },
  search: { body: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>' },
  database: {
    body: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>'
  },
  ellipsis: {
    body: '<circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/>',
    filled: true
  },
  x: { body: '<path d="M6 6 18 18"/><path d="M18 6 6 18"/>' },
  check: { body: '<path d="m5 13 4 4L19 7"/>' },
  plus: { body: '<path d="M12 5v14"/><path d="M5 12h14"/>' },
  minus: { body: '<path d="M5 12h14"/>' },
  "chevron-down": { body: '<path d="m6 9 6 6 6-6"/>' },
  "chevron-right": { body: '<path d="m9 6 6 6-6 6"/>' },
  "chevron-left": { body: '<path d="m15 6-6 6 6 6"/>' },
  "arrow-up": { body: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>' },
  "arrow-down": { body: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>' },
  "chevron-up-down": { body: '<path d="m7 9 5-5 5 5"/><path d="m7 15 5 5 5-5"/>' },
  "chevrons-in": { body: '<path d="m7 4 5 5 5-5"/><path d="m7 20 5-5 5 5"/>' },

  // Document / view
  list: {
    body: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3.5 6h.01"/><path d="M3.5 12h.01"/><path d="M3.5 18h.01"/>'
  },
  note: { body: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 12h7"/><path d="M9 16h7"/>' },
  type: { body: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>' },
  save: {
    body: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><path d="M8 20v-6h8v6"/>'
  },
  sun: {
    body: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.9 4.9l1.4 1.4"/><path d="M17.7 17.7l1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M4.9 19.1l1.4-1.4"/><path d="M17.7 6.3l1.4-1.4"/>'
  },
  moon: { body: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>' },
  contrast: { body: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor" stroke="none"/>' },

  // Marking tools
  square: { body: '<rect x="4" y="4" width="16" height="16" rx="2"/>' },
  "square-filled": { body: '<rect x="4" y="4" width="16" height="16" rx="2"/>', filled: true },
  highlighter: {
    body: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'
  },
  "line-band": { body: '<path d="M3 9.5h18"/><path d="M3 14.5h18"/>' },
  pen: { body: '<path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 3 21l.5-4.5z"/><path d="m15 5 4 4"/>' },
  target: {
    body: '<circle cx="12" cy="12" r="7"/><path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/>'
  },
  eye: { body: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>' },
  "eye-off": {
    body: '<path d="M3 3l18 18"/><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2"/><path d="M9.4 5.3A9.5 9.5 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.6 3.4"/><path d="M6.1 6.1A17 17 0 0 0 2 12s3.5 7 10 7a9.5 9.5 0 0 0 3.5-.7"/>'
  },

  // Outline roles / tools
  tag: { body: '<path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8" cy="8" r="1.4"/>' },
  "circle-question": {
    body: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.4 2.4 0 1 1 3.3 2.2c-.7.4-.9.9-.9 1.6"/><path d="M12 17h.01"/>'
  },
  crop: { body: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>' },
  "anchor-line": {
    body: '<path d="M6 12h15"/><circle cx="3" cy="12" r="2" fill="currentColor"/>'
  },
  scissors: {
    body: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="m8 8 12 10"/><path d="M20 6 8 16"/>'
  },
  sparkles: {
    body: '<path d="M5 19 15 9"/><path d="M15 4.5 16 7l2.5 1L16 9l-1 2.5L14 9l-2.5-1L14 7z"/><path d="M6 4l.6 1.4L8 6l-1.4.6L6 8l-.6-1.4L4 6l1.4-.6z"/>'
  },

  // Row / item actions
  play: { body: '<path d="M7 5v14l12-7z"/>', filled: true },
  trash: { body: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>' },
  pencil: { body: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>' },
  star: { body: '<path d="m12 3.2 2.6 5.6 6.1.7-4.5 4.1 1.2 6L12 16.8l-5.4 2.8 1.2-6-4.5-4.1 6.1-.7z"/>' },
  "star-filled": {
    body: '<path d="m12 3.2 2.6 5.6 6.1.7-4.5 4.1 1.2 6L12 16.8l-5.4 2.8 1.2-6-4.5-4.1 6.1-.7z"/>',
    filled: true
  },
  layers: { body: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>' },
  "file-text": {
    body: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 13h6"/><path d="M9 17h6"/>'
  },
  image: {
    body: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m5 18 5-5 4 4 3-3 2 2"/>'
  }
};

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 15): SVGSVGElement {
  const def: IconDef = ICONS[name];
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", "ihobs-icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (def.filled) {
    svg.setAttribute("fill", "currentColor");
  } else {
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
  }
  // Inner markup is parsed in the SVG namespace when assigned to an <svg>.
  svg.innerHTML = def.body;
  return svg;
}

// Replaces an element's contents with a single icon (used to swap a glyph on a
// persistent button, e.g. the theme toggle's sun/moon).
export function setIcon(el: HTMLElement, name: IconName, size = 15): void {
  el.textContent = "";
  el.appendChild(icon(name, size));
}
