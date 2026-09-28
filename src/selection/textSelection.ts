import type { Surface } from "../adapters/types";

// A selection reduced to one union box per surface, in normalized page coords.
export interface SelectionHull {
  surface: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CapturedSelection {
  quote: string;
  // Surface holding the largest part of the selection, used as the anchor.
  surface: number;
  hulls: SelectionHull[];
}

interface Bounds {
  l: number;
  t: number;
  r: number;
  b: number;
}

function union(a: Bounds | null, l: number, t: number, r: number, b: number): Bounds {
  if (!a) return { l, t, r, b };
  return { l: Math.min(a.l, l), t: Math.min(a.t, t), r: Math.max(a.r, r), b: Math.max(a.b, b) };
}

// Turns the current DOM selection into one bounding box per surface. The
// scanned PDFs here carry a word-level OCR text layer, so a phrase yields many
// small rects on a line; their union is the tight phrase box we want, with no
// need for grouping. Normalized against each surface's box so it holds at any
// zoom.
export function captureSelection(
  container: HTMLElement,
  surfaces: Surface[]
): CapturedSelection | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;

  const quote = sel.toString().replace(/\s+/g, " ").trim();
  if (!quote) return null;

  const rects = Array.from(range.getClientRects()).filter((r) => r.width >= 1 && r.height >= 1);
  if (!rects.length) return null;

  const sizeBySurface = new Map<number, { w: number; h: number }>();
  const boundsBySurface = new Map<number, Bounds>();

  for (const s of surfaces) {
    const elRect = s.el.getBoundingClientRect();
    if (elRect.width <= 0 || elRect.height <= 0) continue;
    sizeBySurface.set(s.index, { w: elRect.width, h: elRect.height });
    let acc: Bounds | null = null;
    for (const r of rects) {
      // Assign a rect by its center, so a rect near a page edge (or the small
      // gap between pages) is not double-counted across two surfaces.
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < elRect.left || cx > elRect.right || cy < elRect.top || cy > elRect.bottom) continue;
      const l = Math.max(0, r.left - elRect.left);
      const t = Math.max(0, r.top - elRect.top);
      const rr = Math.min(elRect.width, r.right - elRect.left);
      const bb = Math.min(elRect.height, r.bottom - elRect.top);
      acc = union(acc, l, t, rr, bb);
    }
    if (acc) boundsBySurface.set(s.index, acc);
  }

  const hulls: SelectionHull[] = [];
  for (const [index, b] of boundsBySurface) {
    const size = sizeBySurface.get(index);
    if (!size) continue;
    const w = b.r - b.l;
    const h = b.b - b.t;
    if (w < 1 || h < 1) continue;
    hulls.push({ surface: index, x: b.l / size.w, y: b.t / size.h, w: w / size.w, h: h / size.h });
  }
  if (!hulls.length) return null;

  hulls.sort((a, b) => b.w * b.h - a.w * a.h);
  return { quote, surface: hulls[0].surface, hulls };
}
