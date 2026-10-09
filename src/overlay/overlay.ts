import {
  DEFAULT_OCCLUSION_COLOR,
  HIGHLIGHT_COLOR,
  INK_COLOR,
  INK_WEIGHT,
  PAGE_OWNER,
  isInk,
  markKind,
  newMarkId,
  setMarkKind,
  type InkPoint,
  type Mark,
  type MarkKind,
  type Span
} from "../store/schema";
import type { Surface } from "../adapters/types";
import { icon } from "../ui/icons";

export type OverlayMode = "none" | "occlude" | "highlight" | "line" | "ink";

export interface OverlayOptions {
  onChange(marks: Mark[]): void;
  onContext?(id: string, x: number, y: number): void;
  // Right-click on an uncommitted line draft. The draft is not a mark until
  // the caller picks a kind via commitPending(); choosing any other tool
  // discards it.
  onPendingContext?(x: number, y: number): void;
  // Right-click on the page with the line tool armed but no draft (or beside
  // one). Lets the caller open the line tool's settings, which is the only way
  // back once a default kind makes swipes commit immediately.
  onLineContext?(x: number, y: number): void;
  // Resolves the owner for a freshly drawn mark. Explicit selection wins;
  // otherwise the caller falls back to containment, then page.
  ownerFor(span: Span): string;
  // Resolves a human label for a mark's owner, used by inspect mode.
  ownerLabel?(owner: string): string;
  // Whether a mark carries a note, so its indicator dot can be drawn.
  hasNote?(id: string): boolean;
  // Opens the note for a mark from its indicator dot.
  onNote?(id: string, x: number, y: number): void;
  // Hovering the indicator dot: preview the note body; on leave, drop it.
  onNoteHover?(id: string, x: number, y: number): void;
  onNoteLeave?(): void;
  // Hovering the mark body: preview its cue. Same dwell/grace handling as the
  // note dot; the corner dot's own hover wins when the pointer is over it.
  onCueHover?(id: string, x: number, y: number): void;
  onCueLeave?(): void;
}

export class Overlay {
  private readonly surfaces: Surface[];
  private readonly options: OverlayOptions;
  private readonly layers = new Map<number, HTMLElement>();
  private marks: Mark[];
  private mode: OverlayMode = "none";
  private inspect = false;
  // Line tool: instead of dragging a rectangle corner-to-corner, a preview
  // band follows the cursor at a fixed height ('[' / ']' to resize) and a
  // swipe sets its horizontal extent. A swipe produces a *pending* draft, not
  // a mark — it is written only once the user picks a kind from its
  // right-click menu (commitPending); any other tool switch discards it.
  // Fraction of page height, kept sticky across swipes (and pages/zoom,
  // since it's normalized the same way a mark's h is).
  private bandHeight = 0.025;
  // Line tool's default kind. "none" keeps the two-step flow (swipe, then pick
  // from the draft's right-click menu); a kind commits each swipe immediately,
  // which is the whole point of setting a default.
  private lineDefault: "none" | MarkKind = "none";
  private static readonly BAND_MIN = 0.01;
  private static readonly BAND_MAX = 0.3;
  // Browsers refuse cursor images past 128x128 and silently fall back to the
  // keyword, so the band-height I-beam is capped just under that.
  private static readonly CURSOR_MAX = 120;
  // Per '[' / ']' keypress, as a fraction of page height.
  private static readonly BAND_STEP = 0.006;
  private hoverGhost: HTMLElement | null = null;
  private hoverLayer: HTMLElement | null = null;
  // Last pointer position over a layer, so a '[ / ]' resize can redraw the
  // preview band without waiting for the next pointermove.
  private lastHover: { layer: HTMLElement; x: number; y: number } | null = null;
  // The one uncommitted line draft (normalized span) and its live element.
  // Nothing is persisted until commitPending assigns it a kind.
  private pending: { span: Span; el: HTMLElement } | null = null;
  // Pen tool: color and stroke width (normalized to page width). Sticky across
  // strokes and pages, like the line tool's band height.
  private inkColor = INK_COLOR;
  private inkWeight = INK_WEIGHT;
  // Line tool's default color per kind, set from its right-click menu and from
  // prefs on load. Kept separate so an occlusion swipe and a highlight swipe
  // each keep their own hue.
  private lineOcclusionColor = DEFAULT_OCCLUSION_COLOR;
  private lineHighlightColor = HIGHLIGHT_COLOR;
  private drawing: {
    surface: number;
    startX: number;
    startY: number;
    // The live preview element: a div for rect/line tools, an SVG path for ink.
    ghost: Element;
    // Set only for a line-tool swipe: height is fixed up front (from
    // bandHeight), so pointerMove only ever adjusts the horizontal extent.
    lineHeight?: number;
    // Set only for a pen stroke: the normalized points collected so far.
    inkPoints?: InkPoint[];
  } | null = null;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onPointerLeave: () => void;
  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;

