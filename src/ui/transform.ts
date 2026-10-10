import { resizeSpan, translateSpan, type Handle, type Span } from "../store/schema";
import type { Surface } from "../adapters/types";

export interface TransformTarget {
  // The span to frame. Multi-span entities frame only their first span; the
  // caller translates them all by the same delta.
  span: Span;
  // Which resize handles to expose. Empty means move-only (an anchor line,
  // where width is fixed by construction).
  handles: Handle[];
  // Which deltas a move may apply. "y" locks an anchor to vertical movement.
  axis?: "x" | "y" | "both";
}

export interface TransformOptions {
  // Re-read on every paint so the frame always tracks app state (it is the
  // app that owns the entity; this controller only draws and drags it).
  getTarget(): TransformTarget | null;
  // Live geometry update while dragging — no persistence. `origin` is the span
  // the drag started from, so the app can re-apply the same delta to any
  // sibling spans on a multi-span entity.
  onPreview(span: Span, origin: Span): void;
  // Pointer released after a real drag: persist.
  onCommit(span: Span, origin: Span): void;
  // Escape mid-drag: restore the pre-drag span.
  onCancel(origin: Span): void;
  // Pointer released without moving: forward the click (e.g. reveal a mark).
  onClick(): void;
  // Right-click on the frame body: reopen the entity's menu, since the frame
  // covers the element that would normally receive it.
  onContext(x: number, y: number): void;
  // Escape with no drag in progress: drop the selection.
  onDeselect(): void;
}

interface Drag {
  mode: "move" | "resize";
  handle?: Handle;
  surface: number;
  origin: Span;
  last: Span;
  startX: number;
  startY: number;
  moved: boolean;
}

// How far the pointer must travel before a press becomes a drag rather than a
// click. Without this, every click-to-reveal on a mark would nudge it.
const DRAG_THRESHOLD_PX = 3;
// A mouse can hold a 3px line; a finger cannot. Touch slop is routinely 5–15px,
// so the mouse threshold would turn any scroll that happens to start on the
// frame into a move or a resize. Reading mode never shows the frame, but a
// touchscreen laptop or a tablet with a trackpad still can.
const TOUCH_THRESHOLD_PX = 12;

// The transform frame: a move/resize chrome drawn over the selected entity
// only. Nothing here mutates the model directly; the app owns the span and is
// told to preview (live), commit (persist) or cancel.
export class Transform {
  private readonly surfaces: Surface[];
  private readonly options: TransformOptions;
  private readonly layers = new Map<number, HTMLElement>();
  private frame: HTMLElement | null = null;
  private drag: Drag | null = null;
  private readonly onPointerDown: (e: PointerEvent) => void;
  private readonly onPointerMove: (e: PointerEvent) => void;
  private readonly onPointerUp: (e: PointerEvent) => void;
  private readonly onPointerCancel: () => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;

  constructor(surfaces: Surface[], options: TransformOptions) {
    this.surfaces = surfaces;
    this.options = options;
    this.onPointerDown = (e) => this.pointerDown(e);
    this.onPointerMove = (e) => this.pointerMove(e);
    this.onPointerUp = (e) => this.pointerUp(e);
    this.onPointerCancel = () => this.pointerCancel();
    this.onKeyDown = (e) => this.keyDown(e);
    this.mount();
  }

  private mount(): void {
    for (const s of this.surfaces) {
      const layer = document.createElement("div");
      layer.className = "transform-layer";
      layer.dataset.surface = String(s.index);
      s.el.appendChild(layer);
      this.layers.set(s.index, layer);
      layer.addEventListener("pointerdown", this.onPointerDown);
      layer.addEventListener("pointermove", this.onPointerMove);
      layer.addEventListener("pointerup", this.onPointerUp);
      layer.addEventListener("pointercancel", this.onPointerCancel);
      layer.addEventListener("contextmenu", (e) => {
        if (!(e.target as HTMLElement).closest(".transform-frame")) return;
        e.preventDefault();
        e.stopPropagation();
        this.options.onContext(e.clientX, e.clientY);
      });
    }
    window.addEventListener("keydown", this.onKeyDown);
  }

