import type { Span } from "../store/schema";
import type { Surface } from "../adapters/types";

export type DrawTool = "concept" | "questions" | "question" | "frame" | "marker" | "split";

export interface SplitCut {
  page: number;
  y: number;
}

export interface SegmentDrawerOptions {
  onBox(span: Span): void;
  onAnchor(page: number, y: number): void;
}

interface Drawing {
  surface: number;
  startX: number;
  startY: number;
  ghost: HTMLElement;
}

export class SegmentDrawer {
  private readonly surfaces: Surface[];
  private readonly options: SegmentDrawerOptions;
  private readonly layers = new Map<number, HTMLElement>();
  private tool: DrawTool | null = null;
  private drawing: Drawing | null = null;
  private splitPage: number | null = null;
  private splitBounds: { x: number; y: number; w: number; h: number } | null = null;
  private readonly cuts: SplitCut[] = [];
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onPointerCancel: () => void;
  private readonly onLeave: () => void;

  constructor(surfaces: Surface[], options: SegmentDrawerOptions) {
    this.surfaces = surfaces;
    this.options = options;
    this.onPointerDown = (e) => this.pointerDown(e);
    this.onPointerMove = (e) => this.pointerMove(e);
    this.onPointerUp = (e) => this.pointerUp(e);
    this.onPointerCancel = () => this.pointerCancel();
    this.onLeave = () => this.clearHover();
    this.mount();
  }

  private mount(): void {
    for (const s of this.surfaces) {
      const layer = document.createElement("div");
      layer.className = "seg-draw-layer";
      layer.dataset.surface = String(s.index);
      layer.style.display = "none";
      s.el.appendChild(layer);
      this.layers.set(s.index, layer);
      layer.addEventListener("pointerdown", this.onPointerDown);
      layer.addEventListener("pointermove", this.onPointerMove);
      layer.addEventListener("pointerup", this.onPointerUp);
      layer.addEventListener("pointercancel", this.onPointerCancel);
      layer.addEventListener("pointerleave", this.onLeave);
    }
  }

  setTool(tool: DrawTool | null): void {
    this.tool = tool;
    if (tool !== "split") this.resetSplit();
    for (const layer of this.layers.values()) {
      layer.style.display = tool ? "block" : "none";
      layer.classList.toggle("is-drawing", !!tool && tool !== "split");
      layer.classList.toggle("is-marker", tool === "marker");
      layer.classList.toggle("is-split", tool === "split");
    }
    if (!tool && this.drawing) {
      this.drawing.ghost.remove();
      this.drawing = null;
    }
  }

  getTool(): DrawTool | null {
    return this.tool;
  }

  // The split tool operates inside the selected questions container's box on
  // one page. Cuts are stored as normalized y positions and shown live.
  startSplit(page: number, bounds: { x: number; y: number; w: number; h: number }): void {
    this.resetSplit();
    this.splitPage = page;
    this.splitBounds = bounds;
    if (this.tool !== "split") this.setTool("split");
    this.paintSplit();
  }

  getCuts(): SplitCut[] {
    return this.cuts.slice();
  }

  resetSplit(): void {
    this.cuts.length = 0;
    this.splitPage = null;
    this.splitBounds = null;
    for (const layer of this.layers.values()) {
      layer.querySelectorAll(".split-cut, .split-hover").forEach((n) => n.remove());
    }
  }

  private splitLayer(): HTMLElement | null {
    if (this.splitPage === null) return null;
    return this.layers.get(this.splitPage) ?? null;
  }

  private hoverLine(e: PointerEvent): void {
    if (this.tool !== "split" || !this.splitBounds) return;
    const layer = e.currentTarget as HTMLElement;
    const surface = Number(layer.dataset.surface);
    if (surface !== this.splitPage) return;
    const { y } = this.localPoint(e, layer);
    const { h, w } = this.surfaceSize(surface);
    const bounds = this.splitBounds;
    const top = Math.max(bounds.y * h, Math.min((bounds.y + bounds.h) * h, y));
    let hover = layer.querySelector<HTMLElement>(".split-hover");
    if (!hover) {
      hover = document.createElement("div");
      hover.className = "split-hover";
      layer.appendChild(hover);
    }
    hover.style.left = `${bounds.x * w}px`;
    hover.style.width = `${bounds.w * w}px`;
    hover.style.top = `${top}px`;
  }

