import { pickAdapter, type DocView } from "../adapters";
import { ensureReadWrite, loadRoot, pickRoot } from "../host/idb";
import { Overlay, type OverlayMode } from "../overlay/overlay";
import { SidecarStore } from "../store/sidecar";
import { PrefsStore, type Prefs } from "../store/prefs";
import { listTree } from "../vault/tree";
import { splitPath } from "../vault/types";
import { Explorer } from "../ui/explorer";
import { Home } from "../ui/home";
import { Toolbar } from "../ui/toolbar";
import { ZoomController } from "../ui/zoom";
import "../ui/styles.css";

const SCROLL_KEY = "ihobs:scroll";

function hasStorage(): boolean {
  return typeof chrome !== "undefined" && !!chrome.storage?.local;
}

interface Shell {
  root: HTMLElement;
  explorer: HTMLElement;
  viewer: HTMLElement;
}

function buildShell(mount: HTMLElement): Shell {
  mount.innerHTML = "";
  const shell = document.createElement("div");
  shell.className = "shell vault-collapsed";

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";

  const workspace = document.createElement("div");
  workspace.className = "workspace";

  const explorer = document.createElement("div");
  explorer.className = "explorer";

  const viewer = document.createElement("div");
  viewer.className = "viewer empty";
  viewer.textContent = "no vault";

  workspace.append(explorer, viewer);
  shell.append(toolbar, workspace);
  mount.appendChild(shell);

  return { root: shell, explorer, viewer };
}

export class App {
  private shell: Shell;
  private toolbar!: Toolbar;
  private explorer!: Explorer;
  private home!: Home;
  private prefs = new PrefsStore();
  private vault: FileSystemDirectoryHandle | null = null;
  private store: SidecarStore | null = null;
  private view: DocView | null = null;
  private overlay: Overlay | null = null;
  private zoomCtl: ZoomController | null = null;
  private mode: OverlayMode = "none";
  private currentPath: string | null = null;
  private scrollMemo = new Map<string, number>();
  private readonly onScroll: () => void;
  private scrollTimer: number | null = null;

  constructor(mount: HTMLElement) {
    this.shell = buildShell(mount);
    this.onScroll = () => this.memoScroll();
    this.shell.viewer.addEventListener("scroll", this.onScroll, { passive: true });
    void this.boot();
  }

  private async boot(): Promise<void> {
    const prefs = await this.prefs.load();
    this.applyTheme(prefs.theme);
    this.wire();
    this.toolbar.setThemeIcon(prefs.theme);
    this.explorer.setState(prefs.expanded, prefs.pinned);
    await this.loadScroll();

    const handle = await loadRoot();
    if (!handle) {
      this.showHome();
      return;
    }
    this.vault = handle;
    this.store = new SidecarStore(handle);
    await this.refreshTree();

    if (prefs.lastOpened) {
      const ok = await this.nodeHandle(prefs.lastOpened);
      if (ok) await this.openPath(prefs.lastOpened);
      else this.showHome();
    } else {
      this.showHome();
    }
  }

  private wire(): void {
    this.explorer = new Explorer(this.shell.explorer, {
      onOpen: (path) => void this.openPath(path),
      onTogglePin: (path) => void this.togglePin(path),
      onExpandedChange: (expanded) => void this.prefs.setExpanded(expanded)
    });

    this.home = new Home(this.shell.viewer, {
      onOpen: (path) => void this.openPath(path),
      onTogglePin: (path) => void this.togglePin(path)
    });

    this.toolbar = new Toolbar(this.shell.root.querySelector(".toolbar") as HTMLElement, {
      onPickVault: () => void this.pick(),
      onHome: () => this.showHome(),
      onToggleTheme: () => void this.toggleTheme(),
      onMode: (mode) => {
        this.mode = mode;
        this.overlay?.setMode(mode);
      },
      onRevealAll: (revealed) => {
        this.overlay?.revealAll(revealed);
        void this.persist();
      },
      onToggleReveal: () => {
        this.overlay?.toggleReveal();
        void this.persist();
      },
      onSave: () => void this.persist()
    });
  }

  private applyTheme(theme: Prefs["theme"]): void {
    this.shell.root.dataset.theme = theme;
    document.documentElement.dataset.theme = theme;
  }

  private async toggleTheme(): Promise<void> {
    const next: Prefs["theme"] = this.prefs.get().theme === "dark" ? "light" : "dark";
    await this.prefs.setTheme(next);
    this.applyTheme(next);
    this.toolbar.setThemeIcon(next);
  }

  private showHome(): void {
    this.teardown();
    this.currentPath = null;
    this.toolbar.setTitle("no document");
    this.toolbar.setZoom(1);
    this.explorer.setActive(null);
    this.home.show(this.prefs.get());
  }

