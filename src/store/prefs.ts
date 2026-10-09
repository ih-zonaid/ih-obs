import { hasChromeStorage, kvGet, kvRemove, kvSet } from "./kv";

export interface RecentEntry {
  path: string;
  at: number;
}

// Left-sidebar views. "files" is the vault explorer; the rest are "coming
// soon" activity-bar entries, kept out of the leftCollapsed persistence path.
export type LeftTab = "files" | "search" | "bookmarks";

// Right-sidebar views. "notes" is a single global panel that follows the active
// document (the Notes tab always shows the current document's notes).
export type RailTab = "outline" | "notes";

export interface Prefs {
  recents: RecentEntry[];
  pinned: string[];
  expanded: string[];
  lastOpened: string | null;
  // Panel layout, kept per vault. `leftCollapsed` hides the file explorer;
  // `railOpen`/`railTab` remember the right rail's visibility and active tab.
  leftCollapsed: boolean;
  railOpen: boolean;
  railTab: RailTab;
  // Set once the user opens/closes the rail themselves; until then we may
  // auto-open the outline for the first paged document.
  railConfigured: boolean;
  // Sidebar widths in px, remembered across sessions. 0 means "use the CSS
  // default"; the app clamps whatever is loaded to the allowed range.
  leftWidth: number;
  rightWidth: number;
  // Line tool's default kind. "none" keeps the original two-step flow (swipe,
  // then choose occlusion/highlight from the draft's right-click menu); a kind
  // commits each swipe immediately with that tag.
  lineDefault: LineDefault;
}

export type LineDefault = "none" | "occlusion" | "highlight";

export type Theme = "dark" | "light";

// How the document's raster page is tinted, independent of the app `Theme`:
// dark chrome with a light book is a legitimate combination, so this is its own
// setting. "invert" is a full dark-mode flip; "warm" is a softer, paper-tinted
// dim that hides scanner noise better on dirty scans.
export type PageMode = "off" | "invert" | "warm";

// Canvas 2D can't read CSS variables, and play mode paints the page crop
// itself, so the filter strings are shared from here. The CSS mirrors these in
// styles.css (.shell[data-page-tint] rules).
export const PAGE_FILTERS: Record<PageMode, string> = {
  off: "none",
  invert: "invert(1) hue-rotate(180deg)",
  warm: "invert(0.92) hue-rotate(180deg) sepia(0.3) saturate(1.2) brightness(1.05)"
};

const THEME_KEY = "ihobs:theme";
const PAGE_MODE_KEY = "ihobs:page-mode";
const MAX_RECENTS = 20;

const DEFAULTS: Prefs = {
  recents: [],
  pinned: [],
  expanded: [],
  lastOpened: null,
  leftCollapsed: false,
  railOpen: false,
  railTab: "outline",
  railConfigured: false,
  leftWidth: 0,
  rightWidth: 0,
  lineDefault: "none"
};

export class PrefsStore {
  private data: Prefs = { ...DEFAULTS };
  private loaded = false;
  private stored = false;
  private key = "ihobs:prefs:global";

  withVault(vaultId: string): this {
    this.key = `ihobs:prefs:${vaultId}`;
    this.data = { ...DEFAULTS };
    this.loaded = false;
    this.stored = false;
    return this;
  }

  async load(): Promise<Prefs> {
    if (this.loaded) return this.data;
    const stored = await kvGet<Partial<Prefs>>(this.key);
    this.stored = !!stored;
    this.data = { ...DEFAULTS, ...(stored ?? {}) };
    this.loaded = true;
    return this.data;
  }

  // True when real preferences existed on disk, so callers can apply a layout
  // default only on a genuinely first visit rather than overriding a choice.
  hasStored(): boolean {
    return this.stored;
  }

  get(): Prefs {
    return this.data;
  }

  async update(patch: Partial<Prefs>): Promise<void> {
    this.data = { ...this.data, ...patch };
    await kvSet(this.key, this.data);
  }

  async pushRecent(path: string): Promise<void> {
    const recents = this.data.recents.filter((r) => r.path !== path);
    recents.unshift({ path, at: Date.now() });
    await this.update({ recents: recents.slice(0, MAX_RECENTS), lastOpened: path });
  }

  async togglePin(path: string): Promise<boolean> {
    const pinned = new Set(this.data.pinned);
    const wasPinned = pinned.has(path);
    if (wasPinned) pinned.delete(path);
    else pinned.add(path);
    await this.update({ pinned: [...pinned] });
    return !wasPinned;
  }

  async setExpanded(expanded: string[]): Promise<void> {
    await this.update({ expanded });
  }

  async clearVaultData(): Promise<void> {
    await kvRemove(this.key);
  }
}

export async function loadTheme(): Promise<Theme> {
  const stored = await kvGet<Theme>(THEME_KEY);
  return stored === "light" ? "light" : "dark";
}

export async function saveTheme(theme: Theme): Promise<void> {
  await kvSet(THEME_KEY, theme);
}

export async function loadPageMode(): Promise<PageMode> {
  const stored = await kvGet<PageMode>(PAGE_MODE_KEY);
  return stored === "invert" || stored === "warm" ? stored : "off";
}

export async function savePageMode(mode: PageMode): Promise<void> {
  await kvSet(PAGE_MODE_KEY, mode);
}

export function nextPageMode(mode: PageMode): PageMode {
  return mode === "off" ? "invert" : mode === "invert" ? "warm" : "off";
}

export { hasChromeStorage };
