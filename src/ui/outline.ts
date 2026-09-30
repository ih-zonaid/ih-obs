import { buildOutlineTree, TAGS, type Entity, type OutlineNode } from "../store/schema";
import type { DrawTool } from "./segmentDraw";
import { icon, type IconName } from "./icons";

type BoxTag = "frame" | "concept" | "questions" | "question" | "other";

// One glyph per outline control so the header stays compact; the tooltip carries
// the full name.
const OUTLINE_ICONS: Record<string, IconName> = {
  expand: "chevron-up-down",
  collapse: "chevrons-in",
  concept: "tag",
  questions: "list",
  question: "circle-question",
  frame: "crop",
  marker: "anchor-line",
  split: "scissors",
  apply: "check",
  cancel: "x",
  play: "play",
  auto: "sparkles",
  clear: "trash"
};

export interface OutlineHandlers {
  onSelect(id: string, kind: "box" | "mark"): void;
  onLabel(id: string, label: string): void;
  onDelete(id: string): void;
  onTool(tool: DrawTool | null): void;
  onAutoSegment(): void;
  onSplitApply(): void;
  onSplitCancel(): void;
  onPlay(id: string): void;
  onClear(): void;
  // Opens (or creates) the note for an entry from its row badge.
  onNote?(id: string, kind: "box" | "mark", x: number, y: number): void;
  hasNote?(id: string): boolean;
}

const TOOLS: DrawTool[] = ["concept", "questions", "question", "frame", "marker", "split"];

export class Outline {
  private readonly root: HTMLElement;
  private readonly handlers: OutlineHandlers;
  private active: string | null = null;
  private editingId: string | null = null;
  private tool: DrawTool | null = null;
  private entities: Entity[] = [];
  private readonly collapsed = new Set<string>();
  private readonly rows = new Map<string, HTMLElement>();
  private counts = new Map<string, number>();
  private showCounts = false;

  constructor(root: HTMLElement, handlers: OutlineHandlers) {
    this.root = root;
    this.root.className = "outline";
    this.handlers = handlers;
  }

  // Inspect mode overlays a per-entry mark count so under-attached entries stand
  // out (a question showing 0 while it has occlusions means a bad owner).
  setInspect(show: boolean, counts: Map<string, number>): void {
    this.showCounts = show;
    this.counts = counts;
  }

  render(entities: Entity[]): void {
    this.entities = entities;
    this.rows.clear();
    this.root.innerHTML = "";
    const tree = buildOutlineTree(this.entities);
    this.root.appendChild(this.head(this.countNodes(tree)));
    this.root.appendChild(this.list(tree));
  }

  private countNodes(nodes: OutlineNode[]): number {
    let n = 0;
    for (const node of nodes) n += 1 + this.countNodes(node.children);
    return n;
  }

  private head(count: number): HTMLElement {
    const head = document.createElement("div");
    head.className = "outline-head";

    const row = document.createElement("div");
    row.className = "outline-titlerow";
    const title = document.createElement("div");
    title.className = "outline-title";
    title.textContent = `Outline · ${count}`;
    row.appendChild(title);
    const expand = this.btn("expand", "expand all", () => {
      this.collapsed.clear();
      this.render(this.entities);
    });
    const collapse = this.btn("collapse", "collapse all", () => {
      for (const id of this.rows.keys()) this.collapsed.add(id);
      this.render(this.entities);
    });
    const fold = document.createElement("div");
    fold.className = "outline-actions outline-fold";
    fold.append(expand, collapse);
    row.appendChild(fold);
    head.appendChild(row);

    const tools = document.createElement("div");
    tools.className = "outline-actions";
    for (const tool of TOOLS) {
      const title =
        tool === "marker"
          ? "place an anchor line"
          : tool === "split"
            ? "split the selected questions container"
            : tool === "frame"
              ? "draw a frame (crop mask)"
              : `draw ${tool}`;
      const b = this.btn(tool, title, () => this.toggleTool(tool));
      b.dataset.tool = tool;
      b.classList.toggle("active", this.tool === tool);
      tools.appendChild(b);
    }
    head.appendChild(tools);

    if (this.tool === "split") {
      const bar = document.createElement("div");
      bar.className = "outline-splitbar";
      const note = document.createElement("span");
      note.className = "outline-splitnote";
      note.textContent = "click boundaries on the page";
      bar.append(
        note,
        this.btn("apply", "turn cuts into question boxes", () => this.handlers.onSplitApply()),
        this.btn("cancel", "leave split mode", () => this.handlers.onSplitCancel())
      );
      head.appendChild(bar);
    }

    const actions = document.createElement("div");
    actions.className = "outline-actions";
    actions.append(
      this.btn("play", "play questions one at a time", () =>
        this.handlers.onPlay(this.active ?? "")
      ),
      this.btn("auto", "auto-segment the selected questions container", () =>
        this.handlers.onAutoSegment()
      ),
      this.btn("clear", "clear all boxes and anchors", () => this.handlers.onClear())
    );
    head.appendChild(actions);
    return head;
  }

