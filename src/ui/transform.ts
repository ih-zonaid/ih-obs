import { resizeSpan, translateSpan, type CornerIndex, type Corners, type Edge, type Handle, type Point, type Span } from "../store/schema";
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
  // Present for a quad frame: the four corners (TL, TR, BR, BL) the handles sit
  // on. When set, a corner handle moves that one corner and a side handle moves
  // that whole side in parallel; `span` is their bounding box.
  corners?: Corners;
  // True only when the frame is actually skewed, so the seg layer is drawing a
  // polygon and the transform chrome should not also draw its own rectangle.
  skew?: boolean;
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
  // Quad-frame drags. A corner reports the corner (0=TL, 1=TR, 2=BR, 3=BL) and
  // the pointer in page-normalized coords; a side reports its edge and the delta
  // to move that whole side by. Preview fires live; commit persists once on
  // release; cancel (Escape / pointercancel) drops the drag so the caller can
  // restore the pre-drag shape.
  onCornerPreview?(index: CornerIndex, point: Point): void;
  onCornerCommit?(index: CornerIndex, point: Point): void;
  onEdgePreview?(edge: Edge, dx: number, dy: number): void;
  onEdgeCommit?(edge: Edge, dx: number, dy: number): void;
  onQuadCancel?(): void;
  // Pointer released without moving: forward the click (e.g. reveal a mark).
  onClick(): void;
  // Right-click on the frame body: reopen the entity's menu, since the frame
  // covers the element that would normally receive it.
  onContext(x: number, y: number): void;
  // Escape with no drag in progress: drop the selection.
  onDeselect(): void;
}

interface Drag {
  mode: "move" | "resize" | "corner" | "edge";
  handle?: Handle;
  // Set only for a quad-frame corner drag.
  corner?: CornerIndex;
  // Set only for a quad-frame side drag.
  edge?: Edge;
  // Last corner point (page-normalized), set for a corner drag.
  point?: Point;
  // Last delta, set for a side drag.
  delta?: { dx: number; dy: number };
  surface: number;
  origin: Span;
  last: Span;
  startX: number;
  startY: number;
  moved: boolean;
}

// A corner handle's name -> its corner index on a quad. Edge handles (n/e/s/w)
// have no corner and return -1.
function cornerIndexOf(handle: Handle): number {
  if (handle === "nw") return 0;
  if (handle === "ne") return 1;
  if (handle === "se") return 2;
  if (handle === "sw") return 3;
  return -1;
}

// A side handle's name -> its edge, or null for a corner handle.
function edgeOf(handle: Handle): Edge | null {
  return handle === "n" || handle === "e" || handle === "s" || handle === "w" ? handle : null;
}

// Where a handle sits on a quad, for drawing: a corner handle on its corner, a
// side handle on that side's midpoint.
function quadHandlePoint(handle: Handle, corners: Corners): Point | null {
  const ci = cornerIndexOf(handle);
  if (ci >= 0) return corners[ci];
  const pair: [number, number] | null =
    handle === "n" ? [0, 1] : handle === "e" ? [1, 2] : handle === "s" ? [2, 3] : handle === "w" ? [3, 0] : null;
  if (!pair) return null;
  const [a, b] = pair;
  return { x: (corners[a].x + corners[b].x) / 2, y: (corners[a].y + corners[b].y) / 2 };
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
    frame.className = "transform-frame" + (target.skew ? " quad" : "");
    frame.dataset.axis = target.axis ?? "both";
    frame.style.left = `${target.span.x * w}px`;
    frame.style.top = `${target.span.y * h}px`;
    frame.style.width = `${target.span.w * w}px`;
    frame.style.height = `${target.span.h * h}px`;
    for (const handle of target.handles) {
      const el = document.createElement("div");
      el.className = "transform-handle";
      el.dataset.h = handle;
      // A quad target puts each handle on its own (possibly skewed) corner or
      // side midpoint; the frame div is only their bounding box, so offset by
      // its origin.
      if (target.corners) {
        const p = quadHandlePoint(handle, target.corners);
        if (p) {
          el.style.left = `${(p.x - target.span.x) * w}px`;
          el.style.top = `${(p.y - target.span.y) * h}px`;
        }
      }
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
    const corner = handle && target.corners ? cornerIndexOf(handle) : -1;
    const edge = handle && target.corners ? edgeOf(handle) : null;
    const origin = { ...target.span };
    this.drag = {
      mode: corner >= 0 ? "corner" : edge ? "edge" : handle ? "resize" : "move",
      handle,
      corner: corner >= 0 ? (corner as CornerIndex) : undefined,
      edge: edge ?? undefined,
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
    if (!drag.moved) {
      const px = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (px < (e.pointerType === "touch" ? TOUCH_THRESHOLD_PX : DRAG_THRESHOLD_PX)) return;
      drag.moved = true;
    }
    // A quad corner follows the pointer directly (page-normalized), rather than
    // applying a delta to an edge. Bounds/clamping live in the app's handler.
    if (drag.corner !== undefined) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const point = { x: (e.clientX - rect.left) / w, y: (e.clientY - rect.top) / h };
      drag.point = point;
      this.options.onCornerPreview?.(drag.corner, point);
      this.repaint();
      return;
    }
    let dx = (e.clientX - drag.startX) / w;
    let dy = (e.clientY - drag.startY) / h;
    // A quad side moves as a whole; report the raw delta straight to the app.
    if (drag.edge) {
      drag.delta = { dx, dy };
      this.options.onEdgePreview?.(drag.edge, dx, dy);
      this.repaint();
      return;
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
    if (!drag.moved) {
      this.options.onClick();
    } else if (drag.corner !== undefined && drag.point) {
      this.options.onCornerCommit?.(drag.corner, drag.point);
    } else if (drag.edge && drag.delta) {
      this.options.onEdgeCommit?.(drag.edge, drag.delta.dx, drag.delta.dy);
    } else {
      this.options.onCommit(drag.last, drag.origin);
    }
  }

  // A touch that turns into a scroll never reaches pointerup, so the drag is
  // abandoned and the pre-drag span restored (Escape's path). Without this,
  // `drag` would stay set and the early return in pointerDown would make the
  // frame permanently un-draggable — the whole app's own worst mobile bug.
  private pointerCancel(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (drag.corner !== undefined || drag.edge) this.options.onQuadCancel?.();
    else this.options.onCancel(drag.origin);
    this.repaint();
  }

  private keyDown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    // Don't swallow Escape from inside a text field (label/note editors).
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (this.drag) {
      e.preventDefault();
      const drag = this.drag;
      this.drag = null;
      if (drag.corner !== undefined || drag.edge) this.options.onQuadCancel?.();
      else this.options.onCancel(drag.origin);
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
