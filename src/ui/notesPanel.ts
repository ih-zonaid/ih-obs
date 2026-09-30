import type { NoteTargetKind } from "../store/schema";

export interface NoteRow {
  id: string;
  body: string;
  quote?: string;
  target: string;
  targetKind: NoteTargetKind;
  // Resolved, human-readable target, e.g. "Highlight · p3" or "Q4 (question)".
  label: string;
  page: number | null;
}

export interface NotesPanelHandlers {
  // Bring the note's target into view and select it.
  onFocus(id: string): void;
  onEdit(id: string, anchor: { x: number; y: number }): void;
  onDelete(id: string): void;
}

const KIND_ICON: Record<NoteTargetKind, string> = {
  mark: "▧",
  box: "▤",
  group: "▥",
  page: "¶"
};

// The right-rail Notes panel: one row per note, newest first, with a filter and
// per-row focus/edit/delete. Rendering is a full rebuild; the list is small.
export class NotesPanel {
  private readonly root: HTMLElement;
  private readonly handlers: NotesPanelHandlers;
  private rows: NoteRow[] = [];
  private query = "";

  constructor(root: HTMLElement, handlers: NotesPanelHandlers) {
    this.root = root;
    this.root.className = "notes";
    this.handlers = handlers;
  }

  setRows(rows: NoteRow[]): void {
    this.rows = rows;
    this.render();
  }

  private visible(): NoteRow[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.rows;
    return this.rows.filter((r) =>
      `${r.body} ${r.quote ?? ""} ${r.label}`.toLowerCase().includes(q)
    );
  }

  render(): void {
    const scroll = this.root.scrollTop;
    this.root.innerHTML = "";
    this.root.appendChild(this.head());

    const rows = this.visible();
    if (!rows.length) {
      const hint = document.createElement("div");
      hint.className = "notes-hint";
      hint.textContent = this.rows.length
        ? "No notes match your filter."
        : "No notes yet. Right-click a mark, box, or the page to add one.";
      this.root.appendChild(hint);
      this.root.scrollTop = scroll;
      return;
    }

    const list = document.createElement("div");
    list.className = "notes-list";
    for (const row of rows) list.appendChild(this.row(row));
    this.root.appendChild(list);
    this.root.scrollTop = scroll;
  }

  private head(): HTMLElement {
    const head = document.createElement("div");
    head.className = "notes-head";
    const title = document.createElement("div");
    title.className = "notes-title";
    title.textContent = `Notes · ${this.rows.length}`;
    head.appendChild(title);

    const search = document.createElement("input");
    search.className = "notes-search explorer-search";
    search.type = "search";
    search.placeholder = "filter notes…";
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      this.render();
    });
    head.appendChild(search);
    return head;
  }

  private row(row: NoteRow): HTMLElement {
    const el = document.createElement("div");
    el.className = "note-row";
    el.dataset.id = row.id;

    const top = document.createElement("div");
    top.className = "note-row-top";
    const icon = document.createElement("span");
    icon.className = "note-row-icon";
    icon.textContent = KIND_ICON[row.targetKind] ?? "▧";
    const label = document.createElement("span");
    label.className = "note-row-label";
    label.textContent = row.label;
    label.title = row.label;
    top.append(icon, label);
    if (row.page !== null) {
      const page = document.createElement("span");
      page.className = "note-row-page";
      page.textContent = `p${row.page + 1}`;
      top.appendChild(page);
    }
    el.appendChild(top);

    if (row.quote?.trim()) {
      const quote = document.createElement("div");
      quote.className = "note-row-quote";
      quote.textContent = row.quote.trim();
      el.appendChild(quote);
    }

    const body = document.createElement("div");
    body.className = "note-row-body md-body";
    body.textContent = row.body;
    el.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "note-row-actions";
    const edit = document.createElement("button");
    edit.className = "note-row-btn";
    edit.textContent = "edit";
    edit.title = "edit note";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      this.handlers.onEdit(row.id, { x: rect.left, y: rect.bottom + 4 });
    });
    const del = document.createElement("button");
    del.className = "note-row-btn danger";
    del.textContent = "delete";
    del.title = "delete note";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.handlers.onDelete(row.id);
    });
    actions.append(edit, del);
    el.appendChild(actions);

    el.addEventListener("click", () => this.handlers.onFocus(row.id));
    return el;
  }
}
