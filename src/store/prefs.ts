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
}

export type Theme = "dark" | "light";

const THEME_KEY = "ihobs:theme";
const MAX_RECENTS = 20;

const DEFAULTS: Prefs = {
  recents: [],
  pinned: [],
  expanded: [],
  lastOpened: null
};

export class PrefsStore {
  private data: Prefs = { ...DEFAULTS };
  private loaded = false;
  private key = "ihobs:prefs:global";

  withVault(vaultId: string): this {
    this.key = `ihobs:prefs:${vaultId}`;
    this.data = { ...DEFAULTS };
    this.loaded = false;
    return this;
  }

  async load(): Promise<Prefs> {
    if (this.loaded) return this.data;
    const stored = await kvGet<Partial<Prefs>>(this.key);
    this.data = { ...DEFAULTS, ...(stored ?? {}) };
    this.loaded = true;
    return this.data;
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
