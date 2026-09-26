import type { Segment } from "../store/schema";

export interface OutlineHandlers {
  onSelect(id: string): void;
  onRename(id: string, title: string): void;
  onDelete(id: string): void;
  onDetect(): void;
  onClear(): void;
}

export class Outline {
  private readonly root: HTMLElement;
  private readonly handlers: OutlineHandlers;
  private active: string | null = null;

  constructor(root: HTMLElement, handlers: OutlineHandlers) {
    this.root = root;
    this.root.className = "outline";
    this.handlers = handlers;
  }

  render(segments: Segment[]): void {
    this.root.innerHTML = "";

    const head = document.createElement("div");
    head.className = "outline-head";
    const label = document.createElement("span");
    label.className = "outline-title";
    label.textContent = `Outline · ${segments.length}`;
    head.appendChild(label);

    const actions = document.createElement("div");
    actions.className = "outline-actions";
    actions.append(
      this.btn("segment", "run auto-segment", () => this.handlers.onDetect()),
      this.btn("clear", "clear segments", () => this.handlers.onClear())
    );
    head.appendChild(actions);
    this.root.appendChild(head);

    if (!segments.length) {
      const hint = document.createElement("div");
      hint.className = "outline-hint";
      hint.textContent = "No segments. Run auto-segment to detect questions.";
      this.root.appendChild(hint);
      return;
    }

    const list = document.createElement("div");
    list.className = "outline-list";
    for (const seg of segments) {
      list.appendChild(this.row(seg));
    }
    this.root.appendChild(list);
  }

  private row(seg: Segment): HTMLElement {
    const row = document.createElement("div");
    row.className = "outline-row" + (seg.id === this.active ? " active" : "");
    row.dataset.id = seg.id;

    const n = document.createElement("span");
    n.className = "outline-n";
    n.textContent = String(seg.order + 1);
    row.appendChild(n);

    const title = document.createElement("span");
    title.className = "outline-name";
    title.textContent = seg.title;
    title.title = "double-click to rename";
    title.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const next = window.prompt("Segment title", seg.title);
      if (next) this.handlers.onRename(seg.id, next);
    });
    row.appendChild(title);

    const page = document.createElement("span");
    page.className = "outline-page";
    page.textContent = `p${(seg.spans[0]?.page ?? 0) + 1}`;
    row.appendChild(page);

    const del = document.createElement("span");
    del.className = "outline-del";
    del.textContent = "×";
    del.title = "delete segment";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.handlers.onDelete(seg.id);
    });
    row.appendChild(del);

    row.addEventListener("click", () => this.handlers.onSelect(seg.id));
    return row;
  }

  private btn(kind: string, title: string, onClick: () => void): HTMLElement {
    const b = document.createElement("button");
    b.className = "tb-btn outline-btn";
    b.dataset.action = kind;
    b.textContent = kind;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  setActive(id: string | null): void {
    this.active = id;
    this.root.querySelectorAll(".outline-row").forEach((el) => {
      el.classList.toggle("active", (el as HTMLElement).dataset.id === id);
    });
  }
}
