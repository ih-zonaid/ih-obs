import { PAGE_OWNER, type Region } from "../store/schema";
import type { Surface } from "../adapters/types";

export type OverlayMode = "none" | "occlude" | "highlight";

export interface OverlayOptions {
  onChange(regions: Region[]): void;
  onContext?(id: string, x: number, y: number): void;
  // Resolves the owner for a freshly drawn mark. Explicit selection wins;
  // otherwise the caller falls back to containment, then page.
  ownerFor(geom: { surface: number; x: number; y: number; w: number; h: number }): string;
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
  private drawing: { surface: number; startX: number; startY: number; ghost: HTMLElement } | null = null;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;

  constructor(surfaces: Surface[], regions: Region[], options: OverlayOptions) {
    this.surfaces = surfaces;
    this.regions = regions;
    this.options = options;
    this.onPointerDown = (e) => this.pointerDown(e);
    this.onPointerMove = (e) => this.pointerMove(e);
    this.onPointerUp = (e) => this.pointerUp(e);
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
    }
    this.paint();
  }

  setMode(mode: OverlayMode): void {
    this.mode = mode;
    for (const layer of this.layers.values()) {
      layer.classList.toggle("is-drawing", mode !== "none");
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

  private localPoint(e: PointerEvent, layer: HTMLElement): { x: number; y: number } {
    const rect = layer.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private pointerDown(e: PointerEvent): void {
    if (this.mode === "none") return;
    if (e.button !== 0) return;
    const layer = e.currentTarget as HTMLElement;
    const surface = Number(layer.dataset.surface);
    const { x, y } = this.localPoint(e, layer);
    const ghost = document.createElement("div");
    ghost.className = `ihobs-region ghost ${this.mode}`;
    layer.appendChild(ghost);
    this.drawing = { surface, startX: x, startY: y, ghost };
    layer.setPointerCapture(e.pointerId);
  }

  private pointerMove(e: PointerEvent): void {
    if (!this.drawing) return;
    const layer = e.currentTarget as HTMLElement;
    const { x, y } = this.localPoint(e, layer);
    const d = this.drawing;
    const left = Math.min(d.startX, x);
    const top = Math.min(d.startY, y);
    d.ghost.style.left = `${left}px`;
    d.ghost.style.top = `${top}px`;
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
    if (this.mode === "none") return;

    this.regions.push({
      id: uid(),
      surface: d.surface,
      kind: this.mode === "highlight" ? "highlight" : "occlusion",
      x: left / w,
      y: top / h,
      w: width / w,
      h: height / h,
      color: this.mode === "highlight" ? "#f5c518" : "#1f2430",
      owner:
        this.options.ownerFor({
          surface: d.surface,
          x: left / w,
          y: top / h,
          w: width / w,
          h: height / h
        }) || PAGE_OWNER,
      revealed: false
    });
    this.paint();
    this.options.onChange(this.regions);
  }

  reveal(id: string, revealed = true): void {
    const r = this.regions.find((x) => x.id === id);
    if (!r) return;
    r.revealed = revealed;
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
      }`;
      el.dataset.owner = r.owner;
      el.style.left = `${r.x * w}px`;
      el.style.top = `${r.y * h}px`;
      el.style.width = `${r.w * w}px`;
      el.style.height = `${r.h * h}px`;
      el.style.background = r.kind === "occlusion" ? r.color : "transparent";
      el.title = "click to reveal · right-click for options";
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
      layer.remove();
    }
    this.layers.clear();
  }
}