  constructor(surfaces: Surface[], marks: Mark[], options: OverlayOptions) {
    this.surfaces = surfaces;
    this.marks = marks;
    this.options = options;
    this.onPointerDown = (e) => this.pointerDown(e);
    this.onPointerMove = (e) => this.pointerMove(e);
    this.onPointerUp = (e) => this.pointerUp(e);
    this.onPointerLeave = () => {
      this.lastHover = null;
      this.clearHoverGhost();
    };
    this.onWheel = () => this.wheel();
    this.onKeyDown = (e) => this.keyDown(e);
    window.addEventListener("keydown", this.onKeyDown);
    this.mount();
  }

  private mount(): void {
    for (const s of this.surfaces) {
      const layer = document.createElement("div");
      layer.className = "ihobs-overlay";
      layer.dataset.surface = String(s.index);
      s.el.appendChild(layer);
      this.layers.set(s.index, layer);
      layer.addEventListener("pointerdown", this.onPointerDown);
      layer.addEventListener("pointermove", this.onPointerMove);
      layer.addEventListener("pointerup", this.onPointerUp);
      layer.addEventListener("pointerleave", this.onPointerLeave);
      layer.addEventListener("wheel", this.onWheel, { passive: false });
      // While the line tool is armed, a right-click on the page (not on a
      // draft's own menu) opens the line tool's settings. This is the only way
      // to change the default back once auto-commit makes swipes mark directly.
      layer.addEventListener("contextmenu", (e) => {
        if (this.mode !== "line") return;
        e.preventDefault();
        e.stopPropagation();
        this.options.onLineContext?.(e.clientX, e.clientY);
      });
    }
    this.paint();
  }

  setMode(mode: OverlayMode): void {
    // Any tool change drops an uncommitted line draft: the user moved on
    // without picking a kind, so it simply vanishes (never written).
    if (mode !== "line") this.discardPending();
    this.mode = mode;
    if (mode !== "line") {
      this.lastHover = null;
      this.clearHoverGhost();
    }
    for (const layer of this.layers.values()) {
      layer.classList.toggle("is-drawing", mode !== "none");
      layer.classList.toggle("is-line", mode === "line");
      layer.classList.toggle("is-ink", mode === "ink");
    }
    this.updateCursor();
  }

