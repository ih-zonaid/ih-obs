import {
  DEFAULT_OCCLUSION_COLOR,
  HIGHLIGHT_COLOR,
  PAGE_OWNER,
  markKind,
  newMarkId,
  setMarkKind,
  type Mark,
  type MarkKind,
  type Span
} from "../store/schema";
import type { Surface } from "../adapters/types";
import { icon } from "../ui/icons";

export type OverlayMode = "none" | "occlude" | "highlight" | "line";

export interface OverlayOptions {
  onChange(marks: Mark[]): void;
  onContext?(id: string, x: number, y: number): void;
  // Right-click on an uncommitted line draft. The draft is not a mark until
  // the caller picks a kind via commitPending(); choosing any other tool
  // discards it.
  onPendingContext?(x: number, y: number): void;
  // Resolves the owner for a freshly drawn mark. Explicit selection wins;
  // otherwise the caller falls back to containment, then page.
  ownerFor(span: Span): string;
  // Resolves a human label for a mark's owner, used by inspect mode.
  ownerLabel?(owner: string): string;
  // Whether a mark carries a note, so its indicator dot can be drawn.
  hasNote?(id: string): boolean;
  // Opens the note for a mark from its indicator dot.
  onNote?(id: string, x: number, y: number): void;
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
  private static readonly BAND_MIN = 0.01;
  private static readonly BAND_MAX = 0.3;
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
  private drawing: {
    surface: number;
    startX: number;
    startY: number;
    ghost: HTMLElement;
    // Set only for a line-tool swipe: height is fixed up front (from
    // bandHeight), so pointerMove only ever adjusts the horizontal extent.
    lineHeight?: number;
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
    }
    this.updateCursor();
  }

  // The line tool's cursor is a vertical double-arrow whose height matches the
  // band, so you can see the line height under the pointer. Built here (not in
  // CSS) because the height changes with '[' / ']'; the hotspot is the arrow's
  // center, so the band centers on the pointer.
  private updateCursor(): void {
    if (this.mode !== "line") {
      for (const layer of this.layers.values()) layer.style.cursor = "";
      return;
    }
    const first = this.surfaces[0];
    const pageH = first ? this.surfaceSize(first.index).h : 800;
    const px = Math.max(16, Math.min(120, Math.round(this.bandHeight * pageH)));
    const w = 16;
    const d = `M8 4 V${px - 4} M3 7 L8 2 L13 7 M3 ${px - 7} L8 ${px - 2} L13 ${px - 7}`;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${px}" viewBox="0 0 ${w} ${px}">` +
      `<path d="${d}" fill="none" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="${d}" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`;
    const cur = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 8 ${Math.round(px / 2)}, crosshair`;
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
    const mark: Mark = {
      kind: "mark",
      id: newMarkId(),
      tags: [kind],
      label: "",
      spans: [p.span],
      color: kind === "highlight" ? HIGHLIGHT_COLOR : DEFAULT_OCCLUSION_COLOR,
      owner: this.options.ownerFor(p.span) || PAGE_OWNER,
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
    if (d.lineHeight !== undefined) {
      // Height is fixed from pointerdown; only the horizontal swipe extent moves.
      d.ghost.style.left = `${Math.min(d.startX, x)}px`;
      d.ghost.style.width = `${Math.abs(x - d.startX)}px`;
    } else {
      const top = Math.min(d.startY, y);
      d.ghost.style.left = `${Math.min(d.startX, x)}px`;
      d.ghost.style.top = `${top}px`;
      d.ghost.style.width = `${Math.abs(x - d.startX)}px`;
      d.ghost.style.height = `${Math.abs(y - d.startY)}px`;
    }
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
      // A line swipe produces a neutral, uncommitted draft — no tags, no
      // color, not persisted. The user's right-click picks occlusion vs
      // highlight (commitPending); any other tool switch discards it.
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
      color: this.mode === "highlight" ? HIGHLIGHT_COLOR : DEFAULT_OCCLUSION_COLOR,
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

  // Detach marks whose owner box no longer exists, so free marks survive
  // but orphaned attachments fall back to the page.
  reassignOwners(validIds: Set<string>): void {
    for (const r of this.marks) {
      if (r.owner !== PAGE_OWNER && !validIds.has(r.owner)) r.owner = PAGE_OWNER;
    }
    this.paint();
  }

  // Flips a mark between occlusion and highlight in place, so a mis-toggled
  // mark can be fixed without deleting and redrawing it.
  setKind(id: string, kind: MarkKind): void {
    const r = this.marks.find((x) => x.id === id);
    if (!r) return;
    setMarkKind(r, kind);
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

  toggleReveal(): void {
    const anyHidden = this.marks.some((r) => !r.revealed);
    this.revealAll(anyHidden);
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
    }
    for (const r of this.marks) {
      const span = r.spans[0];
      if (!span) continue;
      const layer = this.layerOf(span.page);
      if (!layer) continue;
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
      el.style.background = markKind(r) === "occlusion" ? r.color ?? DEFAULT_OCCLUSION_COLOR : "transparent";
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
        dot.title = "note — click to open";
        dot.appendChild(icon("pencil", 8));
        dot.addEventListener("pointerdown", (e) => e.stopPropagation());
        dot.addEventListener("click", (e) => {
          e.stopPropagation();
          this.options.onNote?.(r.id, e.clientX, e.clientY);
        });
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
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.options.onContext?.(r.id, e.clientX, e.clientY);
      });
      layer.appendChild(el);
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
