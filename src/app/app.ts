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
import {
  DEFAULT_RULES,
  PAGE_OWNER,
  parseLabel,
  smallestContainingSegment,
  type Marker,
  type Segment,
  type SegmentRole,
  type Span
} from "../store/schema";
import { detectInSpan } from "../segment/detect";
import { toBitmap } from "../segment/layout";
import { listTree } from "../vault/tree";
import { splitPath } from "../vault/types";
import { openContextMenu, type ContextMenuEntry } from "../ui/contextMenu";
import { Explorer } from "../ui/explorer";
import { Home } from "../ui/home";
import { Outline } from "../ui/outline";
import { Palette } from "../ui/palette";
import { SegmentDrawer, type DrawTool } from "../ui/segmentDraw";
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
  private segDrawer: SegmentDrawer | null = null;
  private segments: Segment[] = [];
  private markers: Marker[] = [];
  private activeId: string | null = null;
  private activeKind: "segment" | "marker" = "segment";
  private drawTool: DrawTool | null = null;
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
      onSelect: (id, kind) => this.selectEntry(id, kind),
      onLabel: (id, kind, label) => void this.setLabel(id, kind, label),
      onDelete: (id, kind) => void this.deleteEntry(id, kind),
      onTool: (tool) => this.setDrawTool(tool),
      onAutoSegment: () => void this.runSegmentation(),
      onSplitApply: () => void this.applySplit(),
      onSplitCancel: () => this.setDrawTool(null),
      onClear: () => void this.clearAll()
    });

    this.toolbar = new Toolbar(this.shell.root.querySelector(".toolbar") as HTMLElement, {
      onOpenHub: () => this.showHub(),
      onOpenPalette: () => this.palette.toggle(),
      onHome: () => this.showHome(),
      onToggleTheme: () => void this.toggleTheme(),
      onMode: (mode) => {
        this.mode = mode;
        this.overlay?.setMode(mode);
        if (mode !== "none" && this.drawTool) this.setDrawTool(null);
        this.syncInteractivity();
      },
      onRevealAll: (revealed) => {
        this.overlay?.revealAll(revealed);
        void this.persist();
      },
      onToggleReveal: () => {
        this.overlay?.toggleReveal();
        void this.persist();
      },
      onSave: () => void this.persist(),
      onZoomIn: () => this.nudgeZoom(1.15),
      onZoomOut: () => this.nudgeZoom(1 / 1.15),
      onZoomReset: () => this.setZoom(1),
      onGoToPage: (page) => this.view?.goToPage?.(page)
    });
  }

  private nudgeZoom(factor: number): void {
    this.setZoom((this.view?.getZoom?.() ?? 1) * factor);
  }

  private setZoom(zoom: number): void {
    if (!this.view?.setZoom) return;
    const applied = this.view.setZoom(zoom);
    this.toolbar.setZoom(applied);
    this.overlay?.repaint();
    this.segLayer?.repaint();
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
    this.toolbar.setZoomVisible(!!view.setZoom);
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

    if (view.pageCount && view.onPageChange) {
      view.onPageChange((page) => this.toolbar.setPage(page, view.pageCount?.() ?? 1));
      this.toolbar.setPage(view.currentPage?.() ?? 1, view.pageCount());
    } else {
      this.toolbar.setPage(1, 1);
    }
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
      onChange: () => void this.persist(),
      onContext: (id, x, y) => this.openRegionMenu(id, x, y),
      ownerFor: (geom) => this.resolveOwner(geom)
    });
    overlay.setMode(this.mode);
    this.overlay = overlay;

    this.segments = model.segments;
    this.markers = model.markers;
    this.activeId = null;
    this.activeKind = "segment";
    this.drawTool = null;
    this.segLayer = new SegmentLayer(view.surfaces, {
      onSelect: (id, kind) => this.selectEntry(id, kind),
      onContext: (id, kind, x, y) => this.openEntryMenu(id, kind, x, y),
      getActive: () => this.activeId
    });
    this.segLayer.setData(this.segments, this.markers);
    this.segLayer.setVisible(this.segments.length > 0 || this.markers.length > 0);
    this.segDrawer = new SegmentDrawer(view.surfaces, {
      onDraw: (span) => void this.addSegmentFromDraw(span),
      onMarker: (page, y) => void this.addMarker(page, y)
    });
    this.syncInteractivity();
    this.refreshOutline();
    this.updateOutlineVisibility();
  }

  // Explicit selection wins; otherwise the smallest containing segment owns the
  // mark; otherwise it is a free page-level mark.
  private resolveOwner(geom: { surface: number; x: number; y: number; w: number; h: number }): string {
    if (this.activeKind === "segment" && this.activeId) {
      const seg = this.segments.find((s) => s.id === this.activeId);
      if (seg) return seg.id;
    }
    const contained = smallestContainingSegment(geom, this.segments);
    return contained ? contained.id : PAGE_OWNER;
  }

  // Tool-owns-pointer: while a mark tool is active segments go click-through;
  // while a segment tool is active the mark overlay goes click-through.
  private syncInteractivity(): void {
    const markTool = this.mode !== "none";
    const segTool = !!this.drawTool;
    this.overlay?.setInteractive(!segTool);
    this.segLayer?.setInteractive(!markTool);
  }

  private refreshOutline(): void {
    this.outline.render(this.segments, this.markers);
    this.outline.setActive(this.activeId);
  }

  private updateOutlineVisibility(): void {
    const show = this.view?.kind === "pdf" || this.view?.kind === "image";
    this.shell.outline.classList.toggle("hidden", !show);
    const ws = this.shell.root.querySelector(".workspace");
    ws?.classList.toggle("has-outline", show);
  }

  private selectEntry(id: string, kind: "segment" | "marker"): void {
    this.activeId = id;
    this.activeKind = kind;
    if (kind === "segment") this.segLayer?.setVisible(true);
    // Update classes in place; a full re-render here would destroy the row that
    // the user just clicked and swallow the double-click.
    this.outline.setActive(id);
    this.segLayer?.scrollTo(id);
    if (this.drawTool === "split") {
      const container = this.selectedContainer();
      if (container) this.armSplit(container);
      else this.segDrawer?.resetSplit();
    }
  }

  // Right-click menus are spec-driven: add future actions as new entries here.
  private openEntryMenu(id: string, kind: "segment" | "marker", clientX: number, clientY: number): void {
    const entry =
      kind === "marker"
        ? this.markers.find((m) => m.id === id)
        : this.segments.find((s) => s.id === id);
    if (!entry) return;
    this.selectEntry(id, kind);

    const items: ContextMenuEntry[] = [];
    if (kind === "segment") {
      const seg = entry as Segment;
      if (seg.role === "questions") {
        items.push({
          label: "Auto-segment inside",
          hint: "find questions",
          onSelect: () => void this.runSegmentation()
        });
      }
      items.push({ label: "Rename label", onSelect: () => this.outline.beginEditActive() });
    } else {
      items.push({ label: "Rename label", onSelect: () => this.outline.beginEditActive() });
    }
    items.push("separator");
    items.push({
      label: kind === "marker" ? "Delete marker" : "Delete segment",
      danger: true,
      onSelect: () => void this.deleteEntry(id, kind)
    });

    openContextMenu({ title: this.entryTitle(kind, entry), items }, clientX, clientY);
  }

  private openRegionMenu(id: string, clientX: number, clientY: number): void {
    const region = this.overlay?.getRegions().find((r) => r.id === id);
    if (!region) return;
    const kindLabel = region.kind === "highlight" ? "Highlight" : "Occlusion";
    const ownerSeg =
      region.owner !== PAGE_OWNER ? this.segments.find((s) => s.id === region.owner) : undefined;
    const ownerName = ownerSeg ? ownerSeg.label.replace(/^#+\s*/, "") || "segment" : "page";
    const items: ContextMenuEntry[] = [
      {
        label: region.revealed ? "Hide" : "Reveal",
        onSelect: () => {
          this.overlay?.reveal(id, !region.revealed);
          void this.persist();
        }
      }
    ];
    // Attach to the selected segment, or detach back to page scope.
    if (ownerSeg) {
      items.push({
        label: "Detach from segment",
        onSelect: () => {
          this.overlay?.setOwner(id, PAGE_OWNER);
          void this.persist();
        }
      });
    } else if (this.activeKind === "segment" && this.activeId) {
      const target = this.segments.find((s) => s.id === this.activeId);
      if (target) {
        items.push({
          label: `Attach to "${target.label.replace(/^#+\s*/, "") || "segment"}"`,
          onSelect: () => {
            this.overlay?.setOwner(id, target.id);
            void this.persist();
          }
        });
      }
    }
    items.push({
      label: "Remove",
      danger: true,
      onSelect: () => {
        this.overlay?.remove(id);
        void this.persist();
      }
    });
    openContextMenu({ title: `${kindLabel} · ${ownerName}`, items }, clientX, clientY);
  }

  private entryTitle(kind: "segment" | "marker", entry: Segment | Marker): string {
    const label = entry.label.trim() || (kind === "marker" ? "marker" : "segment");
    const page = kind === "marker" ? (entry as Marker).page : (entry as Segment).spans[0]?.page ?? 0;
    return `${label} · p${page + 1}`;
  }

  private setDrawTool(tool: DrawTool | null): void {
    const container = tool === "split" ? this.selectedContainer() : null;
    if (tool === "split" && !container) {
      window.alert("Select a 'questions' container first, then split it.");
      tool = null;
    }
    this.drawTool = tool;
    this.segDrawer?.setTool(tool);
    if (tool === "split" && container) this.armSplit(container);
    else this.segDrawer?.resetSplit();
    if (tool && this.mode !== "none") {
      this.mode = "none";
      this.overlay?.setMode("none");
      this.toolbar.clearMode();
    }
    // setTool updates internal state; refresh so the split action bar appears
    // or disappears with the tool.
    this.outline.setTool(tool);
    this.syncInteractivity();
    this.refreshOutline();
  }

  private selectedContainer(): Segment | null {
    if (this.activeKind !== "segment" || !this.activeId) return null;
    const seg = this.segments.find((s) => s.id === this.activeId);
    return seg && seg.role === "questions" ? seg : null;
  }

  private armSplit(container: Segment): void {
    const span = container.spans[0];
    if (!span) return;
    this.segDrawer?.startSplit(span.page, { x: span.x, y: span.y, w: span.w, h: span.h });
  }

  // Slices the selected questions container at the user's cut lines into child
  // 'question' segments, one per band, right after the container in the outline.
  private async applySplit(): Promise<void> {
    const container = this.selectedContainer();
    const cuts = this.segDrawer?.getCuts() ?? [];
    if (!container) {
      window.alert("Select a 'questions' container first.");
      return;
    }
    if (!cuts.length) {
      window.alert("Click at least one boundary line on the page.");
      return;
    }
    const span = container.spans[0];
    if (!span) return;

    const pageCuts = cuts.filter((c) => c.page === span.page).map((c) => c.y).sort((a, b) => a - b);
    const bounds = [span.y, ...pageCuts, span.y + span.h];
    const baseText = parseLabel(container.label).text || "Q";
    const children: Segment[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const top = bounds[i];
      const bottom = bounds[i + 1];
      if (bottom - top < 0.004) continue;
      children.push({
        id: `s_${Math.random().toString(36).slice(2, 9)}`,
        role: "question",
        label: `${baseText} ${i + 1}`,
        spans: [{ page: span.page, x: span.x, y: top, w: span.w, h: bottom - top }]
      });
    }
    if (!children.length) {
      window.alert("Cuts produced no sections.");
      return;
    }

    const at = this.segments.indexOf(container);
    this.segments.splice(at + 1, 0, ...children);
    this.setDrawTool(null);
    this.segLayer?.setData(this.segments, this.markers);
    this.segLayer?.setVisible(true);
    this.selectEntry(children[0].id, "segment");
    await this.persistSegments();
  }

  private defaultLabel(role: SegmentRole): string {
    const n = this.segments.filter((s) => s.role === role).length + 1;
    if (role === "concept") return `Concept ${n}`;
    if (role === "questions") return `Questions ${n}`;
    if (role === "question") return `Q${n}`;
    return `Item ${n}`;
  }

  private async addSegmentFromDraw(span: Span): Promise<void> {
    const role: SegmentRole =
      this.drawTool === "concept" || this.drawTool === "questions" || this.drawTool === "question"
        ? this.drawTool
        : "concept";
    const seg: Segment = {
      id: `s_${Math.random().toString(36).slice(2, 9)}`,
      role,
      label: this.defaultLabel(role),
      spans: [span]
    };
    this.segments.push(seg);
    this.segLayer?.setData(this.segments, this.markers);
    this.segLayer?.setVisible(true);
    this.selectEntry(seg.id, "segment");
    this.outline.beginEditActive();
    await this.persistSegments();
  }

  private async addMarker(page: number, y: number): Promise<void> {
    const n = this.markers.filter((m) => m.page === page).length + 1;
    const marker: Marker = {
      id: `m_${Math.random().toString(36).slice(2, 9)}`,
      page,
      y,
      label: `Marker ${n}`
    };
    this.markers.push(marker);
    this.segLayer?.setData(this.segments, this.markers);
    this.segLayer?.setVisible(true);
    this.selectEntry(marker.id, "marker");
    this.outline.beginEditActive();
    await this.persistSegments();
  }

  private async setLabel(id: string, kind: "segment" | "marker", label: string): Promise<void> {
    if (kind === "marker") {
      const m = this.markers.find((x) => x.id === id);
      if (!m) return;
      m.label = label;
    } else {
      const s = this.segments.find((x) => x.id === id);
      if (!s) return;
      s.label = label;
    }
    this.segLayer?.setData(this.segments, this.markers);
    this.refreshOutline();
    await this.persistSegments();
  }

  private async deleteEntry(id: string, kind: "segment" | "marker"): Promise<void> {
    if (kind === "marker") this.markers = this.markers.filter((m) => m.id !== id);
    else this.segments = this.segments.filter((s) => s.id !== id);
    if (this.activeId === id) this.activeId = null;
    // Marks that were attached to the deleted segment (or nested under it) fall
    // back to page scope rather than disappearing or dangling.
    this.overlay?.reassignOwners(new Set(this.segments.map((s) => s.id)));
    void this.persist();
    this.segLayer?.setData(this.segments, this.markers);
    this.refreshOutline();
    await this.persistSegments();
  }

  private async clearAll(): Promise<void> {
    const total = this.segments.length + this.markers.length;
    if (total && !window.confirm("Clear all segments and markers in this document?")) return;
    this.segments = [];
    this.markers = [];
    this.activeId = null;
    this.segLayer?.setData([], []);
    this.refreshOutline();
    await this.persistSegments();
  }

  private async persistSegments(): Promise<void> {
    if (!this.store || !this.view || !this.currentPath) return;
    await this.store.saveSegments(this.currentPath, this.view.kind, this.segments, this.markers);
  }

  // Auto-segmentation always runs INSIDE a manually drawn "questions" container.
  private async runSegmentation(): Promise<void> {
    if (!this.view || !this.store || !this.currentPath) return;
    if (this.view.kind !== "pdf" || !this.view.getPageImages) {
      window.alert("Auto-segment currently supports PDFs.");
      return;
    }
    const container =
      this.activeKind === "segment"
        ? this.segments.find((s) => s.id === this.activeId && s.role === "questions")
        : undefined;
    if (!container) {
      window.alert("Select a 'questions' container, then auto-segment.");
      return;
    }
    if (!container.spans.length) return;

    const rule = DEFAULT_RULES[0];
    const baseText = parseLabel(container.label).text || "Q";
    const startIndex = this.segments.indexOf(container);
    try {
      const found: Segment[] = [];
      for (const region of container.spans) {
        const images = await this.view.getPageImages([region.page], 1.2);
        const img = images[0];
        if (!img) continue;
        const bitmap = toBitmap(img.image);
        const part = detectInSpan(
          { page: img.page, bitmap },
          region,
          rule,
          "question",
          `${baseText} `
        );
        found.push(...part);
      }
      if (!found.length) {
        window.alert("No questions detected inside this container. Split it manually.");
        return;
      }
      this.segments.splice(startIndex + 1, 0, ...found);
      this.segLayer?.setData(this.segments, this.markers);
      this.segLayer?.setVisible(true);
      this.refreshOutline();
      this.selectEntry(found[0].id, "segment");
      await this.store.saveSegments(
        this.currentPath,
        this.view.kind,
        this.segments,
        this.markers,
        rule
      );
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
    this.segDrawer?.destroy();
    this.segDrawer = null;
    this.segLayer?.destroy();
    this.segLayer = null;
    this.segments = [];
    this.markers = [];
    this.activeId = null;
    this.drawTool = null;
    this.shell.outline.classList.add("hidden");
    this.shell.root.querySelector(".workspace")?.classList.remove("has-outline");
    this.zoomCtl?.destroy();
    this.zoomCtl = null;
    this.toolbar.setZoomVisible(false);
    this.toolbar.setPage(1, 1);
    this.view?.destroy();
    this.view = null;
  }
}
