import { pickAdapter, type DocView, type PageImage } from "../adapters";
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
import { kvGet, kvRemove, kvSet } from "../store/kv";
import {
  buildOutlineTree,
  DEFAULT_OCCLUSION_COLOR,
  DEFAULT_RULES,
  OCCLUSION_PALETTE,
  PAGE_OWNER,
  assignOwners,
  parseLabel,
  smallestContainingSegment,
  type Marker,
  type Note,
  type NoteTargetKind,
  type OutlineNode,
  type Region,
  type RegionKind,
  type Segment,
  type SegmentRole,
  type Span
} from "../store/schema";
import { detectInSpan } from "../segment/detect";
import { toBitmap } from "../segment/layout";
import { captureSelection, type CapturedSelection } from "../selection/textSelection";
import { listTree } from "../vault/tree";
import { splitPath } from "../vault/types";
import { openContextMenu, type ContextMenuEntry } from "../ui/contextMenu";
import { Explorer } from "../ui/explorer";
import { Home } from "../ui/home";
import { Outline } from "../ui/outline";
import { NotesPanel, type NoteRow } from "../ui/notesPanel";
import { openNoteEditor } from "../ui/notePopover";
import { Palette } from "../ui/palette";
import { Player } from "../ui/player";
import { SegmentDrawer, type DrawTool } from "../ui/segmentDraw";
import { SegmentLayer } from "../ui/segmentLayer";
import { Toolbar } from "../ui/toolbar";
import { VaultHub } from "../ui/vaultHub";
import { ZoomController } from "../ui/zoom";
import "../ui/styles.css";

const SCROLL_PREFIX = "ihobs:scroll:";

function findNode(nodes: OutlineNode[], id: string): OutlineNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

interface Shell {
  root: HTMLElement;
  explorer: HTMLElement;
  viewer: HTMLElement;
  rail: HTMLElement;
  railTabs: HTMLElement;
  outline: HTMLElement;
  notes: HTMLElement;
  palette: HTMLElement;
  player: HTMLElement;
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

  const rail = document.createElement("div");
  rail.className = "rail hidden";

  const railTabs = document.createElement("div");
  railTabs.className = "rail-tabs";

  const outline = document.createElement("div");
  outline.className = "outline hidden";

  const notes = document.createElement("div");
  notes.className = "notes hidden";

  rail.append(railTabs, outline, notes);

  const palette = document.createElement("div");
  palette.className = "palette-root hidden";

  const player = document.createElement("div");
  player.className = "player-root hidden";

  workspace.append(explorer, viewer, rail);
  shell.append(toolbar, workspace, palette, player);
  mount.appendChild(shell);

  return { root: shell, explorer, viewer, rail, railTabs, outline, notes, palette, player };
}

export class App {
  private shell: Shell;
  private toolbar!: Toolbar;
  private explorer!: Explorer;
  private home!: Home;
  private hub!: VaultHub;
  private palette!: Palette;
  private outline!: Outline;
  private notesPanel!: NotesPanel;
  private player!: Player;

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
  private notes: Note[] = [];
  private activeId: string | null = null;
  private activeKind: "segment" | "marker" = "segment";
  private drawTool: DrawTool | null = null;
  private zoomCtl: ZoomController | null = null;
  private mode: OverlayMode = "none";
  private inspect = false;
  private lineMode = false;
  private railOpen = false;
  private railTab: "outline" | "notes" = "outline";
  private leftCollapsed = false;
  private pendingSelection: CapturedSelection | null = null;
  private currentPath: string | null = null;
  private scrollMemo = new Map<string, number>();
  private readonly onScroll: () => void;
  private scrollTimer: number | null = null;
  private loadSeq = 0;
  private loadAbort: AbortController | null = null;

  constructor(mount: HTMLElement) {
    this.shell = buildShell(mount);
    this.onScroll = () => this.memoScroll();
    this.shell.viewer.addEventListener("scroll", this.onScroll, { passive: true });
    this.shell.viewer.addEventListener("contextmenu", (e) => this.viewerContext(e));
    // Right-click's mousedown can collapse the selection before contextmenu
    // fires, so the resolved frame is stashed here and reused by viewerContext.
    this.shell.viewer.addEventListener(
      "mousedown",
      (e) => {
        if (e.button !== 2) return;
        this.pendingSelection =
          this.view && this.view.kind !== "json"
            ? captureSelection(this.shell.viewer, this.view.surfaces)
            : null;
      },
      true
    );
    void this.boot();
  }

