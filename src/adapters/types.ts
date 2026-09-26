export type DocKind = "markdown" | "image" | "pdf";

export interface Surface {
  index: number;
  el: HTMLElement;
  width: number;
  height: number;
}

export interface DocView {
  kind: DocKind;
  path: string;
  surfaces: Surface[];
  destroy(): void;
}

export interface LoadContext {
  vault: FileSystemDirectoryHandle;
  path: string;
  handle: FileSystemFileHandle;
  container: HTMLElement;
}

export interface DocAdapter {
  kind: DocKind;
  matches(path: string): boolean;
  load(ctx: LoadContext): Promise<DocView>;
}
