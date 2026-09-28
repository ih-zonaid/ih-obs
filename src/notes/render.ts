import { marked } from "marked";

// Strips the vectors that matter for a local, offline reader: script tags,
// inline event handlers, and javascript: URLs. Not a full sanitizer, but the
// input is the user's own vault, so this is proportionate.
export function safe(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/ on\w+="[^"]*"/gi, "")
    .replace(/ on\w+='[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

// Turns [[target]] / [[target|alias]] into anchors. Relative targets get the
// note's own directory as base so a bare name resolves beside it.
export function resolveWikilinks(html: string, path: string): string {
  const base = path.slice(0, path.lastIndexOf("/") + 1);
  return html.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const label = (alias ?? target).trim();
    const rel = target.trim();
    const resolved = rel.includes(".") ? `${base}${rel}` : `${base}${rel}.md`;
    return `<a class="wiki-link" data-target="${resolved}">${label}</a>`;
  });
}

// The single entry point for rendering any user markdown in the app, so notes
// and markdown documents cannot drift apart in what they allow or linkify.
export function renderMarkdown(raw: string, path = ""): string {
  const html = marked.parse(raw, { async: false }) as string;
  const linked = path ? resolveWikilinks(html, path) : html;
  return safe(linked);
}