  // The line tool's cursor is an I-beam — the same glyph as a text caret — but
  // stretched to the band's height, so the pointer itself shows how tall the
  // highlight will be: the two serifs sit on the band's top and bottom edges and
  // the stem spans it. The hotspot is the stem's centre, so the band centres on
  // the pointer. Built here rather than in CSS because the height changes with
  // '[' / ']'.
  //
  // Browsers ignore cursor images over 128x128 outright (they do not scale them
  // down), so past CURSOR_MAX the I-beam stops growing and `text` — the keyword
  // fallback — is what shows. For those tall bands the hover preview band
  // (hoverMove) is the honest cue, which is why it is kept.
  private updateCursor(): void {
    if (this.mode === "ink") {
      for (const layer of this.layers.values()) layer.style.cursor = "crosshair";
      return;
    }
    if (this.mode !== "line") {
      for (const layer of this.layers.values()) layer.style.cursor = "";
      return;
    }
    const first = this.surfaces[0];
    const pageH = first ? this.surfaceSize(first.index).h : 800;
    const px = Math.max(16, Math.min(Overlay.CURSOR_MAX, Math.round(this.bandHeight * pageH)));
    const w = 16;
    // Half the 4px stroke, so the serifs' outer edges land on the bitmap's edges
    // and therefore on the band's edges.
    const pad = 2;
    const d =
      `M3 ${pad} H${w - 3} M${w / 2} ${pad} V${px - pad} M3 ${px - pad} H${w - 3}`;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${px}" viewBox="0 0 ${w} ${px}">` +
      `<path d="${d}" fill="none" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="${d}" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`;
    const cur =
      `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${w / 2} ${Math.round(px / 2)}, text`;
    for (const layer of this.layers.values()) layer.style.cursor = cur;
  }

  // While another tool owns the pointer, the whole overlay becomes transparent
  // to gestures so it cannot intercept a segment draw underneath it.
  setInteractive(interactive: boolean): void {
    for (const layer of this.layers.values()) {
      layer.classList.toggle("click-through", !interactive);
    }
  }

  isDrawing(): boolean {
    return this.mode !== "none";
  }

  // The line tool's default kind, set from its right-click menu. "none" = ask
  // per swipe; otherwise a swipe commits straight to a mark of that kind.
  setLineDefault(kind: "none" | MarkKind): void {
    this.lineDefault = kind;
  }

  // The line tool's default color per kind, set from its right-click menu and
  // restored from prefs on load. Applied to the swipes (and free rects) a tool
  // commits from then on.
  setLineColors(colors: { occlusion?: string; highlight?: string }): void {
    if (colors.occlusion) this.lineOcclusionColor = colors.occlusion;
    if (colors.highlight) this.lineHighlightColor = colors.highlight;
  }

  getLineColors(): { occlusion: string; highlight: string } {
    return { occlusion: this.lineOcclusionColor, highlight: this.lineHighlightColor };
  }

  // Pen color/width, set from the pen's right-click menu. Sticky for future
  // strokes; existing strokes keep the values they were drawn with.
  setInkStyle(color: string, weight?: number): void {
    this.inkColor = color;
    if (weight !== undefined) this.inkWeight = weight;
  }

  getInkStyle(): { color: string; weight: number } {
    return { color: this.inkColor, weight: this.inkWeight };
  }

  // True while an uncommitted line draft is on the page. The context menu uses
  // this to decide whether to offer "commit as …" entries.
  hasPending(): boolean {
    return this.pending !== null;
  }

  getMarks(): Mark[] {
    return this.marks;
  }

  private layerOf(surface: number): HTMLElement | undefined {
    return this.layers.get(surface);
  }

  private surfaceSize(index: number): { w: number; h: number } {
    const s = this.surfaces.find((x) => x.index === index);
    if (!s) return { w: 1, h: 1 };
    const w = s.el.clientWidth || s.width;
    const h = s.el.clientHeight || s.height;
    return { w: w || 1, h: h || 1 };
  }