  // Right-clicking the page itself (marks/segments stopPropagation) offers a
  // selection menu when text is selected, otherwise a page-scoped note.
  // Suppressed while a mark or segment tool owns the pointer.
  private viewerContext(e: MouseEvent): void {
    if (!this.view || this.view.kind === "json") return;
    if (this.mode !== "none" || this.drawTool) return;
    const captured =
      this.pendingSelection ?? captureSelection(this.shell.viewer, this.view.surfaces);
    this.pendingSelection = null;
    if (captured) {
      e.preventDefault();
      this.selectionMenu(captured, e.clientX, e.clientY);
      return;
    }
    e.preventDefault();
    openContextMenu(
      {
        title: "Page",
        items: [...this.noteMenuItems("page", PAGE_OWNER, e.clientX, e.clientY)]
      },
      e.clientX,
      e.clientY
    );
  }

  private async boot(): Promise<void> {
    const theme = await loadTheme();
    this.applyTheme(theme);
    this.wire();
    this.toolbar.setThemeIcon(theme);
    this.applyDebugParam();

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
      onPlay: (id) => void this.openPlayer(id),
      onClear: () => void this.clearAll(),
      onNote: (id, kind, x, y) => this.openNoteTarget(kind, id, x, y),
      hasNote: (id) => this.hasNote(id)
    });

    this.player = new Player(
      this.shell.player,
      {
        loadPage: (page, scale) => this.loadPageImage(page, scale),
        marksFor: (segmentId) => this.marksForSegment(segmentId)
      },
      { onClose: () => undefined }
    );

    this.notesPanel = new NotesPanel(this.shell.notes, {
      onFocus: (id) => this.focusNote(id),
      onEdit: (id, anchor) => this.editNote(id, anchor),
      onDelete: (id) => void this.deleteNote(id)
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
      onGoToPage: (page) => this.view?.goToPage?.(page),
      onToggleInspect: () => this.toggleInspect(),
      onToggleLine: () => this.toggleLineMode(),
      onToggleTextDebug: () => this.applyTextDebug(),
      onToggleExplorer: () => this.toggleExplorer(),
      onToggleOutline: () => this.toggleRail("outline"),
      onToggleNotes: () => this.toggleRail("notes")
    });
  }

  // Applies the PDF text-layer debug level to the current view (no-op otherwise).
  private applyTextDebug(): void {
    const level = this.toolbar.getTextDebug();
    this.view?.setTextDebug?.(level);
  }

  // ?debug=text shows glyph boxes; ?debug=text-full also paints the glyphs.
  private applyDebugParam(): void {
    const mode = new URLSearchParams(window.location.search).get("debug");
    if (mode === "text") this.toolbar.setTextDebug(1);
    else if (mode === "text-full") this.toolbar.setTextDebug(2);
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
    await kvRemove(this.scrollKey(id));
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
    this.leftCollapsed = prefs.leftCollapsed;
    this.railOpen = prefs.railOpen;
    this.railTab = prefs.railTab;
    this.applyLeftCollapsed();
    this.toolbar.setExplorer(!this.leftCollapsed);

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

    const seq = this.loadSeq;
    const abort = new AbortController();
    this.loadAbort = abort;

    this.shell.viewer.classList.remove("empty");
    this.shell.viewer.innerHTML = "";
    this.showLoading();
    this.toolbar.setTitle(path);
    this.explorer.setActive(path);
    this.explorer.revealActive();
    this.currentPath = path;
    // On narrow screens the explorer is an overlay drawer; opening a document
    // should reveal it, so tuck the drawer away.
    if (window.matchMedia("(max-width: 900px)").matches && !this.leftCollapsed) {
      this.leftCollapsed = true;
      this.applyLeftCollapsed();
      this.toolbar.setExplorer(false);
    }

    let view: DocView;
    try {
      view = await adapter.load({
        vault: this.vault.handle,
        path,
        handle,
        container: this.shell.viewer,
        signal: abort.signal
      });
    } catch (err) {
      if (seq !== this.loadSeq || (err as { name?: string }).name === "AbortError") return;
      this.hideLoading();
      this.shell.viewer.textContent = "Failed to open document.";
      console.error(`Failed to open ${path}`, err);
      return;
    }

    // A newer openPath() call already superseded this one; discard the
    // now-unwanted view instead of mounting it over whatever loaded after it.
    if (seq !== this.loadSeq) {
      view.destroy();
      return;
    }
    this.hideLoading();
    this.view = view;

    this.setupZoom(view);
    this.applyTextDebug();
    this.openRailFor(view);
    await this.attachOverlay(view);
    await this.restoreScroll(path);
    await this.prefs.pushRecent(path);
  }

  private showLoading(): void {
    const el = document.createElement("div");
    el.className = "viewer-loading";
    el.textContent = "Loading…";
    this.shell.viewer.appendChild(el);
  }

  private hideLoading(): void {
    this.shell.viewer.querySelector(".viewer-loading")?.remove();
  }

  private setupZoom(view: DocView): void {
    this.zoomCtl?.destroy();
    this.zoomCtl = null;
    this.toolbar.setZoomVisible(!!view.setZoom);
    this.toolbar.setTextDebugVisible(!!view.setTextDebug);
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
    const map = (await kvGet<Record<string, number>>(this.scrollKey(vaultId))) ?? {};
    for (const [k, v] of Object.entries(map)) this.scrollMemo.set(k, v);
  }

  private memoScroll(): void {
    if (!this.currentPath || !this.vault) return;
    if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer);
    const path = this.currentPath;
    const key = this.scrollKey(this.vault.id);
    this.scrollTimer = window.setTimeout(() => {
      this.scrollMemo.set(path, this.shell.viewer.scrollTop);
      void kvSet(key, Object.fromEntries(this.scrollMemo));
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
      ownerFor: (geom) => this.resolveOwner(geom),
      ownerLabel: (owner) => this.ownerLabel(owner),
      hasNote: (id) => this.hasNote(id),
      onNote: (id, x, y) => this.openNoteTarget("region", id, x, y)
    });
    overlay.setMode(this.mode);
    overlay.setInspect(this.inspect);
    overlay.setLineMode(this.lineMode);
    this.overlay = overlay;

    this.segments = model.segments;
    this.markers = model.markers;
    this.notes = model.notes;
    this.activeId = null;
    this.activeKind = "segment";
    this.drawTool = null;
    this.segLayer = new SegmentLayer(view.surfaces, {
      onSelect: (id, kind) => this.selectEntry(id, kind),
      onContext: (id, kind, x, y) => this.openEntryMenu(id, kind, x, y),
      getActive: () => this.activeId,
      hasNote: (id) => this.hasNote(id),
      onNoteBadge: (id, kind, x, y) => this.openNoteTarget(kind, id, x, y)
    });
    this.segLayer.setData(this.segments, this.markers);
    this.segLayer.setVisible(this.segments.length > 0 || this.markers.length > 0);
    this.segDrawer = new SegmentDrawer(view.surfaces, {
      onDraw: (span) => void this.addSegmentFromDraw(span),
      onMarker: (page, y) => void this.addMarker(page, y)
    });
    this.syncInteractivity();
    this.refreshOutline();
    this.refreshNotes();
    this.updateRailVisibility();
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
    // Counts must be set before render so the badges are drawn in one pass.
    this.outline.setInspect(this.inspect, this.inspect ? this.inspectCounts() : new Map());
    this.outline.render(this.segments, this.markers);
    this.outline.setActive(this.activeId);
  }

  // Per-segment count of marks the player would resolve to it, so inspect mode
  // reveals questions whose occlusions are owned by a container or the page.
  private inspectCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const seg of this.segments) {
      if (seg.role !== "question") continue;
      counts.set(seg.id, this.marksForSegment(seg.id).length);
    }
    return counts;
  }

  // The right rail hosts the outline and notes panels on tabs. The outline only
  // makes sense for paged surfaces; notes work for any document kind.
  private updateRailVisibility(): void {
    const outlineSupported = this.view?.kind === "pdf" || this.view?.kind === "image";
    if (!outlineSupported && this.railTab === "outline") this.railTab = "notes";
    if (!this.view) this.railOpen = false;

    const ws = this.shell.root.querySelector(".workspace");
    const showRail = this.railOpen && !!this.view;
    this.shell.rail.classList.toggle("hidden", !showRail);
    ws?.classList.toggle("has-rail", showRail);
    this.renderRailTabs(outlineSupported);
    this.shell.outline.classList.toggle("hidden", this.railTab !== "outline");
    this.shell.notes.classList.toggle("hidden", this.railTab !== "notes");
    this.toolbar.setOutline(this.railOpen && outlineSupported && this.railTab === "outline");
    this.toolbar.setNotes(this.railOpen && this.railTab === "notes");
  }

  // Opening a paged document shows the outline by default until the user has
  // made a rail choice; afterwards their last choice is respected.
  private openRailFor(view: DocView): void {
    if (this.prefs.get().railConfigured) return;
    if (view.kind === "pdf" || view.kind === "image") {
      this.railOpen = true;
      this.railTab = "outline";
    }
  }

  private renderRailTabs(outlineSupported: boolean): void {
    this.shell.railTabs.innerHTML = "";
    const tab = (kind: "outline" | "notes", label: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "rail-tab" + (this.railTab === kind ? " active" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        this.railTab = kind;
        this.railOpen = true;
        this.updateRailVisibility();
        void this.prefs.update({ railOpen: true, railTab: kind, railConfigured: true });
      });
      return b;
    };
    if (outlineSupported) this.shell.railTabs.appendChild(tab("outline", "Outline"));
    this.shell.railTabs.appendChild(tab("notes", "Notes"));

    // Collapse the whole rail without hunting for the toolbar button.
    const close = document.createElement("button");
    close.className = "rail-close";
    close.textContent = "×";
    close.title = "collapse panel";
    close.addEventListener("click", () => {
      this.railOpen = false;
      this.updateRailVisibility();
      void this.prefs.update({ railOpen: false, railConfigured: true });
    });
    this.shell.railTabs.appendChild(close);
  }

  private toggleRail(kind: "outline" | "notes"): void {
    if (!this.view) return;
    if (this.railOpen && this.railTab === kind) {
      this.railOpen = false;
    } else {
      this.railOpen = true;
      this.railTab = kind;
    }
    this.updateRailVisibility();
    void this.prefs.update({ railOpen: this.railOpen, railTab: this.railTab, railConfigured: true });
  }

  private toggleExplorer(): void {
    if (!this.vault) return;
    this.leftCollapsed = !this.leftCollapsed;
    this.applyLeftCollapsed();
    this.toolbar.setExplorer(!this.leftCollapsed);
    void this.prefs.update({ leftCollapsed: this.leftCollapsed });
  }

  private applyLeftCollapsed(): void {
    this.shell.root.classList.toggle("left-collapsed", this.leftCollapsed);
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
    items.push(...this.noteMenuItems(kind, id, clientX, clientY));
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
      },
      ...this.noteMenuItems("region", id, clientX, clientY),
      {
        label: region.kind === "occlusion" ? "Convert to highlight" : "Convert to occlusion",
        onSelect: () => {
          this.overlay?.setKind(id, region.kind === "occlusion" ? "highlight" : "occlusion");
          void this.persist();
        }
      }
    ];
    if (region.kind === "occlusion") {
      items.push("separator");
      const names = ["Blue", "Yellow", "Green", "Pink", "Purple"];
      OCCLUSION_PALETTE.forEach((color, i) => {
        items.push({
          label: names[i] ?? color,
          swatch: color,
          onSelect: () => {
            this.overlay?.setColor(id, color);
            void this.persist();
          }
        });
      });
      items.push({
        label: "Custom color…",
        onSelect: () => this.pickRegionColor(id, region.color)
      });
    }
    // Attach to the selected segment, or detach back to page scope.
    if (ownerSeg) {
      items.push({
        label: `Detach from ${this.ownerLabel(region.owner)}`,
        onSelect: () => {
          this.overlay?.setOwner(id, PAGE_OWNER);
          void this.persist();
          this.refreshOutline();
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
            this.refreshOutline();
          }
        });
      }
    }
    // Snap to the smallest containing segment, fixing container/page owners.
    const container = smallestContainingSegment(region, this.segments);
    if (container && container.id !== region.owner) {
      items.push({
        label: `Snap to containing ${this.ownerLabel(container.id)}`,
        hint: "fix attachment",
        onSelect: () => {
          this.overlay?.setOwner(id, container.id);
          void this.persist();
          this.refreshOutline();
        }
      });
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

  // Native color picker: live-previews on every drag tick, persists once the
  // user commits so dragging the wheel doesn't spam sidecar writes.
  private pickRegionColor(id: string, current: string): void {
    const input = document.createElement("input");
    input.type = "color";
    input.value = /^#[0-9a-fA-F]{6}$/.test(current) ? current : DEFAULT_OCCLUSION_COLOR;
    input.style.position = "fixed";
    input.style.opacity = "0";
    input.style.pointerEvents = "none";
    document.body.appendChild(input);
    input.addEventListener("input", () => this.overlay?.setColor(id, input.value, { silent: true }));
    input.addEventListener("change", () => this.overlay?.setColor(id, input.value));
    input.addEventListener("blur", () => window.setTimeout(() => input.remove(), 0));
    input.click();
  }

  // ---- Notes ------------------------------------------------------------

  // A selection becomes one region per surface, each a single union box hugging
  // the selected words. With a word-level OCR text layer this is exactly the
  // phrase box; no grouping is needed.
  private buildSelectionRegions(captured: CapturedSelection, kind: RegionKind): Region[] {
    const color = kind === "highlight" ? "#f5c518" : DEFAULT_OCCLUSION_COLOR;
    return captured.hulls.map((h) => ({
      id: `r_${Math.random().toString(36).slice(2, 9)}`,
      surface: h.surface,
      kind,
      x: h.x,
      y: h.y,
      w: h.w,
      h: h.h,
      color,
      owner: this.resolveOwner(h),
      revealed: false
    }));
  }

  // Adds a mark (and optionally a note carrying the quoted text) for the current
  // selection, then clears the selection so the new mark is what you see.
  private markFromSelection(
    captured: CapturedSelection,
    kind: RegionKind,
    withNote: boolean,
    anchor?: { x: number; y: number }
  ): void {
    const overlay = this.overlay;
    if (!overlay || !this.view) return;
    const regions = this.buildSelectionRegions(captured, kind);
    for (const r of regions) overlay.getRegions().push(r);
    overlay.repaint();
    document.getSelection()?.removeAllRanges();
    void this.persist();

    if (withNote && regions[0]) {
      this.openNoteForRegion(regions[0], captured.quote, anchor ?? this.hullAnchor(captured));
    }
  }

  // Center of the first selection hull, in viewport coords, used to place the
  // note editor next to the words just marked.
  private hullAnchor(captured: CapturedSelection): { x: number; y: number } {
    const hull = captured.hulls[0];
    const surface = this.view?.surfaces.find((s) => s.index === hull.surface);
    if (!surface) return { x: window.innerWidth / 2, y: 120 };
    const rect = surface.el.getBoundingClientRect();
    return { x: rect.left + (hull.x + hull.w / 2) * rect.width, y: rect.top + (hull.y + hull.h) * rect.height + 6 };
  }

  // Opens the note editor for a freshly made region, prefilling the quote so the
  // mark and its note are created together.
  private openNoteForRegion(region: Region, quote: string, anchor: { x: number; y: number }): void {
    const anchorInfo = this.noteAnchor("region", region.id);
    const existing = this.notes.find((n) => n.target === anchorInfo.target);
    const label = this.noteLabel(anchorInfo.kind, anchorInfo.target);
    const page = this.notePage(anchorInfo.kind, anchorInfo.target);
    openNoteEditor({
      title: `Note · ${label}${page !== undefined ? ` · p${page + 1}` : ""}`,
      quote: existing?.quote ?? quote,
      initial: existing?.body ?? "",
      path: this.currentPath ?? "",
      anchor,
      onSave: (body) => void this.saveNote(anchorInfo.kind, anchorInfo.target, body, existing, quote),
      onDelete: existing ? () => void this.deleteNote(existing.id) : undefined
    });
  }

  // Right-click menu for a text selection, offered before the page menu.
  private selectionMenu(captured: CapturedSelection, x: number, y: number): void {
    const items: ContextMenuEntry[] = [
      { label: "Highlight selection", onSelect: () => this.markFromSelection(captured, "highlight", false) },
      {
        label: "Highlight + note…",
        hint: "markdown",
        onSelect: () => this.markFromSelection(captured, "highlight", true, { x, y })
      },
      "separator",
      { label: "Occlude selection", onSelect: () => this.markFromSelection(captured, "occlusion", false) },
      {
        label: "Occlude + note…",
        hint: "cloze answer",
        onSelect: () => this.markFromSelection(captured, "occlusion", true, { x, y })
      },
      "separator",
      {
        label: "Note on selection…",
        hint: "no mark",
        onSelect: () => this.noteOnSelection(captured, x, y)
      },
      "separator",
      { label: "Copy", onSelect: () => void navigator.clipboard.writeText(captured.quote) }
    ];
    openContextMenu({ title: "Selection", items }, x, y);
  }

  // A note with no mark: it hangs off the page carrying the quoted text only.
  private noteOnSelection(captured: CapturedSelection, x: number, y: number): void {
    document.getSelection()?.removeAllRanges();
    const target = `${PAGE_OWNER}:${captured.surface}`;
    const existing = this.notes.find((n) => n.target === target);
    openNoteEditor({
      title: `Note · Page ${captured.surface + 1}`,
      quote: existing?.quote ?? captured.quote,
      initial: existing?.body ?? "",
      path: this.currentPath ?? "",
      anchor: { x, y },
      onSave: (body) => void this.saveNote("page", target, body, existing, captured.quote),
      onDelete: existing ? () => void this.deleteNote(existing.id) : undefined
    });
  }

  // A region that belongs to a reveal group carries one note for the whole
  // group, so a multi-line swipe is annotated once rather than per box.
  private noteAnchor(targetKind: NoteTargetKind, id: string): { target: string; kind: NoteTargetKind } {
    if (targetKind === "region") {
      const region = this.overlay?.getRegions().find((r) => r.id === id);
      if (region?.groupId) return { target: region.groupId, kind: "group" };
    }
    // A page note is scoped to the page you clicked, not the whole document.
    if (targetKind === "page") return { target: `${PAGE_OWNER}:${this.pageIndex()}`, kind: "page" };
    return { target: id, kind: targetKind };
  }

  private pageIndex(): number {
    return Math.max(0, (this.view?.currentPage?.() ?? 1) - 1);
  }

  private hasNote(id: string): boolean {
    const region = this.overlay?.getRegions().find((r) => r.id === id);
    if (region?.groupId && this.notes.some((n) => n.target === region.groupId)) return true;
    return this.notes.some((n) => n.target === id);
  }

  private notePage(kind: NoteTargetKind, target: string): number | undefined {
    if (kind === "region" || kind === "group") {
      const regions = this.overlay?.getRegions() ?? [];
      const r =
        kind === "region" ? regions.find((x) => x.id === target) : regions.find((x) => x.groupId === target);
      return r?.surface;
    }
    if (kind === "marker") return this.markers.find((m) => m.id === target)?.page;
    if (kind === "page") {
      const n = Number(target.split(":")[1]);
      return Number.isFinite(n) ? n : 0;
    }
    if (kind === "segment") return this.segments.find((s) => s.id === target)?.spans[0]?.page;
    return undefined;
  }

  private noteLabel(kind: NoteTargetKind, target: string): string {
    if (kind === "region") {
      const r = this.overlay?.getRegions().find((x) => x.id === target);
      return r ? (r.kind === "highlight" ? "Highlight" : "Occlusion") : "Mark";
    }
    if (kind === "group") return "Mark group";
    if (kind === "page") return "Page";
    if (kind === "marker") {
      return this.markers.find((m) => m.id === target)?.label.replace(/^#+\s*/, "").trim() || "Marker";
    }
    const seg = this.segments.find((s) => s.id === target);
    if (!seg) return "Segment";
    return `${seg.label.replace(/^#+\s*/, "").trim() || seg.role} (${seg.role})`;
  }

  // Opens the editor for an anchor, creating the note on first save. Existing
  // notes open prefilled; an editor on a blank note deletes it when cleared.
  private openNoteTarget(kind: NoteTargetKind, id: string, x: number, y: number): void {
    const anchor = this.noteAnchor(kind, id);
    const existing = this.notes.find((n) => n.target === anchor.target);
    const label = this.noteLabel(anchor.kind, anchor.target);
    const page = this.notePage(anchor.kind, anchor.target);
    openNoteEditor({
      title: `Note · ${label}${page !== undefined ? ` · p${page + 1}` : ""}`,
      quote: existing?.quote,
      initial: existing?.body ?? "",
      path: this.currentPath ?? "",
      anchor: { x, y },
      onSave: (body) => void this.saveNote(anchor.kind, anchor.target, body, existing),
      onDelete: existing ? () => void this.deleteNote(existing.id) : undefined
    });
  }

  private editNote(noteId: string, anchor: { x: number; y: number }): void {
    const note = this.notes.find((n) => n.id === noteId);
    if (!note) return;
    const label = this.noteLabel(note.targetKind, note.target);
    openNoteEditor({
      title: `Note · ${label}${note.page !== undefined ? ` · p${note.page + 1}` : ""}`,
      quote: note.quote,
      initial: note.body,
      path: this.currentPath ?? "",
      anchor,
      onSave: (body) => void this.saveNote(note.targetKind, note.target, body, note),
      onDelete: () => void this.deleteNote(note.id)
    });
  }

  private async saveNote(
    kind: NoteTargetKind,
    target: string,
    body: string,
    existing: Note | undefined,
    quote?: string
  ): Promise<void> {
    const now = Date.now();
    if (existing) {
      existing.body = body;
      existing.updatedAt = now;
      existing.page ??= this.notePage(kind, target);
      if (!existing.quote && quote) existing.quote = quote;
    } else {
      this.notes.push({
        id: `n_${Math.random().toString(36).slice(2, 9)}`,
        target,
        targetKind: kind,
        body,
        quote: quote?.trim() ? quote.trim() : undefined,
        page: this.notePage(kind, target),
        createdAt: now,
        updatedAt: now
      });
    }
    this.refreshNotes();
    this.overlay?.repaint();
    this.segLayer?.setData(this.segments, this.markers);
    await this.persistNotes();
  }

  private async deleteNote(noteId: string): Promise<void> {
    this.notes = this.notes.filter((n) => n.id !== noteId);
    this.refreshNotes();
    this.overlay?.repaint();
    this.segLayer?.setData(this.segments, this.markers);
    await this.persistNotes();
  }

  // Brings a note's anchor into view and selects it where applicable.
  private focusNote(noteId: string): void {
    const note = this.notes.find((n) => n.id === noteId);
    if (!note) return;
    if (note.targetKind === "segment") {
      this.selectEntry(note.target, "segment");
      this.segLayer?.scrollTo(note.target);
      return;
    }
    if (note.targetKind === "marker") {
      this.selectEntry(note.target, "marker");
      this.segLayer?.scrollTo(note.target);
      return;
    }
    if (note.targetKind === "page") {
      this.view?.goToPage?.((note.page ?? 0) + 1);
      return;
    }    // region / group: scroll the surface the mark sits on to the viewer center.
    const regions = this.overlay?.getRegions() ?? [];
    const r =
      note.targetKind === "region"
        ? regions.find((x) => x.id === note.target)
        : regions.find((x) => x.groupId === note.target);
    if (!r) return;
    const surface = this.view?.surfaces.find((s) => s.index === r.surface);
    surface?.el.scrollIntoView({ block: "center" });
  }

  private refreshNotes(): void {
    const rows: NoteRow[] = this.notes
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((n) => ({
        id: n.id,
        body: n.body,
        quote: n.quote,
        target: n.target,
        targetKind: n.targetKind,
        label: this.noteLabel(n.targetKind, n.target),
        page: n.page ?? this.notePage(n.targetKind, n.target) ?? null
      }));
    this.notesPanel.setRows(rows);
  }

  private async persistNotes(): Promise<void> {
    if (!this.store || !this.view || !this.currentPath) return;
    await this.store.saveNotes(this.currentPath, this.view.kind, this.notes);
  }

  private noteMenuItems(kind: NoteTargetKind, id: string, x: number, y: number): ContextMenuEntry[] {
    const anchor = this.noteAnchor(kind, id);
    const has = this.notes.some((n) => n.target === anchor.target);
    return [
      {
        label: has ? "Edit note…" : "Add note…",
        hint: "markdown",
        onSelect: () => this.openNoteTarget(kind, id, x, y)
      }
    ];
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
    // Re-home marks now that finer-grained questions exist to contain them.
    this.reassignMarkOwners();
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
    // Notes anchored to the deleted entry go with it, so none dangle.
    this.notes = this.notes.filter((n) => n.target !== id);
    // Marks that were attached to the deleted segment (or nested under it) fall
    // back to page scope rather than disappearing or dangling.
    this.overlay?.reassignOwners(new Set(this.segments.map((s) => s.id)));
    void this.persist();
    this.segLayer?.setData(this.segments, this.markers);
    this.refreshOutline();
    this.refreshNotes();
    this.overlay?.repaint();
    await this.persistSegments();
    await this.persistNotes();
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

  private async loadPageImage(page: number, scale: number): Promise<PageImage | null> {
    if (!this.view?.getPageImages) return null;
    const images = await this.view.getPageImages([page], scale);
    return images[0] ?? null;
  }

  // Re-homes mark owners against the current segments (after split/auto-segment).
  private reassignMarkOwners(): void {
    if (!this.overlay) return;
    assignOwners(this.overlay.getRegions(), this.segments, true);
    this.overlay.repaint();
  }

  private toggleInspect(): void {
    this.inspect = !this.inspect;
    this.toolbar.setInspect(this.inspect);
    this.overlay?.setInspect(this.inspect);
    this.refreshOutline();
  }

  private toggleLineMode(): void {
    this.lineMode = !this.lineMode;
    this.toolbar.setLine(this.lineMode);
    this.overlay?.setLineMode(this.lineMode);
  }

  // Human-readable owner label for inspect mode badges and menus.
  private ownerLabel(owner: string): string {
    if (owner === PAGE_OWNER) return "page";
    const seg = this.segments.find((s) => s.id === owner);
    if (!seg) return "orphan";
    const text = seg.label.replace(/^#+\s*/, "").trim() || seg.role;
    return `${text} (${seg.role})`;
  }

  // Marks shown for a question in play mode: those attached to it, plus any
  // mark that geometrically sits inside its box but is not attached to a
  // different question (covers free and container-owned marks).
  private marksForSegment(segmentId: string): Region[] {
    const regions = this.overlay?.getRegions() ?? [];
    const seg = this.segments.find((s) => s.id === segmentId);
    const span = seg?.spans[0];
    return regions.filter((r) => {
      if (r.owner === segmentId) return true;
      if (!span || r.surface !== span.page) return false;
      const inside =
        r.x >= span.x - 1e-6 &&
        r.y >= span.y - 1e-6 &&
        r.x + r.w <= span.x + span.w + 1e-6 &&
        r.y + r.h <= span.y + span.h + 1e-6;
      if (!inside) return false;
      // Another question that also contains it is the truer owner.
      if (r.owner !== PAGE_OWNER) {
        const owner = this.segments.find((s) => s.id === r.owner);
        if (owner?.role === "question") return false;
      }
      return true;
    });
  }

  // Opens a one-question-at-a-time player. Scope: the selected questions
  // container's descendants, or a single selected question, or all questions.
  private openPlayer(id: string): void {
    if (!this.view?.getPageImages) {
      window.alert("Play mode supports PDFs.");
      return;
    }
    const tree = buildOutlineTree(this.segments, this.markers);
    const collect = (nodes: OutlineNode[], acc: Segment[]): void => {
      for (const n of nodes) {
        const seg = n.kind === "segment" ? this.segments.find((s) => s.id === n.id) : undefined;
        if (seg && seg.role === "question") acc.push(seg);
        collect(n.children, acc);
      }
    };

    let scope: Segment[] = [];
    const picked = this.segments.find((s) => s.id === id);
    if (picked?.role === "questions") {
      const node = findNode(tree, id);
      collect(node ? node.children : [], scope);
    } else if (picked?.role === "question") {
      scope = [picked];
    } else {
      scope = this.segments.filter((s) => s.role === "question");
    }

    scope.sort((a, b) => {
      const pa = a.spans[0]?.page ?? 0;
      const pb = b.spans[0]?.page ?? 0;
      return pa - pb || (a.spans[0]?.y ?? 0) - (b.spans[0]?.y ?? 0);
    });

    if (!scope.length) {
      window.alert("No questions to play. Split a questions container first.");
      return;
    }

    this.player.start(
      scope.map((s) => ({
        id: s.id,
        label: s.label.replace(/^#+\s*/, "") || "question",
        span: s.spans[0] ?? null
      }))
    );
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
      this.reassignMarkOwners();
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
    // Supersede any load still in flight: bumping loadSeq makes openPath()
    // discard it when it resolves, and aborting lets the adapter itself bail
    // out of expensive setup early instead of racing the new load.
    this.loadSeq++;
    this.loadAbort?.abort();
    this.loadAbort = null;
    if (this.player.isOpen()) this.player.close();
    this.overlay?.destroy();
    this.overlay = null;
    this.segDrawer?.destroy();
    this.segDrawer = null;
    this.segLayer?.destroy();
    this.segLayer = null;
    this.segments = [];
    this.markers = [];
    this.notes = [];
    this.activeId = null;
    this.drawTool = null;
    this.shell.rail.classList.add("hidden");
    this.shell.root.querySelector(".workspace")?.classList.remove("has-rail");
    this.toolbar.setOutline(false);
    this.toolbar.setNotes(false);
    this.zoomCtl?.destroy();
    this.zoomCtl = null;
    this.toolbar.setZoomVisible(false);
    this.toolbar.setTextDebugVisible(false);
    this.toolbar.setPage(1, 1);
    this.view?.destroy();
    this.view = null;
    this.refreshNotes();
  }
}
