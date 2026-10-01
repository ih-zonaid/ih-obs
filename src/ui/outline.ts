import { buildOutlineTree, TAGS, type Entity, type OutlineNode } from "../store/schema";
import type { DeckCounts } from "../srs";
import type { DrawTool } from "./segmentDraw";
import { icon, type IconName } from "./icons";

// Pseudo-id for the page-scoped cards that no box contains. The app owns the
// review rows; this is only the scope key the outline hands back on play.
export const UNGROUPED_DECK = "__ungrouped__";

const NO_DECK: DeckCounts = { due: 0, fresh: 0, seen: 0, total: 0 };

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
  // `scope` tells the app what the row means: a `question` box or `frame` plays
  // its own contained cards, anything else (`deck`) plays the card marks in the
  // row's subtree. The `UNGROUPED_DECK` id is the page-scoped cards no box owns.
  onPlay(id: string, scope: "deck" | "question" | "frame"): void;
  onClear(): void;
  // Recomputes deck counts for the current entities. Called whenever the review
  // state may have changed (a grade, opening a document).
  decks?(): Map<string, DeckCounts>;
  // Reveals a card mark by id (outline row hidden, so it needs an app path).
  onBrowseDeck?(id: string): void;
  // On-disk path of the document, shown beside the outline title.
  docPath?(): string;
  // Opens (or creates) the note for an entry from its row badge.
  onNote?(id: string, kind: "box" | "mark", x: number, y: number): void;
  hasNote?(id: string): boolean;
}

