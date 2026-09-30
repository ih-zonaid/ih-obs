import type { FsNode } from "../vault/types";
import { icon } from "./icons";

export interface ExplorerHandlers {
  onOpen(path: string): void;
  onTogglePin(path: string): void;
  onExpandedChange(expanded: string[]): void;
}

export class Explorer {
  private readonly root: HTMLElement;
  private readonly handlers: ExplorerHandlers;
  private active: string | null = null;
  private expanded = new Set<string>();
  private pinned = new Set<string>();
  private filter = "";
  private tree: FsNode | null = null;

  constructor(root: HTMLElement, handlers: ExplorerHandlers) {
    this.root = root;
    this.handlers = handlers;
    this.root.className = "explorer";
  }

  setState(expanded: string[], pinned: string[]): void {
    this.expanded = new Set(expanded);
    this.pinned = new Set(pinned);
  }

  render(tree: FsNode): void {
    this.tree = tree;
    this.root.innerHTML = "";

    const search = document.createElement("input");
    search.className = "explorer-search";
    search.placeholder = "filter…";
    search.value = this.filter;
    search.addEventListener("input", () => {
      this.filter = search.value.trim().toLowerCase();
      this.paintTree();
    });
    this.root.appendChild(search);

    const list = document.createElement("div");
    list.className = "explorer-tree";
    list.id = "explorer-tree";
    this.root.appendChild(list);
    this.paintTree();
  }

  private paintTree(): void {
    const list = this.root.querySelector("#explorer-tree");
    if (!list || !this.tree) return;
    list.innerHTML = "";
    const children = this.tree.children ?? [];
    for (const child of children) {
      const el = this.filter ? this.filteredNode(child, 0) : this.node(child, 0);
      if (el) list.appendChild(el);
    }
  }

  private matches(node: FsNode, q: string): boolean {
    if (node.name.toLowerCase().includes(q)) return true;
    return (node.children ?? []).some((c) => this.matches(c, q));
  }

  private filteredNode(node: FsNode, depth: number): HTMLElement | null {
    if (!this.matches(node, this.filter)) return null;
    if (node.kind === "file") {
      return this.fileNode(node, depth);
    }
    const details = document.createElement("details");
    details.className = "explorer-dir";
    details.open = true;
    details.appendChild(this.dirSummary(node, depth));
    for (const child of node.children ?? []) {
      const el = this.filteredNode(child, depth + 1);
      if (el) details.appendChild(el);
    }
    return details;
  }

  private dirSummary(node: FsNode, depth: number): HTMLElement {
    const summary = document.createElement("summary");
    summary.className = "explorer-item dir";
    summary.textContent = node.name;
    summary.style.paddingLeft = `${8 + depth * 12}px`;
    return summary;
  }

  private node(node: FsNode, depth: number): HTMLElement {
    if (node.kind === "directory") {
      const details = document.createElement("details");
      details.className = "explorer-dir";
      details.dataset.path = node.path;
      details.open = this.expanded.has(node.path) || this.isAncestorOfActive(node.path);
      details.addEventListener("toggle", () => {
        if (details.open) this.expanded.add(node.path);
        else this.expanded.delete(node.path);
        this.handlers.onExpandedChange([...this.expanded]);
      });
      details.appendChild(this.dirSummary(node, depth));
      for (const child of node.children ?? []) {
        details.appendChild(this.node(child, depth + 1));
      }
      return details;
    }
    return this.fileNode(node, depth);
  }

  private fileNode(node: FsNode, depth: number): HTMLElement {
    const item = document.createElement("div");
    item.className = "explorer-item file";
    item.dataset.path = node.path;
    const isPinned = this.pinned.has(node.path);
    if (isPinned) item.classList.add("pinned");
    item.style.paddingLeft = `${8 + depth * 12}px`;

    const name = document.createElement("span");
    name.className = "explorer-name";
    name.textContent = node.name;
    item.appendChild(name);

    const star = document.createElement("span");
    star.className = "explorer-star" + (isPinned ? " on" : "");
    star.appendChild(icon(isPinned ? "star-filled" : "star", 14));
    star.title = isPinned ? "unpin" : "pin";
    star.setAttribute("role", "button");
    star.setAttribute("aria-label", star.title);
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      this.handlers.onTogglePin(node.path);
    });
    item.appendChild(star);

    if (this.active === node.path) item.classList.add("active");
    item.addEventListener("click", () => this.handlers.onOpen(node.path));
    return item;
  }

  private isAncestorOfActive(dirPath: string): boolean {
    if (!this.active) return false;
    return this.active.startsWith(dirPath + "/");
  }

  setActive(path: string | null): void {
    this.active = path;
    this.paintTree();
  }

  revealActive(): void {
    if (!this.active || !this.tree) return;
    const segments = this.active.split("/");
    let acc = "";
    for (let i = 0; i < segments.length - 1; i++) {
      acc = acc ? `${acc}/${segments[i]}` : segments[i];
      if (!this.expanded.has(acc)) {
        this.expanded.add(acc);
        this.handlers.onExpandedChange([...this.expanded]);
      }
    }
    this.paintTree();
  }
}
