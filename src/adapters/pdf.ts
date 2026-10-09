import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { readBytes } from "../vault/fs";
import { isPdf } from "../vault/tree";
import { scrollIntoContainer } from "../ui/scroll";
import type { DocAdapter, DocView, LoadContext, PageImage, Surface } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const BASE_SCALE = 1.6;
export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 4;
// Matches .pdf-page { margin: 18px auto } — adjacent pages' vertical margins
// collapse into one gap of this size, so this must track that CSS value.
const PAGE_GAP = 18;

interface PageNode {
  index: number;
  page: pdfjs.PDFPageProxy;
  wrap: HTMLElement;
  canvas: HTMLCanvasElement | null;
  // Invisible, selectable glyph boxes laid over the raster page (pdf.js pattern).
  textEl: HTMLElement | null;
  textLayer: pdfjs.TextLayer | null;
  baseW: number;
  baseH: number;
  renderedScale: number;
  rendering: boolean;
  task: pdfjs.RenderTask | null;
}

// pdf.js TextLayer writes glyph boxes in PDF units and expects an ancestor to
// expose the CSS-pixels-per-unit factor as --scale-factor (see setLayerDimensions).
const scaleFactor = (zoom: number): number => BASE_SCALE * zoom;

export const pdfAdapter: DocAdapter = {
  kind: "pdf",
  matches: isPdf,
  async load(ctx: LoadContext): Promise<DocView> {
    const data = await readBytes(ctx.handle);
    if (ctx.signal.aborted) throw new DOMException("aborted", "AbortError");
    const task = pdfjs.getDocument({ data });
    const doc = await task.promise;
    if (ctx.signal.aborted) {
      void doc.destroy();
      throw new DOMException("aborted", "AbortError");
    }
    const ratio = window.devicePixelRatio || 1;
    const nodes: PageNode[] = [];
    const surfaces: Surface[] = [];
    let zoom = 1;
    let destroyed = false;
    let textDebug = 0;
    const renderQueue: PageNode[] = [];

    // Builds the selectable text layer over a page. Reuses an existing layer on
    // zoom; empty for scanned pages that carry no embedded text.
    const renderTextLayer = async (n: PageNode, viewport: pdfjs.PageViewport): Promise<void> => {
      if (n.textLayer) {
        n.textLayer.update({ viewport });
        return;
      }
      const textContent = await n.page.getTextContent();
      if (destroyed || n.textLayer) return;
      const el = document.createElement("div");
      el.className = "textLayer";
      // Normalize the selection so pasted text matches what pdf.js's own viewer
      // yields (ligatures, non-breaking spaces, stray nulls).
      el.addEventListener("copy", (event) => {
        const selection = document.getSelection();
        if (!selection || !event.clipboardData) return;
        event.clipboardData.setData(
          "text/plain",
          pdfjs.normalizeUnicode(selection.toString()).replace(/\u0000/g, "")
        );
        event.preventDefault();
      });
      n.textEl = el;
      n.wrap.appendChild(el);
      const layer = new pdfjs.TextLayer({
        textContentSource: textContent,
        container: el,
        viewport
      });
      n.textLayer = layer;
      await layer.render();
    };

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
        await renderTextLayer(n, viewport);
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

    // Fetch all pages concurrently rather than one round-trip at a time; the
    // worker pipelines these, so this is far faster than a sequential loop
    // for documents with many pages.
    const pages = await Promise.all(
      Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1))
    );

    for (let i = 1; i <= doc.numPages; i++) {
      if (ctx.signal.aborted) break;
      const page = pages[i - 1];
      const base = page.getViewport({ scale: BASE_SCALE });
      const wrap = document.createElement("div");
      wrap.className = "pdf-page ihobs-surface";
      wrap.dataset.surface = String(i - 1);
      wrap.style.width = `${base.width}px`;
      wrap.style.height = `${base.height}px`;
      wrap.style.setProperty("--scale-factor", String(scaleFactor(1)));
      wrap.classList.toggle("debug-text", textDebug === 1);
      wrap.classList.toggle("debug-text-full", textDebug === 2);

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
        textEl: null,
        textLayer: null,
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

    // Analytic page-top offsets, kept in lockstep with the sizes we assign
    // below — avoids measuring the DOM (getBoundingClientRect) to find them.
    let pageOffsets: number[] = [];
    const rebuildOffsets = (): void => {
      let y = PAGE_GAP;
      pageOffsets = nodes.map((n) => {
        const top = y;
        y += n.baseH * zoom + PAGE_GAP;
        return top;
      });
    };
    rebuildOffsets();

    const applyZoom = (): void => {
      for (const n of nodes) {
        n.wrap.style.width = `${n.baseW * zoom}px`;
        n.wrap.style.height = `${n.baseH * zoom}px`;
        n.wrap.style.setProperty("--scale-factor", String(scaleFactor(zoom)));
        // Reposition existing glyph boxes to the new viewport scale.
        const viewport = n.page.getViewport({ scale: scaleFactor(zoom) });
        n.textLayer?.update({ viewport });
      }
      rebuildOffsets();
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

    // Binary search against the cached offsets instead of measuring every
    // page's position on every scroll frame — O(n) getBoundingClientRect
    // calls here made jumps across a large document (many hundreds of pages)
    // visibly janky, since each forces a synchronous layout.
    const computeCurrentPage = (): void => {
      if (!pageOffsets.length) return;
      const mid = ctx.container.scrollTop + ctx.container.clientHeight / 2;
      let lo = 0;
      let hi = pageOffsets.length - 1;
      while (lo < hi) {
        const cand = (lo + hi + 1) >> 1;
        if (pageOffsets[cand] <= mid) lo = cand;
        else hi = cand - 1;
      }
      const best = nodes[lo].index + 1;
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
        scrollIntoContainer(ctx.container, target.wrap, "start");
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
      async getPageImageUrl(page: number, scale: number): Promise<string | null> {
        const node = nodes[page - 1];
        if (!node) return null;
        const viewport = node.page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const c = canvas.getContext("2d");
        if (!c) return null;
        await node.page.render({ canvasContext: c, viewport }).promise;
        // PNG (not JPEG) so the reader gets the sharpest glyph edges; a single
        // page at this scale stays in the low single-digit MB as base64.
        return canvas.toDataURL("image/png");
      },
      setZoom(next: number) {
        zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
        applyZoom();
        if (settle !== null) window.clearTimeout(settle);
        settle = window.setTimeout(reRenderVisible, 180);
        return zoom;
      },
      setTextDebug(level: number) {
        textDebug = level;
        for (const n of nodes) {
          n.wrap.classList.toggle("debug-text", level === 1);
          n.wrap.classList.toggle("debug-text-full", level === 2);
        }
      },
      destroy() {
        destroyed = true;
        observer.disconnect();
        ctx.container.removeEventListener("scroll", onScroll);
        if (pageRaf) cancelAnimationFrame(pageRaf);
        nodes.forEach((n) => {
          n.task?.cancel();
          n.textLayer?.cancel();
        });
        void task.destroy();
        nodes.forEach((n) => n.wrap.remove());
      }
    };
  }
};
