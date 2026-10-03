import type { OverlayMode } from "../overlay/overlay";
import type { PageMode } from "../store/prefs";
import { icon, setIcon, type IconName } from "./icons";

export interface ToolbarHandlers {
  onOpenHub(): void;
  onOpenPalette(): void;
  onMode(mode: OverlayMode): void;
  onRevealAll(revealed: boolean): void;
  onToggleReveal(): void;
  onSave(): void;
  onHome(): void;
  onToggleTheme(): void;
  onCyclePageMode(): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomReset(): void;
  onGoToPage(page: number): void;
  onToggleInspect(): void;
  onToggleTextDebug(): void;
  onToggleExplorer(): void;
  onToggleOutline(): void;
  onToggleNotes(): void;
  // Right-click on a tool button opens that tool's options at the pointer. The
  // toolbar passes the button's data-action so the app can route it; tools with
  // no options simply never register a context handler and never emit this.
  onToolMenu?(action: string, x: number, y: number): void;
}

// PDF text-layer debug levels: 0 off, 1 outline glyph boxes, 2 also show glyphs.
export type TextDebugLevel = 0 | 1 | 2;

// A toolbar control plus whether it may be demoted into the "more" menu when
// the row runs out of width. Core navigation/document controls are fixed; the
// drawing, view and debug controls are movable, in priority order (later items
// are demoted first).
interface ToolbarItem {
  el: HTMLElement;
  movable: boolean;
}

export class Toolbar {
  private readonly root: HTMLElement;
  private readonly h: ToolbarHandlers;
  private mode: OverlayMode = "none";
  private inspect = false;
  private textDebug: TextDebugLevel = 0;
  private outlineOn = false;
  private notesOn = false;
  private explorerOn = false;

  // Overflow: the row is measured after every layout-affecting change; when the
  // controls no longer fit, the least important ones move into a popover instead
  // of being clipped. The same DOM nodes migrate (no clones), so their handlers
  // and active state survive. In the popover each control also reveals the name
  // it keeps hidden inline (see data-label in styles.css).
  private items: ToolbarItem[] = [];
  private overflowBtn!: HTMLButtonElement;
  private overflowMenu!: HTMLElement;
  private menuOpen = false;
  private raf = 0;

