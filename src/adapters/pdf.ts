import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { readBytes } from "../vault/fs";
import { isPdf } from "../vault/tree";
import type { DocAdapter, DocView, LoadContext, PageImage, Surface } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const BASE_SCALE = 1.6;
export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 4;

interface PageNode {
  index: number;
  page: pdfjs.PDFPageProxy;
  wrap: HTMLElement;
  canvas: HTMLCanvasElement | null;
  baseW: number;
  baseH: number;
  renderedScale: number;
  rendering: boolean;
  task: pdfjs.RenderTask | null;
}

export const pdfAdapter: DocAdapter = {
  kind: "pdf",
  matches: isPdf,
  async load(ctx: LoadContext): Promise<DocView> {
    const data = await readBytes(ctx.handle);
    const task = pdfjs.getDocument({ data });
    const doc = await task.promise;
    const ratio = window.devicePixelRatio || 1;
    const nodes: PageNode[] = [];
    const surfaces: Surface[] = [];
    let zoom = 1;
    let destroyed = false;
    const renderQueue: PageNode[] = [];

    const renderPage = async (n: PageNode): Promise<void> => {
      if (destroyed || n.rendering) return;
      if (n.renderedScale && Math.abs(n.renderedScale - zoom) < 0.01) return;
      n.rendering = true;
      const target = zoom;
      try {
        const viewport = n.page.getViewport({ scale: BASE_SCALE * target });
        const canvas = n.canvas ?? document.createElement("canvas");
        canvas.className = "pdf-canvas";
        const cctx = canvas.getContext("2d");
        if (!cctx) throw new Error("no 2d context");
        canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
        canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
        if (!n.canvas) {
          n.canvas = canvas;
          n.wrap.appendChild(canvas);
        }
        n.wrap.classList.add("is-rendered");
        cctx.save();
        cctx.scale(ratio, ratio);
        n.task = n.page.render({ canvasContext: cctx, viewport });
        await n.task.promise;
        n.renderedScale = target;
      } catch {
        /* cancelled or failed render */
      } finally {
        n.task = null;
        n.rendering = false;
        if (!destroyed && Math.abs(n.renderedScale - zoom) > 0.01) {
          renderQueue.push(n);
          pump();
        }
      }
    };

    const pump = (): void => {
      while (renderQueue.length) {
        void renderPage(renderQueue.shift() as PageNode);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const n = nodes[Number((e.target as HTMLElement).dataset.surface)];
          if (!n) continue;
          renderQueue.push(n);
        }
        pump();
      },
      { root: ctx.container, rootMargin: "800px 0px" }
    );

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: BASE_SCALE });
      const wrap = document.createElement("div");
      wrap.className = "pdf-page ihobs-surface";
      wrap.dataset.surface = String(i - 1);
      wrap.style.width = `${base.width}px`;
      wrap.style.height = `${base.height}px`;

      const placeholder = document.createElement("div");
      placeholder.className = "pdf-placeholder";
      placeholder.textContent = String(i);
      wrap.appendChild(placeholder);

      ctx.container.appendChild(wrap);

      const node: PageNode = {
        index: i - 1,
        page,
        wrap,
        canvas: null,
        baseW: base.width,
        baseH: base.height,
        renderedScale: 0,
        rendering: false,
        task: null
      };
      nodes.push(node);
      surfaces.push({ index: i - 1, el: wrap, width: base.width, height: base.height });
      observer.observe(wrap);
    }

    const applyZoom = (): void => {
      for (const n of nodes) {
        n.wrap.style.width = `${n.baseW * zoom}px`;
        n.wrap.style.height = `${n.baseH * zoom}px`;
      }
    };

    let settle: number | null = null;
    const reRenderVisible = (): void => {
      for (const n of nodes) {
        const rect = n.wrap.getBoundingClientRect();
        const rootRect = ctx.container.getBoundingClientRect();
        const visible = rect.bottom > rootRect.top - 800 && rect.top < rootRect.bottom + 800;
        if (visible && n.renderedScale && Math.abs(n.renderedScale - zoom) > 0.01) {
          renderQueue.push(n);
        }
      }
      pump();
    };

    let currentPage = 1;
    let pageCb: ((page: number) => void) | null = null;
    let pageRaf = 0;

    const computeCurrentPage = (): void => {
      const rootTop = ctx.container.getBoundingClientRect().top;
      const probe = rootTop + ctx.container.clientHeight * 0.35;
      let best = 1;
      for (const n of nodes) {
        const rect = n.wrap.getBoundingClientRect();
        if (rect.top <= probe && rect.bottom >= probe) {
          best = n.index + 1;
          break;
        }
        if (rect.top > probe) break;
        best = n.index + 1;
      }
      if (best !== currentPage) {
        currentPage = best;
        pageCb?.(best);
      }
    };

    const onScroll = (): void => {
      if (pageRaf) return;
      pageRaf = requestAnimationFrame(() => {
        pageRaf = 0;
        computeCurrentPage();
      });
    };
    ctx.container.addEventListener("scroll", onScroll, { passive: true });

    return {
      kind: "pdf",
      path: ctx.path,
      surfaces,
      pageCount() {
        return nodes.length;
      },
      currentPage() {
        return currentPage;
      },
      goToPage(page: number) {
        const target = nodes[Math.max(0, Math.min(nodes.length - 1, page - 1))];
        if (!target) return;
        target.wrap.scrollIntoView({ block: "start" });
        currentPage = target.index + 1;
        pageCb?.(currentPage);
      },
      onPageChange(cb: (page: number) => void) {
        pageCb = cb;
      },
      getZoom() {
        return zoom;
      },
      async getPageImages(pageIndices: number[], scale: number): Promise<PageImage[]> {
        const out: PageImage[] = [];
        for (const index of pageIndices) {
          const node = nodes[index];
          if (!node) continue;
          const viewport = node.page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          const c = canvas.getContext("2d", { willReadFrequently: true });
          if (!c) continue;
          await node.page.render({ canvasContext: c, viewport }).promise;
          out.push({
            page: index,
            width: canvas.width,
            height: canvas.height,
            image: c.getImageData(0, 0, canvas.width, canvas.height)
          });
        }
        return out;
      },
      setZoom(next: number) {
        zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
        applyZoom();
        if (settle !== null) window.clearTimeout(settle);
        settle = window.setTimeout(reRenderVisible, 180);
        return zoom;
      },
      destroy() {
        destroyed = true;
        observer.disconnect();
        ctx.container.removeEventListener("scroll", onScroll);
        if (pageRaf) cancelAnimationFrame(pageRaf);
        nodes.forEach((n) => n.task?.cancel());
        void task.destroy();
        nodes.forEach((n) => n.wrap.remove());
      }
    };
  }
};