// A scope row's play verb and its tooltip, derived from its role.
function playVerb(role: BoxTag, counts: DeckCounts, isMarker: boolean): string {
  if (isMarker) return "play cards under this anchor";
  if (role === "concept") return counts.total ? "play this concept's cards" : "no cards";
  if (role === "questions") return "play cards in this section";
  if (role === "question") return "play this question";
  if (role === "frame") return "play cards in this frame";
  return "play cards here";
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
  private decks = new Map<string, DeckCounts>();
  // True when any scope has cards, i.e. the deck badges are worth showing.
  private hasDecks = false;

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
    // Pull deck counts before drawing so badges are correct in one pass. The
    // handler reads from cache, so this stays synchronous.
    this.decks = this.handlers.decks?.() ?? new Map();
    this.hasDecks = false;
    for (const counts of this.decks.values()) {
      if (counts.total > 0) {
        this.hasDecks = true;
        break;
      }
    }
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
    const doc = this.handlers.docPath?.();
    if (doc) {
      const hint = document.createElement("div");
      hint.className = "outline-doc";
      hint.textContent = doc.split("/").pop() ?? doc;
      hint.title = doc;
      row.appendChild(hint);
    }
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
    const play = this.btn("play", "play the selected row", () => this.playActive());
    play.disabled = !this.active;
    actions.append(
      play,
      this.btn("auto", "auto-segment the selected questions container", () =>
        this.handlers.onAutoSegment()
      ),
      this.btn("clear", "clear all boxes and anchors", () => this.handlers.onClear())
    );
    head.appendChild(actions);
    return head;
  }

  private list(tree: OutlineNode[]): HTMLElement {
    const list = document.createElement("div");
    list.className = "outline-list";
    // Cards no box contains (page-scoped) get their own row, or they would be
    // invisible as a deck: they appear in no subtree, so they contribute to no
    // ancestor's count.
    const loose = this.decks.get(UNGROUPED_DECK) ?? NO_DECK;
    if (loose.total > 0) list.appendChild(this.ungroupedRow(loose));
    for (const node of tree) this.appendNode(list, node);

    if (!tree.length && loose.total === 0) {
      const hint = document.createElement("div");
      hint.className = "outline-hint";
      hint.textContent = "Nothing yet. Pick a tool above, then draw a box or place an anchor line.";
      list.appendChild(hint);
    }
    return list;
  }

  // The synthetic root for free-floating cards. Not editable or deletable — it
  // owns no entity — only playable and countable.
  private ungroupedRow(counts: DeckCounts): HTMLElement {
    const row = document.createElement("div");
    row.className = "outline-row loose";
    row.dataset.id = UNGROUPED_DECK;

    const gutter = document.createElement("div");
    gutter.className = "outline-gutter";
    const chevron = document.createElement("span");
    chevron.className = "outline-chevron empty";
    chevron.textContent = "•";
    gutter.appendChild(chevron);
    row.appendChild(gutter);

    const mark = document.createElement("span");
    mark.className = "outline-mark";
    mark.textContent = "◇";
    row.appendChild(mark);

    const name = document.createElement("span");
    name.className = "outline-name";
    name.textContent = "Ungrouped cards";
    name.title = "cards no box contains";
    row.appendChild(name);

    const badge = document.createElement("span");
    const actionable = counts.due + counts.fresh;
    badge.className = "outline-deck" + (actionable ? " due" : "");
    badge.textContent = `◇${actionable}`;
    badge.title = `${counts.due} due · ${counts.fresh} new · ${counts.seen} scheduled · ${counts.total} card(s)`;
    row.appendChild(badge);

    const play = document.createElement("span");
    play.className = "outline-play";
    if (actionable) play.classList.add("due");
    play.appendChild(icon("play", 11));
    play.title = actionable ? "play ungrouped cards" : "no cards due";
    play.setAttribute("role", "button");
    play.setAttribute("aria-label", play.title);
    play.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.handlers.onPlay(UNGROUPED_DECK, "deck");
    });
    row.appendChild(play);

    row.addEventListener("click", () => this.handlers.onBrowseDeck?.(UNGROUPED_DECK));
    return row;
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

    // Deck badge: due + new are the actionable numbers, so they are the whole
    // badge and go blue when non-zero. Total is the tooltip's job.
    const deck = this.decks.get(node.id) ?? NO_DECK;
    if (this.hasDecks && deck.total > 0) {
      const badge = document.createElement("span");
      const actionable = deck.due + deck.fresh;
      badge.className = "outline-deck" + (actionable ? " due" : "");
      badge.textContent = `◇${actionable}`;
      badge.title =
        `${deck.due} due · ${deck.fresh} new · ${deck.seen} scheduled · ${deck.total} card(s)` +
        (isMarker ? " (this anchor's subtree)" : "");
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

    // Every row can play its subtree's cards, so every row gets a play button.
    // Rows with nothing under them still show it (dimmed) rather than shifting
    // the layout as cards are added; the tooltip says so.
    const scope = this.scopeFor(role, isMarker);
    const counts = this.decks.get(node.id) ?? NO_DECK;
    const play = document.createElement("span");
    play.className = "outline-play";
    if (counts.due + counts.fresh > 0) play.classList.add("due");
    play.appendChild(icon("play", 11));
    play.title = playVerb(role ?? "other", counts, isMarker);
    play.setAttribute("role", "button");
    play.setAttribute("aria-label", play.title);
    play.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.handlers.onPlay(node.id, scope);
    });
    row.insertBefore(play, del);

    row.addEventListener("click", () => this.handlers.onSelect(node.id, "box"));
    this.rows.set(node.id, row);
    return row;
  }

  // Frame and question rows play their own cards; a concept/marker/other plays
  // its whole subtree as a deck. Question boxes keep the legacy behaviour so
  // their grade row still works card-by-card.
  private scopeFor(role: BoxTag | undefined, isMarker: boolean): "deck" | "question" | "frame" {
    if (isMarker) return "deck";
    if (role === "question") return "question";
    if (role === "frame") return "frame";
    return "deck";
  }

  private playActive(): void {
    if (!this.active) return;
    const node = this.find(this.active);
    if (!node) return;
    const role = node.tags.find((t): t is BoxTag =>
      t === "frame" || t === "concept" || t === "questions" || t === "question" || t === "other"
    );
    this.handlers.onPlay(node.id, this.scopeFor(role, node.tags.includes(TAGS.anchor)));
  }

  private find(id: string): OutlineNode | null {
    const search = (nodes: OutlineNode[]): OutlineNode | null => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const hit = search(node.children);
        if (hit) return hit;
      }
      return null;
    };
    return search(buildOutlineTree(this.entities));
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
    b.type = "button";
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
    // The header Play button follows the selection; update it in place too.
    this.root.querySelectorAll<HTMLButtonElement>('.outline-btn[data-action="play"]').forEach((b) => {
      b.disabled = !id;
    });
  }
}