  private readonly onWinResize = (): void => this.scheduleRelayout();
  private readonly onDocPointerDown = (e: PointerEvent): void => {
    const t = e.target as Node;
    if (!this.overflowMenu.contains(t) && !this.overflowBtn.contains(t)) this.closeMenu();
  };
  private readonly onMenuKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.closeMenu();
  };

  constructor(root: HTMLElement, h: ToolbarHandlers) {
    this.root = root;
    this.root.className = "toolbar";
    this.h = h;
    this.build();
  }

  private build(): void {
    this.root.innerHTML = "";
    this.items = [];
    this.menuOpen = false;

    const home = this.iconCtrl("home", "go home", { action: "go-home" }, () => this.h.onHome());
    const files = this.iconCtrl(
      "panel-left",
      "toggle the file panel",
      { extra: "tb-explorer-toggle" },
      () => this.toggleExplorer()
    );

    const search = this.iconCtrl(
      "search",
      "go to file (⌘/Ctrl+P)",
      { action: "open-palette", label: "go to file" },
      () => this.h.onOpenPalette()
    );

    // The vault chip keeps its name visible — which vault you are in matters
    // more than the space it costs.
    const vault = document.createElement("button");
    vault.className = "tb-btn vault-chip";
    vault.dataset.action = "open-hub";
    vault.id = "tb-vault";
    vault.title = "switch vault";
    vault.setAttribute("aria-label", "switch vault");
    const vaultLabel = document.createElement("span");
    vaultLabel.id = "tb-vault-label";
    vaultLabel.className = "tb-vault-label";
    vaultLabel.textContent = "vaults";
    vault.append(icon("database", 14), vaultLabel);
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
    const zOut = this.iconCtrl("minus", "zoom out", {}, () => this.h.onZoomOut());
    const zVal = document.createElement("button");
    zVal.className = "tb-zoom tb-zoom-btn";
    zVal.id = "tb-zoom";
    zVal.title = "reset to 100%";
    zVal.textContent = "100%";
    zVal.addEventListener("click", () => this.h.onZoomReset());
    const zIn = this.iconCtrl("plus", "zoom in", {}, () => this.h.onZoomIn());
    zoomBox.append(zOut, zVal, zIn);

    const spacer = document.createElement("div");
    spacer.className = "tb-spacer";

    const occlude = this.iconCtrl(
      "square-filled",
      "occlude: draw a solid cover over the answer",
      { action: "occlude", label: "occlude" },
      () => this.setMode("occlude")
    );
    const highlight = this.iconCtrl(
      "highlighter",
      "highlight: draw a translucent wash",
      { action: "highlight", label: "highlight" },
      () => this.setMode("highlight")
    );
    const line = this.iconCtrl(
      "line-band",
      "line tool: swipe sideways to mark a line — [ / ] resizes the band; right-click for options",
      { action: "line", label: "line tool", options: true },
      () => this.setMode("line")
    );
    const inspect = this.iconCtrl(
      "target",
      "inspect: show each mark's resolved owner",
      { action: "inspect", label: "inspect" },
      () => this.toggleInspect()
    );
    const reveal = this.iconCtrl(
      "eye",
      "toggle reveal of the current page's marks",
      { label: "reveal" },
      () => this.h.onToggleReveal()
    );
    const hideAll = this.iconCtrl(
      "eye-off",
      "hide all marks",
      { label: "hide all" },
      () => this.h.onRevealAll(false)
    );
    const textDebug = this.iconCtrl(
      "type",
      "debug: show the PDF text layer (off → boxes → text)",
      { extra: "tb-text-debug", label: "text debug" },
      () => this.cycleTextDebug()
    );
    const save = this.iconCtrl("save", "save now", { label: "save" }, () => this.h.onSave());
    const outlineBtn = this.iconCtrl(
      "list",
      "toggle the outline panel",
      { extra: "tb-outline-toggle", label: "outline" },
      () => this.toggleOutline()
    );
    const notesBtn = this.iconCtrl(
      "note",
      "toggle the notes panel",
      { extra: "tb-notes-toggle", label: "notes" },
      () => this.toggleNotes()
    );
    const theme = this.iconCtrl(
      "sun",
      "switch theme",
      { action: "toggle-theme", label: "theme" },
      () => this.h.onToggleTheme()
    );
    const pageMode = this.iconCtrl(
      "contrast",
      "page tone: normal → invert → warm dim (darken a scanned book)",
      { extra: "tb-page-mode hidden", action: "toggle-page-mode", label: "page tone" },
      () => this.h.onCyclePageMode()
    );

    // Fixed (identity/document) controls first, then the movable tool/view/debug
    // controls in demotion order.
    this.addItem(home, false);
    this.addItem(files, false);
    this.addItem(search, true);
    this.addItem(vault, true);
    this.addItem(title, false);
    this.addItem(page, false);
    this.addItem(zoomBox, false);
    this.addItem(spacer, false);
    this.addItem(occlude, true);
    this.addItem(highlight, true);
    this.addItem(line, true);
    this.addItem(inspect, true);
    this.addItem(reveal, true);
    this.addItem(hideAll, true);
    this.addItem(textDebug, true);
    this.addItem(save, true);
    this.addItem(outlineBtn, true);
    this.addItem(notesBtn, true);
    this.addItem(pageMode, true);
    this.addItem(theme, true);

    this.overflowBtn = this.iconCtrl(
      "ellipsis",
      "more actions",
      { extra: "tb-overflow-btn hidden" },
      () => this.toggleMenu()
    );
    this.addItem(this.overflowBtn, false);

    this.overflowMenu = document.createElement("div");
    this.overflowMenu.className = "tb-overflow";
    this.overflowMenu.id = "tb-overflow";
    this.root.appendChild(this.overflowMenu);
    // Any click bubbling out of a menu item means the user acted; dismiss.
    this.overflowMenu.addEventListener("click", () => this.closeMenu());

    this.applyState();
    this.observeSize();
    this.scheduleRelayout();
  }

  private addItem(el: HTMLElement, movable: boolean): void {
    this.items.push({ el, movable });
    this.root.appendChild(el);
  }

  // Builds an icon control and wires the small amount of metadata the rest of
  // the toolbar depends on (data-action for state sync, data-label for the
  // overflow popover, extra classes for visibility hooks). `meta.options`
  // marks the control as having right-click options, which routes a
  // contextmenu gesture to the app's onToolMenu handler.
  private iconCtrl(
    name: IconName,
    title: string,
    meta: { action?: string; extra?: string; label?: string; options?: boolean },
    onClick: () => void
  ): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "tb-btn" + (meta.extra ? ` ${meta.extra}` : "");
    if (meta.action) b.dataset.action = meta.action;
    if (meta.label) b.dataset.label = meta.label;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.appendChild(icon(name));
    b.addEventListener("click", onClick);
    // A right-click on a tool with options opens its menu instead of the
    // browser's; left-click still toggles the tool. Only controls flagged
    // `options` suppress the native menu, so unrelated icons keep it.
    if (meta.options) {
      b.addEventListener("contextmenu", (e) => {
        if (!meta.action) return;
        e.preventDefault();
        e.stopPropagation();
        this.h.onToolMenu?.(meta.action, e.clientX, e.clientY);
      });
    }
    return b;
  }

  // Re-applies control state after a rebuild so the (possibly relocated) nodes
  // still reflect the active tool/panel/debug selection.
  private applyState(): void {
    this.syncMode();
    this.setTextDebug(this.textDebug);
    this.setInspect(this.inspect);
    this.setOutline(this.outlineOn);
    this.setNotes(this.notesOn);
    this.setExplorer(this.explorerOn);
  }

  private observeSize(): void {
    // An unobstructed ResizeObserver stays alive while it has a live target, so
    // there is no need to keep a reference to it.
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => this.scheduleRelayout()).observe(this.root);
    }
    window.addEventListener("resize", this.onWinResize);
    // Web-font metrics can change widths after first paint; re-measure then.
    document.fonts?.ready.then(() => this.scheduleRelayout()).catch(() => {});
  }

  private scheduleRelayout(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.relayout();
    });
  }

  // Reset every control inline, then demote the least important movable ones
  // (from the end, prepended to the menu to preserve order) until the row fits.
  private relayout(): void {
    if (this.root.clientWidth <= 0) return;
    this.closeMenu();
    for (const it of this.items) this.root.appendChild(it.el);
    this.overflowBtn.classList.add("hidden");

    const fits = (): boolean => this.root.scrollWidth <= this.root.clientWidth + 1;
    if (fits()) return;

    this.overflowBtn.classList.remove("hidden");
    while (!fits()) {
      const last = this.lastMovableInline();
      if (!last) break;
      this.overflowMenu.prepend(last);
    }
    if (!this.overflowMenu.children.length) this.overflowBtn.classList.add("hidden");
  }

  private lastMovableInline(): HTMLElement | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.movable && it.el.parentElement === this.root) return it.el;
    }
    return null;
  }

  private toggleMenu(): void {
    if (this.menuOpen) {
      this.closeMenu();
      return;
    }
    if (!this.overflowMenu.children.length) return;
    this.overflowMenu.classList.add("open");
    this.overflowBtn.classList.add("active");
    this.menuOpen = true;

    // Right-align the popover under the button, clamped to the viewport.
    const r = this.overflowBtn.getBoundingClientRect();
    const m = this.overflowMenu.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - m.width, window.innerWidth - m.width - 8));
    const top = Math.min(r.bottom + 6, window.innerHeight - m.height - 8);
    this.overflowMenu.style.left = `${left}px`;
    this.overflowMenu.style.top = `${Math.max(8, top)}px`;

    window.addEventListener("pointerdown", this.onDocPointerDown, true);
    window.addEventListener("keydown", this.onMenuKey, true);
  }

  private closeMenu(): void {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    this.overflowMenu.classList.remove("open");
    this.overflowBtn.classList.remove("active");
    window.removeEventListener("pointerdown", this.onDocPointerDown, true);
    window.removeEventListener("keydown", this.onMenuKey, true);
  }

  cycleTextDebug(): void {
    this.textDebug = (((this.textDebug + 1) % 3) as TextDebugLevel);
    this.setTextDebug(this.textDebug);
    this.h.onToggleTextDebug();
  }

  setTextDebug(level: TextDebugLevel): void {
    this.textDebug = level;
    const btn = this.root.querySelector<HTMLElement>(".tb-text-debug");
    if (btn) {
      btn.classList.toggle("active", level > 0);
      btn.dataset.level = String(level);
      const name = level === 0 ? "text layer: off" : level === 1 ? "text layer: glyph boxes" : "text layer: glyphs shown";
      btn.title = `debug: ${name} (click to cycle)`;
      btn.setAttribute("aria-label", btn.title);
      btn.dataset.label = name;
    }
  }

  getTextDebug(): TextDebugLevel {
    return this.textDebug;
  }

  setTextDebugVisible(visible: boolean): void {
    this.root.querySelector(".tb-text-debug")?.classList.toggle("hidden", !visible);
    if (!visible) this.setTextDebug(0);
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

  toggleOutline(): void {
    this.outlineOn = !this.outlineOn;
    this.root.querySelector(".tb-outline-toggle")?.classList.toggle("active", this.outlineOn);
    this.h.onToggleOutline();
  }

  setOutline(on: boolean): void {
    this.outlineOn = on;
    this.root.querySelector(".tb-outline-toggle")?.classList.toggle("active", on);
  }

  toggleNotes(): void {
    this.notesOn = !this.notesOn;
    this.root.querySelector(".tb-notes-toggle")?.classList.toggle("active", this.notesOn);
    this.h.onToggleNotes();
  }

  setNotes(on: boolean): void {
    this.notesOn = on;
    this.root.querySelector(".tb-notes-toggle")?.classList.toggle("active", on);
  }

  toggleExplorer(): void {
    this.explorerOn = !this.explorerOn;
    this.root.querySelector(".tb-explorer-toggle")?.classList.toggle("active", this.explorerOn);
    this.h.onToggleExplorer();
  }

  setExplorer(on: boolean): void {
    this.explorerOn = on;
    this.root.querySelector(".tb-explorer-toggle")?.classList.toggle("active", on);
  }

  private pageInput(): HTMLInputElement {
    const input = document.createElement("input");
    input.className = "tb-page-input";
    input.id = "tb-page-input";
    input.type = "text";
    input.inputMode = "numeric";
    input.value = "1";
    input.title = "current page — type and press Enter to jump";
    input.setAttribute("aria-label", "current page");
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

  private clearPageEdit(): void {
    const input = this.root.querySelector<HTMLInputElement>("#tb-page-input");
    if (input) input.value = input.dataset.value ?? input.value;
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
      if (action === "occlude" || action === "highlight" || action === "line") {
        btn.classList.toggle("active", action === this.mode);
      }
    });
  }

  setTitle(text: string): void {
    const el = this.root.querySelector("#tb-title");
    if (el) el.textContent = text;
    // A longer title can push controls past the row; re-check the fit.
    this.scheduleRelayout();
  }

  setVaultLabel(label: string | null): void {
    const el = this.root.querySelector("#tb-vault-label");
    if (el) el.textContent = label ?? "vaults";
    const chip = this.root.querySelector<HTMLElement>("#tb-vault");
    if (chip) {
      chip.classList.toggle("bound", !!label);
      chip.title = label ? `switch vault (${label})` : "switch vault";
    }
    this.scheduleRelayout();
  }

  setZoom(zoom: number): void {
    const el = this.root.querySelector("#tb-zoom");
    if (el) el.textContent = `${Math.round(zoom * 100)}%`;
    this.scheduleRelayout();
  }

  setZoomVisible(visible: boolean): void {
    this.root.querySelector("#tb-zoombox")?.classList.toggle("hidden", !visible);
    this.scheduleRelayout();
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
    this.scheduleRelayout();
  }

  setThemeIcon(theme: "dark" | "light"): void {
    const el = this.root.querySelector<HTMLElement>('[data-action="toggle-theme"]');
    if (!el) return;
    // Show the theme you would switch *to*: sun while dark, moon while light.
    const next = theme === "dark" ? "light" : "dark";
    setIcon(el, theme === "dark" ? "sun" : "moon");
    const title = `switch to ${next} theme`;
    el.title = title;
    el.setAttribute("aria-label", title);
    el.dataset.label = `${next} theme`;
  }

  setPageMode(mode: PageMode): void {
    const el = this.root.querySelector<HTMLElement>('[data-action="toggle-page-mode"]');
    if (!el) return;
    el.classList.toggle("active", mode !== "off");
    const name = mode === "off" ? "normal" : mode === "invert" ? "inverted" : "warm dim";
    const title = `page tone: ${name} — click to cycle (normal → invert → warm)`;
    el.title = title;
    el.setAttribute("aria-label", title);
    el.dataset.label = `page tone: ${name}`;
  }

  setPageModeVisible(visible: boolean): void {
    this.root.querySelector('[data-action="toggle-page-mode"]')?.classList.toggle("hidden", !visible);
    this.scheduleRelayout();
  }
}
