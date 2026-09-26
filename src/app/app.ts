import { pickAdapter, type DocView } from "../adapters";
import {
  clearLegacyRoot,
  deleteVault,
  getCurrentVaultId,
  getLegacyRoot,
  listVaults,
  newId,
  pickDirectory,
  putVault,
  queryPermission,
  requestReadWrite,
  setCurrentVaultId,
  type VaultRecord
} from "../host/idb";
import { Overlay, type OverlayMode } from "../overlay/overlay";
import { SidecarStore } from "../store/sidecar";
import { loadTheme, PrefsStore, saveTheme } from "../store/prefs";
import { hasChromeStorage } from "../store/kv";
import { DEFAULT_RULES, type Segment, type SegmentRule } from "../store/schema";
import { detectLayout } from "../segment/detect";
import { toBitmap } from "../segment/layout";
import { listTree } from "../vault/tree";
import { splitPath } from "../vault/types";
import { Explorer } from "../ui/explorer";
import { Home } from "../ui/home";
import { Outline } from "../ui/outline";
import { Palette } from "../ui/palette";
import { SegmentLayer } from "../ui/segmentLayer";
import { Toolbar } from "../ui/toolbar";
import { VaultHub } from "../ui/vaultHub";
import { ZoomController } from "../ui/zoom";
import "../ui/styles.css";

const SCROLL_PREFIX = "ihobs:scroll:";

interface Shell {
  root: HTMLElement;
  explorer: HTMLElement;
  viewer: HTMLElement;
  outline: HTMLElement;
  palette: HTMLElement;
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

  const outline = document.createElement("div");
  outline.className = "outline hidden";

  const palette = document.createElement("div");
  palette.className = "palette-root hidden";

  workspace.append(explorer, viewer, outline);
  shell.append(toolbar, workspace, palette);
  mount.appendChild(shell);

  return { root: shell, explorer, viewer, outline, palette };
}

export class App {
  private shell: Shell;
  private toolbar!: Toolbar;
  private explorer!: Explorer;
  private home!: Home;
  private hub!: VaultHub;
  private palette!: Palette;
  private outline!: Outline;

  private vaults: VaultRecord[] = [];
  private vault: VaultRecord | null = null;
  private store: SidecarStore | null = null;
  private prefs = new PrefsStore();

  private view: DocView | null = null;
  private overlay: Overlay | null = null;
  private segLayer: SegmentLayer | null = null;
  private segments: Segment[] = [];
  private activeSegment: string | null = null;
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
    const theme = await loadTheme();
    this.applyTheme(theme);
    this.wire();
    this.toolbar.setThemeIcon(theme);

    await this.migrateLegacy();
    this.vaults = await listVaults();

    if (!this.vaults.length) {
      this.showHub();
      return;
    }

