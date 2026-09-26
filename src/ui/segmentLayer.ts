import type { Marker, Segment } from "../store/schema";
import type { Surface } from "../adapters/types";

export interface SegmentLayerOptions {
  onSelect(id: string, kind: "segment" | "marker"): void;
  onContext(id: string, kind: "segment" | "marker", x: number, y: number): void;
  getActive(): string | null;
}

export class SegmentLayer {
  private readonly surfaces: Surface[];
  private readonly options: SegmentLayerOptions;
  private readonly layers = new Map<number, HTMLElement>();
  private segments: Segment[] = [];
  private markers: Marker[] = [];
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

  setData(segments: Segment[], markers: Marker[]): void {
    this.segments = segments;
    this.markers = markers;
    this.paint();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const layer of this.layers.values()) {
      layer.style.display = visible ? "block" : "none";
    }
    if (visible) this.paint();
  }

  // While a mark tool is active, drop pointer events on the whole layer (and
  // its boxes) so the overlay can draw through segments, including a question.
  setInteractive(interactive: boolean): void {
    for (const layer of this.layers.values()) {
      layer.classList.toggle("click-through", !interactive);
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  scrollTo(id: string): void {
    const seg = this.segments.find((s) => s.id === id);
    if (seg?.spans.length) {
      const el = this.layers.get(seg.spans[0].page)?.querySelector<HTMLElement>(`[data-seg="${id}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const marker = this.markers.find((m) => m.id === id);
    if (!marker) return;
    const el = this.layers.get(marker.page)?.querySelector<HTMLElement>(`[data-marker="${id}"]`);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
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
      layer.querySelectorAll(".seg-box, .seg-marker").forEach((n) => n.remove());
    }
    if (!this.visible) return;
    const active = this.options.getActive();

    for (const seg of this.segments) {
      for (const span of seg.spans) {
        const layer = this.layers.get(span.page);
        if (!layer) continue;
        const { w, h } = this.size(span.page);
        const box = document.createElement("div");
        box.className = `seg-box role-${seg.role}` + (seg.id === active ? " active" : "");
        box.dataset.seg = seg.id;
        box.style.left = `${span.x * w}px`;
        box.style.top = `${span.y * h}px`;
        box.style.width = `${span.w * w}px`;
        box.style.height = `${span.h * h}px`;
        const tag = document.createElement("span");
        tag.className = "seg-tag";
        tag.textContent = seg.label.trim() || seg.role;
        box.appendChild(tag);
        box.addEventListener("click", (e) => {
          e.stopPropagation();
          this.options.onSelect(seg.id, "segment");
        });
        box.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.options.onContext(seg.id, "segment", e.clientX, e.clientY);
        });
        layer.appendChild(box);
      }
    }

    for (const marker of this.markers) {
      const layer = this.layers.get(marker.page);
      if (!layer) continue;
      const { h } = this.size(marker.page);
      const line = document.createElement("div");
      line.className = "seg-marker" + (marker.id === active ? " active" : "");
      line.dataset.marker = marker.id;
      line.style.top = `${marker.y * h}px`;
      const tag = document.createElement("span");
      tag.className = "seg-marker-tag";
      tag.textContent = marker.label.trim() || "marker";
      line.appendChild(tag);
      line.addEventListener("click", (e) => {
        e.stopPropagation();
        this.options.onSelect(marker.id, "marker");
      });
      line.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.options.onContext(marker.id, "marker", e.clientX, e.clientY);
      });
      layer.appendChild(line);
    }
  }

  destroy(): void {
    for (const layer of this.layers.values()) layer.remove();
    this.layers.clear();
  }
}