  private async pick(): Promise<void> {
    try {
      const handle = await pickRoot();
      await ensureReadWrite(handle);
      this.vault = handle;
      this.store = new SidecarStore(handle);
      await this.refreshTree();
    } catch {
      /* user cancelled */
    }
  }

  private async refreshTree(): Promise<void> {
    if (!this.vault) return;
    const tree = await listTree(this.vault);
    const prefs = this.prefs.get();
    this.explorer.setState(prefs.expanded, prefs.pinned);
    this.explorer.render(tree);
    this.shell.root.classList.remove("vault-collapsed");
  }

  private async togglePin(path: string): Promise<void> {
    await this.prefs.togglePin(path);
    const prefs = this.prefs.get();
    this.explorer.setState(prefs.expanded, prefs.pinned);
    if (this.vault) {
      const tree = await listTree(this.vault);
      this.explorer.render(tree);
      this.explorer.setActive(this.currentPath);
    }
    if (!this.currentPath) this.home.show(prefs);
  }

  private async nodeHandle(path: string): Promise<FileSystemFileHandle | null> {
    if (!this.vault) return null;
    let dir: FileSystemDirectoryHandle = this.vault;
    const segs = splitPath(path);
    for (let i = 0; i < segs.length - 1; i++) {
      try {
        dir = await dir.getDirectoryHandle(segs[i]);
      } catch {
        return null;
      }
    }
    try {
      return await dir.getFileHandle(segs[segs.length - 1]);
    } catch {
      return null;
    }
  }

  async openPath(path: string): Promise<void> {
    if (!this.vault) return;
    const adapter = pickAdapter(path);
    if (!adapter) return;
    const handle = await this.nodeHandle(path);
    if (!handle) return;

    this.teardown();

    this.shell.viewer.classList.remove("empty");
    this.shell.viewer.innerHTML = "";
    this.toolbar.setTitle(path);
    this.explorer.setActive(path);
    this.explorer.revealActive();
    this.currentPath = path;

    const view = await adapter.load({
      vault: this.vault,
      path,
      handle,
      container: this.shell.viewer
    });
    this.view = view;

    this.setupZoom(view);
    await this.attachOverlay(view);
    await this.restoreScroll(path);
    await this.prefs.pushRecent(path);
  }

  private setupZoom(view: DocView): void {
    this.zoomCtl?.destroy();
    this.zoomCtl = null;
    if (!view.setZoom) return;
    const viewer = this.shell.viewer;
    this.zoomCtl = new ZoomController({
      viewer,
      getZoom: () => view.getZoom?.() ?? 1,
      onChange: (z) => {
        const applied = view.setZoom?.(z) ?? z;
        this.toolbar.setZoom(applied);
      },
      onRepaint: () => this.overlay?.repaint()
    });
    this.toolbar.setZoom(view.getZoom?.() ?? 1);
  }

  private async loadScroll(): Promise<void> {
    if (!hasStorage()) return;
    const got = await chrome.storage.local.get(SCROLL_KEY);
    const map = (got[SCROLL_KEY] as Record<string, number>) ?? {};
    for (const [k, v] of Object.entries(map)) this.scrollMemo.set(k, v);
  }

  private memoScroll(): void {
    if (!this.currentPath) return;
    if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer);
    const path = this.currentPath;
    this.scrollTimer = window.setTimeout(() => {
      const value = this.shell.viewer.scrollTop;
      this.scrollMemo.set(path, value);
      if (hasStorage()) {
        void chrome.storage.local.set({ [SCROLL_KEY]: Object.fromEntries(this.scrollMemo) });
      }
    }, 150);
  }

  private async restoreScroll(path: string): Promise<void> {
    const stored = this.scrollMemo.get(path);
    if (stored === undefined) return;
    requestAnimationFrame(() => {
      this.shell.viewer.scrollTop = stored;
    });
  }

  private async attachOverlay(view: DocView): Promise<void> {
    if (!this.store || !this.currentPath) return;
    const model = await this.store.load(this.currentPath, view.kind);
    const overlay = new Overlay(view.surfaces, model.regions, {
      onChange: () => void this.persist()
    });
    overlay.setMode(this.mode);
    this.overlay = overlay;
  }

  private async persist(): Promise<void> {
    if (!this.store || !this.overlay || !this.view || !this.currentPath) return;
    await this.store.save(this.currentPath, this.view.kind, this.overlay.getRegions());
  }

  private teardown(): void {
    this.overlay?.destroy();
    this.overlay = null;
    this.zoomCtl?.destroy();
    this.zoomCtl = null;
    this.view?.destroy();
    this.view = null;
  }
}
