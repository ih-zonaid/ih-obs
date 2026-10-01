export interface ContextMenuItem {
  label: string;
  onSelect(): void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  // Small colored dot before the label, e.g. for a color quick-pick.
  swatch?: string;
  // Radio-style entry: draws a tick when true, so a menu can show which of a
  // set of mutually exclusive settings is currently active.
  checked?: boolean;
}

export type ContextMenuEntry = ContextMenuItem | "separator";

export interface ContextMenuSpec {
  title?: string;
  items: ContextMenuEntry[];
}

// Single shared menu attached to <body>. Call openContextMenu() from any
// right-click handler; adding new actions is just another item in the spec.
class ContextMenu {
  private el: HTMLElement | null = null;
  private readonly onDocPointerDown = (e: PointerEvent): void => {
    if (this.el && !this.el.contains(e.target as Node)) this.hide();
  };
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.hide();
  };
  private readonly onReflow = (): void => this.hide();

  show(spec: ContextMenuSpec, x: number, y: number): void {
    this.hide();
    const el = document.createElement("div");
    el.className = "ctx-menu";

    if (spec.title) {
      const head = document.createElement("div");
      head.className = "ctx-title";
      head.textContent = spec.title;
      el.appendChild(head);
    }

    for (const entry of spec.items) {
      if (entry === "separator") {
        const sep = document.createElement("div");
        sep.className = "ctx-sep";
        el.appendChild(sep);
        continue;
      }
      const item = document.createElement("button");
      item.className = "ctx-item" + (entry.danger ? " danger" : "");
      item.disabled = !!entry.disabled;
      const main = document.createElement("span");
      main.className = "ctx-item-main";
      if (entry.checked) {
        const tick = document.createElement("span");
        tick.className = "ctx-check";
        tick.textContent = "✓";
        main.appendChild(tick);
      }
      if (entry.swatch) {
        const dot = document.createElement("span");
        dot.className = "ctx-swatch";
        dot.style.background = entry.swatch;
        main.appendChild(dot);
      }
      const label = document.createElement("span");
      label.textContent = entry.label;
      main.appendChild(label);
      item.appendChild(main);
      if (entry.hint) {
        const hint = document.createElement("span");
        hint.className = "ctx-hint";
        hint.textContent = entry.hint;
        item.appendChild(hint);
      }
      item.addEventListener("click", () => {
        this.hide();
        entry.onSelect();
      });
      el.appendChild(item);
    }

    document.body.appendChild(el);
    this.el = el;

    // Keep the menu inside the viewport.
    const rect = el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;

    window.addEventListener("pointerdown", this.onDocPointerDown, true);
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("blur", this.onReflow);
    window.addEventListener("resize", this.onReflow);
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
}

const menu = new ContextMenu();

export function openContextMenu(spec: ContextMenuSpec, x: number, y: number): void {
  menu.show(spec, x, y);
}

export function hideContextMenu(): void {
  menu.hide();
}
