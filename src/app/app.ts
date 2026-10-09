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
import { ReviewStore } from "../store/review";
import { SidecarStore } from "../store/sidecar";
import {
  loadPageMode,
  loadTheme,
  nextPageMode,
  PAGE_FILTERS,
  PrefsStore,
  savePageMode,
  saveTheme,
  type LeftTab,
  type LineDefault,
  type PageMode,
  type RailTab
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
  INK_COLOR,
  containsMark,
  containsSpan,
  frames,
  intersect,
  isAnchor,
  isBox,
  isCard,
  isContainer,
  isFrame,
  isInk,
  isMark,
  markKind,
  newMarkId,
  newBoxId,
  MARK_PALETTE,
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
import { Outline, UNGROUPED_DECK } from "../ui/outline";
import { NotesPanel, type NoteRow } from "../ui/notesPanel";
import { hideNotePreview, openNoteEditor, showNotePreview } from "../ui/notePopover";
import { Palette } from "../ui/palette";
import { Player, type PlayerItem } from "../ui/player";
import { SegmentDrawer, type DrawTool } from "../ui/segmentDraw";
import { SegmentLayer } from "../ui/segmentLayer";
import { Transform, type TransformTarget } from "../ui/transform";
import { Toolbar } from "../ui/toolbar";
import { VaultHub } from "../ui/vaultHub";
import { ZoomController } from "../ui/zoom";
import {
  buildQueue,
  countDeck,
  formatPreviews,
  previewIntervals,
  workloadFrom,
  type DeckCounts,
  type ReviewGrade,
} from "../srs";
import "../ui/styles.css";

const SCROLL_PREFIX = "ihobs:scroll:";
// Note hover preview: wait this long on an indicator before showing the card,
// then this long after leaving before hiding it (so the pointer can reach the
// card's Edit button).
const NOTE_DWELL_MS = 220;
const NOTE_GRACE_MS = 180;

// What the shared hover-preview controller should show after the dwell. A note
// previews a Note row and edits via openNoteTarget; a cue previews a mark's cue
// and edits via openCueEditor.
type PreviewRequest =
  | { kind: "note"; targetKind: NoteTargetKind; id: string; x: number; y: number }
  | { kind: "cue"; markId: string; x: number; y: number };

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
  activity: HTMLElement;
  leftRail: HTMLElement;
  explorer: HTMLElement;
  viewer: HTMLElement;
  rail: HTMLElement;
  railTabs: HTMLElement;
  outline: HTMLElement;
  notes: HTMLElement;
  palette: HTMLElement;
  player: HTMLElement;
  scrim: HTMLElement;
}

