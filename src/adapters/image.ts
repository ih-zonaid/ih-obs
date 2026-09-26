import { isImage } from "../vault/tree";
import type { DocAdapter, DocView, LoadContext, Surface } from "./types";

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 4;

export const imageAdapter: DocAdapter = {
  kind: "image",
  matches: isImage,
  async load(ctx: LoadContext): Promise<DocView> {
    const file = await ctx.handle.getFile();
    const url = URL.createObjectURL(file);

    const stage = document.createElement("div");
    stage.className = "img-stage";

    const wrap = document.createElement("div");
    wrap.className = "img-wrap ihobs-surface";
    wrap.dataset.surface = "0";

    const img = document.createElement("img");
    img.className = "img-canvas";
    img.src = url;
    img.draggable = false;

    wrap.appendChild(img);
    stage.appendChild(wrap);
    ctx.container.appendChild(stage);

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image load failed"));
    });

    const naturalW = img.naturalWidth;
    let zoom = 1;

    const apply = (): void => {
      img.style.maxWidth = zoom <= 1 ? "100%" : "none";
      img.style.width = `${Math.round(naturalW * zoom)}px`;
    };
    apply();

    const surface: Surface = {
      index: 0,
      el: wrap,
      width: img.clientWidth,
      height: img.clientHeight
    };

    return {
      kind: "image",
      path: ctx.path,
      surfaces: [surface],
      getZoom() {
        return zoom;
      },
      setZoom(next: number) {
        zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
        apply();
        return zoom;
      },
      destroy() {
        URL.revokeObjectURL(url);
        stage.remove();
      }
    };
  }
};
