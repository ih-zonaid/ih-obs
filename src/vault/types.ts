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
