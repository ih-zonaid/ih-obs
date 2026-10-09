import { renderMarkdown } from "../notes/render";
import { icon } from "./icons";

export interface NoteEditorOptions {
  title?: string;
  quote?: string;
  initial: string;
  // Vault path of the open document, so [[wikilinks]] in a note resolve
  // relative to the same place a document's links would.
  path?: string;
  anchor: { x: number; y: number };
  // Open read-only when the note already has a body (the common case is
  // reviewing, not rewriting). A blank note opens ready to type.
  startInPreview?: boolean;
  // Overrides the textarea placeholder, so a card cue can read as a cue rather
  // than as a freeform note.
  placeholder?: string;
  onSave(body: string): void;
  onDelete?(): void;
}

export interface NotePreviewOptions {
  title?: string;
  quote?: string;
  body: string;
  path?: string;
  anchor: { x: number; y: number };
  // Fired as the pointer enters/leaves the card, so the caller can keep it
  // open while the user travels from the indicator toward the Edit button.
  onHoverChange?(over: boolean): void;
  onEdit(): void;
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
    hideNotePreview();
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
    writeTab.className = "note-pop-tab";
    writeTab.appendChild(icon("pencil", 12));
    writeTab.appendChild(textNode("Write"));
    const previewTab = document.createElement("button");
    previewTab.className = "note-pop-tab";
    previewTab.appendChild(icon("eye", 12));
    previewTab.appendChild(textNode("Preview"));
    tabs.append(writeTab, previewTab);
    el.appendChild(tabs);

    const body = document.createElement("textarea");
    body.className = "note-pop-input md-body";
    body.value = opts.initial;
    body.placeholder =
      opts.placeholder ?? "markdown note…  **bold**, *italic*, `code`, - list, [[link]]";
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
    del.appendChild(icon("trash", 13));
    del.appendChild(textNode("Delete"));
    del.hidden = !opts.onDelete;
    const save = document.createElement("button");
    save.className = "tb-btn note-pop-save";
    save.appendChild(icon("check", 13));
    save.appendChild(textNode("Save"));
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

    // Preview-first for existing notes; Write for a blank one, so the caret is
    // ready. Clicking the rendered preview jumps straight into editing.
    const hasContent = opts.initial.trim().length > 0;
    if (opts.startInPreview ?? hasContent) {
      showPreview();
      preview.style.cursor = "text";
      preview.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("a")) return;
        showWrite();
      });
    } else {
      showWrite();
    }

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
      if (body.hidden) return;
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

// A read-only rendered note shown while hovering its indicator, so the body is
// legible without committing to a click. The card is inert (pointer-events:
// none) except for an Edit affordance, so it can never swallow a click meant
// for the mark underneath; moving toward the card to click Edit keeps it open
// via the shared leave-grace timer in the app.
export class NotePreview {
  private el: HTMLElement | null = null;
  // The card is inert (pointer-events: none), so clicks fall through to the
  // page; a press anywhere outside the card should dismiss it. The Edit button
  // re-enables pointer events, so a press on it is "inside" and left alone.
  private readonly onDocPointerDown = (e: PointerEvent): void => {
    if (this.el && !this.el.contains(e.target as Node)) this.hide();
  };

  open(opts: NotePreviewOptions): void {
    this.hide();
    const el = document.createElement("div");
    el.className = "note-hover";

    if (opts.title) {
      const head = document.createElement("div");
      head.className = "note-hover-head";
      head.textContent = opts.title;
      el.appendChild(head);
    }

    if (opts.quote?.trim()) {
      const quote = document.createElement("blockquote");
      quote.className = "note-hover-quote";
      quote.textContent = opts.quote.trim();
      el.appendChild(quote);
    }

    const body = document.createElement("div");
    body.className = "note-hover-body md-body";
    body.innerHTML = renderMarkdown(opts.body, opts.path ?? "");
    el.appendChild(body);

    const foot = document.createElement("div");
    foot.className = "note-hover-foot";
    const edit = document.createElement("button");
    edit.className = "tb-btn note-hover-edit";
    edit.appendChild(icon("pencil", 12));
    edit.appendChild(textNode("Edit"));
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hide();
      opts.onEdit();
    });
    foot.appendChild(edit);
    el.appendChild(foot);

    document.body.appendChild(el);
    this.el = el;
    this.place(el, opts.anchor.x, opts.anchor.y);
    el.addEventListener("pointerenter", () => opts.onHoverChange?.(true));
    el.addEventListener("pointerleave", () => opts.onHoverChange?.(false));
    window.addEventListener("pointerdown", this.onDocPointerDown, true);
  }

  private place(el: HTMLElement, x: number, y: number): void {
    const rect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    let top = y;
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, y - rect.height - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  hide(): void {
    window.removeEventListener("pointerdown", this.onDocPointerDown, true);
    this.el?.remove();
    this.el = null;
  }

  isOpen(): boolean {
    return !!this.el;
  }
}

const preview = new NotePreview();

export function showNotePreview(opts: NotePreviewOptions): void {
  preview.open(opts);
}

export function hideNotePreview(): void {
  preview.hide();
}

function textNode(text: string): Text {
  return document.createTextNode(text);
}
