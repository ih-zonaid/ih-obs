import { hexToRgba, INK_COLOR, INK_WEIGHT, isInk, type Mark, type Span } from "../store/schema";
import type { PageImage } from "../adapters/types";
import type { ReviewGrade } from "../srs";
import { icon } from "./icons";

export interface PlayerItem {
  id: string;
  label: string;
  span: Span | null;
  // Crop rectangle for the card's question side. Defaults to the span when a
  // caller does not supply a derived crop (questions, frame-scoped cards).
  crop?: Span | null;
  // The frame a card crop is clipped by. The up/down context controls expand
  // the crop within it, so revealing extra lines never leaks the other column.
  bounds?: Span | null;
}

export interface PlayerSource {
  loadPage(page: number, scale: number): Promise<PageImage | null>;
  marksFor(boxId: string): Mark[];
  // Neighbouring marks visible in a card's crop, drawn in a neutral grey behind
  // the focused card so they stay occluded without competing with the answer.
  // Card play supplies these; question play leaves it undefined.
  contextMarks?(id: string, crop: Span): Mark[];
  // What each grade would schedule for this card, already formatted for the
  // button (e.g. "3d"). Returns null when the item is not a schedulable card,
  // which hides the grade row.
  preview?(id: string): Record<ReviewGrade, string> | null;
  // Marks that reveal together with this card, dropped from the sitting when it
  // is answered so one logical answer is not asked several times in a row.
  siblingIds?(id: string): string[];
}

export interface PlayerHandlers {
  onClose(): void;
  // A grade was chosen. Queue maintenance (advancing, burying siblings) is the
  // player's job; the caller only records the review.
  onGrade?(grade: ReviewGrade, id: string): void;
}

// Hardest first, so the row reads as a scale. Colour is applied in CSS.
const GRADES: { grade: ReviewGrade; label: string }[] = [
  { grade: "again", label: "Again" },
  { grade: "hard", label: "Hard" },
  { grade: "good", label: "Good" },
  { grade: "easy", label: "Easy" }
];

const RENDER_SCALE = 2;
// How much page height one press of the context up/down button reveals, and the
// cap on each side so a card can never grow into the whole page.
const CONTEXT_STEP = 0.02;
const CONTEXT_MAX = 0.5;
// Neighbouring marks in the crop are painted this flat grey so they stay
// occluded but do not compete with the focused answer's own colour.
const CONTEXT_COLOR = "#9ca3af";

export class Player {
  private readonly root: HTMLElement;
  private readonly source: PlayerSource;
  private readonly handlers: PlayerHandlers;
  private items: PlayerItem[] = [];
  private index = 0;
  private revealed = false;
  private open = false;
  private renderToken = 0;
  // Extra context revealed above/below a card's base crop, as page-normalized
  // fractions. Reset on every navigation; expanded by the up/down controls.
  private padUp = 0;
  private padDown = 0;
  // The cropped page image without marks. Every paint starts from this so
  // hiding an occlusion truly erases it instead of drawing over the last frame.
  private baseCanvas: HTMLCanvasElement | null = null;
  // Full rasterized page for the current item, cached for the context controls.
  private fullCanvas: HTMLCanvasElement | null = null;
  private fullPage = -1;
  // CSS filter applied to the page crop at paint time (page-tone setting). Set
  // before drawing the base so the marks drawn afterwards keep their colours.
  private pageFilter = "none";
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

  // Play mode composites the page and the marks on one canvas, so the page
  // tone cannot be a CSS rule here — it is applied to the base crop at paint
  // time, leaving the marks above it at their true colours.
  setPageFilter(filter: string): void {
    this.pageFilter = filter;
    if (this.open) this.paintOverlayOnly();
  }

  start(items: PlayerItem[]): void {
    if (!items.length) return;
    this.items = items;
    this.index = 0;
    this.revealed = false;
    this.resetContext();
    this.baseCanvas = null;
    this.open = true;
    this.root.classList.remove("hidden");
    this.build();
    void this.paint();
  }

