import { readText } from "../vault/fs";
import { isMarkdown } from "../vault/tree";
import { renderMarkdown } from "../notes/render";
import type { DocAdapter, DocView, LoadContext } from "./types";

export const markdownAdapter: DocAdapter = {
  kind: "markdown",
  matches: isMarkdown,
  async load(ctx: LoadContext): Promise<DocView> {
    const raw = await readText(ctx.handle);
    const body = renderMarkdown(raw, ctx.path);
    const el = document.createElement("article");
    el.className = "md-scroll ihobs-surface";
    el.dataset.surface = "0";
    el.innerHTML = body;
    ctx.container.appendChild(el);
    return {
      kind: "markdown",
      path: ctx.path,
      surfaces: [{ index: 0, el, width: el.clientWidth, height: el.scrollHeight }],
      destroy() {
        el.remove();
      }
    };
  }
};
