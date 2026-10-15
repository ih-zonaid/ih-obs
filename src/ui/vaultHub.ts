import type { VaultRecord } from "../host/idb";
import { icon, type IconName } from "./icons";

export interface VaultHubHandlers {
  onOpen(id: string): void;
  onAdd(): void;
  onAddFile(): void;
  onRename(id: string): void;
  onForget(id: string): void;
}

export interface VaultStatus {
  id: string;
  ready: boolean;
}

export class VaultHub {
  private readonly root: HTMLElement;
  private readonly handlers: VaultHubHandlers;

  constructor(root: HTMLElement, handlers: VaultHubHandlers) {
    this.root = root;
    this.handlers = handlers;
  }

  show(vaults: VaultRecord[], currentId: string | null, status: Map<string, boolean>): void {
    this.root.innerHTML = "";
    this.root.classList.remove("empty");

    const wrap = document.createElement("div");
    wrap.className = "home hub";

    const head = document.createElement("div");
    head.className = "hub-head";
    const title = document.createElement("h1");
    title.className = "home-title";
    title.textContent = "Vaults & files";

    const actions = document.createElement("div");
    actions.className = "hub-actions";

    const openFile = document.createElement("button");
    openFile.className = "tb-btn";
    openFile.appendChild(icon("file-text", 14));
    const fileLabel = document.createElement("span");
    fileLabel.textContent = "open file";
    openFile.appendChild(fileLabel);
    openFile.title = "open a single document (pdf, image, markdown, json)";
    openFile.addEventListener("click", () => this.handlers.onAddFile());

    const add = document.createElement("button");
    add.className = "tb-btn";
    add.appendChild(icon("plus", 14));
    const addLabel = document.createElement("span");
    addLabel.textContent = "add vault";
    add.appendChild(addLabel);
    add.title = "add a folder as a vault";
    add.addEventListener("click", () => this.handlers.onAdd());

    actions.append(openFile, add);
    head.append(title, actions);
    wrap.appendChild(head);

    if (!vaults.length) {
      const hint = document.createElement("p");
      hint.className = "home-hint";
      hint.textContent = "No vaults or files yet. Add a folder as a vault, or open a single file.";
      wrap.appendChild(hint);
      this.root.appendChild(wrap);
      return;
    }

    const list = document.createElement("div");
    list.className = "home-list";
    for (const v of vaults) {
      list.appendChild(this.row(v, v.id === currentId, status.get(v.id) ?? false));
    }
    wrap.appendChild(list);
    this.root.appendChild(wrap);
  }

  private row(v: VaultRecord, current: boolean, ready: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "home-row hub-row" + (current ? " current" : "");
    row.addEventListener("click", () => this.handlers.onOpen(v.id));

    if (v.single) {
      const kind = document.createElement("span");
      kind.className = "hub-kind";
      kind.title = "single file";
      kind.appendChild(icon("file-text", 13));
      row.appendChild(kind);
    }

    const name = document.createElement("span");
    name.className = "home-name";
    name.textContent = v.label;
    row.appendChild(name);

    const badge = document.createElement("span");
    badge.className = "hub-badge" + (ready ? " ok" : " warn");
    badge.textContent = ready ? "ready" : "re-connect";
    badge.title = ready ? "permission granted" : "click to grant access";
    row.appendChild(badge);

    const when = document.createElement("span");
    when.className = "home-when";
    when.textContent = relative(v.lastOpenedAt);
    row.appendChild(when);

    row.append(
      this.action("pencil", "rename vault", (e) => {
        e.stopPropagation();
        this.handlers.onRename(v.id);
      }),
      this.action("trash", "forget vault", (e) => {
        e.stopPropagation();
        this.handlers.onForget(v.id);
      })
    );
    return row;
  }

  private action(name: IconName, title: string, onClick: (e: MouseEvent) => void): HTMLElement {
    const el = document.createElement("span");
    el.className = "hub-action";
    el.appendChild(icon(name, 14));
    el.title = title;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", title);
    el.addEventListener("click", onClick);
    return el;
  }
}

function relative(at: number): string {
  if (!at) return "";
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
