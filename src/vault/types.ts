export interface FsNode {
  name: string;
  path: string;
  kind: "directory" | "file";
  ext?: string;
  children?: FsNode[];
}

export function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function flattenFiles(node: FsNode, out: FsNode[] = []): FsNode[] {
  if (node.kind === "file") {
    out.push(node);
    return out;
  }
  for (const child of node.children ?? []) flattenFiles(child, out);
  return out;
}
