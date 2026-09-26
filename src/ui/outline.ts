import { buildOutlineTree, type Marker, type OutlineNode, type Segment } from "../store/schema";
import type { DrawTool } from "./segmentDraw";

export interface OutlineHandlers {
  onSelect(id: string, kind: "segment" | "marker"): void;
  onLabel(id: string, kind: "segment" | "marker", label: string): void;
  onDelete(id: string, kind: "segment" | "marker"): void;
  onTool(tool: DrawTool | null): void;
  onAutoSegment(): void;
  onSplitApply(): void;
  onSplitCancel(): void;
  onClear(): void;
}

const TOOLS: DrawTool[] = ["concept", "questions", "question", "marker", "split"];

export class Outline {
  private readonly root: HTMLElement;
  private readonly handlers: OutlineHandlers;
  private active: string | null = null;
  private editingId: string | null = null;
  private tool: DrawTool | null = null;
  private segments: Segment[] = [];
  private markers: Marker[] = [];
  private collapsed = new Set<string>();
  private readonly rows = new Map<string, HTMLElement>();

  constructor(root: HTMLElement, handlers: OutlineHandlers) {
    this.root = root;
    this.root.className = "outline";
    this.handlers = handlers;
  }

  render(segments: Segment[], markers: Marker[]): void {
    this.segments = segments;
    this.markers = markers;
    this.rows.clear();
    this.root.innerHTML = "";
    const tree = buildOutlineTree(this.segments, this.markers);
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
      this.render(this.segments, this.markers);
    });
    const collapse = this.btn("collapse", "collapse all", () => {
      for (const id of this.rows.keys()) this.collapsed.add(id);
      this.render(this.segments, this.markers);
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
          ? "place a marker line"
          : tool === "split"
            ? "split the selected questions container"
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
        this.btn("apply", "turn cuts into question segments", () => this.handlers.onSplitApply()),
        this.btn("cancel", "leave split mode", () => this.handlers.onSplitCancel())
      );
      head.appendChild(bar);
    }

    const actions = document.createElement("div");
    actions.className = "outline-actions";
    actions.append(
      this.btn("auto", "auto-segment the selected questions container", () =>
        this.handlers.onAutoSegment()
      ),
      this.btn("clear", "clear all segments and markers", () => this.handlers.onClear())
    );
    head.appendChild(actions);
    return head;
  }

  private list(tree: OutlineNode[]): HTMLElement {
    if (!tree.length) {
      const hint = document.createElement("div");
      hint.className = "outline-hint";
      hint.textContent = "Nothing yet. Pick a tool above, then draw a box or place a marker line.";
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
    const row = document.createElement("div");
    row.className = "outline-row";
    row.classList.toggle("active", node.id === this.active);
    row.dataset.id = node.id;
    row.dataset.kind = node.kind;
    if (node.kind === "marker") row.classList.add("marker");
    if (node.role) row.dataset.role = node.role;

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
    if (node.kind === "marker") mark.textContent = "▸";
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
    name.textContent = text || (node.kind === "marker" ? "marker" : "untitled");
    name.classList.toggle("untitled", !text);
    name.title = "click to select · double-click to edit";
    name.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      this.beginEdit(node.id);
    });
    row.appendChild(name);

    const page = document.createElement("span");
    page.className = "outline-page";
    page.textContent = `p${node.page + 1}`;
    row.appendChild(page);

    const del = document.createElement("span");
    del.className = "outline-del";
    del.textContent = "×";
    del.title = node.kind === "marker" ? "delete marker" : "delete segment";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.handlers.onDelete(node.id, node.kind);
    });
    row.appendChild(del);

    row.addEventListener("click", () => this.handlers.onSelect(node.id, node.kind));
    this.rows.set(node.id, row);
    return row;
  }

  private toggleCollapse(id: string): void {
    if (this.collapsed.has(id)) this.collapsed.delete(id);
    else this.collapsed.add(id);
    const scroll = this.root.scrollTop;
    this.render(this.segments, this.markers);
    this.root.scrollTop = scroll;
  }

  // The selected row turns into an input in place, so editing is where you look.
  private editField(node: OutlineNode): HTMLElement {
    const input = document.createElement("input");
    input.className = "outline-edit";
    input.value = node.label;
    input.placeholder = node.kind === "marker" ? "marker label…" : "label… use ## for headings";
    input.spellcheck = false;

    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      this.editingId = null;
      if (save && input.value !== node.label) this.handlers.onLabel(node.id, node.kind, input.value);
      else this.render(this.segments, this.markers);
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
    this.render(this.segments, this.markers);
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
    b.textContent = kind;
    b.title = title;
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
