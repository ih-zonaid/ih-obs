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
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomReset(): void;
  onGoToPage(page: number): void;
  onToggleInspect(): void;
}

export class Toolbar {
  private readonly root: HTMLElement;
  private readonly h: ToolbarHandlers;
  private mode: OverlayMode = "none";
  private inspect = false;

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

    const page = document.createElement("span");
    page.className = "tb-page hidden";
    page.id = "tb-page";
    page.appendChild(this.pageInput());
    const total = document.createElement("span");
    total.className = "tb-page-total";
    total.id = "tb-page-total";
    page.appendChild(total);

    const zoomBox = document.createElement("div");
    zoomBox.className = "tb-zoombox hidden";
    zoomBox.id = "tb-zoombox";
    const zOut = this.iconBtn("−", "zoom out", () => this.h.onZoomOut());
    const zVal = document.createElement("button");
    zVal.className = "tb-zoom tb-zoom-btn";
    zVal.id = "tb-zoom";
    zVal.title = "reset to 100%";
    zVal.textContent = "100%";
    zVal.addEventListener("click", () => this.h.onZoomReset());
    const zIn = this.iconBtn("+", "zoom in", () => this.h.onZoomIn());
    zoomBox.append(zOut, zVal, zIn);

    const spacer = document.createElement("div");
    spacer.className = "tb-spacer";

    const occlude = this.button("occlude", () => this.setMode("occlude"));
    const highlight = this.button("highlight", () => this.setMode("highlight"));
    const inspect = this.button("inspect", () => this.toggleInspect());
    const reveal = this.button("reveal", () => this.h.onToggleReveal());
    const hideAll = this.button("hide", () => this.h.onRevealAll(false));
    const save = this.button("save", () => this.h.onSave());
    const theme = this.button("theme", () => this.h.onToggleTheme(), "toggle-theme");

    this.root.append(
      home,
      search,
      vault,
      title,
      page,
      zoomBox,
      spacer,
      occlude,
      highlight,
      inspect,
      reveal,
      hideAll,
      save,
      theme
    );
  }

  toggleInspect(): void {
    this.inspect = !this.inspect;
    const btn = this.root.querySelector<HTMLElement>('[data-action="inspect"]');
    btn?.classList.toggle("active", this.inspect);
    this.h.onToggleInspect();
  }

  setInspect(on: boolean): void {
    this.inspect = on;
    this.root.querySelector<HTMLElement>('[data-action="inspect"]')?.classList.toggle("active", on);
  }

  private pageInput(): HTMLInputElement {
    const input = document.createElement("input");
    input.className = "tb-page-input";
    input.id = "tb-page-input";
    input.type = "text";
    input.inputMode = "numeric";
    input.value = "1";
    input.title = "current page — type and press Enter to jump";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const total = Number(input.max) || 1;
        let n = parseInt(input.value, 10);
        if (!Number.isFinite(n)) n = Number(input.dataset.value) || 1;
        n = Math.max(1, Math.min(total, n));
        input.value = String(n);
        input.dataset.value = String(n);
        this.h.onGoToPage(n);
        input.blur();
      }
    });
    input.addEventListener("blur", () => this.clearPageEdit());
    input.addEventListener("focus", () => input.select());
    return input;
  }

  private iconBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "tb-btn tb-icon";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  private clearPageEdit(): void {
    const input = this.root.querySelector<HTMLInputElement>("#tb-page-input");
    if (input) input.value = input.dataset.value ?? input.value;
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
    this.syncMode();
    this.h.onMode(this.mode);
  }

  clearMode(): void {
    if (this.mode === "none") return;
    this.mode = "none";
    this.syncMode();
  }

  private syncMode(): void {
    this.root.querySelectorAll(".tb-btn").forEach((el) => {
      const btn = el as HTMLButtonElement;
      const action = btn.dataset.action;
      if (action === "occlude" || action === "highlight") {
        btn.classList.toggle("active", action === this.mode);
      }
    });
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

  setZoomVisible(visible: boolean): void {
    this.root.querySelector("#tb-zoombox")?.classList.toggle("hidden", !visible);
  }

  setPage(current: number, total: number): void {
    const box = this.root.querySelector("#tb-page");
    const input = this.root.querySelector<HTMLInputElement>("#tb-page-input");
    const totalEl = this.root.querySelector("#tb-page-total");
    box?.classList.toggle("hidden", total <= 1);
    if (input && document.activeElement !== input) {
      input.value = String(current);
      input.dataset.value = String(current);
    }
    if (input) input.max = String(total);
    if (totalEl) totalEl.textContent = ` / ${total}`;
  }

  setThemeIcon(theme: "dark" | "light"): void {
    const el = this.root.querySelector('[data-action="toggle-theme"]');
    if (el) el.textContent = theme === "dark" ? "light" : "dark";
  }
}
