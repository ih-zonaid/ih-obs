import type { OverlayMode } from "../overlay/overlay";

export interface ToolbarHandlers {
  onOpenHub(): void;
  onOpenPalette(): void;
  onMode(mode: OverlayMode): void;
  onRevealAll(revealed: boolean): void;
  onToggleReveal(): void;
  onSave(): void;
  onHome(): void;
  onToggleTheme(): void;
}

export class Toolbar {
  private readonly root: HTMLElement;
  private readonly h: ToolbarHandlers;
  private mode: OverlayMode = "none";

  constructor(root: HTMLElement, h: ToolbarHandlers) {
    this.root = root;
    this.root.className = "toolbar";
    this.h = h;
    this.build();
  }

  private build(): void {
    this.root.innerHTML = "";

    const home = this.button("home", () => this.h.onHome(), "go-home");

    const search = document.createElement("button");
    search.className = "tb-btn tb-search";
    search.dataset.action = "open-palette";
    search.textContent = "go to file…";
    search.title = "quick open (⌘/Ctrl+P)";
    search.addEventListener("click", () => this.h.onOpenPalette());

    const vault = document.createElement("button");
    vault.className = "tb-btn vault-chip";
    vault.dataset.action = "open-hub";
    vault.id = "tb-vault";
    vault.textContent = "vaults";
    vault.title = "switch vault";
    vault.addEventListener("click", () => this.h.onOpenHub());

    const title = document.createElement("span");
    title.className = "tb-title";
    title.id = "tb-title";
    title.textContent = "no document";

    const zoom = document.createElement("span");
    zoom.className = "tb-zoom";
    zoom.id = "tb-zoom";
    zoom.textContent = "";

    const spacer = document.createElement("div");
    spacer.className = "tb-spacer";

    const occlude = this.button("occlude", () => this.setMode("occlude"));
    const highlight = this.button("highlight", () => this.setMode("highlight"));
    const reveal = this.button("reveal", () => this.h.onToggleReveal());
    const hideAll = this.button("hide", () => this.h.onRevealAll(false));
    const save = this.button("save", () => this.h.onSave());
    const theme = this.button("theme", () => this.h.onToggleTheme(), "toggle-theme");

    this.root.append(home, search, vault, title, zoom, spacer, occlude, highlight, reveal, hideAll, save, theme);
  }

  private button(label: string, onClick: () => void, extra?: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "tb-btn" + (extra ? ` ${extra}` : "");
    b.dataset.action = extra ?? label;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  setMode(mode: OverlayMode): void {
    this.mode = mode === this.mode ? "none" : mode;
    this.root.querySelectorAll(".tb-btn").forEach((el) => {
      const btn = el as HTMLButtonElement;
      const action = btn.dataset.action;
      if (action === "occlude" || action === "highlight") {
        btn.classList.toggle("active", action === this.mode);
      }
    });
    this.h.onMode(this.mode);
  }

  setTitle(text: string): void {
    const el = this.root.querySelector("#tb-title");
    if (el) el.textContent = text;
  }

  setVaultLabel(label: string | null): void {
    const el = this.root.querySelector("#tb-vault");
    if (el) el.textContent = label ?? "vaults";
    if (el) el.classList.toggle("bound", !!label);
  }

  setZoom(zoom: number): void {
    const el = this.root.querySelector("#tb-zoom");
    if (el) el.textContent = `${Math.round(zoom * 100)}%`;
  }

  setThemeIcon(theme: "dark" | "light"): void {
    const el = this.root.querySelector('[data-action="toggle-theme"]');
    if (el) el.textContent = theme === "dark" ? "light" : "dark";
  }
}