  private localPoint(layer: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
    const rect = layer.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  private clearHoverGhost(): void {
    this.hoverGhost?.remove();
    this.hoverGhost = null;
    this.hoverLayer = null;
  }

  // Drops the uncommitted line draft (visual only; there is no mark yet).
  private discardPending(): void {
    this.pending?.el.remove();
    this.pending = null;
  }

  // Turns the pending draft into a real mark of the given kind. Called from
  // the draft's right-click menu; a no-op if there is no draft.
  commitPending(kind: MarkKind): void {
    const p = this.pending;
    if (!p) return;
    p.el.remove();
    this.pending = null;
    this.commitLine(p.span, kind);
  }

  // Builds a line mark from a span and kind. Shared by commitPending (picker
  // flow) and an immediate commit when the line tool has a default kind.
  private commitLine(span: Span, kind: MarkKind): void {
    const mark: Mark = {
      kind: "mark",
      id: newMarkId(),
      tags: [kind],
      label: "",
      spans: [span],
      color: kind === "highlight" ? this.lineHighlightColor : this.lineOcclusionColor,
      owner: this.options.ownerFor(span) || PAGE_OWNER,
      revealed: false
    };
    this.marks.push(mark);
    this.paint();
    this.options.onChange(this.marks);
  }

  // Builds an ink mark from normalized stroke points. `spans[0]` is the stroke's
  // bounding box (with a little padding) so containment/ownership still applies;
  // when the stroke is a single dot the box is a minimal sliver.
  private commitInk(page: number, points: InkPoint[]): void {
    if (points.length < 2) return;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const pad = this.inkWeight / 2;
    const x0 = Math.max(0, Math.min(...xs) - pad);
    const y0 = Math.max(0, Math.min(...ys) - pad);
    const x1 = Math.min(1, Math.max(...xs) + pad);
    const y1 = Math.min(1, Math.max(...ys) + pad);
    const span: Span = { page, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const mark: Mark = {
      kind: "mark",
      id: newMarkId(),
      tags: ["ink"],
      label: "",
      spans: [span],
      color: this.inkColor,
      weight: this.inkWeight,
      path: points,
      owner: this.options.ownerFor(span) || PAGE_OWNER,
      revealed: false
    };
    this.marks.push(mark);
    this.paint();
    this.options.onChange(this.marks);
  }

  // Live preview band while the line tool is armed but not yet swiping —
  // shows which line height/row you're about to stamp before you commit.
  private hoverMove(layer: HTMLElement, clientX: number, clientY: number): void {
    if (this.mode !== "line") {
      this.clearHoverGhost();
      return;
    }
    this.lastHover = { layer, x: clientX, y: clientY };
    const surface = Number(layer.dataset.surface);
    const { w, h } = this.surfaceSize(surface);
    const { y } = this.localPoint(layer, clientX, clientY);
    if (!this.hoverGhost || this.hoverLayer !== layer) {
      this.clearHoverGhost();
      const ghost = document.createElement("div");
      ghost.className = `ihobs-region ghost hover-line ${this.mode}`;
      layer.appendChild(ghost);
      this.hoverGhost = ghost;
      this.hoverLayer = layer;
    }
    const bandH = this.bandHeight * h;
    this.hoverGhost.style.left = "0px";
    this.hoverGhost.style.width = `${w}px`;
    this.hoverGhost.style.top = `${y - bandH / 2}px`;
    this.hoverGhost.style.height = `${bandH}px`;
  }

  // The wheel is owned by zoom (ctrl/cmd) and page scroll, so the line band
  // is resized with '[' / ']' while the tool is armed. Plain scroll still
  // moves the page; the preview band is dropped on scroll so it cannot linger
  // over the wrong row, and the next pointermove brings it back.
  private wheel(): void {
    if (this.mode !== "line" || this.drawing) return;
    this.clearHoverGhost();
  }

  private keyDown(e: KeyboardEvent): void {
    if (this.mode !== "line") return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let step = 0;
    if (e.key === "[") step = -Overlay.BAND_STEP;
    else if (e.key === "]") step = Overlay.BAND_STEP;
    else return;
    e.preventDefault();
    this.bandHeight = Math.min(Overlay.BAND_MAX, Math.max(Overlay.BAND_MIN, this.bandHeight + step));
    this.updateCursor();
    if (this.lastHover) this.hoverMove(this.lastHover.layer, this.lastHover.x, this.lastHover.y);
  }

  private pointerDown(e: PointerEvent): void {
    if (this.mode === "none") return;
    if (e.button !== 0) return;
    const layer = e.currentTarget as HTMLElement;
    const surface = Number(layer.dataset.surface);
    const { x, y } = this.localPoint(layer, e.clientX, e.clientY);
    // A fresh swipe replaces any earlier uncommitted draft.
    if (this.mode === "line") this.discardPending();
    this.clearHoverGhost();
    if (this.mode === "ink") {
      const { w, h } = this.surfaceSize(surface);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", "ihobs-ink-live");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", this.inkColor);
      path.setAttribute("stroke-width", String(Math.max(1, this.inkWeight * w)));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      const svg = this.inkSvg(layer);
      svg.appendChild(path);
      this.drawing = {
        surface,
        startX: x,
        startY: y,
        ghost: path,
        inkPoints: [this.clampPoint(x / w, y / h)]
      };
      layer.setPointerCapture(e.pointerId);
      return;
    }
    const ghost = document.createElement("div");
    ghost.className = `ihobs-region ghost ${this.mode}`;
    layer.appendChild(ghost);
    if (this.mode === "line") {
      const { h } = this.surfaceSize(surface);
      const lineHeight = this.bandHeight * h;
      const top = y - lineHeight / 2;
      ghost.style.top = `${top}px`;
      ghost.style.height = `${lineHeight}px`;
      this.drawing = { surface, startX: x, startY: top, ghost, lineHeight };
    } else {
      this.drawing = { surface, startX: x, startY: y, ghost };
    }
    layer.setPointerCapture(e.pointerId);
  }

  private pointerMove(e: PointerEvent): void {
    const layer = e.currentTarget as HTMLElement;
    if (!this.drawing) {
      this.hoverMove(layer, e.clientX, e.clientY);
      return;
    }
    const { x, y } = this.localPoint(layer, e.clientX, e.clientY);
    const d = this.drawing;
    if (d.inkPoints) {
      // Freehand: append the point and redraw the live path. Points are
      // normalized here so the preview and the committed stroke agree.
      const { w, h } = this.surfaceSize(d.surface);
      d.inkPoints.push(this.clampPoint(x / w, y / h));
      const path = d.ghost as SVGPathElement;
      path.setAttribute("d", this.inkPathD(d.inkPoints, w, h));
    } else if (d.lineHeight !== undefined) {
      // Height is fixed from pointerdown; only the horizontal swipe extent moves.
      const el = d.ghost as HTMLElement;
      el.style.left = `${Math.min(d.startX, x)}px`;
      el.style.width = `${Math.abs(x - d.startX)}px`;
    } else {
      const el = d.ghost as HTMLElement;
      const top = Math.min(d.startY, y);
      el.style.left = `${Math.min(d.startX, x)}px`;
      el.style.top = `${top}px`;
      el.style.width = `${Math.abs(x - d.startX)}px`;
      el.style.height = `${Math.abs(y - d.startY)}px`;
    }
  }

  // Points are captured by pointer capture, which keeps reporting even when the
  // cursor leaves the page; clamp so a stroke never runs off the surface.
  private clampPoint(x: number, y: number): InkPoint {
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  // A fixed SVG for live ink, one per layer, layered above the mark divs.
  private inkSvg(layer: HTMLElement): SVGSVGElement {
    let svg = layer.querySelector<SVGSVGElement>(":scope > .ihobs-ink-layer");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "ihobs-ink-layer");
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      layer.appendChild(svg);
    }
    return svg;
  }

