import type { Prefs, RecentEntry } from "../store/prefs";
import { icon } from "./icons";

export interface HomeHandlers {
  onOpen(path: string): void;
  onTogglePin(path: string): void;
}

export class Home {
  private readonly root: HTMLElement;
  private readonly handlers: HomeHandlers;

  constructor(root: HTMLElement, handlers: HomeHandlers) {
    this.root = root;
    this.handlers = handlers;
  }

  show(prefs: Prefs): void {
    this.root.innerHTML = "";
    this.root.classList.remove("empty");

    const wrap = document.createElement("div");
    wrap.className = "home";

    const title = document.createElement("h1");
    title.className = "home-title";
    title.textContent = "ihobs";
    wrap.appendChild(title);

    const pinned = prefs.pinned.filter(Boolean);
    if (pinned.length) {
      wrap.appendChild(this.section("Pinned", this.pinRows(pinned)));
    }

    if (prefs.recents.length) {
      wrap.appendChild(this.section("Recent", this.recentRows(prefs.recents)));
    }

    if (!pinned.length && !prefs.recents.length) {
      const hint = document.createElement("p");
      hint.className = "home-hint";
      hint.textContent = "Pick a vault, then open a file from the sidebar.";
      wrap.appendChild(hint);
    }

    this.root.appendChild(wrap);
  }

  private section(label: string, rows: HTMLElement[]): HTMLElement {
    const sec = document.createElement("section");
    sec.className = "home-section";
    const h = document.createElement("h2");
    h.textContent = label;
    sec.appendChild(h);
    const list = document.createElement("div");
    list.className = "home-list";
    rows.forEach((r) => list.appendChild(r));
    sec.appendChild(list);
    return sec;
  }

  private recentRows(recents: RecentEntry[]): HTMLElement[] {
    return recents.map((r) => this.row(r.path, r.at));
  }

  private pinRows(paths: string[]): HTMLElement[] {
    return paths.map((p) => this.row(p, null));
  }

  private row(path: string, at: number | null): HTMLElement {
    const row = document.createElement("div");
    row.className = "home-row";

    const name = document.createElement("span");
    name.className = "home-name";
    name.textContent = path;
    row.appendChild(name);

    if (at !== null) {
      const when = document.createElement("span");
      when.className = "home-when";
      when.textContent = relative(at);
      row.appendChild(when);
    }

    const star = document.createElement("span");
    star.className = "explorer-star";
    star.appendChild(icon("star", 14));
    star.title = "pin";
    star.setAttribute("role", "button");
    star.setAttribute("aria-label", "pin");
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      this.handlers.onTogglePin(path);
    });
    row.appendChild(star);

    row.addEventListener("click", () => this.handlers.onOpen(path));
    return row;
  }
}

function relative(at: number): string {
  const diff = Date.now() - at;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(at).toLocaleDateString();
}
