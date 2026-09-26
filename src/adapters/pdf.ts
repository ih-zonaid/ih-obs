import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { readBytes } from "../vault/fs";
import { isPdf } from "../vault/tree";
import type { DocAdapter, DocView, LoadContext, Surface } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const BASE_SCALE = 1.6;

export const pdfAdapter: DocAdapter = {
  kind: "pdf",
  matches: isPdf,
  async load(ctx: LoadContext): Promise<DocView> {
    const data = await readBytes(ctx.handle);
    const task = pdfjs.getDocument({ data });
    const doc = await task.promise;
    const surfaces: Surface[] = [];
    const nodes: HTMLElement[] = [];

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: BASE_SCALE });

      const wrap = document.createElement("div");
      wrap.className = "pdf-page ihobs-surface";
      wrap.dataset.surface = String(i - 1);
      wrap.style.width = `${viewport.width}px`;
      wrap.style.height = `${viewport.height}px`;

      const canvas = document.createElement("canvas");
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const cctx = canvas.getContext("2d");
      if (!cctx) throw new Error("no 2d context");
      cctx.scale(ratio, ratio);

      wrap.appendChild(canvas);
      ctx.container.appendChild(wrap);

      await page.render({ canvasContext: cctx, viewport }).promise;

      surfaces.push({ index: i - 1, el: wrap, width: viewport.width, height: viewport.height });
      nodes.push(wrap);
    }

    return {
      kind: "pdf",
      path: ctx.path,
      surfaces,
      destroy() {
        void task.destroy();
        nodes.forEach((n) => n.remove());
      }
    };
  }
};
