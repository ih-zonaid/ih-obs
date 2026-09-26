import { marked } from "marked";
import { readText } from "../vault/fs";
import { isMarkdown } from "../vault/tree";
import type { DocAdapter, DocView, LoadContext } from "./types";

function safe(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/ on\w+="[^"]*"/gi, "")
    .replace(/ on\w+='[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

function resolveWikilinks(html: string, path: string): string {
  const base = path.slice(0, path.lastIndexOf("/") + 1);
  return html.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const label = (alias ?? target).trim();
    const rel = target.trim();
    const resolved = rel.includes(".") ? `${base}${rel}` : `${base}${rel}.md`;
    return `<a class="wiki-link" data-target="${resolved}">${label}</a>`;
  });
}

export const markdownAdapter: DocAdapter = {
  kind: "markdown",
  matches: isMarkdown,
  async load(ctx: LoadContext): Promise<DocView> {
    const raw = await readText(ctx.handle);
    const body = resolveWikilinks(safe(marked.parse(raw) as string), ctx.path);
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