  close(): void {
    this.open = false;
    this.baseCanvas = null;
    this.fullCanvas = null;
    this.fullPage = -1;
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
    close.appendChild(icon("x", 16));
    close.title = "close (Esc)";
    close.setAttribute("aria-label", "close");
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
    prev.appendChild(icon("chevron-left", 16));
    prev.title = "previous (←)";
    prev.setAttribute("aria-label", "previous");
    prev.addEventListener("click", () => this.step(-1));

    const up = document.createElement("button");
    up.className = "tb-btn player-context";
    up.id = "player-context-up";
    up.title = "reveal line above (↑)";
    up.setAttribute("aria-label", "reveal context above");
    up.appendChild(icon("arrow-up", 15));
    up.addEventListener("click", () => this.growContext("up"));

    const reveal = document.createElement("button");
    reveal.className = "tb-btn player-reveal";
    reveal.id = "player-reveal";
    reveal.title = "show/hide answer (space)";
    reveal.appendChild(icon("eye", 15));
    const revealLabel = document.createElement("span");
    revealLabel.id = "player-reveal-label";
    revealLabel.textContent = "show answer";
    reveal.appendChild(revealLabel);
    reveal.addEventListener("click", () => this.toggleReveal());

    const down = document.createElement("button");
    down.className = "tb-btn player-context";
    down.id = "player-context-down";
    down.title = "reveal line below (↓)";
    down.setAttribute("aria-label", "reveal context below");
    down.appendChild(icon("arrow-down", 15));
    down.addEventListener("click", () => this.growContext("down"));

    const next = document.createElement("button");
    next.className = "tb-btn player-nav";
    next.appendChild(icon("chevron-right", 16));
    next.title = "next (→)";
    next.setAttribute("aria-label", "next");
    next.addEventListener("click", () => this.step(1));

    foot.append(prev, up, reveal, down, next);

    // Grade buttons live under the nav row and only appear once the answer is
    // shown, so a question is never graded sight-unseen.
    const grades = document.createElement("div");
    grades.className = "player-grades";
    grades.id = "player-grades";

    box.append(head, stage, foot, grades);
    this.root.append(backdrop, box);
  }

  private grade(g: ReviewGrade): void {
    const item = this.current();
    if (!item) return;
    this.handlers.onGrade?.(g, item.id);

    // Siblings of the answered card leave with it: a reveal group is one logical
    // answer, so asking the rest in the same sitting is asking it again.
    const gone = new Set<string>([item.id, ...(this.source.siblingIds?.(item.id) ?? [])]);
    const remaining = this.items.filter((card) => !gone.has(card.id));

    if (remaining.length === 0) {
      this.close();
      return;
    }
    // The answered card is gone, so whatever now sits at its index is next.
    const nextIndex = Math.min(this.index, remaining.length - 1);
    this.items = remaining;
    this.index = nextIndex;
    this.revealed = false;
    this.resetContext();
    void this.paint();
  }

