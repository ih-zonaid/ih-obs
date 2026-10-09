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
  // Renders one page to a self-contained data-URL image. Exists so the app can
  // publish the current page as a real <img> in the DOM: page-context AI
  // sidebars ingest image *resources* (Facebook-style <img src>), never a
  // <canvas>'s pixels or network-less app text, so the raster must be a URL.
  getPageImageUrl?(page: number, scale: number): Promise<string | null>;
  pageCount?(): number;
  currentPage?(): number;
  goToPage?(page: number): void;
  onPageChange?(cb: (page: number) => void): void;
  // PDF debugging: reveals the invisible text layer (0 off, 1 boxes, 2 text).
  setTextDebug?(level: number): void;
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
  // Aborted when a newer openPath() supersedes this load; adapters with
  // expensive setup (e.g. per-page work) should check it to bail out early.
  signal: AbortSignal;
}

export interface DocAdapter {
  kind: DocKind;
  matches(path: string): boolean;
  load(ctx: LoadContext): Promise<DocView>;
}