  private list(tree: OutlineNode[]): HTMLElement {
    if (!tree.length) {
      const hint = document.createElement("div");
      hint.className = "outline-hint";
      hint.textContent = "Nothing yet. Pick a tool above, then draw a box or place an anchor line.";
      return hint;
    }
    const list = document.createElement("div");
    list.className = "outline-list";
    for (const node of tree) this.appendNode(list, node);
    return list;
  }

  private appendNode(parent: HTMLElement, node: OutlineNode): void {
    parent.appendChild(this.row(node));
    if (this.collapsed.has(node.id)) return;
    for (const child of node.children) this.appendNode(parent, child);
  }

  private row(node: OutlineNode): HTMLElement {
    const isMarker = node.tags.includes(TAGS.anchor);
    const role = node.tags.find((t): t is BoxTag =>
      t === "frame" || t === "concept" || t === "questions" || t === "question" || t === "other"
    );

    const row = document.createElement("div");
    row.className = "outline-row";
    row.classList.toggle("active", node.id === this.active);
    row.dataset.id = node.id;
    row.dataset.kind = "box";
    if (isMarker) row.classList.add("marker");
    if (role) row.dataset.role = role;

    const gutter = document.createElement("div");
    gutter.className = "outline-gutter";
    // One guide column per depth level, drawn with repeating borders.
    for (let i = 0; i < node.depth; i++) {
      const guide = document.createElement("span");
      guide.className = "outline-guide";
      gutter.appendChild(guide);
    }
    const chevron = document.createElement("span");
    chevron.className = "outline-chevron";
    if (node.children.length) {
      chevron.textContent = this.collapsed.has(node.id) ? "▸" : "▾";
      chevron.title = this.collapsed.has(node.id) ? "expand" : "collapse";
      chevron.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.toggleCollapse(node.id);
      });
    } else {
      chevron.classList.add("empty");
      chevron.textContent = node.depth === 0 ? "" : "•";
    }
    gutter.appendChild(chevron);
    row.appendChild(gutter);

    const mark = document.createElement("span");
    mark.className = "outline-mark";
    if (isMarker) mark.textContent = "▸";
    else if (node.level > 0) mark.textContent = "#".repeat(node.level);
    else mark.textContent = "¶";
    row.appendChild(mark);

    if (this.editingId === node.id) {
      row.appendChild(this.editField(node));
      this.rows.set(node.id, row);
      return row;
    }

    const name = document.createElement("span");
    name.className = "outline-name";
    const text = node.text.trim();
    name.textContent = text || (isMarker ? "anchor" : "untitled");
    name.classList.toggle("untitled", !text);
    name.title = "click to select · double-click to edit";
    name.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      this.beginEdit(node.id);
    });
    row.appendChild(name);

    if (this.showCounts && !isMarker) {
      const n = this.counts.get(node.id) ?? 0;
      const badge = document.createElement("span");
      badge.className = "outline-count" + (n === 0 ? " none" : "");
      badge.textContent = `●${n}`;
      badge.title = `${n} mark(s) resolved to this box`;
      row.appendChild(badge);
    }

    if (this.handlers.hasNote?.(node.id)) {
      const note = document.createElement("span");
      note.className = "outline-note-badge";
      note.appendChild(icon("pencil", 11));
      note.title = "edit note";
      note.setAttribute("role", "button");
      note.setAttribute("aria-label", "edit note");
      note.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        this.handlers.onNote?.(node.id, "box", rect.left, rect.bottom + 4);
      });
      row.appendChild(note);
    }

    const page = document.createElement("span");
    page.className = "outline-page";
    page.textContent = `p${node.page + 1}`;
    row.appendChild(page);

    const del = document.createElement("span");
    del.className = "outline-del";
    del.appendChild(icon("trash", 12));
    del.title = isMarker ? "delete anchor" : "delete box";
    del.setAttribute("role", "button");
    del.setAttribute("aria-label", del.title);
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.handlers.onDelete(node.id);
    });
    row.appendChild(del);

    if (role === "questions" || role === "question" || role === "frame") {
      const play = document.createElement("span");
      play.className = "outline-play";
      play.appendChild(icon("play", 11));
      play.title =
        role === "questions"
          ? "play questions inside"
          : role === "frame"
            ? "play cards in this frame"
            : "play this question";
      play.setAttribute("role", "button");
      play.setAttribute("aria-label", play.title);
      play.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.handlers.onPlay(node.id);
      });
      row.insertBefore(play, del);
    }

    row.addEventListener("click", () => this.handlers.onSelect(node.id, "box"));
    this.rows.set(node.id, row);
    return row;
  }

  private toggleCollapse(id: string): void {
    if (this.collapsed.has(id)) this.collapsed.delete(id);
    else this.collapsed.add(id);
    const scroll = this.root.scrollTop;
    this.render(this.entities);
    this.root.scrollTop = scroll;
  }

  // The selected row turns into an input in place, so editing is where you look.
  private editField(node: OutlineNode): HTMLElement {
    const input = document.createElement("input");
    input.className = "outline-edit";
    input.value = node.label;
    input.placeholder = node.tags.includes(TAGS.anchor) ? "anchor label…" : "label… use ## for headings";
    input.spellcheck = false;

    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      this.editingId = null;
      if (save && input.value !== node.label) this.handlers.onLabel(node.id, input.value);
      else this.render(this.entities);
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => window.setTimeout(() => finish(true), 0));
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("dblclick", (ev) => ev.stopPropagation());

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return input;
  }

  private beginEdit(id: string): void {
    this.editingId = id;
    this.active = id;
    this.render(this.entities);
  }

  // Called by the app right after creating an entry so the label can be typed at once.
  beginEditActive(): void {
    if (this.active) this.beginEdit(this.active);
  }

  private toggleTool(tool: DrawTool): void {
    this.handlers.onTool(this.tool === tool ? null : tool);
  }

  setTool(tool: DrawTool | null): void {
    this.tool = tool;
    this.syncTools();
  }

  currentTool(): DrawTool | null {
    return this.tool;
  }

  private syncTools(): void {
    this.root.querySelectorAll<HTMLElement>(".outline-btn[data-tool]").forEach((el) => {
      el.classList.toggle("active", el.dataset.tool === this.tool);
    });
  }

  private btn(kind: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "tb-btn outline-btn";
    b.dataset.action = kind;
    const name = OUTLINE_ICONS[kind];
    if (name) b.appendChild(icon(name, 13));
    else b.textContent = kind;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", onClick);
    return b;
  }

  // Selection only toggles classes; it never rebuilds rows, so the click that
  // selected a row is not destroyed mid-gesture (which broke double-click).
  setActive(id: string | null): void {
    if (id !== this.active) this.editingId = null;
    this.active = id;
    for (const [rowId, el] of this.rows) {
      el.classList.toggle("active", rowId === id);
    }
  }
}
