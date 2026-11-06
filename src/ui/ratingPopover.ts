import type { ReviewGrade } from "../srs";

export interface RatingPopoverAnchor {
  // Horizontal center of the mark.
  x: number;
  // Mark top and bottom, so the card can prefer sitting above it and flip below
  // when there is no room.
  top: number;
  bottom: number;
}

export interface RatingPopoverOptions {
  anchor: RatingPopoverAnchor;
  previews: Record<ReviewGrade, string>;
  onGrade(grade: ReviewGrade): void;
}

const GRADES: { grade: ReviewGrade; label: string }[] = [
  { grade: "again", label: "Again" },
  { grade: "hard", label: "Hard" },
  { grade: "good", label: "Good" },
  { grade: "easy", label: "Easy" }
];

// A compact rating card anchored to a mark, so a card can be graded without
// opening the player. Same grade order and interval hints as the player's row.
class RatingPopover {
  private el: HTMLElement | null = null;
  private onGrade: ((grade: ReviewGrade) => void) | null = null;

  private readonly onDocPointerDown = (e: PointerEvent): void => {
    if (this.el && !this.el.contains(e.target as Node)) this.hide();
  };

  // Digits grade, mirroring the player; Escape dismisses. Both are consumed so
  // the app's global shortcuts cannot fire underneath the open card.
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      this.hide();
      return;
    }
    const index = ["1", "2", "3", "4"].indexOf(e.key);
    if (index < 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.pick(GRADES[index].grade);
  };

  // The anchor is a page position, so scrolling would leave the card behind.
  private readonly onScroll = (): void => this.hide();

  open(opts: RatingPopoverOptions): void {
    this.hide();
    const el = document.createElement("div");
    el.className = "rating-pop";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "rate card");
    this.onGrade = opts.onGrade;

    for (const { grade, label } of GRADES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `rating-pop-btn grade-${grade}`;
      const name = document.createElement("span");
      name.className = "rating-pop-label";
      name.textContent = label;
      const interval = document.createElement("span");
      interval.className = "rating-pop-interval";
      interval.textContent = opts.previews[grade];
      b.append(name, interval);
      b.addEventListener("click", () => this.pick(grade));
      el.appendChild(b);
    }

    document.body.appendChild(el);
    this.el = el;
    this.place(el, opts.anchor);

    window.addEventListener("pointerdown", this.onDocPointerDown, true);
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("scroll", this.onScroll, true);
    window.addEventListener("resize", this.onScroll);
  }

  private pick(grade: ReviewGrade): void {
    const onGrade = this.onGrade;
    this.hide();
    onGrade?.(grade);
  }

  // Prefer above the mark, centered on it; flip below when the top would clip,
  // and clamp horizontally like the note popovers do.
  private place(el: HTMLElement, anchor: RatingPopoverAnchor): void {
    const rect = el.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(anchor.x - rect.width / 2, window.innerWidth - rect.width - 8)
    );
    let top = anchor.top - rect.height - 8;
    if (top < 8) top = Math.min(anchor.bottom + 8, window.innerHeight - rect.height - 8);
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(8, top)}px`;
  }

  hide(): void {
    if (!this.el) return;
    window.removeEventListener("pointerdown", this.onDocPointerDown, true);
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("scroll", this.onScroll, true);
    window.removeEventListener("resize", this.onScroll);
    this.el.remove();
    this.el = null;
    this.onGrade = null;
  }
}

const popover = new RatingPopover();

export function openRatingPopover(opts: RatingPopoverOptions): void {
  popover.open(opts);
}
