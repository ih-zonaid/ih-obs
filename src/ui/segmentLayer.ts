import { isAnchor, isBox, roleOf, type Box, type Entity } from "../store/schema";
import type { Surface } from "../adapters/types";
import { icon } from "./icons";
import { scrollIntoContainer, scrollParent } from "./scroll";

export interface SegmentLayerOptions {
  onSelect(id: string, kind: "box" | "mark"): void;
  onContext(id: string, kind: "box" | "mark", x: number, y: number): void;
  getActive(): string | null;
  hasNote?(id: string): boolean;
  onNoteBadge?(id: string, kind: "box" | "mark", x: number, y: number): void;
  onNoteHover?(id: string, kind: "box" | "mark", x: number, y: number): void;
  onNoteLeave?(): void;
}

// Renders the structural geometry: container boxes and anchor lines. Marks live
// in the overlay, so this layer only ever looks at boxes.
export class SegmentLayer {
  private readonly surfaces: Surface[];
  private readonly options: SegmentLayerOptions;
  private readonly layers = new Map<number, HTMLElement>();
  private boxes: Box[] = [];
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

  setData(entities: Entity[]): void {
    this.boxes = entities.filter(isBox);
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
  // its boxes) so the overlay can draw through boxes, including a question.
  setInteractive(interactive: boolean): void {
    for (const layer of this.layers.values()) {
      layer.classList.toggle("click-through", !interactive);
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  // Instant, not smooth: an animated scroll across a large document drags the
  // viewport through every intervening page, and each one transiently enters
  // the render-ahead margin and gets rasterized just to be flown past —
  // expensive for scanned PDFs and a source of visible jank on long jumps.
  // Scroll via the container, never Element.scrollIntoView: the latter also
  // scrolls the document element, which shifts the fixed toolbar off-screen
  // (see scroll.ts).
  scrollTo(id: string): void {
    for (const layer of this.layers.values()) {
      const container = layer.closest<HTMLElement>(".viewer") ?? scrollParent(layer);
      if (!container) return;
      const box = layer.querySelector<HTMLElement>(`[data-seg="${id}"]`);
      if (box) {
        scrollIntoContainer(container, box, "center");
        return;
      }
      const anchor = layer.querySelector<HTMLElement>(`[data-marker="${id}"]`);
      if (anchor) {
        scrollIntoContainer(container, anchor, "start");
        return;
      }
    }
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

    for (const box of this.boxes) {
      if (isAnchor(box)) {
        this.paintAnchor(box, active);
        continue;
      }
      for (const span of box.spans) {
        const layer = this.layers.get(span.page);
        if (!layer) continue;
        const { w, h } = this.size(span.page);
        const el = document.createElement("div");
        el.className = `seg-box role-${roleOf(box)}` + (box.id === active ? " active" : "");
        el.dataset.seg = box.id;
        el.style.left = `${span.x * w}px`;
        el.style.top = `${span.y * h}px`;
        el.style.width = `${span.w * w}px`;
        el.style.height = `${span.h * h}px`;
        const tag = document.createElement("span");
        tag.className = "seg-tag";
        tag.textContent = box.label.trim() || roleOf(box);
        el.appendChild(tag);
        if (this.options.hasNote?.(box.id)) el.appendChild(this.noteBadge(box.id, "box"));
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          this.options.onSelect(box.id, "box");
        });
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.options.onContext(box.id, "box", e.clientX, e.clientY);
        });
        layer.appendChild(el);
      }
    }
  }

  private paintAnchor(box: Box, active: string | null): void {
    const span = box.spans[0];
    if (!span) return;
    const layer = this.layers.get(span.page);
    if (!layer) return;
    const { h } = this.size(span.page);
    const line = document.createElement("div");
    line.className = "seg-marker" + (box.id === active ? " active" : "");
    line.dataset.marker = box.id;
    line.style.top = `${span.y * h}px`;
    const tag = document.createElement("span");
    tag.className = "seg-marker-tag";
    tag.textContent = box.label.trim() || "anchor";
    line.appendChild(tag);
    if (this.options.hasNote?.(box.id)) line.appendChild(this.noteBadge(box.id, "box"));
    line.addEventListener("click", (e) => {
      e.stopPropagation();
      this.options.onSelect(box.id, "box");
    });
    line.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.options.onContext(box.id, "box", e.clientX, e.clientY);
    });
    layer.appendChild(line);
  }

  private noteBadge(id: string, kind: "box" | "mark"): HTMLElement {
    const badge = document.createElement("span");
    badge.className = "seg-note-badge";
    badge.appendChild(icon("pencil", 9));
    badge.title = "note — click to open";
    badge.addEventListener("pointerdown", (e) => e.stopPropagation());
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      this.options.onNoteBadge?.(id, kind, e.clientX, e.clientY);
    });
    badge.addEventListener("pointerenter", (e) => {
      this.options.onNoteHover?.(id, kind, e.clientX, e.clientY);
    });
    badge.addEventListener("pointerleave", () => this.options.onNoteLeave?.());
    return badge;
  }

  destroy(): void {
    for (const layer of this.layers.values()) layer.remove();
    this.layers.clear();
  }
}
