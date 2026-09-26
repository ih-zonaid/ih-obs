import type { FsNode } from "../vault/types";

export interface ExplorerHandlers {
  onOpen(path: string): void;
}

export class Explorer {
  private readonly root: HTMLElement;
  private readonly handlers: ExplorerHandlers;
  private active: string | null = null;

  constructor(root: HTMLElement, handlers: ExplorerHandlers) {
    this.root = root;
    this.handlers = handlers;
    this.root.className = "explorer";
  }

  render(tree: FsNode): void {
    this.root.innerHTML = "";
    const list = document.createElement("div");
    list.className = "explorer-tree";
    for (const child of tree.children ?? []) {
      list.appendChild(this.node(child, 0));
    }
    this.root.appendChild(list);
  }

  setActive(path: string | null): void {
    this.active = path;
    this.root.querySelectorAll(".explorer-item").forEach((el) => {
      el.classList.toggle("active", (el as HTMLElement).dataset.path === path);
    });
  }

  private node(node: FsNode, depth: number): HTMLElement {
    if (node.kind === "directory") {
      const details = document.createElement("details");
      details.className = "explorer-dir";
      details.open = depth < 1;
      const summary = document.createElement("summary");
      summary.className = "explorer-item dir";
      summary.textContent = node.name;
      summary.style.paddingLeft = `${8 + depth * 12}px`;
      details.appendChild(summary);
      for (const child of node.children ?? []) {
        details.appendChild(this.node(child, depth + 1));
      }
      return details;
    }

    const item = document.createElement("div");
    item.className = "explorer-item file";
    item.dataset.path = node.path;
    item.textContent = node.name;
    item.style.paddingLeft = `${8 + depth * 12}px`;
    if (this.active === node.path) item.classList.add("active");
    item.addEventListener("click", () => this.handlers.onOpen(node.path));
    return item;
  }
}
