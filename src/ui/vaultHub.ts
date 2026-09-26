import type { VaultRecord } from "../host/idb";

export interface VaultHubHandlers {
  onOpen(id: string): void;
  onAdd(): void;
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
    title.textContent = "Vaults";
    const add = document.createElement("button");
    add.className = "tb-btn";
    add.textContent = "+ add vault";
    add.addEventListener("click", () => this.handlers.onAdd());
    head.append(title, add);
    wrap.appendChild(head);

    if (!vaults.length) {
      const hint = document.createElement("p");
      hint.className = "home-hint";
      hint.textContent = "No vaults yet. Add a folder to get started.";
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
      this.action("rename", (e) => {
        e.stopPropagation();
        this.handlers.onRename(v.id);
      }),
      this.action("forget", (e) => {
        e.stopPropagation();
        this.handlers.onForget(v.id);
      })
    );
    return row;
  }

  private action(label: string, onClick: (e: MouseEvent) => void): HTMLElement {
    const el = document.createElement("span");
    el.className = "hub-action";
    el.textContent = label;
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
