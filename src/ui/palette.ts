import { flattenFiles, type FsNode } from "../vault/types";
import { scrollIntoContainer } from "./scroll";

export interface PaletteHandlers {
  onOpen(path: string): void;
}

interface Candidate {
  path: string;
  name: string;
  lower: string;
  score: number;
  indices: number[];
}

const MAX_RESULTS = 40;

function fuzzy(query: string, target: string): { score: number; indices: number[] } | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const indices: number[] = [];
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    const gap = found - ti;
    if (gap === 0) {
      streak += 1;
      score += 6 + streak;
    } else {
      streak = 0;
      score += 1;
    }
    if (found === 0 || t[found - 1] === "/" || t[found - 1] === "_" || t[found - 1] === "-") {
      score += 4;
    }
    indices.push(found);
    ti = found + 1;
  }
  score -= t.length * 0.05;
  return { score, indices };
}

export class Palette {
  private readonly root: HTMLElement;
  private readonly handlers: PaletteHandlers;
  private files: Candidate[] = [];
  private results: Candidate[] = [];
  private selected = 0;
  private open = false;
  private readonly onKey: (e: KeyboardEvent) => void;

  constructor(root: HTMLElement, handlers: PaletteHandlers) {
    this.root = root;
    this.handlers = handlers;
    this.onKey = (e) => this.key(e);
    window.addEventListener("keydown", this.onKey);
  }

  setTree(tree: FsNode): void {
    this.files = flattenFiles(tree).map((f) => ({
      path: f.path,
      name: f.name,
      lower: f.path.toLowerCase(),
      score: 0,
      indices: []
    }));
  }

  isOpen(): boolean {
    return this.open;
  }

  show(): void {
    this.open = true;
    this.root.classList.remove("hidden");
    this.root.innerHTML = "";

    const backdrop = document.createElement("div");
    backdrop.className = "palette-backdrop";
    backdrop.addEventListener("click", () => this.hide());

    const box = document.createElement("div");
    box.className = "palette";

    const input = document.createElement("input");
    input.className = "palette-input";
    input.placeholder = "go to file…";
    input.addEventListener("input", () => this.query(input.value));
    input.addEventListener("keydown", (e) => this.nav(e));

    const list = document.createElement("div");
    list.className = "palette-list";
    list.id = "palette-list";

    box.append(input, list);
    this.root.append(backdrop, box);

    this.query("");
    input.focus();
  }

  hide(): void {
    this.open = false;
    this.root.classList.add("hidden");
    this.root.innerHTML = "";
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  private query(text: string): void {
    const q = text.trim();
    const scored: Candidate[] = [];
    for (const f of this.files) {
      const m = fuzzy(q, f.path);
      if (!m) continue;
      scored.push({ ...f, score: m.score, indices: m.indices });
    }
    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
    this.results = scored.slice(0, MAX_RESULTS);
    this.selected = 0;
    this.paint();
  }

  private nav(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selected = Math.min(this.selected + 1, this.results.length - 1);
      this.paint();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selected = Math.max(this.selected - 1, 0);
      this.paint();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = this.results[this.selected];
      if (pick) {
        this.hide();
        this.handlers.onOpen(pick.path);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.hide();
    }
  }

  private paint(): void {
    const list = this.root.querySelector("#palette-list");
    if (!list) return;
    list.innerHTML = "";
    if (!this.results.length) {
      const empty = document.createElement("div");
      empty.className = "palette-empty";
      empty.textContent = this.files.length ? "no matches" : "no vault open";
      list.appendChild(empty);
      return;
    }
    this.results.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "palette-row" + (i === this.selected ? " selected" : "");
      row.appendChild(this.label(r));
      const dir = r.path.slice(0, r.path.length - r.name.length).replace(/\/$/, "");
      if (dir) {
        const sub = document.createElement("span");
        sub.className = "palette-dir";
        sub.textContent = dir;
        row.appendChild(sub);
      }
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.hide();
        this.handlers.onOpen(r.path);
      });
      list.appendChild(row);
    });
    const sel = list.querySelector<HTMLElement>(".selected");
    // Scroll the list itself, not Element.scrollIntoView, so the document
    // element behind the overlay is never scrolled (see scroll.ts).
    if (sel) scrollIntoContainer(list as HTMLElement, sel, "nearest");
  }

  private label(r: Candidate): HTMLElement {
    const span = document.createElement("span");
    span.className = "palette-name";
    const mark = new Set(r.indices);
    for (let i = 0; i < r.path.length; i++) {
      const ch = r.path[i];
      if (i < r.path.length - r.name.length) continue;
      const node = document.createElement(mark.has(i) ? "b" : "span");
      node.textContent = ch;
      span.appendChild(node);
    }
    return span;
  }

  private key(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
      e.preventDefault();
      this.toggle();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      this.show();
    }
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKey);
    this.hide();
  }
}
