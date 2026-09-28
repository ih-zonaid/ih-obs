import { renderMarkdown } from "../notes/render";

export interface NoteEditorOptions {
  title?: string;
  quote?: string;
  initial: string;
  // Vault path of the open document, so [[wikilinks]] in a note resolve
  // relative to the same place a document's links would.
  path?: string;
  anchor: { x: number; y: number };
  onSave(body: string): void;
  onDelete?(): void;
}

// A small markdown editor with a Write/Preview toggle. Saving an empty body on
// a note that already exists deletes it, which is the natural "clear to remove".
export class NotePopover {
  private el: HTMLElement | null = null;
  private readonly onDocPointerDown = (e: PointerEvent): void => {
    if (this.el && !this.el.contains(e.target as Node)) this.hide();
  };
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      this.hide();
    }
  };
  private readonly onReflow = (): void => this.hide();

  open(opts: NoteEditorOptions): void {
    this.hide();
    const el = document.createElement("div");
    el.className = "note-pop";

    if (opts.title) {
      const head = document.createElement("div");
      head.className = "note-pop-head";
      head.textContent = opts.title;
      el.appendChild(head);
    }

    if (opts.quote?.trim()) {
      const quote = document.createElement("blockquote");
      quote.className = "note-pop-quote";
      quote.textContent = opts.quote.trim();
      el.appendChild(quote);
    }

    const tabs = document.createElement("div");
    tabs.className = "note-pop-tabs";
    const writeTab = document.createElement("button");
    writeTab.className = "note-pop-tab active";
    writeTab.textContent = "Write";
    const previewTab = document.createElement("button");
    previewTab.className = "note-pop-tab";
    previewTab.textContent = "Preview";
    tabs.append(writeTab, previewTab);
    el.appendChild(tabs);

    const body = document.createElement("textarea");
    body.className = "note-pop-input md-body";
    body.value = opts.initial;
    body.placeholder = "markdown note…  **bold**, *italic*, `code`, - list, [[link]]";
    body.spellcheck = false;

    const preview = document.createElement("div");
    preview.className = "note-pop-preview md-body";
    preview.hidden = true;

    el.append(body, preview);

    const foot = document.createElement("div");
    foot.className = "note-pop-foot";
    const hint = document.createElement("span");
    hint.className = "note-pop-hint";
    hint.textContent = "⌘/Ctrl+Enter save · Esc cancel";
    const spacer = document.createElement("span");
    spacer.className = "note-pop-spacer";
    const del = document.createElement("button");
    del.className = "tb-btn note-pop-del";
    del.textContent = "Delete";
    del.hidden = !opts.onDelete;
    const save = document.createElement("button");
    save.className = "tb-btn note-pop-save";
    save.textContent = "Save";
    foot.append(hint, spacer, del, save);
    el.appendChild(foot);

    const saved = { done: false };
    const finish = (commit: boolean): void => {
      if (saved.done) return;
      saved.done = true;
      const text = body.value.trim();
      this.hide();
      if (commit && text) opts.onSave(text);
      else if (commit && !text && opts.onDelete) opts.onDelete();
    };

    const showWrite = (): void => {
      writeTab.classList.add("active");
      previewTab.classList.remove("active");
      body.hidden = false;
      preview.hidden = true;
      body.focus();
    };
    const showPreview = (): void => {
      previewTab.classList.add("active");
      writeTab.classList.remove("active");
      body.hidden = true;
      preview.hidden = false;
      preview.innerHTML = renderMarkdown(body.value, opts.path ?? "");
    };
    writeTab.addEventListener("click", showWrite);
    previewTab.addEventListener("click", showPreview);

    body.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        finish(true);
      }
    });
    save.addEventListener("click", () => finish(true));
    del.addEventListener("click", () => {
      if (saved.done) return;
      saved.done = true;
      this.hide();
      opts.onDelete?.();
    });

    document.body.appendChild(el);
    this.el = el;
    this.place(el, opts.anchor.x, opts.anchor.y);

    window.addEventListener("pointerdown", this.onDocPointerDown, true);
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("blur", this.onReflow);
    window.addEventListener("resize", this.onReflow);

    requestAnimationFrame(() => {
      body.focus();
      body.setSelectionRange(body.value.length, body.value.length);
    });
  }

  // Clamp inside the viewport; prefer below-right of the anchor, flip when the
  // panel would overflow the bottom.
  private place(el: HTMLElement, x: number, y: number): void {
    const rect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    let top = y;
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, y - rect.height - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  hide(): void {
    if (!this.el) return;
    window.removeEventListener("pointerdown", this.onDocPointerDown, true);
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("blur", this.onReflow);
    window.removeEventListener("resize", this.onReflow);
    this.el.remove();
    this.el = null;
  }

  isOpen(): boolean {
    return !!this.el;
  }
}

const popover = new NotePopover();

export function openNoteEditor(opts: NoteEditorOptions): void {
  popover.open(opts);
}

export function hideNoteEditor(): void {
  popover.hide();
}

export function isNoteEditorOpen(): boolean {
  return popover.isOpen();
}
