import { DEFAULT_OCCLUSION_COLOR, PAGE_OWNER, type Region, type RegionKind } from "../store/schema";
import type { Surface } from "../adapters/types";

export type OverlayMode = "none" | "occlude" | "highlight";

export interface OverlayOptions {
  onChange(regions: Region[]): void;
  onContext?(id: string, x: number, y: number): void;
  // Resolves the owner for a freshly drawn mark. Explicit selection wins;
  // otherwise the caller falls back to containment, then page.
  ownerFor(geom: { surface: number; x: number; y: number; w: number; h: number }): string;
  // Resolves a human label for a mark's owner, used by inspect mode.
  ownerLabel?(owner: string): string;
  // Whether a mark carries a note, so its indicator dot can be drawn.
  hasNote?(id: string): boolean;
  // Opens the note for a mark from its indicator dot.
  onNote?(id: string, x: number, y: number): void;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export class Overlay {
  private readonly surfaces: Surface[];
  private readonly options: OverlayOptions;
  private readonly layers = new Map<number, HTMLElement>();
  private regions: Region[];
  private mode: OverlayMode = "none";
  private inspect = false;
  // Line tool: instead of dragging a rectangle corner-to-corner, a preview
  // band follows the cursor at a fixed (wheel-adjustable) height and a swipe
  // sets its horizontal extent — built for occluding/highlighting one text
  // line at a time in a scanned book.
  private lineMode = false;
  // Fraction of page height, kept sticky across swipes (and pages/zoom,
  // since it's normalized the same way Region.h is).
  private bandHeight = 0.025;
  private static readonly BAND_MIN = 0.01;
  private static readonly BAND_MAX = 0.3;
  private static readonly BAND_STEP = 0.004;
  private hoverGhost: HTMLElement | null = null;
  private hoverLayer: HTMLElement | null = null;
  // Id of the last region stamped by the line tool, so a Shift+swipe can
  // join it into the same reveal group.
  private lastLineRegionId: string | null = null;
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

  constructor(surfaces: Surface[], regions: Region[], options: OverlayOptions) {
    this.surfaces = surfaces;
    this.regions = regions;
    this.options = options;
    this.onPointerDown = (e) => this.pointerDown(e);
    this.onPointerMove = (e) => this.pointerMove(e);
    this.onPointerUp = (e) => this.pointerUp(e);
    this.onPointerLeave = () => this.clearHoverGhost();
    this.onWheel = (e) => this.wheel(e);
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
    this.mode = mode;
    if (mode === "none") {
      this.clearHoverGhost();
      this.lastLineRegionId = null;
    }
    for (const layer of this.layers.values()) {
      layer.classList.toggle("is-drawing", mode !== "none");
    }
  }

  setLineMode(on: boolean): void {
    this.lineMode = on;
    if (!on) {
      this.clearHoverGhost();
      this.lastLineRegionId = null;
    }
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

  getRegions(): Region[] {
    return this.regions;
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

  // Live preview band while the line tool is armed but not yet swiping —
  // shows which line height/row you're about to stamp before you commit.
  private hoverMove(layer: HTMLElement, clientX: number, clientY: number): void {
    if (!this.lineMode || this.mode === "none") {
      this.clearHoverGhost();
      return;
    }
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

  // Adjusts the line tool's band height in place, only while it's armed —
  // otherwise the wheel just scrolls the document as normal.
  private wheel(e: WheelEvent): void {
    if (!this.lineMode || this.mode === "none" || this.drawing) return;
    e.preventDefault();
    const step = Overlay.BAND_STEP * (e.deltaY < 0 ? 1 : -1);
    this.bandHeight = Math.min(Overlay.BAND_MAX, Math.max(Overlay.BAND_MIN, this.bandHeight + step));
    this.hoverMove(e.currentTarget as HTMLElement, e.clientX, e.clientY);
  }

  private pointerDown(e: PointerEvent): void {
    if (this.mode === "none") return;
    if (e.button !== 0) return;
    const layer = e.currentTarget as HTMLElement;
    const surface = Number(layer.dataset.surface);
    const { x, y } = this.localPoint(layer, e.clientX, e.clientY);
    this.clearHoverGhost();
    const ghost = document.createElement("div");
    ghost.className = `ihobs-region ghost ${this.mode}`;
    layer.appendChild(ghost);
    if (this.lineMode) {
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

  // Joins a fresh swipe to the group the last line-tool region belongs to
  // (creating the group on first use), so multiple swipes for one ragged
  // answer still reveal/hide as a single unit.
  private joinLineGroup(): string | undefined {
    if (!this.lastLineRegionId) return undefined;
    const prev = this.regions.find((r) => r.id === this.lastLineRegionId);
    if (!prev) return undefined;
    if (!prev.groupId) prev.groupId = uid();
    return prev.groupId;
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
      if (this.lineMode) this.hoverMove(layer, e.clientX, e.clientY);
      return;
    }
    if (this.mode === "none") return;

    const region: Region = {
      id: uid(),
      surface: d.surface,
      kind: this.mode === "highlight" ? "highlight" : "occlusion",
      x: left / w,
      y: top / h,
      w: width / w,
      h: height / h,
      color: this.mode === "highlight" ? "#f5c518" : DEFAULT_OCCLUSION_COLOR,
      owner:
        this.options.ownerFor({
          surface: d.surface,
          x: left / w,
          y: top / h,
          w: width / w,
          h: height / h
        }) || PAGE_OWNER,
      revealed: false,
      groupId: this.lineMode && e.shiftKey ? this.joinLineGroup() : undefined
    };
    this.regions.push(region);
    if (this.lineMode) {
      this.lastLineRegionId = region.id;
      this.hoverMove(layer, e.clientX, e.clientY);
    }
    this.paint();
    this.options.onChange(this.regions);
  }

  // A mark with a groupId (line-tool swipes chained with Shift) reveals and
  // hides together with the rest of its group, as one logical answer.
  reveal(id: string, revealed = true): void {
    const r = this.regions.find((x) => x.id === id);
    if (!r) return;
    const targets = r.groupId ? this.regions.filter((x) => x.groupId === r.groupId) : [r];
    for (const t of targets) t.revealed = revealed;
    this.paint();
    this.options.onChange(this.regions);
  }

  revealAll(revealed: boolean): void {
    for (const r of this.regions) r.revealed = revealed;
    this.paint();
    this.options.onChange(this.regions);
  }

  // Detach marks whose owner segment no longer exists, so free marks survive
  // but orphaned attachments fall back to the page.
  reassignOwners(validIds: Set<string>): void {
    for (const r of this.regions) {
      if (r.owner !== PAGE_OWNER && !validIds.has(r.owner)) r.owner = PAGE_OWNER;
    }
    this.paint();
  }

  // Flips a mark between occlusion and highlight in place, so a mis-toggled
  // mark can be fixed without deleting and redrawing it.
  setKind(id: string, kind: RegionKind): void {
    const r = this.regions.find((x) => x.id === id);
    if (!r) return;
    r.kind = kind;
    this.paint();
    this.options.onChange(this.regions);
  }

  // silent: true skips onChange (persist) so a live color-picker drag doesn't
  // trigger a sidecar write on every intermediate value.
  setColor(id: string, color: string, opts?: { silent?: boolean }): void {
    const r = this.regions.find((x) => x.id === id);
    if (!r) return;
    r.color = color;
    this.paint();
    if (!opts?.silent) this.options.onChange(this.regions);
  }

  setOwner(id: string, owner: string): void {
    const r = this.regions.find((x) => x.id === id);
    if (!r) return;
    r.owner = owner;
    this.paint();
    this.options.onChange(this.regions);
  }

  toggleReveal(): void {
    const anyHidden = this.regions.some((r) => !r.revealed);
    this.revealAll(anyHidden);
  }

  remove(id: string): void {
    this.regions = this.regions.filter((r) => r.id !== id);
    this.paint();
    this.options.onChange(this.regions);
  }

  setRegions(regions: Region[]): void {
    this.regions = regions;
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
      layer.querySelectorAll(".ihobs-region:not(.ghost)").forEach((n) => n.remove());
    }
    for (const r of this.regions) {
      const layer = this.layerOf(r.surface);
      if (!layer) continue;
      const { w, h } = this.surfaceSize(r.surface);
      const el = document.createElement("div");
      const attached = r.owner && r.owner !== PAGE_OWNER;
      el.className = `ihobs-region ${r.kind}${r.revealed ? " revealed" : ""}${
        attached ? " attached" : ""
      }${this.inspect ? " inspect" : ""}`;
      el.dataset.owner = r.owner;
      el.style.left = `${r.x * w}px`;
      el.style.top = `${r.y * h}px`;
      el.style.width = `${r.w * w}px`;
      el.style.height = `${r.h * h}px`;
      el.style.background = r.kind === "occlusion" ? r.color : "transparent";
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
        dot.textContent = "✎";
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