  // Builds an SVG path `d` from normalized points for a given pixel size. A
  // midpoint quadratic keeps the line smooth without storing extra geometry.
  private inkPathD(points: InkPoint[], w: number, h: number): string {
    if (points.length === 0) return "";
    const px = (p: InkPoint): [number, number] => [p.x * w, p.y * h];
    if (points.length === 1) {
      const [x, y] = px(points[0]);
      return `M ${x} ${y} L ${x + 0.01} ${y}`;
    }
    const [sx, sy] = px(points[0]);
    let d = `M ${sx} ${sy}`;
    for (let i = 1; i < points.length - 1; i++) {
      const [cx, cy] = px(points[i]);
      const [nx, ny] = px(points[i + 1]);
      d += ` Q ${cx} ${cy} ${(cx + nx) / 2} ${(cy + ny) / 2}`;
    }
    const [lx, ly] = px(points[points.length - 1]);
    return `${d} L ${lx} ${ly}`;
  }

  private pointerUp(e: PointerEvent): void {
    if (!this.drawing) return;
    const layer = e.currentTarget as HTMLElement;
    const d = this.drawing;
    this.drawing = null;
    layer.releasePointerCapture(e.pointerId);
    d.ghost.remove();

    const { w, h } = this.surfaceSize(d.surface);
    const { x, y } = this.localPoint(layer, e.clientX, e.clientY);

    if (d.inkPoints) {
      // The final cursor position may not have been reported as a move.
      d.inkPoints.push(this.clampPoint(x / w, y / h));
      this.commitInk(d.surface, d.inkPoints);
      return;
    }

    let left: number;
    let top: number;
    let width: number;
    let height: number;
    if (d.lineHeight !== undefined) {
      left = Math.min(d.startX, x);
      top = d.startY;
      width = Math.abs(x - d.startX);
      height = d.lineHeight;
    } else {
      left = Math.min(d.startX, x);
      top = Math.min(d.startY, y);
      width = Math.abs(x - d.startX);
      height = Math.abs(y - d.startY);
    }

    if (width < 4 || height < 4) {
      if (this.mode === "line") this.hoverMove(layer, e.clientX, e.clientY);
      return;
    }
    if (this.mode === "none") return;

    const nx = left / w;
    const ny = top / h;
    const nw = width / w;
    const nh = height / h;
    const span: Span = { page: d.surface, x: nx, y: ny, w: nw, h: nh };

    if (this.mode === "line") {
      // With a default kind set, a swipe is committed immediately; otherwise it
      // stays a neutral draft (no tags, no color, not persisted) and the user
      // picks occlusion vs highlight from its right-click menu.
      if (this.lineDefault !== "none") {
        this.commitLine(span, this.lineDefault);
        this.hoverMove(layer, e.clientX, e.clientY);
        return;
      }
      const el = document.createElement("div");
      el.className = "ihobs-region pending-line";
      el.style.left = `${nx * w}px`;
      el.style.top = `${ny * h}px`;
      el.style.width = `${nw * w}px`;
      el.style.height = `${nh * h}px`;
      el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      el.addEventListener("click", (ev) => ev.stopPropagation());
      el.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.options.onPendingContext?.(ev.clientX, ev.clientY);
      });
      layer.appendChild(el);
      this.pending = { span, el };
      this.hoverMove(layer, e.clientX, e.clientY);
      return;
    }

    const mark: Mark = {
      kind: "mark",
      id: newMarkId(),
      tags: [this.mode === "highlight" ? "highlight" : "occlusion"],
      label: "",
      spans: [span],
      color: this.mode === "highlight" ? this.lineHighlightColor : this.lineOcclusionColor,
      owner: this.options.ownerFor(span) || PAGE_OWNER,
      revealed: false
    };
    this.marks.push(mark);
    this.paint();
    this.options.onChange(this.marks);
  }

  // A mark with a groupId (line-tool swipes chained with Shift) reveals and
  // hides together with the rest of its group, as one logical answer.
  reveal(id: string, revealed = true): void {
    const r = this.marks.find((x) => x.id === id);
    if (!r) return;
    const targets = r.groupId ? this.marks.filter((x) => x.groupId === r.groupId) : [r];
    for (const t of targets) t.revealed = revealed;
    this.paint();
    this.options.onChange(this.marks);
  }

  revealAll(revealed: boolean): void {
    for (const r of this.marks) r.revealed = revealed;
    this.paint();
    this.options.onChange(this.marks);
  }

  // The toolbar's page-scoped toggle: if any mark is hidden, show them all;
  // otherwise hide them all back.
  toggleReveal(): void {
    const anyHidden = this.marks.some((r) => !r.revealed);
    this.revealAll(anyHidden);
  }

  // Detach marks whose owner box no longer exists, so free marks survive
  // but orphaned attachments fall back to the page.
  reassignOwners(validIds: Set<string>): void {
    for (const r of this.marks) {
      if (r.owner !== PAGE_OWNER && !validIds.has(r.owner)) r.owner = PAGE_OWNER;
    }
    this.paint();
  }

  // Flips a mark between occlusion and highlight in place, so a mis-toggled
  // mark can be fixed without deleting and redrawing it. The color is reset to
  // that kind's default, so a converted mark never keeps the other kind's hue.
  setKind(id: string, kind: MarkKind): void {
    const r = this.marks.find((x) => x.id === id);
    if (!r) return;
    setMarkKind(r, kind);
    r.color = kind === "highlight" ? this.lineHighlightColor : this.lineOcclusionColor;
    this.paint();
    this.options.onChange(this.marks);
  }

  // silent: true skips onChange (persist) so a live color-picker drag doesn't
  // trigger a sidecar write on every intermediate value.
  setColor(id: string, color: string, opts?: { silent?: boolean }): void {
    const r = this.marks.find((x) => x.id === id);
    if (!r) return;
    r.color = color;
    this.paint();
    if (!opts?.silent) this.options.onChange(this.marks);
  }

  setOwner(id: string, owner: string): void {
    const r = this.marks.find((x) => x.id === id);
    if (!r) return;
    r.owner = owner;
    this.paint();
    this.options.onChange(this.marks);
  }

  remove(id: string): void {
    this.marks = this.marks.filter((r) => r.id !== id);
    this.paint();
    this.options.onChange(this.marks);
  }

  setMarks(marks: Mark[]): void {
    this.marks = marks;
    this.paint();
  }

  setInspect(inspect: boolean): void {
    this.inspect = inspect;
    this.paint();
  }

  repaint(): void {
    this.paint();
  }

  private paint(): void {
    for (const layer of this.layers.values()) {
      // The pending line draft is a region too; it is not a mark, so leave it.
      layer.querySelectorAll(".ihobs-region:not(.ghost):not(.pending-line)").forEach((n) => n.remove());
      // Live ink is re-drawn too, so remove committed stroke paths as well.
      layer.querySelectorAll(".ihobs-ink-layer > path:not(.ihobs-ink-live)").forEach((n) => n.remove());
    }
    for (const r of this.marks) {
      const span = r.spans[0];
      if (!span) continue;
      const layer = this.layerOf(span.page);
      if (!layer) continue;
      if (isInk(r)) {
        this.paintInk(layer, r);
        continue;
      }
      const { w, h } = this.surfaceSize(span.page);
      const inflated = `ihobs-region ${markKind(r)}`;
      const attached = r.owner && r.owner !== PAGE_OWNER;
      const el = document.createElement("div");
      el.className = `${inflated}${r.revealed ? " revealed" : ""}${
        attached ? " attached" : ""
      }${this.inspect ? " inspect" : ""}`;
      el.dataset.owner = r.owner;
      el.style.left = `${span.x * w}px`;
      el.style.top = `${span.y * h}px`;
      el.style.width = `${span.w * w}px`;
      el.style.height = `${span.h * h}px`;
      if (markKind(r) === "occlusion") {
        el.style.background = r.color ?? DEFAULT_OCCLUSION_COLOR;
      } else {
        // Highlights expose their color as a var so each theme can compose it
        // as a translucent tint (multiply in light, screen in dark).
        el.style.setProperty("--ih-color", r.color ?? HIGHLIGHT_COLOR);
      }
      el.title = "click to reveal · right-click for options";
      if (this.inspect) {
        const badge = document.createElement("span");
        badge.className = "ihobs-region-owner";
        badge.textContent = this.options.ownerLabel?.(r.owner) ?? r.owner;
        el.appendChild(badge);
      }
      // A small corner dot signals an attached note without covering the mark.
      if (this.options.hasNote?.(r.id)) {
        const dot = document.createElement("span");
        dot.className = "ihobs-region-note";
        dot.title = "note or cue — click to open";
        dot.appendChild(icon("pencil", 8));
        dot.addEventListener("pointerdown", (e) => e.stopPropagation());
        dot.addEventListener("click", (e) => {
          e.stopPropagation();
          this.options.onNote?.(r.id, e.clientX, e.clientY);
        });
        dot.addEventListener("pointerenter", (e) => {
          this.options.onNoteHover?.(r.id, e.clientX, e.clientY);
        });
        dot.addEventListener("pointerleave", () => this.options.onNoteLeave?.());
        el.appendChild(dot);
      }
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("click", (e) => {
        if (e.altKey) {
          this.remove(r.id);
        } else {
          this.reveal(r.id, !r.revealed);
        }
      });
      // A cue lives on the mark body (not a badge), so hovering the mark is what
      // previews it. `pointerover` (which bubbles, unlike pointerenter) lets us
      // ignore the corner dot: only a target that is the mark itself counts, so
      // the dot's own note hover is never clobbered by the cue.
      if (r.cue) {
        el.addEventListener("pointerover", (e) => {
          if (e.target !== el) return;
          this.options.onCueHover?.(r.id, e.clientX, e.clientY);
        });
        el.addEventListener("pointerout", (e) => {
          if (e.target !== el) return;
          if (el.contains(e.relatedTarget as Node)) return;
          this.options.onCueLeave?.();
        });
      }
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.options.onContext?.(r.id, e.clientX, e.clientY);
      });
      layer.appendChild(el);
    }
  }

  // Committed ink is one SVG path per stroke, drawn above the mark divs. A wide
  // transparent hit path sits under it so thin strokes are still easy to click.
  private paintInk(layer: HTMLElement, r: Mark): void {
    const span = r.spans[0];
    if (!span || !r.path?.length) return;
    const { w, h } = this.surfaceSize(span.page);
    const svg = this.inkSvg(layer);
    const d = this.inkPathD(r.path, w, h);
    const width = Math.max(1, (r.weight ?? INK_WEIGHT) * w);

    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.setAttribute("class", "ihobs-ink-hit");
    hit.setAttribute("d", d);
    hit.setAttribute("fill", "none");
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", String(Math.max(12, width + 8)));
    hit.setAttribute("stroke-linecap", "round");
    hit.setAttribute("stroke-linejoin", "round");
    hit.setAttribute("pointer-events", "stroke");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "ihobs-ink");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", r.color ?? INK_COLOR);
    path.setAttribute("stroke-width", String(width));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("pointer-events", "none");

    hit.addEventListener("pointerdown", (e) => e.stopPropagation());
    hit.addEventListener("click", (e) => {
      if (e.altKey) this.remove(r.id);
      else this.reveal(r.id, !r.revealed);
    });
    if (r.cue) {
      hit.addEventListener("pointerenter", (e) =>
        this.options.onCueHover?.(r.id, e.clientX, e.clientY)
      );
      hit.addEventListener("pointerleave", () => this.options.onCueLeave?.());
    }
    for (const el of [hit, path]) {
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.options.onContext?.(r.id, e.clientX, e.clientY);
      });
      svg.appendChild(el);
    }
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    for (const layer of this.layers.values()) {
      layer.removeEventListener("pointerdown", this.onPointerDown);
      layer.removeEventListener("pointermove", this.onPointerMove);
      layer.removeEventListener("pointerup", this.onPointerUp);
      layer.removeEventListener("pointerleave", this.onPointerLeave);
      layer.removeEventListener("wheel", this.onWheel);
      layer.remove();
    }
    this.layers.clear();
  }
}
