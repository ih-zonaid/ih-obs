export interface RecentEntry {
  path: string;
  at: number;
}

export interface Prefs {
  theme: "dark" | "light";
  recents: RecentEntry[];
  pinned: string[];
  expanded: string[];
  lastOpened: string | null;
}

const KEY = "ihobs:prefs";
const MAX_RECENTS = 20;

const DEFAULTS: Prefs = {
  theme: "dark",
  recents: [],
  pinned: [],
  expanded: [],
  lastOpened: null
};

function hasChromeStorage(): boolean {
  return typeof chrome !== "undefined" && !!chrome.storage?.local;
}

export class PrefsStore {
  private data: Prefs = { ...DEFAULTS };
  private loaded = false;

  async load(): Promise<Prefs> {
    if (this.loaded) return this.data;
    if (hasChromeStorage()) {
      const got = await chrome.storage.local.get(KEY);
      this.data = { ...DEFAULTS, ...((got[KEY] as Partial<Prefs>) ?? {}) };
    } else {
      try {
        const raw = localStorage.getItem(KEY);
        this.data = raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : { ...DEFAULTS };
      } catch {
        this.data = { ...DEFAULTS };
      }
    }
    this.loaded = true;
    return this.data;
  }

  get(): Prefs {
    return this.data;
  }

  async update(patch: Partial<Prefs>): Promise<void> {
    this.data = { ...this.data, ...patch };
    await this.persist();
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

  async setTheme(theme: Prefs["theme"]): Promise<void> {
    await this.update({ theme });
  }

  private async persist(): Promise<void> {
    if (hasChromeStorage()) {
      await chrome.storage.local.set({ [KEY]: this.data });
    } else {
      try {
        localStorage.setItem(KEY, JSON.stringify(this.data));
      } catch {
        /* ignore */
      }
    }
  }
}