  private clearHover(): void {
    for (const layer of this.layers.values()) {
      layer.querySelectorAll(".split-hover").forEach((n) => n.remove());
    }
  }

  private paintSplit(): void {
    const layer = this.splitLayer();
    if (!layer || !this.splitBounds) return;
    layer.querySelectorAll(".split-cut").forEach((n) => n.remove());
    const { w, h } = this.surfaceSize(this.splitPage as number);
    for (const cut of this.cuts) {
      const line = document.createElement("div");
      line.className = "split-cut";
      line.style.left = `${this.splitBounds.x * w}px`;
      line.style.width = `${this.splitBounds.w * w}px`;
      line.style.top = `${cut.y * h}px`;
      layer.appendChild(line);
    }
  }

  private surfaceSize(index: number): { w: number; h: number } {
    const s = this.surfaces.find((x) => x.index === index);
    if (!s) return { w: 1, h: 1 };
    return { w: s.el.clientWidth || s.width || 1, h: s.el.clientHeight || s.height || 1 };
  }

  private localPoint(e: PointerEvent, layer: HTMLElement): { x: number; y: number } {
    const rect = layer.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.tool || e.button !== 0) return;
    const layer = e.currentTarget as HTMLElement;
    const surface = Number(layer.dataset.surface);
    const { x, y } = this.localPoint(e, layer);
    e.preventDefault();

    if (this.tool === "marker") {
      const { h } = this.surfaceSize(surface);
      this.options.onAnchor(surface, y / h);
      return;
    }

    if (this.tool === "split") {
      if (this.splitPage === null || surface !== this.splitPage) return;
      const { h } = this.surfaceSize(surface);
      const bounds = this.splitBounds;
      const ny = y / h;
      if (!bounds || ny < bounds.y || ny > bounds.y + bounds.h) return;
      const existing = this.cuts.findIndex((c) => Math.abs(c.y - ny) < 0.004);
      if (existing >= 0) this.cuts.splice(existing, 1);
      else this.cuts.push({ page: surface, y: ny });
      this.cuts.sort((a, b) => a.y - b.y);
      this.paintSplit();
      return;
    }

    const ghost = document.createElement("div");
    ghost.className = "seg-draw-ghost";
    layer.appendChild(ghost);
    this.drawing = { surface, startX: x, startY: y, ghost };
    layer.setPointerCapture(e.pointerId);
  }

  private pointerMove(e: PointerEvent): void {
    if (this.tool === "split") {
      this.hoverLine(e);
      return;
    }
    if (!this.drawing) return;
    const layer = e.currentTarget as HTMLElement;
    const { x, y } = this.localPoint(e, layer);
    const d = this.drawing;
    d.ghost.style.left = `${Math.min(d.startX, x)}px`;
    d.ghost.style.top = `${Math.min(d.startY, y)}px`;
    d.ghost.style.width = `${Math.abs(x - d.startX)}px`;
    d.ghost.style.height = `${Math.abs(y - d.startY)}px`;
  }

  private pointerUp(e: PointerEvent): void {
    if (!this.drawing) return;
    const layer = e.currentTarget as HTMLElement;
    const d = this.drawing;
    this.drawing = null;
    layer.releasePointerCapture(e.pointerId);
    d.ghost.remove();

    const { w, h } = this.surfaceSize(d.surface);
    const { x, y } = this.localPoint(e, layer);
    const left = Math.min(d.startX, x);
    const top = Math.min(d.startY, y);
    const width = Math.abs(x - d.startX);
    const height = Math.abs(y - d.startY);
    if (width < 4 || height < 4) return;
    this.options.onBox({
      page: d.surface,
      x: left / w,
      y: top / h,
      w: width / w,
      h: height / h
    });
  }

  // The browser cancels the pointer when it claims the gesture for scrolling or
  // a pinch; pointerup never arrives, so the ghost has to be dropped here or it
  // would stay painted on the page and `drawing` would stay set.
  private pointerCancel(): void {
    const d = this.drawing;
    if (!d) return;
    this.drawing = null;
    d.ghost.remove();
  }

  destroy(): void {
    for (const layer of this.layers.values()) {
      layer.removeEventListener("pointerdown", this.onPointerDown);
      layer.removeEventListener("pointermove", this.onPointerMove);
      layer.removeEventListener("pointerup", this.onPointerUp);
      layer.remove();
    }
    this.layers.clear();
  }
}
