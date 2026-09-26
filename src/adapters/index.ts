import { imageAdapter } from "./image";
import { jsonAdapter } from "./json";
import { markdownAdapter } from "./markdown";
import { pdfAdapter } from "./pdf";
import type { DocAdapter } from "./types";

const ADAPTERS: DocAdapter[] = [imageAdapter, pdfAdapter, markdownAdapter, jsonAdapter];

export function pickAdapter(path: string): DocAdapter | null {
  return ADAPTERS.find((a) => a.matches(path)) ?? null;
}

export function registerAdapter(adapter: DocAdapter): void {
  ADAPTERS.unshift(adapter);
}

export type { DocAdapter, DocView, Surface, LoadContext, DocKind, PageImage } from "./types";