    const currentId = await getCurrentVaultId();
    const target = this.vaults.find((v) => v.id === currentId) ?? this.vaults[0];
    const perm = await queryPermission(target.handle);
    if (perm === "granted") {
      await this.activate(target, true);
    } else {
      this.showHub();
    }
  }

  private async migrateLegacy(): Promise<void> {
    const existing = await listVaults();
    if (existing.length) return;
    const legacy = await getLegacyRoot();
    if (!legacy) return;
    const rec: VaultRecord = {
      id: newId(),
      label: legacy.name || "vault",
      handle: legacy,
      addedAt: Date.now(),
      lastOpenedAt: Date.now()
    };
    await putVault(rec);
    await setCurrentVaultId(rec.id);
    await clearLegacyRoot();
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

    this.hub = new VaultHub(this.shell.viewer, {
      onOpen: (id) => void this.openVault(id),
      onAdd: () => void this.addVault(),
      onRename: (id) => void this.renameVault(id),
      onForget: (id) => void this.forgetVault(id)
    });

    this.palette = new Palette(this.shell.palette, {
      onOpen: (path) => void this.openPath(path)
    });

    this.outline = new Outline(this.shell.outline, {
      onSelect: (id) => this.selectSegment(id),
      onRename: (id, title) => void this.renameSegment(id, title),
      onDelete: (id) => void this.deleteSegment(id),
      onDetect: () => void this.runSegmentation(),
      onClear: () => void this.clearSegments()
    });

    this.toolbar = new Toolbar(this.shell.root.querySelector(".toolbar") as HTMLElement, {
      onOpenHub: () => this.showHub(),
      onOpenPalette: () => this.palette.toggle(),
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

  private applyTheme(theme: "dark" | "light"): void {
    this.shell.root.dataset.theme = theme;
    document.documentElement.dataset.theme = theme;
  }

  private async toggleTheme(): Promise<void> {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    await saveTheme(next);
    this.applyTheme(next);
    this.toolbar.setThemeIcon(next);
  }

  private async showHub(): Promise<void> {
    this.teardown();
    this.currentPath = null;
    this.toolbar.setTitle("no document");
    this.toolbar.setZoom(1);
    this.toolbar.setVaultLabel(null);
    this.shell.root.classList.add("vault-collapsed");
    this.explorer.render({ name: "", path: "", kind: "directory", children: [] });
    this.palette.setTree({ name: "", path: "", kind: "directory", children: [] });
    this.vaults = await listVaults();
    const status = new Map<string, boolean>();
    for (const v of this.vaults) {
      status.set(v.id, (await queryPermission(v.handle)) === "granted");
    }
    const currentId = this.vault?.id ?? null;
    this.hub.show(this.vaults, currentId, status);
  }

  private async openVault(id: string): Promise<void> {
    const rec = this.vaults.find((v) => v.id === id);
    if (!rec) return;
    const ok = await requestReadWrite(rec.handle);
    if (!ok) {
      window.alert("Access denied. Grant permission to open this vault.");
      return;
    }
    await this.activate(rec, true);
  }

  private async addVault(): Promise<void> {
    try {
      const handle = await pickDirectory();
      const ok = await requestReadWrite(handle);
      if (!ok) return;
      const rec: VaultRecord = {
        id: newId(),
        label: handle.name || "vault",
        handle,
        addedAt: Date.now(),
        lastOpenedAt: Date.now()
      };
      await putVault(rec);
      this.vaults = await listVaults();
      await this.activate(rec, false);
    } catch {
      /* cancelled */
    }
  }

  private async renameVault(id: string): Promise<void> {
    const rec = this.vaults.find((v) => v.id === id);
    if (!rec) return;
    const next = window.prompt("Vault name", rec.label);
    if (!next || next === rec.label) return;
    await putVault({ ...rec, label: next });
    this.vaults = await listVaults();
    if (this.vault?.id === id) {
      this.vault = { ...rec, label: next };
      this.toolbar.setVaultLabel(next);
    }
    await this.showHub();
  }

  private async forgetVault(id: string): Promise<void> {
    const rec = this.vaults.find((v) => v.id === id);
    if (!rec) return;
    if (!window.confirm(`Forget "${rec.label}"? Your files and .ihobs data stay untouched.`)) return;
    this.prefs = new PrefsStore().withVault(id);
    await this.prefs.clearVaultData();
    if (hasChromeStorage()) await chrome.storage.local.remove(this.scrollKey(id));
    await deleteVault(id);
    if (this.vault?.id === id) {
      this.vault = null;
      await setCurrentVaultId(null);
    }
    await this.showHub();
  }

  private async activate(rec: VaultRecord, reopenLast: boolean): Promise<void> {
    this.teardown();
    this.vault = rec;
    this.store = new SidecarStore(rec.handle);
    this.prefs = new PrefsStore().withVault(rec.id);
    const prefs = await this.prefs.load();
    this.toolbar.setVaultLabel(rec.label);
    this.explorer.setState(prefs.expanded, prefs.pinned);
    this.shell.root.classList.remove("vault-collapsed");

    await setCurrentVaultId(rec.id);
    await putVault({ ...rec, lastOpenedAt: Date.now() });
    this.vaults = await listVaults();

    await this.loadScroll(rec.id);
    await this.refreshTree();

    if (reopenLast && prefs.lastOpened) {
      const ok = await this.nodeHandle(prefs.lastOpened);
      if (ok) {
        await this.openPath(prefs.lastOpened);
        return;
      }
    }
    this.showHome();
  }

  private showHome(): void {
    if (!this.vault) {
      void this.showHub();
      return;
    }
    this.teardown();
    this.currentPath = null;
    this.toolbar.setTitle("no document");
    this.toolbar.setZoom(1);
    this.explorer.setActive(null);
    this.home.show(this.prefs.get());
  }

  private async refreshTree(): Promise<void> {
    if (!this.vault) return;
    const tree = await listTree(this.vault.handle);
    const prefs = this.prefs.get();
    this.explorer.setState(prefs.expanded, prefs.pinned);
    this.explorer.render(tree);
    this.palette.setTree(tree);
  }

  private async togglePin(path: string): Promise<void> {
    await this.prefs.togglePin(path);
    const prefs = this.prefs.get();
    this.explorer.setState(prefs.expanded, prefs.pinned);
    if (this.vault) {
      const tree = await listTree(this.vault.handle);
      this.explorer.render(tree);
      this.explorer.setActive(this.currentPath);
    }
    if (!this.currentPath) this.home.show(prefs);
  }

  private async nodeHandle(path: string): Promise<FileSystemFileHandle | null> {
    if (!this.vault) return null;
    let dir: FileSystemDirectoryHandle = this.vault.handle;
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
      vault: this.vault.handle,
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
    this.zoomCtl = new ZoomController({
      viewer: this.shell.viewer,
      getZoom: () => view.getZoom?.() ?? 1,
      onChange: (z) => {
        const applied = view.setZoom?.(z) ?? z;
        this.toolbar.setZoom(applied);
      },
      onRepaint: () => {
        this.overlay?.repaint();
        this.segLayer?.repaint();
      }
    });
    this.toolbar.setZoom(view.getZoom?.() ?? 1);
  }

  private scrollKey(vaultId: string): string {
    return `${SCROLL_PREFIX}${vaultId}`;
  }

  private async loadScroll(vaultId: string): Promise<void> {
    this.scrollMemo.clear();
    if (!hasChromeStorage()) return;
    const got = await chrome.storage.local.get(this.scrollKey(vaultId));
    const map = (got[this.scrollKey(vaultId)] as Record<string, number>) ?? {};
    for (const [k, v] of Object.entries(map)) this.scrollMemo.set(k, v);
  }

  private memoScroll(): void {
    if (!this.currentPath || !this.vault) return;
    if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer);
    const path = this.currentPath;
    const key = this.scrollKey(this.vault.id);
    this.scrollTimer = window.setTimeout(() => {
      this.scrollMemo.set(path, this.shell.viewer.scrollTop);
      if (hasChromeStorage()) {
        void chrome.storage.local.set({ [key]: Object.fromEntries(this.scrollMemo) });
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
    if (view.kind === "json") return;
    const model = await this.store.load(this.currentPath, view.kind);
    const overlay = new Overlay(view.surfaces, model.regions, {
      onChange: () => void this.persist()
    });
    overlay.setMode(this.mode);
    this.overlay = overlay;

    this.segments = model.segments;
    this.activeSegment = null;
    this.segLayer = new SegmentLayer(view.surfaces, {
      onSelect: (id) => this.selectSegment(id),
      getActive: () => this.activeSegment
    });
    this.segLayer.setSegments(this.segments);
    this.refreshOutline();
    this.updateOutlineVisibility();
  }

  private refreshOutline(): void {
    this.outline.render(this.segments);
    this.outline.setActive(this.activeSegment);
  }

  private updateOutlineVisibility(): void {
    const show = this.view?.kind === "pdf" || this.view?.kind === "image";
    this.shell.outline.classList.toggle("hidden", !show);
    const ws = this.shell.root.querySelector(".workspace");
    ws?.classList.toggle("has-outline", show);
  }

  private selectSegment(id: string): void {
    this.activeSegment = id;
    this.segLayer?.setVisible(true);
    this.outline.setActive(id);
    this.segLayer?.scrollTo(id);
  }

  private async renameSegment(id: string, title: string): Promise<void> {
    const seg = this.segments.find((s) => s.id === id);
    if (!seg) return;
    seg.title = title;
    this.refreshOutline();
    await this.persistSegments();
  }

  private async deleteSegment(id: string): Promise<void> {
    this.segments = this.segments.filter((s) => s.id !== id);
    this.segments.forEach((s, i) => (s.order = i));
    if (this.activeSegment === id) this.activeSegment = null;
    this.segLayer?.setSegments(this.segments);
    this.refreshOutline();
    await this.persistSegments();
  }

  private async clearSegments(): Promise<void> {
    this.segments = [];
    this.activeSegment = null;
    this.segLayer?.setSegments([]);
    this.refreshOutline();
    await this.persistSegments();
  }

  private async persistSegments(): Promise<void> {
    if (!this.store || !this.view || !this.currentPath) return;
    await this.store.saveSegments(this.currentPath, this.view.kind, this.segments);
  }

  private async runSegmentation(): Promise<void> {
    if (!this.view || !this.store || !this.currentPath) return;
    if (this.view.kind !== "pdf" || !this.view.getPageImages) {
      window.alert("Auto-segment currently supports PDFs.");
      return;
    }
    const rule: SegmentRule = DEFAULT_RULES[0];
    this.outline.render(this.segments);
    this.shell.outline.classList.remove("hidden");

    try {
      const pages = this.view.surfaces.map((s) => s.index);
      const images = await this.view.getPageImages(pages, 1.2);
      const found: Segment[] = [];
      let order = 0;
      for (const img of images) {
        const bitmap = toBitmap(img.image);
        const spans = detectLayout({ page: img.page, bitmap }, rule);
        for (const span of spans) {
          found.push({
            id: `s_${order}_${Math.random().toString(36).slice(2, 7)}`,
            type: "question",
            title: `Q${order + 1}`,
            order,
            spans: [span]
          });
          order++;
        }
      }
      this.segments = found;
      this.segLayer?.setSegments(found);
      this.segLayer?.setVisible(true);
      this.refreshOutline();
      await this.store.saveSegments(this.currentPath, this.view.kind, found, rule);
    } catch {
      window.alert("Segmentation failed.");
    }
  }

  private async persist(): Promise<void> {
    if (!this.store || !this.overlay || !this.view || !this.currentPath) return;
    await this.store.saveRegions(this.currentPath, this.view.kind, this.overlay.getRegions());
  }

  private teardown(): void {
    this.overlay?.destroy();
    this.overlay = null;
    this.segLayer?.destroy();
    this.segLayer = null;
    this.segments = [];
    this.activeSegment = null;
    this.shell.outline.classList.add("hidden");
    this.shell.root.querySelector(".workspace")?.classList.remove("has-outline");
    this.zoomCtl?.destroy();
    this.zoomCtl = null;
    this.view?.destroy();
    this.view = null;
  }
}
