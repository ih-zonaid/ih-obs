export type DocKind = "markdown" | "image" | "pdf" | "json";

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
  setZoom?(zoom: number): number;
  getZoom?(): number;
  getPageImages?(pageIndices: number[], scale: number): Promise<PageImage[]>;
  pageCount?(): number;
  currentPage?(): number;
  goToPage?(page: number): void;
  onPageChange?(cb: (page: number) => void): void;
  destroy(): void;
}

export interface PageImage {
  page: number;
  width: number;
  height: number;
  image: ImageData;
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