  // Hidden entirely while a draw tool owns the pointer, so the frame cannot
  // swallow the gesture that is drawing a new box or mark.
  setVisible(visible: boolean): void {
    for (const layer of this.layers.values()) {
      layer.classList.toggle("hidden", !visible);
    }
    if (!visible) this.clearFrame();
  }

  private clearFrame(): void {
    this.frame?.remove();
    this.frame = null;
  }

  private size(index: number): { w: number; h: number } {
    const s = this.surfaces.find((x) => x.index === index);
    if (!s) return { w: 1, h: 1 };
    return { w: s.el.clientWidth || s.width || 1, h: s.el.clientHeight || s.height || 1 };
  }

  repaint(): void {
    this.clearFrame();
    const target = this.options.getTarget();
    if (!target) return;
    const layer = this.layers.get(target.span.page);
    if (!layer || layer.classList.contains("hidden")) return;
    const { w, h } = this.size(target.span.page);
    const frame = document.createElement("div");
    frame.className = "transform-frame";
    frame.dataset.axis = target.axis ?? "both";
    frame.style.left = `${target.span.x * w}px`;
    frame.style.top = `${target.span.y * h}px`;
    frame.style.width = `${target.span.w * w}px`;
    frame.style.height = `${target.span.h * h}px`;
    for (const handle of target.handles) {
      const el = document.createElement("div");
      el.className = "transform-handle";
      el.dataset.h = handle;
      frame.appendChild(el);
    }
    layer.appendChild(frame);
    this.frame = frame;
  }

  private pointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this.drag) return;
    const target = this.options.getTarget();
    if (!target) return;
    const layer = e.currentTarget as HTMLElement;
    const surface = Number(layer.dataset.surface);
    if (surface !== target.span.page) return;
    const handle = (e.target as HTMLElement).dataset.h as Handle | undefined;
    const origin = { ...target.span };
    this.drag = {
      mode: handle ? "resize" : "move",
      handle,
      surface,
      origin,
      last: origin,
      startX: e.clientX,
      startY: e.clientY,
      moved: false
    };
    layer.setPointerCapture(e.pointerId);
  }

  private pointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const { w, h } = this.size(drag.surface);
    let dx = (e.clientX - drag.startX) / w;
    let dy = (e.clientY - drag.startY) / h;
    if (!drag.moved) {
      const px = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (px < (e.pointerType === "touch" ? TOUCH_THRESHOLD_PX : DRAG_THRESHOLD_PX)) return;
      drag.moved = true;
    }
    const axis = this.options.getTarget()?.axis ?? "both";
    if (axis === "y") dx = 0;
    if (axis === "x") dy = 0;
    const span =
      drag.mode === "resize" && drag.handle
        ? resizeSpan(drag.origin, drag.handle, dx, dy)
        : translateSpan(drag.origin, dx, dy);
    drag.last = span;
    this.options.onPreview(span, drag.origin);
    this.repaint();
  }

  private pointerUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const layer = e.currentTarget as HTMLElement;
    layer.releasePointerCapture(e.pointerId);
    this.drag = null;
    if (drag.moved) this.options.onCommit(drag.last, drag.origin);
    else this.options.onClick();
  }

  // A touch that turns into a scroll never reaches pointerup, so the drag is
  // abandoned and the pre-drag span restored (Escape's path). Without this,
  // `drag` would stay set and the early return in pointerDown would make the
  // frame permanently un-draggable — the whole app's own worst mobile bug.
  private pointerCancel(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.options.onCancel(drag.origin);
    this.repaint();
  }

  private keyDown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    // Don't swallow Escape from inside a text field (label/note editors).
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (this.drag) {
      e.preventDefault();
      const origin = this.drag.origin;
      this.drag = null;
      this.options.onCancel(origin);
      this.repaint();
      return;
    }
    if (this.frame) this.options.onDeselect();
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    for (const layer of this.layers.values()) {
      layer.removeEventListener("pointerdown", this.onPointerDown);
      layer.removeEventListener("pointermove", this.onPointerMove);
      layer.removeEventListener("pointerup", this.onPointerUp);
      layer.removeEventListener("pointercancel", this.onPointerCancel);
      layer.remove();
    }
    this.layers.clear();
    this.frame = null;
    this.drag = null;
  }
}
