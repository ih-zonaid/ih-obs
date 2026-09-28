import { hasChromeStorage, kvGet, kvRemove, kvSet } from "./kv";

export interface RecentEntry {
  path: string;
  at: number;
}

export interface Prefs {
  recents: RecentEntry[];
  pinned: string[];
  expanded: string[];
  lastOpened: string | null;
  // Panel layout, kept per vault. `leftCollapsed` hides the file explorer;
  // `railOpen`/`railTab` remember the right rail's visibility and active tab.
  leftCollapsed: boolean;
  railOpen: boolean;
  railTab: "outline" | "notes";
  // Set once the user opens/closes the rail themselves; until then we may
  // auto-open the outline for the first paged document.
  railConfigured: boolean;
}

export type Theme = "dark" | "light";

const THEME_KEY = "ihobs:theme";
const MAX_RECENTS = 20;

const DEFAULTS: Prefs = {
  recents: [],
  pinned: [],
  expanded: [],
  lastOpened: null,
  leftCollapsed: false,
  railOpen: false,
  railTab: "outline",
  railConfigured: false
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

export { hasChromeStorage };