function buildShell(mount: HTMLElement): Shell {
  mount.innerHTML = "";
  const shell = document.createElement("div");
  shell.className = "shell vault-collapsed";

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";

  const workspace = document.createElement("div");
  workspace.className = "workspace";

  // Left side: a narrow activity bar (the durable sidebar spine, always
  // visible) plus the collapsible sidebar body it switches. The activity bar
  // stays put while the body collapses, so the view can always be reopened.
  const leftRail = document.createElement("div");
  leftRail.className = "left-rail";

  const activity = document.createElement("div");
  activity.className = "activity-bar";

  const explorer = document.createElement("div");
  explorer.className = "explorer";

  leftRail.append(activity, explorer);

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

  // Backdrop for the mobile drawers. Tapping it closes whichever is open.
  const scrim = document.createElement("div");
  scrim.className = "scrim";

  workspace.append(leftRail, viewer, rail);
  shell.append(toolbar, workspace, palette, player, scrim);
  mount.appendChild(shell);

  return { root: shell, activity, leftRail, explorer, viewer, rail, railTabs, outline, notes, palette, player, scrim };
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
  private reviewStore: ReviewStore | null = null;
  private prefs = new PrefsStore();

  private view: DocView | null = null;
  private overlay: Overlay | null = null;
  // Note hover-preview: a dwell timer before showing (so sweeping the pointer
  // across indicators doesn't flash cards) and a short grace before hiding (so
  // the pointer can travel onto the card to reach its Edit button). One
  // controller serves both note previews and mark-cue previews.
  private notePreviewTimer: number | null = null;
  private previewReq: PreviewRequest | null = null;
  private notePreviewOver = false;
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
  private railTab: RailTab = "outline";
  private leftCollapsed = false;
  private leftTab: LeftTab = "files";
  // Remembered sidebar widths in px (0 = CSS default). Loaded per vault and
  // written back on drag end, so a chosen layout survives a restart.
  private leftWidth = 0;
  private rightWidth = 0;
  private pendingSelection: CapturedSelection | null = null;
  private currentPath: string | null = null;
  private scrollMemo = new Map<string, number>();
  private pageMode: PageMode = "off";
  private lineDefault: LineDefault = "none";
  // Default colors for the line/free tools, one per kind, restored from prefs.
  private lineOcclusionColor = DEFAULT_OCCLUSION_COLOR;
  private lineHighlightColor = HIGHLIGHT_COLOR;
  // When set, a floating, real <img> publishes the current page so a
  // page-context AI sidebar can fetch it (canvas pixels are invisible to those
  // readers). Held so page changes can refresh it and teardown can remove it.
  private aiContextWrap: HTMLElement | null = null;
  private aiContextImg: HTMLImageElement | null = null;
  private aiContextToken = 0;
  private readonly onScroll: () => void;
  private scrollTimer: number | null = null;
  private loadSeq = 0;
  private loadAbort: AbortController | null = null;

  constructor(mount: HTMLElement) {
    this.shell = buildShell(mount);
    this.onScroll = () => {
      this.memoScroll();
      // The preview card is position:fixed, so it would detach from its note
      // as the page scrolls under it; drop it instead of letting it drift.
      this.cancelNoteHover();
    };
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
      onPlay: (id, scope) =>
        scope === "deck" ? this.playDeck(id) : void this.openPlayer(id),
      onClear: () => void this.clearAll(),
      decks: () => this.deckCounts(),
      onBrowseDeck: (id) => this.browseDeck(id),
      docPath: () => this.currentPath ?? "",
      onNote: (id, kind, x, y) => this.openNoteTarget(kind, id, x, y),
      hasNote: (id) => this.hasNote(id),
      onNoteHover: (id, kind, x, y) => this.hoverNote(kind, id, x, y),
      onNoteLeave: () => this.leaveNote()
    });

    this.player = new Player(
      this.shell.player,
      {
        loadPage: (page, scale) => this.loadPageImage(page, scale),
        // A play item id is a box id for question play and a mark id for card
        // play; resolve whichever it is.
        marksFor: (id) => this.marksForPlayerItem(id),
        contextMarks: (id, crop) => this.contextMarksForCard(id, crop),
        preview: (id) => this.cardPreviews(id),
        siblingIds: (id) => this.siblingCardIds(id),
        path: () => this.currentPath ?? ""
      },
      {
        onClose: () => undefined,
        onGrade: (grade, id) => void this.gradeCard(grade, id)
      }
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
      onToggleShareContext: () => void this.toggleAiContext(),
      onToggleExplorer: () => this.toggleExplorer(),
      onToggleOutline: () => this.toggleRail("outline"),
      onToggleNotes: () => this.toggleRail("notes"),
      onToolMenu: (action, x, y) => this.openToolMenu(action, x, y)
    });

    this.buildActivityBar();
    this.wireResizeHandles();
    this.shell.scrim.addEventListener("click", () => this.closeDrawers());

    // Escape closes an open mobile drawer (or clears the palette overlay first,
    // which owns Escape while it is up).
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (this.palette.isOpen()) return;
      this.closeDrawers();
    });

    // Crossing the drawer breakpoint toggles the mobile mode: entering it tucks
    // any open drawers away; leaving it restores the desktop persistent panels.
    const mq = window.matchMedia("(max-width: 900px)");
    mq.addEventListener("change", () => this.syncLayoutMode());
    this.syncLayoutMode();
  }

  // ---- Left activity bar -------------------------------------------------

  // The activity bar is the always-visible left spine. Files and Bookmarks are
  // real sidebar views; Search is an action that opens the quick-open palette.
  private buildActivityBar(): void {
    const items: Array<{
      id: LeftTab | "search";
      iconName: "layers" | "search" | "star";
      title: string;
      action?: boolean;
    }> = [
      { id: "files", iconName: "layers", title: "files" },
      { id: "search", iconName: "search", title: "go to file", action: true },
      { id: "bookmarks", iconName: "star", title: "bookmarks" }
    ];
    this.shell.activity.innerHTML = "";
    for (const item of items) {
      const b = document.createElement("button");
      b.className = "activity-btn";
      b.dataset.tab = item.id;
      b.appendChild(icon(item.iconName, 18));
      b.title = item.title;
      b.setAttribute("aria-label", item.title);
      b.addEventListener("click", () => {
        if (item.action) {
          this.palette.toggle();
          return;
        }
        this.selectLeftTab(item.id as LeftTab);
      });
      this.shell.activity.appendChild(b);
    }
    this.syncActivityBar();
  }

  private syncActivityBar(): void {
    this.shell.activity.querySelectorAll<HTMLElement>(".activity-btn").forEach((b) => {
      const active = b.dataset.tab === this.leftTab && !this.leftCollapsed;
      b.classList.toggle("active", active);
    });
  }

  private selectLeftTab(tab: LeftTab): void {
    this.leftTab = tab;
    // Files shows the whole vault; Bookmarks shows only pinned files.
    this.explorer.showPinnedOnly(tab === "bookmarks");
    this.explorer.rerender();
    if (this.leftCollapsed) {
      this.leftCollapsed = false;
      this.applyLeftCollapsed();
      this.toolbar.setExplorer(true);
      // Persist the desktop choice only; on mobile this just opens the drawer.
      if (!this.shell.root.classList.contains("is-mobile")) {
        void this.prefs.update({ leftCollapsed: false });
      }
    } else {
      this.syncActivityBar();
    }
  }

  // ---- Resizable sidebars ------------------------------------------------

  // Two thin drag handles, one on the inside edge of each sidebar. Pointer
  // capture keeps the drag alive across the iframe/scroll surface; widths are
  // clamped to the same range the CSS enforces and persisted on release. A
  // double-click restores the CSS default.
  private wireResizeHandles(): void {
    const left = document.createElement("div");
    left.className = "resize-handle resize-left";
    left.title = "drag to resize · double-click to reset";
    this.shell.viewer.before(left);
    left.addEventListener("pointerdown", (e) => this.startResize(e, "left", left));
    left.addEventListener("dblclick", () => this.resetWidth("left"));

    const right = document.createElement("div");
    right.className = "resize-handle resize-right";
    right.title = "drag to resize · double-click to reset";
    // Sits on the viewer's right edge, i.e. just before the rail.
    this.shell.viewer.after(right);
    right.addEventListener("pointerdown", (e) => this.startResize(e, "right", right));
    right.addEventListener("dblclick", () => this.resetWidth("right"));
  }

  private startResize(e: PointerEvent, side: "left" | "right", handle: HTMLElement): void {
    // The handles only make sense on the desktop grid; on mobile the sidebars
    // are drawers and resizing is disabled.
    if (window.matchMedia("(max-width: 900px)").matches) return;
    if (side === "left" && (this.leftCollapsed || !this.vault)) return;
    if (side === "right" && (!this.railOpen || !this.view)) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");

    const startX = e.clientX;
    const startW = side === "left" ? this.shell.leftRail.getBoundingClientRect().width : this.shell.rail.getBoundingClientRect().width;
    const bounds = side === "left" ? { min: 180, max: 520 } : { min: 220, max: 620 };

    const move = (ev: PointerEvent): void => {
      const delta = ev.clientX - startX;
      const raw = side === "left" ? startW + delta : startW - delta;
      const w = Math.max(bounds.min, Math.min(bounds.max, Math.round(raw)));
      if (side === "left") {
        this.leftWidth = w;
        this.applySidebarWidths();
      } else {
        this.rightWidth = w;
        this.applySidebarWidths();
      }
    };
    const up = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing");
      void this.prefs.update({ leftWidth: this.leftWidth, rightWidth: this.rightWidth });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  private resetWidth(side: "left" | "right"): void {
    if (side === "left") this.leftWidth = 0;
    else this.rightWidth = 0;
    this.applySidebarWidths();
    void this.prefs.update({ leftWidth: this.leftWidth, rightWidth: this.rightWidth });
  }

  // Sidebar widths live as CSS custom properties on the shell so both the grid
  // columns and the drag handles can read them. 0 means "fall back to the
  // stylesheet default", which is what the var() fallbacks encode.
  private applySidebarWidths(): void {
    const root = this.shell.root;
    if (this.leftWidth > 0) root.style.setProperty("--left-w", `${this.leftWidth}px`);
    else root.style.removeProperty("--left-w");
    if (this.rightWidth > 0) root.style.setProperty("--right-w", `${this.rightWidth}px`);
    else root.style.removeProperty("--right-w");
  }

  // Tracks the desktop ↔ mobile (drawer) split: the grid becomes drawers and a
  // scrim, and open panels are tucked away on entry so the page is unobstructed.
  private syncLayoutMode(): void {
    const mobile = window.matchMedia("(max-width: 900px)").matches;
    this.shell.root.classList.toggle("is-mobile", mobile);
    if (mobile) {
      this.leftCollapsed = true;
      this.railOpen = false;
      this.applyLeftCollapsed();
      this.toolbar.setExplorer(false);
      this.applyDrawers();
      return;
    }
    // Back on the desktop grid: restore the stored layout, since the drawers
    // forced both panels closed while we were in mobile mode. Before a vault is
    // open there is no layout to restore, so just clear the drawer state.
    if (!this.vault) {
      this.applyDrawers();
      return;
    }
    const p = this.prefs.get();
    this.leftCollapsed = p.leftCollapsed;
    this.railOpen = p.railOpen;
    this.applyLeftCollapsed();
    this.toolbar.setExplorer(!this.leftCollapsed);
    // Only re-render the rail when a document is open; otherwise keep the stored
    // railOpen intent so the next open still restores the outline.
    if (this.view) this.updateRailVisibility();
    else this.applyDrawers();
  }

  // Which drawers are open on mobile, plus the scrim and toolbar active state.
  // On desktop these classes are cleared: the sidebars are persistent grid
  // columns there, not drawers, and the scrim must never appear.
  private applyDrawers(): void {
    const root = this.shell.root;
    const mobile = root.classList.contains("is-mobile");
    const leftOpen = mobile && !!this.vault && !this.leftCollapsed;
    const rightOpen = mobile && this.railOpen && !!this.view;
    root.classList.toggle("drawer-left-open", leftOpen);
    root.classList.toggle("drawer-right-open", rightOpen);
    root.classList.toggle("drawer-open", leftOpen || rightOpen);
  }

  private closeDrawers(): void {
    if (!this.shell.root.classList.contains("is-mobile")) return;
    if (this.leftCollapsed && !this.railOpen) return;
    this.leftCollapsed = true;
    this.railOpen = false;
    this.applyLeftCollapsed();
    this.toolbar.setExplorer(false);
    this.toolbar.setOutline(false);
    this.toolbar.setNotes(false);
    this.updateRailVisibility();
  }

  // Applies the PDF text-layer debug level to the current view (no-op otherwise).
  private applyTextDebug(): void {
    const level = this.toolbar.getTextDebug();
    this.view?.setTextDebug?.(level);
  }

  // Publishes the current page as a real, on-screen <img src="data:…">. A
  // page-context AI sidebar only ingests image *resources* (like a Facebook
  // post photo), so the raster must be an <img> URL in the DOM — canvas pixels
  // are invisible to it and ihobs has no server URL to offer. One image only,
  // refreshed per page, so the data URL stays a single page not a whole doc.
  private toggleAiContext(): void {
    if (this.aiContextWrap) {
      this.unmountAiContext();
      this.toolbar.setShareContext(false);
      return;
    }
    if (!this.view?.getPageImageUrl) return;
    const wrap = document.createElement("div");
    wrap.className = "ai-context";
    const img = document.createElement("img");
    img.className = "ai-context-img";
    img.alt = `Current page of ${this.currentPath ?? "document"}`;
    wrap.append(img);
    this.shell.viewer.appendChild(wrap);
    this.aiContextWrap = wrap;
    this.aiContextImg = img;
    this.toolbar.setShareContext(true);
    void this.refreshAiContext();
  }

  private unmountAiContext(): void {
    this.aiContextToken++;
    this.aiContextWrap?.remove();
    this.aiContextWrap = null;
    this.aiContextImg = null;
  }

  // Renders the visible page to a data URL and swaps it into the published
  // <img>. A token guards against an older render landing after a page flip;
  // only the newest result is applied.
  private async refreshAiContext(): Promise<void> {
    if (!this.aiContextWrap || !this.aiContextImg || !this.view?.getPageImageUrl) return;
    const page = this.view.currentPage?.() ?? 1;
    const token = ++this.aiContextToken;
    // Match the on-screen scale so the shared bitmap is as sharp as the page.
    const scale = 1.6 * (this.view.getZoom?.() ?? 1);
    const url = await this.view.getPageImageUrl(page, scale);
    if (token !== this.aiContextToken || !this.aiContextWrap || !this.aiContextImg) return;
    if (url) this.aiContextImg.src = url;
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
    // An installed window's chrome follows the app theme, not the OS setting:
    // the toggle is explicit and stored, so prefers-color-scheme would be wrong
    // for anyone who picked the other one.
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#16181d" : "#ffffff");
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
    this.syncActivityBar();
    this.applyDrawers();
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
    this.reviewStore = new ReviewStore(rec.handle);
    this.prefs = new PrefsStore().withVault(rec.id);
    const prefs = await this.prefs.load();
    this.toolbar.setVaultLabel(rec.label);
    this.explorer.setState(prefs.expanded, prefs.pinned);
    this.shell.root.classList.remove("vault-collapsed");
    this.leftCollapsed = prefs.leftCollapsed;
    this.railOpen = prefs.railOpen;
    this.railTab = prefs.railTab;
    this.lineDefault = prefs.lineDefault ?? "none";
    this.lineOcclusionColor = prefs.lineOcclusionColor ?? DEFAULT_OCCLUSION_COLOR;
    this.lineHighlightColor = prefs.lineHighlightColor ?? HIGHLIGHT_COLOR;
    this.leftWidth = prefs.leftWidth > 0 ? prefs.leftWidth : 0;
    this.rightWidth = prefs.rightWidth > 0 ? prefs.rightWidth : 0;
    this.leftTab = "files";
    this.explorer.showPinnedOnly(false);
    this.applySidebarWidths();
    this.applyLeftCollapsed();
    this.toolbar.setExplorer(!this.leftCollapsed);
    // On a phone the panels are drawers and must start closed, regardless of
    // the desktop layout that was stored.
    this.syncLayoutMode();

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
    // Review state is a second file; load it before the first outline render so
    // deck badges are correct on open rather than after the first interaction.
    if (this.reviewStore) await this.reviewStore.load(path);
    this.refreshOutline();
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
    this.toolbar.setShareContextVisible(!!view.getPageImageUrl);
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
      view.onPageChange((page) => {
        this.toolbar.setPage(page, view.pageCount?.() ?? 1);
        void this.refreshAiContext();
      });
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
      onNote: (id, x, y) => this.openMarkAttachment(id, x, y),
      onNoteHover: (id, x, y) => this.hoverMarkAttachment(id, x, y),
      onNoteLeave: () => this.leaveNote(),
      onCueHover: (id, x, y) => this.hoverCue(id, x, y),
      onCueLeave: () => this.leaveNote()
    });
    overlay.setMode(this.mode);
    overlay.setInspect(this.inspect);
    overlay.setLineDefault(this.lineDefault);
    overlay.setLineColors({ occlusion: this.lineOcclusionColor, highlight: this.lineHighlightColor });
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
      onNoteBadge: (id, kind, x, y) => this.openNoteTarget(kind, id, x, y),
      onNoteHover: (id, kind, x, y) => this.hoverNote(kind, id, x, y),
      onNoteLeave: () => this.leaveNote()
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
    } else {
      // Ink moves as a whole; resizing a stroke would have to scale its path,
      // which the minimal pen does not support yet.
      const mark = this.markById(this.activeId);
      if (mark && isInk(mark)) return { span, handles: [], axis: "both" };
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
    // A moved stroke's points must follow its bounding box.
    if (!resized && isMark(entity) && isInk(entity) && entity.path) {
      entity.path = entity.path.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
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
    this.updateRailVisibility();
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
    // Never show the rail with nothing in it: without a document the outline is
    // meaningless and the notes pages are all empty.
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
    if (this.shell.root.classList.contains("is-mobile")) this.applyDrawers();
  }

  // Opening a paged document shows the outline by default until the user has
  // made a rail choice; afterwards their last choice is respected. On mobile the
  // outline is a drawer, so it must not spring open over the document.
  private openRailFor(view: DocView): void {
    if (this.prefs.get().railConfigured) return;
    if (this.shell.root.classList.contains("is-mobile")) return;
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
    // Persist only the desktop collapse state; on mobile the drawer opens
    // transiently and must not rewrite the wide-screen layout choice.
    if (!this.shell.root.classList.contains("is-mobile")) {
      void this.prefs.update({ leftCollapsed: this.leftCollapsed });
    }
  }

  private applyLeftCollapsed(): void {
    this.shell.root.classList.toggle("left-collapsed", this.leftCollapsed);
    this.syncActivityBar();
    if (this.shell.root.classList.contains("is-mobile")) this.applyDrawers();
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
        const inside = this.frameCandidateMarks(box);
        items.push({
          label: "Make cards from marks inside",
          hint: `${inside.length} mark${inside.length === 1 ? "" : "s"}`,
          disabled: inside.length === 0,
          onSelect: () => this.cardsFromFrame(box.id)
        });
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
    const ink = isInk(mark);
    const kindLabel = ink ? "Ink" : markKind(mark) === "highlight" ? "Highlight" : "Occlusion";
    const ownerBox = mark.owner !== PAGE_OWNER ? this.boxById(mark.owner) : undefined;
    const ownerName = ownerBox ? this.boxText(ownerBox) : "page";
    const items: ContextMenuEntry[] = [
      {
        label: "Select / transform",
        hint: ink ? "move" : "move · resize",
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
        label: mark.cue ? "Edit cue…" : "Add cue…",
        hint: "card question side",
        onSelect: () => this.openCueEditor(id, { x: clientX, y: clientY })
      }
    ];
    // Ink is a stroke, not a cover; it cannot be flipped to occlusion/highlight.
    if (!ink) {
      items.push({
        label: markKind(mark) === "occlusion" ? "Convert to highlight" : "Convert to occlusion",
        onSelect: () => {
          this.overlay?.setKind(id, markKind(mark) === "occlusion" ? "highlight" : "occlusion");
          void this.persist();
        }
      });
    }
    items.push("separator");
    const names = ["Blue", "Yellow", "Green", "Pink", "Purple"];
    MARK_PALETTE.forEach((color, i) => {
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
      onSelect: () =>
        this.pickMarkColor(
          id,
          mark.color ??
            (ink
              ? INK_COLOR
              : markKind(mark) === "highlight"
                ? HIGHLIGHT_COLOR
                : DEFAULT_OCCLUSION_COLOR)
        )
    });
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
    // Ink is not an answer surface, so it cannot become a flashcard.
    if (!ink) items.push("separator", ...this.cardMenuItems(mark));
    items.push({
      label: "Remove",
      danger: true,
      onSelect: () => {
        this.overlay?.remove(id);
        void this.persist();
        void this.dropReviewRows([id]);
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
      onSelect: () => this.setCardContext(mark.id, undefined, null)
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

  // `undefined` leaves a field alone; `null` clears it. Clearing needs its own
  // case because a setter that only ever assigned would make "Clear frame" a
  // no-op — it would rewrite the card exactly as it already was.
  private setCardContext(
    markId: string,
    context: string | null | undefined,
    frame?: string | null
  ): void {
    const mark = this.markById(markId);
    if (!mark) return;
    const card: Card = { ...(mark.card ?? {}) };
    if (context === null) delete card.context;
    else if (context !== undefined) card.context = context;
    if (frame === null) delete card.frame;
    else if (frame !== undefined) card.frame = frame;
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
    // A mark that is no longer a card has no schedule to keep. The mark itself
    // stays; only its review row goes.
    if (!card) void this.dropReviewRows([markId]);
    this.refreshOutline();
  }

  // The frame a card is really clipped by, or null when it is not clipped at all.
  // A card stores the frame's *id*, so deleting that frame leaves the id behind.
  // Such a card would otherwise be invisible to every frame's deck (they match on
  // exact id) and skipped by the bulk action below — while `cardCrop` already
  // ignores a frame it cannot resolve. Treating an unresolvable id as no clip
  // makes deck membership and adoption agree with what the crop already does.
  private liveFrameIdOf(mark: Mark): string | null {
    const id = mark.card?.frame;
    if (!id) return null;
    const box = this.boxById(id);
    return box && isFrame(box) ? id : null;
  }

  // Marks a bulk "make cards" over a frame would adopt: everything geometrically
  // inside it that no frame already clips. A mark already framed by another frame
  // keeps its clip — the same non-destructive rule ownership follows — so nesting
  // one frame inside another never steals the inner frame's cards.
  private frameCandidateMarks(frame: Box): Mark[] {
    return this.allEntities()
      .filter(isMark)
      .filter((m) => this.liveFrameIdOf(m) === null && containsMark(frame, m));
  }

  // Bulk authoring: every mark inside a frame becomes a card clipped by it. The
  // question side is left to the default band; clipped to the frame that band is
  // exactly the frame's slice at the mark's height, which is what occluding one
  // line of a scanned column wants — no per-card context to assign by hand.
  private cardsFromFrame(frameId: string): void {
    const frame = this.boxById(frameId);
    if (!frame) return;
    for (const mark of this.frameCandidateMarks(frame)) {
      mark.card = { ...(mark.card ?? {}), frame: frame.id };
    }
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
    const items = cards.map((m) => {
      const frameId = this.liveFrameIdOf(m);
      const frame = frameId ? this.boxById(frameId) : undefined;
      return {
        id: m.id,
        label: m.label.replace(/^#+\s*/, "") || "card",
        span: m.spans[0] ?? null,
        crop: cardCrop(m, entities),
        // The frame bounds the up/down context reveal, so it cannot grow into
        // the neighbouring column. Frame-less cards are unbounded (page edge).
        bounds: frame?.spans[0] ?? null,
        cue: m.cue
      };
    });
    this.player.start(this.reviewOrder(items));
  }

  /**
   * Reorders a card list into a study session: overdue first, then new, with
   * not-yet-due cards dropped. Falls back to the caller's order when this is not
   * a paged document or the review store has not loaded.
   *
   * This is the deck seam: because it takes ids rather than a box, the outline
   * can later pass any branch's cards through the same function.
   */
  private reviewOrder(items: PlayerItem[]): PlayerItem[] {
    if (!this.reviewStore || !this.currentPath) return items;
    const rows = this.reviewStore.rows(this.currentPath);
    const order = buildQueue(
      items.map((item) => item.id),
      rows,
      Date.now()
    );
    if (order.length === 0) return items;
    const byId = new Map(items.map((item) => [item.id, item]));
    const ordered = order
      .map((card) => byId.get(card.markId))
      .filter((item): item is PlayerItem => !!item);
    // A scope where nothing is due yet still plays, in document order: an
    // explicit play is a request to see these cards, not only the due ones.
    return ordered.length ? ordered : items;
  }

  /**
   * The workload histogram a grading session balances against: every row the
   * document has, not just the cards on screen, so long intervals spread across
   * the whole document rather than piling onto the day after this session.
   */
  private sessionWorkload(): ReturnType<typeof workloadFrom> | undefined {
    if (!this.reviewStore || !this.currentPath) return undefined;
    return workloadFrom(
      this.reviewStore.reviewedIds(this.currentPath),
      this.reviewStore.rows(this.currentPath),
      Date.now()
    );
  }

  /** Grade-button labels for a card, or null when it is not a schedulable card. */
  private cardPreviews(id: string): Record<ReviewGrade, string> | null {
    const mark = this.markById(id);
    if (!mark || !isCard(mark)) return null;
    const rows = this.reviewStore?.rows(this.currentPath ?? "") ?? {};
    const previews = previewIntervals({
      row: rows[id] ?? null,
      now: Date.now(),
      workload: this.sessionWorkload()
    });
    return formatPreviews(previews);
  }

  /** Marks that reveal together with this card, for bury-siblings. */
  private siblingCardIds(id: string): string[] {
    const mark = this.markById(id);
    const group = mark?.groupId;
    if (!group) return [];
    return this.marks()
      .filter((m) => m.id !== id && isCard(m) && m.groupId === group)
      .map((m) => m.id);
  }

  /** Records a grade. The player has already advanced past the card. */
  private async gradeCard(grade: ReviewGrade, id: string): Promise<void> {
    if (!this.reviewStore || !this.currentPath) return;
    if (!this.markById(id)) return;
    await this.reviewStore.grade({
      docPath: this.currentPath,
      markId: id,
      grade,
      workload: this.sessionWorkload()
    });
    // Counts (and the grade previews for the rest of the session) shifted.
    this.refreshOutline();
  }

  /** Forgets schedule state for marks that no longer exist. */
  private async dropReviewRows(markIds: string[]): Promise<void> {
    if (!this.reviewStore || !this.currentPath) return;
    await this.reviewStore.drop(this.currentPath, markIds);
  }

  // ---- Decks ------------------------------------------------------------
  //
  // A deck is the set of card marks reachable from one outline node: the cards
  // the node's own box resolves to, plus everything its descendants resolve to.
  // A card can be reachable from more than one box (its owner, and any context
  // or frame box it names), so every level is a *set union* — a card is counted
  // once per deck no matter how many ways in, and a parent's total is never more
  // than the number of distinct cards beneath it.

  /** Every card mark the app can currently see, including unsynced overlay ones. */
  private cards(): Mark[] {
    return this.allEntities().filter(isCard) as Mark[];
  }

  // The cards one box resolves to, mirroring what play mode already does:
  //   - a frame plays the cards inside its span, or explicitly framed by it;
  //   - anything else uses `marksForBox` (owned marks plus marks geometrically
  //     inside that no other question owns).
  private deckCardsForBox(box: Box): Mark[] {
    if (isFrame(box)) {
      const span = box.spans[0];
      return this.cards().filter((m) => {
        if (m.card?.frame) return m.card.frame === box.id;
        return span ? m.spans.some((s) => containsSpan(box, s)) : false;
      });
    }
    return this.marksForBox(box.id).filter(isCard) as Mark[];
  }

  // Cards reachable from no box at all: page-scoped marks, and marks whose only
  // handle is a box that no longer exists. These get the synthetic deck.
  private looseCards(): Mark[] {
    const covered = new Set<string>();
    for (const box of this.boxes()) {
      for (const m of this.deckCardsForBox(box)) covered.add(m.id);
    }
    return this.cards().filter((m) => !covered.has(m.id));
  }

  private deckCards(id: string): Mark[] {
    if (id === UNGROUPED_DECK) return this.looseCards();
    const tree = buildOutlineTree(this.allEntities());
    const node = findNode(tree, id);
    const seen = new Map<string, Mark>();
    const gather = (n: OutlineNode): void => {
      const box = this.boxById(n.id);
      if (box) for (const m of this.deckCardsForBox(box)) seen.set(m.id, m);
      for (const child of n.children) gather(child);
    };
    if (node) gather(node);
    else {
      const box = this.boxById(id);
      if (box) for (const m of this.deckCardsForBox(box)) seen.set(m.id, m);
    }
    return [...seen.values()];
  }

  // Per-scope deck counts for the outline badges, keyed by box id plus
  // `UNGROUPED_DECK`. A post-order union means each ancestor's count is the
  // distinct cards beneath it, with no double counting through shared handles.
  private deckCounts(): Map<string, DeckCounts> {
    const out = new Map<string, DeckCounts>();
    if (!this.reviewStore || !this.currentPath) return out;
    const rows = this.reviewStore.rows(this.currentPath);
    const now = Date.now();

    const visit = (node: OutlineNode): Set<string> => {
      const ids = new Set<string>();
      const box = this.boxById(node.id);
      if (box) for (const m of this.deckCardsForBox(box)) ids.add(m.id);
      for (const child of node.children) {
        for (const id of visit(child)) ids.add(id);
      }
      out.set(node.id, countDeck([...ids], rows, now));
      return ids;
    };
    for (const root of buildOutlineTree(this.allEntities())) visit(root);

    const loose = this.looseCards();
    out.set(UNGROUPED_DECK, countDeck(loose.map((m) => m.id), rows, now));
    return out;
  }

  // Plays a deck when its outline row is clicked. Falls through to document
  // order when nothing is due (an explicit play should still show the cards).
  private playDeck(id: string): void {
    if (!this.view?.getPageImages) {
      window.alert("Play mode supports PDFs.");
      return;
    }
    const cards = this.deckCards(id);
    if (!cards.length) {
      window.alert("No cards in this scope. Make a mark a card first.");
      return;
    }
    this.playCards(cards);
  }

  // Clicking an ungrouped/other deck row with no play selects its first card and
  // scrolls to it, so the row is a navigator as well as a launch button.
  private browseDeck(id: string): void {
    const cards = this.deckCards(id).sort(
      (a, b) =>
        (a.spans[0]?.page ?? 0) - (b.spans[0]?.page ?? 0) ||
        (a.spans[0]?.y ?? 0) - (b.spans[0]?.y ?? 0)
    );
    const first = cards[0];
    if (!first) return;
    this.selectEntry(first.id, "mark");
    const page = first.spans[0]?.page;
    if (page !== undefined) this.view?.surfaces.find((s) => s.index === page)?.el.scrollIntoView({ block: "center" });
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
    const color = kind === "highlight" ? this.lineHighlightColor : this.lineOcclusionColor;
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
    // A cue (card question side) also shows the corner dot, so a cue-only mark
    // still advertises that something is attached to it.
    if (mark?.cue?.trim()) return true;
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
      if (!m) return "Mark";
      if (isInk(m)) return "Ink";
      return markKind(m) === "highlight" ? "Highlight" : "Occlusion";
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
    this.cancelNoteHover();
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

  // The corner dot is shared by notes and cues. Clicking it opens whichever the
  // mark actually has, preferring the note (the richer attachment); hovering it
  // previews the same thing.
  private openMarkAttachment(id: string, x: number, y: number): void {
    if (this.notes.some((n) => n.target === this.noteAnchor("mark", id).target)) {
      this.openNoteTarget("mark", id, x, y);
    } else {
      this.openCueEditor(id, { x, y });
    }
  }

  private hoverMarkAttachment(id: string, x: number, y: number): void {
    if (this.notes.some((n) => n.target === this.noteAnchor("mark", id).target)) {
      this.hoverNote("mark", id, x, y);
    } else {
      this.hoverCue(id, x, y);
    }
  }

  // The card cue editor. Reuses the note editor (Write/Preview, markdown,
  // preview-first) but stores the body on the mark, not in the notes list. A
  // cleared body removes the cue; there is no Delete button since clearing is
  // the removal.
  private openCueEditor(markId: string, anchor: { x: number; y: number }): void {
    this.cancelNoteHover();
    const mark = this.markById(markId);
    if (!mark) return;
    const label = this.noteLabel("mark", markId);
    const page = mark.spans[0]?.page;
    openNoteEditor({
      title: `Cue · ${label}${page !== undefined ? ` · p${page + 1}` : ""}`,
      initial: mark.cue ?? "",
      path: this.currentPath ?? "",
      anchor,
      placeholder: "card cue…  shown as the question side (markdown, [[link]])",
      onSave: (body) => {
        const m = this.markById(markId);
        if (!m) return;
        const text = body.trim();
        if (text) m.cue = text;
        else delete m.cue;
        void this.persist();
        this.overlay?.repaint();
      }
    });
  }

  private editNote(noteId: string, anchor: { x: number; y: number }): void {
    this.cancelNoteHover();
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

  // Hover preview: after a short dwell on an indicator, show the note body
  // read-only. A dwell (rather than immediate) avoids flashing cards while the
  // pointer sweeps across marked notes.
  private hoverNote(kind: NoteTargetKind, id: string, x: number, y: number): void {
    const anchor = this.noteAnchor(kind, id);
    const note = this.notes.find((n) => n.target === anchor.target);
    if (!note?.body.trim()) return;
    this.clearNotePreviewTimer();
    this.requestPreview({ kind: "note", targetKind: kind, id, x, y });
  }

  // Hover preview for a mark's cue. Shares the dwell/grace machinery with the
  // note preview so the two never fight over the one card.
  private hoverCue(markId: string, x: number, y: number): void {
    const mark = this.markById(markId);
    if (!mark?.cue?.trim()) return;
    this.clearNotePreviewTimer();
    this.requestPreview({ kind: "cue", markId, x, y });
  }

  private requestPreview(req: PreviewRequest): void {
    this.previewReq = req;
    this.notePreviewOver = false;
    this.notePreviewTimer = window.setTimeout(() => {
      this.notePreviewTimer = null;
      this.showPreviewCard();
    }, NOTE_DWELL_MS);
  }

  private showPreviewCard(): void {
    const req = this.previewReq;
    if (!req) return;
    if (req.kind === "note") {
      const anchor = this.noteAnchor(req.targetKind, req.id);
      const note = this.notes.find((n) => n.target === anchor.target);
      if (!note?.body.trim()) return;
      const label = this.noteLabel(anchor.kind, anchor.target);
      const page = this.notePage(anchor.kind, anchor.target);
      showNotePreview({
        title: `Note · ${label}${page !== undefined ? ` · p${page + 1}` : ""}`,
        quote: note.quote,
        body: note.body,
        path: this.currentPath ?? "",
        anchor: { x: req.x, y: req.y + 6 },
        onHoverChange: (over) => this.previewHover(over),
        onEdit: () => this.openNoteTarget(req.targetKind, req.id, req.x, req.y)
      });
      return;
    }
    const mark = this.markById(req.markId);
    if (!mark?.cue?.trim()) return;
    const label = this.noteLabel("mark", req.markId);
    const page = mark.spans[0]?.page;
    showNotePreview({
      title: `Cue · ${label}${page !== undefined ? ` · p${page + 1}` : ""}`,
      body: mark.cue,
      path: this.currentPath ?? "",
      anchor: { x: req.x, y: req.y + 6 },
      onHoverChange: (over) => this.previewHover(over),
      onEdit: () => this.openCueEditor(req.markId, { x: req.x, y: req.y })
    });
  }

  private previewHover(over: boolean): void {
    this.notePreviewOver = over;
    if (over) this.clearNotePreviewTimer();
    else this.scheduleHideNotePreview();
  }

  // Pointer left the indicator: defer hiding so the user can travel onto the
  // card (its Edit button is the one interactive part). Cancelled on re-enter.
  private leaveNote(): void {
    this.scheduleHideNotePreview();
  }

  private scheduleHideNotePreview(): void {
    if (this.notePreviewOver) return;
    this.clearNotePreviewTimer();
    this.notePreviewTimer = window.setTimeout(() => {
      this.notePreviewTimer = null;
      this.cancelNoteHover();
    }, NOTE_GRACE_MS);
  }

  private cancelNoteHover(): void {
    this.clearNotePreviewTimer();
    this.previewReq = null;
    this.notePreviewOver = false;
    hideNotePreview();
  }

  private clearNotePreviewTimer(): void {
    if (this.notePreviewTimer !== null) {
      window.clearTimeout(this.notePreviewTimer);
      this.notePreviewTimer = null;
    }
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

  // Routes a toolbar button's right-click to that tool's options. Only tools
  // that carry an `options` flag in the toolbar (and thus suppress the native
  // context menu) reach here; adding options to another tool is a new case
  // below plus that flag. The line tool reuses the same menu as the page
  // right-click, so the two entry points can't drift apart.
  private openToolMenu(action: string, clientX: number, clientY: number): void {
    if (action === "line") this.openLineSettings(clientX, clientY);
    else if (action === "ink") this.openInkMenu(clientX, clientY);
  }

  // Pen options: color quick-pick plus stroke sizes. Applies to future strokes.
  private openInkMenu(clientX: number, clientY: number): void {
    const style = this.overlay?.getInkStyle() ?? { color: INK_COLOR, weight: 0.004 };
    const names = ["Blue", "Yellow", "Green", "Pink", "Purple"];
    const items: ContextMenuEntry[] = [{ label: "Pen color", disabled: true, onSelect: () => undefined }];
    MARK_PALETTE.forEach((color, i) => {
      items.push({
        label: names[i] ?? color,
        swatch: color,
        checked: style.color === color,
        onSelect: () => this.overlay?.setInkStyle(color)
      });
    });
    items.push({ label: "Custom…", onSelect: () => this.pickInkColor(style.color) });
    items.push("separator", { label: "Pen size", disabled: true, onSelect: () => undefined });
    const sizes: [string, number][] = [
      ["Thin", 0.003],
      ["Medium", 0.006],
      ["Thick", 0.012]
    ];
    for (const [label, weight] of sizes) {
      items.push({
        label,
        checked: style.weight === weight,
        onSelect: () => this.overlay?.setInkStyle(style.color, weight)
      });
    }
    openContextMenu({ title: "Pen", items }, clientX, clientY);
  }

  private pickInkColor(current: string): void {
    const input = document.createElement("input");
    input.type = "color";
    input.value = /^#[0-9a-fA-F]{6}$/.test(current) ? current : INK_COLOR;
    input.style.position = "fixed";
    input.style.opacity = "0";
    input.style.pointerEvents = "none";
    document.body.appendChild(input);
    input.addEventListener("input", () => this.overlay?.setInkStyle(input.value));
    input.addEventListener("blur", () => window.setTimeout(() => input.remove(), 0));
    input.click();
  }

  private openLineMenu(clientX: number, clientY: number, withDraft: boolean): void {
    const commit = (kind: MarkKind) => {
      this.overlay?.commitPending(kind);
      void this.persist();
    };
    const items: ContextMenuEntry[] = [];
    if (withDraft && this.overlay?.hasPending()) {
      items.push(
        { label: "Use as occlusion", swatch: this.lineOcclusionColor, onSelect: () => commit("occlusion") },
        { label: "Use as highlight", swatch: this.lineHighlightColor, onSelect: () => commit("highlight") },
        "separator"
      );
    }
    items.push(
      { label: "Default for new lines", disabled: true, onSelect: () => undefined },
      {
        label: "Occlusion",
        swatch: this.lineOcclusionColor,
        checked: this.lineDefault === "occlusion",
        hint: this.lineDefault === "occlusion" ? "current" : undefined,
        onSelect: () => void this.setLineDefault("occlusion", true)
      },
      {
        label: "Highlight",
        swatch: this.lineHighlightColor,
        checked: this.lineDefault === "highlight",
        hint: this.lineDefault === "highlight" ? "current" : undefined,
        onSelect: () => void this.setLineDefault("highlight", true)
      },
      {
        label: "Ask each swipe",
        checked: this.lineDefault === "none",
        hint: this.lineDefault === "none" ? "current" : undefined,
        onSelect: () => void this.setLineDefault("none", false)
      },
      "separator",
      { label: "Default colors", disabled: true, onSelect: () => undefined },
      {
        label: "Occlusion color…",
        swatch: this.lineOcclusionColor,
        onSelect: () => this.openLineColorMenu("occlusion", clientX, clientY)
      },
      {
        label: "Highlight color…",
        swatch: this.lineHighlightColor,
        onSelect: () => this.openLineColorMenu("highlight", clientX, clientY)
      }
    );
    openContextMenu({ title: withDraft ? "Line — choose a kind" : "Line tool", items }, clientX, clientY);
  }

  // Palette + custom picker for one line-tool default color. Reopens in place
  // of the line menu (there is no submenu primitive; a pick reopens the line
  // menu so the new swatch is visible immediately).
  private openLineColorMenu(kind: MarkKind, clientX: number, clientY: number): void {
    const names = ["Blue", "Yellow", "Green", "Pink", "Purple"];
    const current = kind === "highlight" ? this.lineHighlightColor : this.lineOcclusionColor;
    const items: ContextMenuEntry[] = [];
    MARK_PALETTE.forEach((color, i) => {
      items.push({
        label: names[i] ?? color,
        swatch: color,
        checked: current === color,
        onSelect: () => {
          void this.setLineColor(kind, color);
          this.openLineMenu(clientX, clientY, false);
        }
      });
    });
    items.push({
      label: "Custom…",
      onSelect: () => this.pickLineColor(kind, () => this.openLineMenu(clientX, clientY, false))
    });
    openContextMenu(
      { title: kind === "highlight" ? "Highlight color" : "Occlusion color", items },
      clientX,
      clientY
    );
  }

  // Persists a line-tool default color and applies it to the overlay, so the
  // next swipe (and any rect drawn while that kind is active) uses it.
  private async setLineColor(kind: MarkKind, color: string): Promise<void> {
    if (kind === "highlight") {
      this.lineHighlightColor = color;
      this.overlay?.setLineColors({ highlight: color });
      await this.prefs.update({ lineHighlightColor: color });
    } else {
      this.lineOcclusionColor = color;
      this.overlay?.setLineColors({ occlusion: color });
      await this.prefs.update({ lineOcclusionColor: color });
    }
  }

  private pickLineColor(kind: MarkKind, done: () => void): void {
    const current = kind === "highlight" ? this.lineHighlightColor : this.lineOcclusionColor;
    const input = document.createElement("input");
    input.type = "color";
    input.value = /^#[0-9a-fA-F]{6}$/.test(current) ? current : DEFAULT_OCCLUSION_COLOR;
    input.style.position = "fixed";
    input.style.opacity = "0";
    input.style.pointerEvents = "none";
    document.body.appendChild(input);
    input.addEventListener("input", () => void this.setLineColor(kind, input.value));
    input.addEventListener("blur", () => window.setTimeout(() => { input.remove(); done(); }, 0));
    input.click();
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

  // Neighbouring occlusions visible in a card's crop, drawn grey behind the
  // focused card. Only marks that actually overlap the shown crop count, and the
  // focused card is excluded. Highlights are skipped: they are annotations, not
  // answers, so greying them would just add clutter. Requires a frame, because
  // a frame-less card's band is page-wide and would pull in unrelated rows.
  private contextMarksForCard(id: string, crop: Span): Mark[] {
    const card = this.markById(id);
    if (!card || !this.liveFrameIdOf(card)) return [];
    return this.marks().filter((m) => {
      if (m.id === id || !m.tags.includes("occlusion")) return false;
      const s = m.spans[0];
      if (!s || s.page !== crop.page) return false;
      const hit = intersect(crop, s);
      return hit.w > 0 && hit.h > 0;
    });
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
    this.unmountAiContext();
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
    this.applyDrawers();
    this.toolbar.setOutline(false);
    this.toolbar.setNotes(false);
    this.zoomCtl?.destroy();
    this.zoomCtl = null;
    this.toolbar.setZoomVisible(false);
    this.toolbar.setTextDebugVisible(false);
    this.toolbar.setShareContextVisible(false);
    this.toolbar.setPageModeVisible(false);
    this.toolbar.setPage(1, 1);
    this.view?.destroy();
    this.view = null;
    this.refreshNotes();
  }
}
