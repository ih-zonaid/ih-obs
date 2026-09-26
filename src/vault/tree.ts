import type { FsNode } from "./types";

const IGNORED = new Set([".git", ".obsidian", "node_modules", ".DS_Store"]);
const HIDDEN_ALLOWED = new Set([".ihobs"]);
const MARKDOWN = new Set([".md", ".markdown", ".mdx"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const PDF = new Set([".pdf"]);
const JSON = new Set([".json"]);

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

export function isMarkdown(name: string): boolean {
  return MARKDOWN.has(extOf(name));
}

export function isImage(name: string): boolean {
  return IMAGE.has(extOf(name));
}

export function isPdf(name: string): boolean {
  return PDF.has(extOf(name));
}

export function isJson(name: string): boolean {
  return JSON.has(extOf(name));
}

export function isSupported(name: string): boolean {
  return isMarkdown(name) || isImage(name) || isPdf(name) || isJson(name);
}

interface DirWithEntries extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

export async function listTree(root: FileSystemDirectoryHandle): Promise<FsNode> {
  return walk(root, "", 0, root.name);
}

async function walk(
  dir: FileSystemDirectoryHandle,
  path: string,
  depth: number,
  name: string
): Promise<FsNode> {
  const children: FsNode[] = [];
  for await (const [childName, handle] of (dir as DirWithEntries).entries()) {
    if (IGNORED.has(childName)) continue;
    if (childName.startsWith(".") && !HIDDEN_ALLOWED.has(childName)) continue;
    const childPath = path ? `${path}/${childName}` : childName;
    if (handle.kind === "directory") {
      if (depth < 8) {
        children.push(
          await walk(handle as FileSystemDirectoryHandle, childPath, depth + 1, childName)
        );
      }
    } else if (isSupported(childName)) {
      children.push({ name: childName, path: childPath, kind: "file", ext: extOf(childName) });
    }
  }
  children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { name, path, kind: "directory", children };
}
