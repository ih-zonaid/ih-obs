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
import {
  loadPageMode,
  loadTheme,
  nextPageMode,
  PAGE_FILTERS,
  PrefsStore,
  savePageMode,
  saveTheme,
  type LineDefault,
  type PageMode
} from "../store/prefs";
import { kvGet, kvRemove, kvSet } from "../store/kv";
import {
  anchorOf,
  anchorPage,
  assignOwners,
  buildOutlineTree,
  cardCrop,
  DEFAULT_OCCLUSION_COLOR,
  DEFAULT_RULES,
  HIGHLIGHT_COLOR,
  containsSpan,
  frames,
  isAnchor,
  isBox,
  isCard,
  isContainer,
  isFrame,
  isMark,
  markKind,
  newMarkId,
  newBoxId,
  OCCLUSION_PALETTE,
  PAGE_OWNER,
  parseLabel,
  roleOf,
  smallestContainingSpan,
  type Box,
  type BoxTag,
  type Card,
  type Entity,
  type Mark,
  type Note,
  type NoteTargetKind,
  type OutlineNode,
  type MarkKind,
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
import { icon } from "../ui/icons";
import { Outline } from "../ui/outline";
import { NotesPanel, type NoteRow } from "../ui/notesPanel";
import { openNoteEditor } from "../ui/notePopover";
import { Palette } from "../ui/palette";
import { Player } from "../ui/player";
import { SegmentDrawer, type DrawTool } from "../ui/segmentDraw";
import { SegmentLayer } from "../ui/segmentLayer";
import { Transform, type TransformTarget } from "../ui/transform";
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
  private transform: Transform | null = null;
  private entities: Entity[] = [];
  private notes: Note[] = [];
  private activeId: string | null = null;
  private activeKind: "box" | "mark" = "box";
  private drawTool: DrawTool | null = null;
  private zoomCtl: ZoomController | null = null;
  private mode: OverlayMode = "none";
  private inspect = false;
  private railOpen = false;
  private railTab: "outline" | "notes" = "outline";
  private leftCollapsed = false;
  private pendingSelection: CapturedSelection | null = null;
  private currentPath: string | null = null;
  private scrollMemo = new Map<string, number>();
  private pageMode: PageMode = "off";
  private lineDefault: LineDefault = "none";
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

  // ---- Entity accessors --------------------------------------------------

  private boxes(): Box[] {
    return this.entities.filter(isBox);
  }

  private marks(): Mark[] {
    return this.entities.filter(isMark);
  }

  private boxById(id: string): Box | undefined {
    return this.entities.find((e) => e.id === id && isBox(e)) as Box | undefined;
  }

  private markById(id: string): Mark | undefined {
    return this.entities.find((e) => e.id === id && isMark(e)) as Mark | undefined;
  }

  // Right-clicking the page itself (marks/boxes stopPropagation) offers a
  // selection menu when text is selected, otherwise a page-scoped note.
  // Suppressed while a mark or box tool owns the pointer.
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
    this.pageMode = await loadPageMode();
    this.wire();
    this.toolbar.setThemeIcon(theme);
    this.toolbar.setPageMode(this.pageMode);
    this.applyPageMode();
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
      onLabel: (id, label) => void this.setLabel(id, label),
      onDelete: (id) => void this.deleteEntry(id),
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
        // A play item id is a box id for question play and a mark id for card
        // play; resolve whichever it is.
        marksFor: (id) => this.marksForPlayerItem(id)
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
      onCyclePageMode: () => void this.cyclePageMode(),
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
    // The page tone is only meaningful on a dark app theme; mirror that onto
    // the shell so the CSS page-tint rules can key off it.
    this.shell.root.dataset.pageTheme = theme;
  }

  private async toggleTheme(): Promise<void> {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    await saveTheme(next);
    this.applyTheme(next);
    this.toolbar.setThemeIcon(next);
    // The effective page tone depends on the app theme (see applyPageMode).
    this.applyPageMode();
  }

  // Cycles the raster page's tone independently of the app theme: normal →
  // inverted → warm dim. Persisted like the theme.
  private async cyclePageMode(): Promise<void> {
    const next = nextPageMode(this.pageMode);
    this.pageMode = next;
    await savePageMode(next);
    this.applyPageMode();
    this.toolbar.setPageMode(next);
  }

  private applyPageMode(): void {
    const tint = this.pageMode === "invert" ? "on" : this.pageMode;
    this.shell.root.dataset.pageTint = tint;
    // Mirrors the CSS: the tone only applies on a dark app theme, and play mode
    // composites the raster itself so it needs the filter passed down.
    const dark = document.documentElement.dataset.theme !== "light";
    this.player?.setPageFilter(dark ? PAGE_FILTERS[this.pageMode] : "none");
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
    this.lineDefault = prefs.lineDefault ?? "none";
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
    // Only raster documents (PDF pages, images) have a page tone to set.
    this.toolbar.setPageModeVisible(view.kind === "pdf" || view.kind === "image");
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
        this.transform?.repaint();
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
    const marks = model.entities.filter(isMark);
    const boxes = model.entities.filter(isBox);
    assignOwners(marks, boxes);
    const overlay = new Overlay(view.surfaces, marks, {
      onChange: () => void this.persist(),
      onContext: (id, x, y) => this.openMarkMenu(id, x, y),
      onPendingContext: (x, y) => this.openPendingLineMenu(x, y),
      onLineContext: (x, y) => this.openLineSettings(x, y),
      ownerFor: (geom) => this.resolveOwner(geom),
      ownerLabel: (owner) => this.ownerLabel(owner),
      hasNote: (id) => this.hasNote(id),
      onNote: (id, x, y) => this.openNoteTarget("mark", id, x, y)
    });
    overlay.setMode(this.mode);
    overlay.setInspect(this.inspect);
    overlay.setLineDefault(this.lineDefault);
    this.overlay = overlay;

    this.entities = model.entities;
    this.notes = model.notes;
    this.activeId = null;
    this.activeKind = "box";
    this.drawTool = null;
    this.segLayer = new SegmentLayer(view.surfaces, {
      onSelect: (id, kind) => this.selectEntry(id, kind),
      onContext: (id, kind, x, y) => this.openEntryMenu(id, kind, x, y),
      getActive: () => this.activeId,
      hasNote: (id) => this.hasNote(id),
      onNoteBadge: (id, kind, x, y) => this.openNoteTarget(kind, id, x, y)
    });
    this.segLayer.setData(this.entities);
    this.segLayer.setVisible(this.boxes().length > 0);
    this.segDrawer = new SegmentDrawer(view.surfaces, {
      onBox: (span) => void this.addBoxFromDraw(span),
      onAnchor: (page, y) => void this.addAnchor(page, y)
    });
    this.transform = new Transform(view.surfaces, {
      getTarget: () => this.transformTarget(),
      onPreview: (span, origin) => this.transformSpan(this.activeId, span, origin),
      onCommit: (span, origin) => {
        this.transformSpan(this.activeId, span, origin);
        void this.persistEntities();
      },
      onCancel: (origin) => this.transformSpan(this.activeId, origin, origin),
      onClick: () => this.revealActiveMark(),
      onContext: (x, y) => {
        if (!this.activeId) return;
        if (this.activeKind === "mark") this.openMarkMenu(this.activeId, x, y);
        else this.openEntryMenu(this.activeId, "box", x, y);
      },
      onDeselect: () => this.clearSelection()
    });
    this.syncInteractivity();
    this.refreshOutline();
    this.refreshNotes();
    this.updateRailVisibility();
  }

  // The entity the transform frame should frame. Only the active entity is
  // ever framed — nothing appears on its own. Anchors are move-only (their
  // width is fixed full-page by construction); every other entity gets all
  // eight handles.
  private transformTarget(): TransformTarget | null {
    if (!this.activeId) return null;
    const span =
      this.activeKind === "box" ? this.boxById(this.activeId)?.spans[0] : this.markById(this.activeId)?.spans[0];
    if (!span) return null;
    if (this.activeKind === "box") {
      const box = this.boxById(this.activeId);
      if (box && isAnchor(box)) return { span, handles: [], axis: "y" };
    }
    return { span, handles: ["nw", "n", "ne", "e", "se", "s", "sw", "w"] };
  }

  // Applies a transform result to the active entity. A multi-span entity is
  // moved by the same delta; resize only ever targets the framed first span.
  private transformSpan(id: string | null, span: Span, origin: Span): void {
    const entity = this.entities.find((e) => e.id === id);
    if (!entity || !entity.spans[0]) return;
    const dx = span.x - origin.x;
    const dy = span.y - origin.y;
    if (dx === 0 && dy === 0 && span.w === origin.w && span.h === origin.h) return;
    const resized = span.w !== origin.w || span.h !== origin.h;
    entity.spans[0] = { ...entity.spans[0], ...span };
    // Sibling spans follow a move; a resize (first span only) leaves them put.
    for (let i = 1; !resized && i < entity.spans.length; i++) {
      entity.spans[i] = {
        ...entity.spans[i],
        x: Math.min(1 - entity.spans[i].w, Math.max(0, entity.spans[i].x + dx)),
        y: Math.min(1 - entity.spans[i].h, Math.max(0, entity.spans[i].y + dy))
      };
    }
    this.segLayer?.setData(this.entities);
    this.overlay?.repaint();
  }

  // Clicking the selected mark's frame body reveals it, matching a plain mark
  // click (reveal is the common action; the frame exists for geometry edits).
  private revealActiveMark(): void {
    if (this.activeKind !== "mark" || !this.activeId) return;
    const mark = this.markById(this.activeId);
    if (!mark) return;
    // reveal() fires onChange, which persists.
    this.overlay?.reveal(mark.id, !mark.revealed);
  }

  // Explicit selection wins; otherwise the smallest containing box owns the
  // mark; otherwise it is a free page-level mark.
  private resolveOwner(geom: Span): string {
    if (this.activeKind === "box" && this.activeId) {
      const box = this.boxById(this.activeId);
      if (box && !isAnchor(box)) return box.id;
    }
    const contained = smallestContainingSpan(geom, this.boxes());
    return contained ? contained.id : PAGE_OWNER;
  }

  // Tool-owns-pointer: while a mark tool is active boxes go click-through;
  // while a box tool is active the mark overlay goes click-through.
  private syncInteractivity(): void {
    const markTool = this.mode !== "none";
    const boxTool = !!this.drawTool;
    this.overlay?.setInteractive(!boxTool);
    this.segLayer?.setInteractive(!markTool);
    // The transform frame is chrome for the selected entity, so it hides
    // whenever a tool is drawing or placing marks rather than editing.
    this.transform?.setVisible(!markTool && !boxTool);
  }

  private refreshOutline(): void {
    // Counts must be set before render so the badges are drawn in one pass.
    this.outline.setInspect(this.inspect, this.inspect ? this.inspectCounts() : new Map());
    this.outline.render(this.entities);
    this.outline.setActive(this.activeId);
  }

  // Per-box count of marks the player would resolve to it, so inspect mode
  // reveals questions whose occlusions are owned by a container or the page.
  private inspectCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const box of this.boxes()) {
      if (roleOf(box) !== "question") continue;
      counts.set(box.id, this.marksForBox(box.id).length);
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
    const tab = (kind: "outline" | "notes", label: string, iconName: "list" | "note"): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "rail-tab" + (this.railTab === kind ? " active" : "");
      b.appendChild(icon(iconName, 13));
      const text = document.createElement("span");
      text.textContent = label;
      b.appendChild(text);
      b.title = `show the ${label.toLowerCase()} panel`;
      b.setAttribute("aria-label", b.title);
      b.addEventListener("click", () => {
        this.railTab = kind;
        this.railOpen = true;
        this.updateRailVisibility();
        void this.prefs.update({ railOpen: true, railTab: kind, railConfigured: true });
      });
      return b;
    };
    if (outlineSupported) this.shell.railTabs.appendChild(tab("outline", "Outline", "list"));
    this.shell.railTabs.appendChild(tab("notes", "Notes", "note"));

    // Collapse the whole rail without hunting for the toolbar button.
    const close = document.createElement("button");
    close.className = "rail-close";
    close.appendChild(icon("x", 15));
    close.title = "collapse panel";
    close.setAttribute("aria-label", "collapse panel");
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

  private selectEntry(id: string, kind: "box" | "mark"): void {
    this.activeId = id;
    this.activeKind = kind;
    if (kind === "box") this.segLayer?.setVisible(true);
    // Update classes in place; a full re-render here would destroy the row that
    // the user just clicked and swallow the double-click.
    this.outline.setActive(id);
    this.segLayer?.scrollTo(id);
    this.transform?.repaint();
    if (this.drawTool === "split") {
      const container = this.selectedContainer();
      if (container) this.armSplit(container);
      else this.segDrawer?.resetSplit();
    }
  }

  private clearSelection(): void {
    this.activeId = null;
    this.outline.setActive(null);
    this.transform?.repaint();
  }

  // Right-click menus are spec-driven: add future actions as new entries here.
  private openEntryMenu(id: string, kind: "box" | "mark", clientX: number, clientY: number): void {
    const entry = kind === "mark" ? this.markById(id) : this.boxById(id);
    if (!entry) return;
    this.selectEntry(id, kind);

    const items: ContextMenuEntry[] = [];
    if (kind === "box") {
      const box = entry as Box;
      if (isFrame(box)) {
        items.push({
          label: "Play cards in frame",
          hint: "flashcards",
          onSelect: () => this.openPlayer(box.id)
        });
      }
      if (roleOf(box) === "questions") {
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
      label: kind === "mark" ? "Delete mark" : isFrame(entry as Box) ? "Delete frame" : "Delete box",
      danger: true,
      onSelect: () => void this.deleteEntry(id)
    });

    openContextMenu({ title: this.entryTitle(kind, entry), items }, clientX, clientY);
  }

  private openMarkMenu(id: string, clientX: number, clientY: number): void {
    const mark = this.markById(id);
    if (!mark) return;
    const kindLabel = markKind(mark) === "highlight" ? "Highlight" : "Occlusion";
    const ownerBox = mark.owner !== PAGE_OWNER ? this.boxById(mark.owner) : undefined;
    const ownerName = ownerBox ? this.boxText(ownerBox) : "page";
    const items: ContextMenuEntry[] = [
      {
        label: "Select / transform",
        hint: "move · resize",
        onSelect: () => this.selectEntry(id, "mark")
      },
      {
        label: mark.revealed ? "Hide" : "Reveal",
        onSelect: () => {
          this.overlay?.reveal(id, !mark.revealed);
          void this.persist();
        }
      },
      ...this.noteMenuItems("mark", id, clientX, clientY),
      {
        label: markKind(mark) === "occlusion" ? "Convert to highlight" : "Convert to occlusion",
        onSelect: () => {
          this.overlay?.setKind(id, markKind(mark) === "occlusion" ? "highlight" : "occlusion");
          void this.persist();
        }
      }
    ];
    if (markKind(mark) === "occlusion") {
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
        onSelect: () => this.pickMarkColor(id, mark.color ?? DEFAULT_OCCLUSION_COLOR)
      });
    }
    // Attach to the selected box, or detach back to page scope.
    if (ownerBox) {
      items.push({
        label: `Detach from ${this.ownerLabel(mark.owner)}`,
        onSelect: () => {
          this.overlay?.setOwner(id, PAGE_OWNER);
          void this.persist();
          this.refreshOutline();
        }
      });
    } else if (this.activeKind === "box" && this.activeId) {
      const target = this.boxById(this.activeId);
      if (target) {
        items.push({
          label: `Attach to "${this.boxText(target)}"`,
          onSelect: () => {
            this.overlay?.setOwner(id, target.id);
            void this.persist();
            this.refreshOutline();
          }
        });
      }
    }
    // Snap to the smallest containing box, fixing container/page owners.
    const span = mark.spans[0];
    const container = span ? smallestContainingSpan(span, this.boxes()) : null;
    if (container && container.id !== mark.owner) {
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
    items.push("separator", ...this.cardMenuItems(mark));
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

  // ---- Cards ------------------------------------------------------------

  // A mark becomes a flashcard only when the user says so; there is no
  // automatic promotion. The `card` object holds explicit box ids: a context
  // (question side) and a frame (crop clip).
  private cardMenuItems(mark: Mark): ContextMenuEntry[] {
    const items: ContextMenuEntry[] = [];
    if (!mark.card) {
      items.push({
        label: "Make card",
        hint: "flashcard",
        onSelect: () => {
          this.setCard(mark.id, {});
          this.refreshOutline();
        }
      });
      return items;
    }

    const contextName = mark.card.context ? this.ownerLabel(mark.card.context) : "band (default)";
    const frameName = mark.card.frame ? this.ownerLabel(mark.card.frame) : "none";
    items.push({ label: `Card context: ${contextName}`, disabled: true, onSelect: () => undefined });
    items.push({
      label: "Clear context",
      disabled: !mark.card.context,
      onSelect: () => this.setCardContext(mark.id, null)
    });
    const selected = this.selectedBox();
    if (selected) {
      items.push({
        label: `Use selected "${this.boxText(selected)}" as context`,
        onSelect: () => this.setCardContext(mark.id, selected.id)
      });
    }

    items.push({ label: `Card frame: ${frameName}`, disabled: true, onSelect: () => undefined });
    items.push({
      label: "Clear frame",
      disabled: !mark.card.frame,
      onSelect: () => this.setCardContext(mark.id, undefined)
    });
    const frameBoxes = frames(this.boxes());
    for (const f of frameBoxes) {
      if (f.id === mark.card.frame) continue;
      items.push({
        label: `Frame with "${this.boxText(f)}"`,
        onSelect: () => this.setCardContext(mark.id, undefined, f.id)
      });
    }

    items.push("separator");
    items.push({
      label: "Open in play…",
      hint: "this card",
      onSelect: () => this.playCards([mark])
    });
    items.push({
      label: "Remove card",
      danger: true,
      onSelect: () => this.setCard(mark.id, null)
    });
    return items;
  }

  // The box currently selected in the outline/page, when it is a real
  // container (never an anchor or a frame).
  private selectedBox(): Box | null {
    if (this.activeKind !== "box" || !this.activeId) return null;
    const box = this.boxById(this.activeId);
    if (!box || isAnchor(box) || isFrame(box)) return null;
    return box;
  }

  // `undefined` leaves an existing card's context alone; `null` clears it.
  private setCardContext(markId: string, context: string | null | undefined, frame?: string): void {
    const mark = this.markById(markId);
    if (!mark) return;
    const card: Card = { ...(mark.card ?? {}) };
    if (context === null) delete card.context;
    else if (context !== undefined) card.context = context;
    if (frame !== undefined) card.frame = frame;
    mark.card = card;
    this.overlay?.repaint();
    void this.persist();
    this.refreshOutline();
  }

  private setCard(markId: string, card: Card | null): void {
    const mark = this.markById(markId);
    if (!mark) return;
    if (card) mark.card = card;
    else delete mark.card;
    this.overlay?.repaint();
    void this.persist();
    this.refreshOutline();
  }

  // Plays an explicit list of card marks, cropping each by its derived card
  // crop. Order is document position (page, then y).
  private playCards(marks: Mark[]): void {
    if (!this.view?.getPageImages) {
      window.alert("Play mode supports PDFs.");
      return;
    }
    const cards = marks.filter(isCard);
    if (!cards.length) {
      window.alert("No cards in this scope. Make a mark a card first.");
      return;
    }
    cards.sort((a, b) => {
      const pa = a.spans[0]?.page ?? 0;
      const pb = b.spans[0]?.page ?? 0;
      return pa - pb || (a.spans[0]?.y ?? 0) - (b.spans[0]?.y ?? 0);
    });
    const entities = this.allEntities();
    this.player.start(
      cards.map((m) => ({
        id: m.id,
        label: m.label.replace(/^#+\s*/, "") || "card",
        span: m.spans[0] ?? null,
        crop: cardCrop(m, entities)
      }))
    );
  }

  // The full entity list as the app currently sees it, including any marks the
  // overlay has mutated but not yet synced back into `this.entities`.
  private allEntities(): Entity[] {
    if (!this.overlay) return this.entities;
    return [...this.entities.filter(isBox), ...this.overlay.getMarks()];
  }

  // Native color picker: live-previews on every drag tick, persists once the
  // user commits so dragging the wheel doesn't spam sidecar writes.
  private pickMarkColor(id: string, current: string): void {
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

  // A selection becomes one mark per surface, each a single union box hugging
  // the selected words. With a word-level OCR text layer this is exactly the
  // phrase box; no grouping is needed.
  private buildSelectionMarks(captured: CapturedSelection, kind: MarkKind): Mark[] {
    const color = kind === "highlight" ? "#f5c518" : DEFAULT_OCCLUSION_COLOR;
    return captured.hulls.map((h) => ({
      kind: "mark",
      id: newMarkId(),
      tags: [kind],
      label: "",
      spans: [{ page: h.surface, x: h.x, y: h.y, w: h.w, h: h.h }],
      color,
      owner: this.resolveOwner({ page: h.surface, x: h.x, y: h.y, w: h.w, h: h.h }),
      revealed: false
    }));
  }

  // Adds a mark (and optionally a note carrying the quoted text) for the current
  // selection, then clears the selection so the new mark is what you see.
  private markFromSelection(
    captured: CapturedSelection,
    kind: MarkKind,
    withNote: boolean,
    anchor?: { x: number; y: number }
  ): void {
    const overlay = this.overlay;
    if (!overlay || !this.view) return;
    const marks = this.buildSelectionMarks(captured, kind);
    for (const m of marks) this.entities.push(m);
    overlay.setMarks(this.marks());
    document.getSelection()?.removeAllRanges();
    void this.persist();

    if (withNote && marks[0]) {
      this.openNoteForMark(marks[0], captured.quote, anchor ?? this.hullAnchor(captured));
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

  // Opens the note editor for a freshly made mark, prefilling the quote so the
  // mark and its note are created together.
  private openNoteForMark(mark: Mark, quote: string, anchor: { x: number; y: number }): void {
    const anchorInfo = this.noteAnchor("mark", mark.id);
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

  // A mark that belongs to a reveal group carries one note for the whole
  // group, so a multi-line swipe is annotated once rather than per box.
  private noteAnchor(targetKind: NoteTargetKind, id: string): { target: string; kind: NoteTargetKind } {
    if (targetKind === "mark") {
      const mark = this.markById(id);
      if (mark?.groupId) return { target: mark.groupId, kind: "group" };
    }
    // A page note is scoped to the page you clicked, not the whole document.
    if (targetKind === "page") return { target: `${PAGE_OWNER}:${this.pageIndex()}`, kind: "page" };
    return { target: id, kind: targetKind };
  }

  private pageIndex(): number {
    return Math.max(0, (this.view?.currentPage?.() ?? 1) - 1);
  }

  private hasNote(id: string): boolean {
    const mark = this.markById(id);
    if (mark?.groupId && this.notes.some((n) => n.target === mark.groupId)) return true;
    return this.notes.some((n) => n.target === id);
  }

  private notePage(kind: NoteTargetKind, target: string): number | undefined {
    if (kind === "mark" || kind === "group") {
      const marks = this.marks();
      const m =
        kind === "mark" ? marks.find((x) => x.id === target) : marks.find((x) => x.groupId === target);
      return m?.spans[0]?.page;
    }
    if (kind === "box") return this.boxById(target)?.spans[0]?.page;
    if (kind === "page") {
      const n = Number(target.split(":")[1]);
      return Number.isFinite(n) ? n : 0;
    }
    return undefined;
  }

  private noteLabel(kind: NoteTargetKind, target: string): string {
    if (kind === "mark") {
      const m = this.markById(target);
      return m ? (markKind(m) === "highlight" ? "Highlight" : "Occlusion") : "Mark";
    }
    if (kind === "group") return "Mark group";
    if (kind === "page") return "Page";
    const box = this.boxById(target);
    if (!box) return "Box";
    if (isAnchor(box)) return box.label.replace(/^#+\s*/, "").trim() || "Anchor";
    return `${this.boxText(box)} (${roleOf(box)})`;
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
    this.segLayer?.setData(this.entities);
    await this.persistNotes();
  }

  private async deleteNote(noteId: string): Promise<void> {
    this.notes = this.notes.filter((n) => n.id !== noteId);
    this.refreshNotes();
    this.overlay?.repaint();
    this.segLayer?.setData(this.entities);
    await this.persistNotes();
  }

  // Brings a note's anchor into view and selects it where applicable.
  private focusNote(noteId: string): void {
    const note = this.notes.find((n) => n.id === noteId);
    if (!note) return;
    if (note.targetKind === "box") {
      this.selectEntry(note.target, "box");
      this.segLayer?.scrollTo(note.target);
      return;
    }
    if (note.targetKind === "page") {
      this.view?.goToPage?.((note.page ?? 0) + 1);
      return;
    }    // mark / group: scroll the surface the mark sits on to the viewer center.
    const marks = this.marks();
    const m =
      note.targetKind === "mark"
        ? marks.find((x) => x.id === note.target)
        : marks.find((x) => x.groupId === note.target);
    const page = m?.spans[0]?.page;
    if (page === undefined) return;
    const surface = this.view?.surfaces.find((s) => s.index === page);
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

  // Human-readable box text, used for titles and labels.
  private boxText(box: Box): string {
    return box.label.replace(/^#+\s*/, "").trim() || roleOf(box);
  }

  private entryTitle(kind: "box" | "mark", entry: Box | Mark): string {
    const label = entry.label.trim() || (kind === "mark" ? "mark" : "box");
    const page = entry.spans[0]?.page ?? 0;
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

  private selectedContainer(): Box | null {
    if (this.activeKind !== "box" || !this.activeId) return null;
    const box = this.boxById(this.activeId);
    return box && isContainer(box) && roleOf(box) === "questions" ? box : null;
  }

  private armSplit(container: Box): void {
    const span = container.spans[0];
    if (!span) return;
    this.segDrawer?.startSplit(span.page, { x: span.x, y: span.y, w: span.w, h: span.h });
  }

  // Slices the selected questions container at the user's cut lines into child
  // 'question' boxes, one per band, right after the container in the outline.
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
    const children: Box[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const top = bounds[i];
      const bottom = bounds[i + 1];
      if (bottom - top < 0.004) continue;
      children.push({
        kind: "box",
        id: newBoxId(),
        tags: ["question"],
        label: `${baseText} ${i + 1}`,
        spans: [{ page: span.page, x: span.x, y: top, w: span.w, h: bottom - top }]
      });
    }
    if (!children.length) {
      window.alert("Cuts produced no sections.");
      return;
    }

    const at = this.entities.indexOf(container);
    this.entities.splice(at + 1, 0, ...children);
    this.setDrawTool(null);
    // Re-home marks now that finer-grained questions exist to contain them.
    this.reassignMarkOwners();
    this.segLayer?.setData(this.entities);
    this.segLayer?.setVisible(true);
    this.selectEntry(children[0].id, "box");
    await this.persistEntities();
  }

  private defaultLabel(role: BoxTag): string {
    const n = this.boxes().filter((b) => roleOf(b) === role).length + 1;
    if (role === "concept") return `Concept ${n}`;
    if (role === "questions") return `Questions ${n}`;
    if (role === "question") return `Q${n}`;
    if (role === "frame") return `Frame ${n}`;
    return `Item ${n}`;
  }

  private async addBoxFromDraw(span: Span): Promise<void> {
    const role: BoxTag =
      this.drawTool === "concept" ||
      this.drawTool === "questions" ||
      this.drawTool === "question" ||
      this.drawTool === "frame"
        ? this.drawTool
        : "concept";
    const box: Box = {
      kind: "box",
      id: newBoxId(),
      tags: [role],
      label: this.defaultLabel(role),
      spans: [span]
    };
    this.entities.push(box);
    this.segLayer?.setData(this.entities);
    this.segLayer?.setVisible(true);
    this.selectEntry(box.id, "box");
    this.outline.beginEditActive();
    await this.persistEntities();
  }

  private async addAnchor(page: number, y: number): Promise<void> {
    const n = this.boxes().filter(isAnchor).filter((b) => anchorPage(b) === page).length + 1;
    const box = anchorOf(page, y, `Anchor ${n}`);
    this.entities.push(box);
    this.segLayer?.setData(this.entities);
    this.segLayer?.setVisible(true);
    this.selectEntry(box.id, "box");
    this.outline.beginEditActive();
    await this.persistEntities();
  }

  private async setLabel(id: string, label: string): Promise<void> {
    const entity = this.entities.find((e) => e.id === id);
    if (!entity) return;
    entity.label = label;
    this.segLayer?.setData(this.entities);
    this.refreshOutline();
    await this.persistEntities();
  }

  private async deleteEntry(id: string): Promise<void> {
    const entry = this.entities.find((e) => e.id === id);
    if (!entry) return;
    this.entities = this.entities.filter((e) => e.id !== id);
    if (this.activeId === id) this.activeId = null;
    // Notes anchored to the deleted entry go with it, so none dangle.
    this.notes = this.notes.filter((n) => n.target !== id);
    // Marks that were attached to the deleted box (or nested under it) fall
    // back to page scope rather than disappearing or dangling.
    this.overlay?.setMarks(this.marks());
    this.overlay?.reassignOwners(new Set(this.boxes().map((b) => b.id)));
    this.overlay?.repaint();
    this.segLayer?.setData(this.entities);
    this.refreshOutline();
    this.refreshNotes();
    await this.persistEntities();
    await this.persistNotes();
  }

  private async clearAll(): Promise<void> {
    const total = this.boxes().length;
    if (total && !window.confirm("Clear all boxes and anchors in this document?")) return;
    this.entities = this.marks();
    this.activeId = null;
    this.segLayer?.setData(this.entities);
    this.refreshOutline();
    await this.persistEntities();
  }

  private async persistEntities(): Promise<void> {
    if (!this.store || !this.view || !this.currentPath) return;
    this.syncMarksFromOverlay();
    await this.store.saveEntities(this.currentPath, this.view.kind, this.entities);
  }

  private async loadPageImage(page: number, scale: number): Promise<PageImage | null> {
    if (!this.view?.getPageImages) return null;
    const images = await this.view.getPageImages([page], scale);
    return images[0] ?? null;
  }

  // Re-homes mark owners against the current boxes (after split/auto-segment).
  private reassignMarkOwners(): void {
    if (!this.overlay) return;
    assignOwners(this.overlay.getMarks(), this.boxes(), true);
    this.overlay.repaint();
  }

  private toggleInspect(): void {
    this.inspect = !this.inspect;
    this.toolbar.setInspect(this.inspect);
    this.overlay?.setInspect(this.inspect);
    this.refreshOutline();
  }

  // Right-click on an uncommitted line draft, or (via onLineContext) on the
  // page while the line tool is armed. The first group commits the draft being
  // right-clicked; the group below sets the line tool's default kind for future
  // swipes. Picking a specific default also commits the current draft, so "set
  // default" and "place this line" are one gesture.
  private openPendingLineMenu(clientX: number, clientY: number): void {
    this.openLineMenu(clientX, clientY, true);
  }

  private openLineSettings(clientX: number, clientY: number): void {
    this.openLineMenu(clientX, clientY, false);
  }

  private openLineMenu(clientX: number, clientY: number, withDraft: boolean): void {
    const commit = (kind: MarkKind) => {
      this.overlay?.commitPending(kind);
      void this.persist();
    };
    const items: ContextMenuEntry[] = [];
    if (withDraft && this.overlay?.hasPending()) {
      items.push(
        { label: "Use as occlusion", swatch: DEFAULT_OCCLUSION_COLOR, onSelect: () => commit("occlusion") },
        { label: "Use as highlight", swatch: HIGHLIGHT_COLOR, onSelect: () => commit("highlight") },
        "separator"
      );
    }
    items.push(
      { label: "Default for new lines", disabled: true, onSelect: () => undefined },
      {
        label: "Occlusion",
        swatch: DEFAULT_OCCLUSION_COLOR,
        checked: this.lineDefault === "occlusion",
        hint: this.lineDefault === "occlusion" ? "current" : undefined,
        onSelect: () => void this.setLineDefault("occlusion", true)
      },
      {
        label: "Highlight",
        swatch: HIGHLIGHT_COLOR,
        checked: this.lineDefault === "highlight",
        hint: this.lineDefault === "highlight" ? "current" : undefined,
        onSelect: () => void this.setLineDefault("highlight", true)
      },
      {
        label: "Ask each swipe",
        checked: this.lineDefault === "none",
        hint: this.lineDefault === "none" ? "current" : undefined,
        onSelect: () => void this.setLineDefault("none", false)
      }
    );
    openContextMenu({ title: withDraft ? "Line — choose a kind" : "Line tool", items }, clientX, clientY);
  }

  // Sets the line tool's next-swipe kind for this vault. `commitDraft` also
  // places the draft currently on the page, so the setting applies to the very
  // line the menu was invoked from.
  private async setLineDefault(kind: LineDefault, commitDraft: boolean): Promise<void> {
    this.lineDefault = kind;
    this.overlay?.setLineDefault(kind);
    if (commitDraft && kind !== "none") {
      this.overlay?.commitPending(kind);
      void this.persist();
    }
    await this.prefs.update({ lineDefault: kind });
  }

  // Human-readable owner label for inspect mode badges and menus.
  private ownerLabel(owner: string): string {
    if (owner === PAGE_OWNER) return "page";
    const box = this.boxById(owner);
    if (!box) return "orphan";
    return `${this.boxText(box)} (${roleOf(box)})`;
  }

  // Play-item id → marks to paint. Question play passes a box id (use the
  // containment rule below); card play passes a mark id (paint just that card,
  // so a sibling mark sharing the crop does not double-cover it).
  private marksForPlayerItem(id: string): Mark[] {
    const mark = this.markById(id);
    if (mark && isCard(mark)) return [mark];
    return this.marksForBox(id);
  }

  // Marks shown for a question in play mode: those attached to it, plus any
  // mark that geometrically sits inside its box but is not attached to a
  // different question (covers free and container-owned marks).
  private marksForBox(boxId: string): Mark[] {
    const box = this.boxById(boxId);
    const span = box?.spans[0];
    const marks = this.marks();
    return marks.filter((m) => {
      if (m.owner === boxId) return true;
      const s = m.spans[0];
      if (!span || !s || s.page !== span.page) return false;
      const inside =
        s.x >= span.x - 1e-6 &&
        s.y >= span.y - 1e-6 &&
        s.x + s.w <= span.x + span.w + 1e-6 &&
        s.y + s.h <= span.y + span.h + 1e-6;
      if (!inside) return false;
      // Another question that also contains it is the truer owner.
      if (m.owner !== PAGE_OWNER) {
        const owner = this.boxById(m.owner);
        if (owner && roleOf(owner) === "question") return false;
      }
      return true;
    });
  }

  // Opens the one-item-at-a-time player. A selected frame plays the cards
  // inside it; otherwise the scope is the selected questions container's
  // descendants, a single question, or all questions.
  private openPlayer(id: string): void {
    if (!this.view?.getPageImages) {
      window.alert("Play mode supports PDFs.");
      return;
    }

    const picked = this.boxById(id);
    if (picked && isFrame(picked)) {
      const frameSpan = picked.spans[0];
      const cards = this.marks().filter((m) => {
        if (!isCard(m)) return false;
        if (m.card?.frame) return m.card.frame === picked.id;
        // No explicit frame: the card belongs to the frame that contains the
        // mark itself. Testing the derived crop would fail for the default
        // full-width band, which never fits inside a column frame.
        return frameSpan ? m.spans.some((s) => containsSpan(picked, s)) : false;
      });
      if (!cards.length) {
        window.alert(`No cards in "${this.boxText(picked)}". Make a mark a card first.`);
        return;
      }
      this.playCards(cards);
      return;
    }

    const tree = buildOutlineTree(this.entities);
    const collect = (nodes: OutlineNode[], acc: Box[]): void => {
      for (const n of nodes) {
        const box = n.kind === "box" ? this.boxById(n.id) : undefined;
        if (box && roleOf(box) === "question") acc.push(box);
        collect(n.children, acc);
      }
    };

    let scope: Box[] = [];
    if (picked && roleOf(picked) === "questions") {
      const node = findNode(tree, id);
      collect(node ? node.children : [], scope);
    } else if (picked && roleOf(picked) === "question") {
      scope = [picked];
    } else {
      scope = this.boxes().filter((b) => roleOf(b) === "question");
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
      this.activeKind === "box"
        ? this.boxes().find((s) => s.id === this.activeId && roleOf(s) === "questions")
        : undefined;
    if (!container) {
      window.alert("Select a 'questions' container, then auto-segment.");
      return;
    }
    if (!container.spans.length) return;

    const rule = DEFAULT_RULES[0];
    const baseText = parseLabel(container.label).text || "Q";
    const startIndex = this.entities.indexOf(container);
    try {
      const found: Box[] = [];
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
      this.entities.splice(startIndex + 1, 0, ...found);
      this.reassignMarkOwners();
      this.segLayer?.setData(this.entities);
      this.segLayer?.setVisible(true);
      this.refreshOutline();
      this.selectEntry(found[0].id, "box");
      await this.store.saveRule(this.currentPath, this.view.kind, rule);
      await this.persistEntities();
    } catch {
      window.alert("Segmentation failed.");
    }
  }

  private async persist(): Promise<void> {
    if (!this.store || !this.overlay || !this.view || !this.currentPath) return;
    this.syncMarksFromOverlay();
    await this.store.saveEntities(this.currentPath, this.view.kind, this.entities);
  }

  // The overlay owns the marks array it mutates (push/remove/reveal), while
  // this.entities also holds boxes. Recompose before any save so removals and
  // additions inside the overlay are what actually get written.
  private syncMarksFromOverlay(): void {
    if (!this.overlay) return;
    this.entities = [...this.entities.filter(isBox), ...this.overlay.getMarks()];
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
    this.transform?.destroy();
    this.transform = null;
    this.segLayer?.destroy();
    this.segLayer = null;
    this.entities = [];
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
    this.toolbar.setPageModeVisible(false);
    this.toolbar.setPage(1, 1);
    this.view?.destroy();
    this.view = null;
    this.refreshNotes();
  }
}
