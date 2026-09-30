import type { Mark, Span } from "../store/schema";
import type { PageImage } from "../adapters/types";

export interface PlayerItem {
  id: string;
  label: string;
  span: Span | null;
  // Crop rectangle for the card's question side. Defaults to the span when a
  // caller does not supply a derived crop (questions, frame-scoped cards).
  crop?: Span | null;
}

export interface PlayerSource {
  loadPage(page: number, scale: number): Promise<PageImage | null>;
  marksFor(boxId: string): Mark[];
}

export interface PlayerHandlers {
  onClose(): void;
}

const RENDER_SCALE = 2;

export class Player {
  private readonly root: HTMLElement;
  private readonly source: PlayerSource;
  private readonly handlers: PlayerHandlers;
  private items: PlayerItem[] = [];
  private index = 0;
  private revealed = false;
  private open = false;
  private renderToken = 0;
  // The cropped page image without marks. Every paint starts from this so
  // hiding an occlusion truly erases it instead of drawing over the last frame.
  private baseCanvas: HTMLCanvasElement | null = null;
  private readonly onKey: (e: KeyboardEvent) => void;

  constructor(root: HTMLElement, source: PlayerSource, handlers: PlayerHandlers) {
    this.root = root;
    this.root.className = "player-root hidden";
    this.source = source;
    this.handlers = handlers;
    this.onKey = (e) => this.key(e);
    window.addEventListener("keydown", this.onKey);
  }

  isOpen(): boolean {
    return this.open;
  }

  start(items: PlayerItem[]): void {
    if (!items.length) return;
    this.items = items;
    this.index = 0;
    this.revealed = false;
    this.baseCanvas = null;
    this.open = true;
    this.root.classList.remove("hidden");
    this.build();
    void this.paint();
  }

  close(): void {
    this.open = false;
    this.root.classList.add("hidden");
    this.root.innerHTML = "";
    this.handlers.onClose();
  }

  private build(): void {
    this.root.innerHTML = "";

    const backdrop = document.createElement("div");
    backdrop.className = "player-backdrop";
    backdrop.addEventListener("click", () => this.close());

    const box = document.createElement("div");
    box.className = "player";
    box.addEventListener("click", (e) => e.stopPropagation());

    const head = document.createElement("div");
    head.className = "player-head";
    const title = document.createElement("span");
    title.className = "player-title";
    title.id = "player-title";
    const close = document.createElement("button");
    close.className = "tb-btn player-close";
    close.textContent = "×";
    close.title = "close (Esc)";
    close.addEventListener("click", () => this.close());
    head.append(title, close);

    const stage = document.createElement("div");
    stage.className = "player-stage";
    const canvas = document.createElement("canvas");
    canvas.className = "player-canvas";
    canvas.id = "player-canvas";
    stage.appendChild(canvas);

    const foot = document.createElement("div");
    foot.className = "player-foot";
    const prev = document.createElement("button");
    prev.className = "tb-btn player-nav";
    prev.textContent = "‹ prev";
    prev.title = "previous (←)";
    prev.addEventListener("click", () => this.step(-1));

    const reveal = document.createElement("button");
    reveal.className = "tb-btn player-reveal";
    reveal.id = "player-reveal";
    reveal.textContent = "show answer";
    reveal.title = "show/hide answer (space)";
    reveal.addEventListener("click", () => this.toggleReveal());

    const next = document.createElement("button");
    next.className = "tb-btn player-nav";
    next.textContent = "next ›";
    next.title = "next (→)";
    next.addEventListener("click", () => this.step(1));

    foot.append(prev, reveal, next);

    box.append(head, stage, foot);
    this.root.append(backdrop, box);
  }

  private step(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next >= this.items.length) return;
    this.index = next;
    // Navigating always hides the answer again, so each question starts covered.
    this.revealed = false;
    void this.paint();
  }

  private toggleReveal(): void {
    this.revealed = !this.revealed;
    this.paintOverlayOnly();
  }

  private key(e: KeyboardEvent): void {
    if (!this.open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      this.step(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      this.step(1);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      this.toggleReveal();
    }
  }

  private current(): PlayerItem | undefined {
    return this.items[this.index];
  }

  private syncRevealButton(): void {
    const reveal = this.root.querySelector<HTMLElement>("#player-reveal");
    if (reveal) {
      reveal.classList.toggle("on", this.revealed);
      reveal.textContent = this.revealed ? "hide answer" : "show answer";
    }
  }

  private paintOverlayOnly(): void {
    this.syncRevealButton();
    this.drawMarks();
  }

  private async paint(): Promise<void> {
    const item = this.current();
    const canvas = this.root.querySelector<HTMLCanvasElement>("#player-canvas");
    const title = this.root.querySelector<HTMLElement>("#player-title");
    if (!canvas) return;
    if (title) title.textContent = `${item?.label || "question"} · ${this.index + 1}/${this.items.length}`;
    // Update the control now; marks are drawn after the fresh crop lands so we
    // never paint the new question's marks over the previous question's image.
    this.syncRevealButton();
    if (!item) {
      return;
    }
    if (!item.span) {
      canvas.width = 1;
      canvas.height = 1;
      return;
    }

    const token = ++this.renderToken;
    const span = item.crop ?? item.span;
    this.baseCanvas = null;
    const image = await this.source.loadPage(span.page, RENDER_SCALE);
    if (token !== this.renderToken || !this.open) return;
    if (!image) {
      canvas.width = 1;
      canvas.height = 1;
      return;
    }

    const sx = Math.round(span.x * image.width);
    const sy = Math.round(span.y * image.height);
    const sw = Math.max(1, Math.round(span.w * image.width));
    const sh = Math.max(1, Math.round(span.h * image.height));

    const full = document.createElement("canvas");
    full.width = image.width;
    full.height = image.height;
    full.getContext("2d")?.putImageData(image.image, 0, 0);

    const base = document.createElement("canvas");
    base.width = sw;
    base.height = sh;
    base.getContext("2d")?.drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
    this.baseCanvas = base;

    canvas.width = sw;
    canvas.height = sh;
    this.drawMarks();
  }

  private drawMarks(): void {
    const item = this.current();
    const canvas = this.root.querySelector<HTMLCanvasElement>("#player-canvas");
    const base = this.baseCanvas;
    if (!item || !item.span || !canvas || !base) return;
    const span = item.crop ?? item.span;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Start from the clean crop so toggling reveal can erase occlusions.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);

    // In play mode the player drives reveal, ignoring per-mark revealed state.
    const marks = this.source.marksFor(item.id).filter((m) => m.spans[0]?.page === span.page);
    for (const m of marks) {
      const s = m.spans[0];
      if (!s) continue;
      const mx = ((s.x - span.x) / span.w) * canvas.width;
      const my = ((s.y - span.y) / span.h) * canvas.height;
      const mw = (s.w / span.w) * canvas.width;
      const mh = (s.h / span.h) * canvas.height;
      if (m.tags.includes("highlight")) {
        ctx.fillStyle = "rgba(245, 197, 24, 0.3)";
        ctx.fillRect(mx, my, mw, mh);
      } else {
        // Occlusions cover the answer and clear once revealed.
        if (this.revealed) continue;
        ctx.fillStyle = m.color || "#1f2430";
        ctx.fillRect(mx, my, mw, mh);
      }
    }
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKey);
    this.root.innerHTML = "";
  }
}