  private step(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next >= this.items.length) return;
    this.index = next;
    // Navigating always hides the answer again, so each question starts covered.
    this.revealed = false;
    this.resetContext();
    void this.paint();
  }

  private resetContext(): void {
    this.padUp = 0;
    this.padDown = 0;
  }

  private toggleReveal(): void {
    this.revealed = !this.revealed;
    this.paintOverlayOnly();
  }

  // Grows the crop on one side by one step, clamped by the card's frame (when it
  // has one) so context reveal can never spill into the neighbouring column.
  private growContext(side: "up" | "down"): void {
    const item = this.current();
    if (!item) return;
    const base = item.crop ?? item.span;
    if (!base) return;
    const bounds = item.bounds ?? null;
    if (side === "up") {
      const limit = bounds ? base.y - bounds.y : base.y;
      this.padUp = Math.min(CONTEXT_MAX, this.padUp + CONTEXT_STEP, Math.max(0, limit));
    } else {
      const limit = bounds ? bounds.y + bounds.h - (base.y + base.h) : 1 - (base.y + base.h);
      this.padDown = Math.min(CONTEXT_MAX, this.padDown + CONTEXT_STEP, Math.max(0, limit));
    }
    void this.paint();
  }

  // The crop actually shown: the card's base crop expanded by the context pads,
  // clipped to the page and (when the card has one) to its frame.
  private effectiveCrop(item: PlayerItem): Span | null {
    const base = item.crop ?? item.span;
    if (!base) return null;
    if (!this.padUp && !this.padDown) return base;
    const bounds = item.bounds;
    const minY = bounds ? bounds.y : 0;
    const maxY = bounds ? bounds.y + bounds.h : 1;
    const y0 = Math.max(minY, base.y - this.padUp);
    const y1 = Math.min(maxY, base.y + base.h + this.padDown);
    return { ...base, y: y0, h: y1 - y0 };
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
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.growContext("up");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      this.growContext("down");
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      this.toggleReveal();
    } else if (this.revealed && (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "4")) {
      // Digits grade once the answer is showing, matching the button order.
      const grade = (["again", "hard", "good", "easy"] as ReviewGrade[])[Number(e.key) - 1];
      e.preventDefault();
      this.grade(grade);
    }
  }

  private current(): PlayerItem | undefined {
    return this.items[this.index];
  }

  private syncRevealButton(): void {
    const reveal = this.root.querySelector<HTMLElement>("#player-reveal");
    if (reveal) {
      reveal.classList.toggle("on", this.revealed);
      // Swap the glyph and the label together; the button (and its handler)
      // persists, only its contents are rebuilt.
      reveal.textContent = "";
      reveal.appendChild(icon(this.revealed ? "eye-off" : "eye", 15));
      const label = document.createElement("span");
      label.id = "player-reveal-label";
      label.textContent = this.revealed ? "hide answer" : "show answer";
      reveal.appendChild(label);
    }
  }

  private paintOverlayOnly(): void {
    this.syncRevealButton();
    this.syncGrades();
    this.drawMarks();
  }

  // Builds the grade row for the current card, or clears it when there is
  // nothing to grade. Rebuilt each paint so previews always reflect the card
  // under the cursor and the workload the caller built the session with.
  private syncGrades(): void {
    const host = this.root.querySelector<HTMLElement>("#player-grades");
    if (!host) return;
    host.innerHTML = "";

    const item = this.current();
    // Grades appear only after reveal: grading a card you have not seen is a
    // guess, and the preview numbers would be meaningless.
    if (!item || !this.revealed) return;

    const previews = this.source.preview?.(item.id) ?? null;
    if (!previews) return;

    for (const { grade, label } of GRADES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `player-grade grade-${grade}`;
      const name = document.createElement("span");
      name.className = "player-grade-label";
      name.textContent = label;
      const span = document.createElement("span");
      span.className = "player-grade-interval";
      span.textContent = previews[grade];
      b.append(name, span);
      b.addEventListener("click", () => this.grade(grade));
      host.appendChild(b);
    }
  }

  private async paint(): Promise<void> {
    const item = this.current();
    const canvas = this.root.querySelector<HTMLCanvasElement>("#player-canvas");
    const title = this.root.querySelector<HTMLElement>("#player-title");
    if (!canvas) return;
    if (title) title.textContent = `${item?.label || "question"} · ${this.index + 1}/${this.items.length}`;
    // Update the controls now; marks are drawn after the fresh crop lands so we
    // never paint the new question's marks over the previous question's image.
    this.syncRevealButton();
    this.syncGrades();
    if (!item) {
      return;
    }
    if (!item.span) {
      canvas.width = 1;
      canvas.height = 1;
      return;
    }

    const span = this.effectiveCrop(item) ?? item.span;
    const token = ++this.renderToken;
    this.baseCanvas = null;
    const full = await this.fullPageCanvas(span.page);
    if (token !== this.renderToken || !this.open) return;
    if (!full) {
      canvas.width = 1;
      canvas.height = 1;
      return;
    }

    const sx = Math.round(span.x * full.width);
    const sy = Math.round(span.y * full.height);
    const sw = Math.max(1, Math.round(span.w * full.width));
    const sh = Math.max(1, Math.round(span.h * full.height));

    const base = document.createElement("canvas");
    base.width = sw;
    base.height = sh;
    base.getContext("2d")?.drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
    this.baseCanvas = base;

    canvas.width = sw;
    canvas.height = sh;
    this.drawMarks();
  }

  // The full rasterized page, cached so the up/down context controls only
  // re-slice instead of re-rasterizing on every press.
  private async fullPageCanvas(page: number): Promise<HTMLCanvasElement | null> {
    if (this.fullCanvas && this.fullPage === page) return this.fullCanvas;
    const image = await this.source.loadPage(page, RENDER_SCALE);
    if (!image) return null;
    const full = document.createElement("canvas");
    full.width = image.width;
    full.height = image.height;
    full.getContext("2d")?.putImageData(image.image, 0, 0);
    this.fullCanvas = full;
    this.fullPage = page;
    return full;
  }

  // Paints a mark's span into the crop's canvas space.
  private markRect(span: Span, s: Span, canvas: HTMLCanvasElement): [number, number, number, number] {
    return [
      ((s.x - span.x) / span.w) * canvas.width,
      ((s.y - span.y) / span.h) * canvas.height,
      (s.w / span.w) * canvas.width,
      (s.h / span.h) * canvas.height
    ];
  }

  private drawMarks(): void {
    const item = this.current();
    const canvas = this.root.querySelector<HTMLCanvasElement>("#player-canvas");
    const base = this.baseCanvas;
    if (!item || !item.span || !canvas || !base) return;
    const span = this.effectiveCrop(item) ?? item.span;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Start from the clean crop so toggling reveal can erase occlusions. The
    // page tone filter is scoped to this drawImage and reset before the marks,
    // so occlusions/highlights are never tinted.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.filter = this.pageFilter;
    ctx.drawImage(base, 0, 0);
    ctx.filter = "none";

    // Neighbouring marks that share the crop are drawn first, flat grey, so the
    // page reads as context without a second answer competing for attention.
    // They stay covered regardless of reveal: they are not this card's answer.
    for (const m of this.source.contextMarks?.(item.id, span) ?? []) {
      const s = m.spans[0];
      if (!s || s.page !== span.page) continue;
      const [mx, my, mw, mh] = this.markRect(span, s, canvas);
      ctx.fillStyle = CONTEXT_COLOR;
      ctx.fillRect(mx, my, mw, mh);
    }

    // In play mode the player drives reveal, ignoring per-mark revealed state.
    const marks = this.source.marksFor(item.id).filter((m) => m.spans[0]?.page === span.page);
    for (const m of marks) {
      const s = m.spans[0];
      if (!s) continue;
      const [mx, my, mw, mh] = this.markRect(span, s, canvas);
      if (isInk(m)) {
        // Ink is page-normalized; map each point through the same crop transform
        // as the bounding box, so handwriting lands where it does on the page.
        const pts = m.path ?? [];
        if (pts.length < 2) continue;
        ctx.save();
        ctx.strokeStyle = m.color ?? INK_COLOR;
        ctx.lineWidth = Math.max(1, ((m.weight ?? INK_WEIGHT) / span.w) * canvas.width);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const px = ((pts[i].x - span.x) / span.w) * canvas.width;
          const py = ((pts[i].y - span.y) / span.h) * canvas.height;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();
      } else if (m.tags.includes("highlight")) {
        ctx.fillStyle = hexToRgba(m.color ?? "#f5c518", 0.3);
        ctx.fillRect(mx, my, mw, mh);
      } else if (this.revealed) {
        // A revealed occlusion leaves a dashed skeleton rather than vanishing,
        // matching the document overlay so the answer's spot stays visible.
        const lw = 1.5;
        ctx.save();
        ctx.strokeStyle = "rgba(122, 162, 247, 0.9)";
        ctx.lineWidth = lw;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(mx + lw / 2, my + lw / 2, Math.max(1, mw - lw), Math.max(1, mh - lw));
        ctx.restore();
      } else {
        // Occlusions cover the answer and clear once revealed.
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
