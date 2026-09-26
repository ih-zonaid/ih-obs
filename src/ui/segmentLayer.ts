import type { Segment } from "../store/schema";
import type { Surface } from "../adapters/types";

export interface SegmentLayerOptions {
  onSelect(id: string): void;
  getActive(): string | null;
}

export class SegmentLayer {
  private readonly surfaces: Surface[];
  private readonly options: SegmentLayerOptions;
  private readonly layers = new Map<number, HTMLElement>();
  private segments: Segment[] = [];
  private visible = false;

  constructor(surfaces: Surface[], options: SegmentLayerOptions) {
    this.surfaces = surfaces;
    this.options = options;
    this.mount();
  }

  private mount(): void {
    for (const s of this.surfaces) {
      const layer = document.createElement("div");
      layer.className = "seg-layer";
      layer.dataset.surface = String(s.index);
      layer.style.display = "none";
      s.el.appendChild(layer);
      this.layers.set(s.index, layer);
    }
  }

  setSegments(segments: Segment[]): void {
    this.segments = segments;
    this.paint();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const layer of this.layers.values()) {
      layer.style.display = visible ? "block" : "none";
    }
    if (visible) this.paint();
  }

  isVisible(): boolean {
    return this.visible;
  }

  scrollTo(id: string): void {
    const seg = this.segments.find((s) => s.id === id);
    if (!seg || !seg.spans.length) return;
    const span = seg.spans[0];
    const el = this.layers.get(span.page)?.querySelector<HTMLElement>(`[data-seg="${id}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  private size(index: number): { w: number; h: number } {
    const s = this.surfaces.find((x) => x.index === index);
    if (!s) return { w: 1, h: 1 };
    return { w: s.el.clientWidth || s.width || 1, h: s.el.clientHeight || s.height || 1 };
  }

  repaint(): void {
    if (this.visible) this.paint();
  }

  private paint(): void {
    for (const layer of this.layers.values()) {
      layer.querySelectorAll(".seg-box").forEach((n) => n.remove());
    }
    if (!this.visible) return;
    const active = this.options.getActive();
    for (const seg of this.segments) {
      for (const span of seg.spans) {
        const layer = this.layers.get(span.page);
        if (!layer) continue;
        const { w, h } = this.size(span.page);
        const box = document.createElement("div");
        box.className = "seg-box" + (seg.id === active ? " active" : "");
        box.dataset.seg = seg.id;
        box.style.left = `${span.x * w}px`;
        box.style.top = `${span.y * h}px`;
        box.style.width = `${span.w * w}px`;
        box.style.height = `${span.h * h}px`;
        const tag = document.createElement("span");
        tag.className = "seg-tag";
        tag.textContent = seg.title;
        box.appendChild(tag);
        box.addEventListener("click", (e) => {
          e.stopPropagation();
          this.options.onSelect(seg.id);
        });
        layer.appendChild(box);
      }
    }
  }

  destroy(): void {
    for (const layer of this.layers.values()) layer.remove();
    this.layers.clear();
  }
}
