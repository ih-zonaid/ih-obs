export interface DrawingOpen {
  // Identifies the drawing; opening the same key again just focuses the panel.
  key: string;
  title: string;
  // Previously saved scene JSON, or null for a blank canvas.
  initial: string | null;
  // Autosave, called after edits settle and on close/swap. Not called for a
  // still-empty new canvas, so opening and closing never creates a blank
  // drawing. Runs its synchronous part before anything else, so a caller that
  // closes the panel mid-teardown still records the drawing against the right
  // document.
  onSave(json: string): Promise<void> | void;
  // The rendered SVG of the saved scene, produced after onSave (it is async).
  onThumb(svg: string): Promise<void> | void;
}

type Scene = { elements: readonly unknown[]; appState: unknown; files: unknown };

const WIDTH_KEY = "ihobs:drawing-width";
const SAVE_DELAY_MS = 1500;

function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return n >= 320 ? n : Math.round(window.innerWidth * 0.4);
  } catch {
    return Math.round(window.innerWidth * 0.4);
  }
}

// A docked right-hand panel hosting Excalidraw, so you can sketch beside the
// page you are reading. The page area shrinks (`.has-drawing` on the shell)
// rather than being covered. React and Excalidraw (~MBs) are imported on first
// use, so the rest of the app stays framework-free and fast to start.
class DrawingPanel {
  private root: HTMLElement | null = null;
  private host!: HTMLElement;
  private titleEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private reactRoot: { render(node: unknown): void; unmount(): void } | null = null;
  private mods: { React: typeof import("react"); ex: typeof import("@excalidraw/excalidraw") } | null = null;

  private current: DrawingOpen | null = null;
  private scene: Scene | null = null;
  // Fingerprint of the last scene we saved (or loaded), so selection and scroll
  // changes — which also fire onChange — never trigger a write.
  private savedSig: string | null = null;
  private timer: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private hadInitial = false;
  // Bumped per open so a stale async open cannot overwrite a newer one.
  private seq = 0;

  isOpen(): boolean {
    return !!this.root;
  }

  async open(opts: DrawingOpen): Promise<void> {
    if (this.current?.key === opts.key) return;
    const seq = ++this.seq;
    await this.flush();
    this.ensureRoot();
    this.current = opts;
    this.scene = null;
    this.savedSig = null;
    this.hadInitial = !!opts.initial;
    this.titleEl.textContent = opts.title;
    this.setStatus("");
    await this.loadMods();
    if (seq !== this.seq || !this.mods) return;
    this.render(opts);
  }

  async close(): Promise<void> {
    this.seq++;
    await this.flush();
    this.current = null;
    this.reactRoot?.unmount();
    this.reactRoot = null;
    this.root?.remove();
    this.root = null;
    document.querySelector(".shell")?.classList.remove("has-drawing");
  }

  private async loadMods(): Promise<void> {
    if (this.mods) return;
    // Fonts ship with the build (vite.config.ts); without this Excalidraw
    // fetches them from a CDN, which breaks drawing offline. Dev has no copy.
    if (import.meta.env.PROD) {
      (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = new URL(
        "./excalidraw/",
        document.baseURI
      ).href;
    }
    this.setStatus("loading…");
    const [React, ex] = await Promise.all([
      import("react"),
      import("@excalidraw/excalidraw"),
      import("@excalidraw/excalidraw/index.css")
    ]);
    this.mods = { React, ex };
    this.setStatus("");
  }

  private ensureRoot(): void {
    if (this.root) return;
    const root = document.createElement("aside");
    root.className = "drawing-panel";
    root.style.width = `${readWidth()}px`;

    const grip = document.createElement("div");
    grip.className = "drawing-grip";
    grip.title = "drag to resize";
    grip.addEventListener("pointerdown", (e) => this.startResize(e, root));

    const bar = document.createElement("div");
    bar.className = "drawing-bar";
    this.titleEl = document.createElement("span");
    this.titleEl.className = "drawing-title";
    this.statusEl = document.createElement("span");
    this.statusEl.className = "drawing-status";
    const close = document.createElement("button");
    close.className = "tb-btn";
    close.textContent = "Close";
    close.title = "save and close";
    close.addEventListener("click", () => void this.close());
    bar.append(this.titleEl, this.statusEl, close);

    this.host = document.createElement("div");
    this.host.className = "drawing-host";

    root.append(grip, bar, this.host);
    // Excalidraw owns the keyboard while focus is inside it; the app's global
    // shortcuts (zoom, palette, page keys) must not fire from there.
    for (const type of ["keydown", "keyup", "wheel"]) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }
    // Inside the shell, not the body: the theme variables live on `.shell`.
    const shell = document.querySelector(".shell");
    (shell ?? document.body).appendChild(root);
    this.root = root;
    shell?.classList.add("has-drawing");
    this.applyWidth(parseInt(root.style.width, 10));
  }

  private applyWidth(px: number): void {
    document.documentElement.style.setProperty("--draw-w", `${px}px`);
  }

  private startResize(e: PointerEvent, root: HTMLElement): void {
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    // Excalidraw's canvas would swallow the drag once the pointer crosses it.
    root.classList.add("resizing");
    const move = (ev: PointerEvent): void => {
      const w = Math.max(320, Math.min(window.innerWidth - 240, window.innerWidth - ev.clientX));
      root.style.width = `${w}px`;
      this.applyWidth(w);
    };
    const up = (): void => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      root.classList.remove("resizing");
      try {
        localStorage.setItem(WIDTH_KEY, String(parseInt(root.style.width, 10)));
      } catch {
        /* a convenience only */
      }
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  }

  private render(opts: DrawingOpen): void {
    const { React, ex } = this.mods!;
    let initialData: Record<string, unknown> | undefined;
    if (opts.initial) {
      try {
        const parsed = JSON.parse(opts.initial) as Record<string, unknown>;
        initialData = {
          elements: parsed.elements,
          // Saved scroll/zoom belong to whatever panel width the drawing was
          // made in; they are replaced by a fit-to-content below.
          appState: {
            ...(parsed.appState as object),
            scrollX: 0,
            scrollY: 0,
            collaborators: new Map()
          },
          files: parsed.files
        };
      } catch {
        initialData = undefined;
      }
    }
    // A swap re-mounts on a fresh host so Excalidraw's undo history and state
    // never leak from one drawing into the next.
    this.reactRoot?.unmount();
    this.host.replaceChildren();
    const mount = document.createElement("div");
    mount.style.height = "100%";
    this.host.appendChild(mount);
    void import("react-dom/client").then(({ createRoot }) => {
      if (this.current !== opts) return;
      this.reactRoot = createRoot(mount);
      this.reactRoot.render(
        React.createElement(ex.Excalidraw, {
          initialData: initialData as never,
          // Centre the saved content in the panel as it is now, at a zoom that
          // fits (never magnifying past 100%), instead of wherever the scroll
          // was when it was last saved.
          excalidrawAPI: (api: {
            getSceneElements(): readonly unknown[];
            scrollToContent(target: unknown, opts: unknown): void;
          }) => {
            if (!initialData) return;
            requestAnimationFrame(() => {
              if (this.current !== opts) return;
              const els = api.getSceneElements();
              if (els.length) {
                api.scrollToContent(els, { fitToContent: true, viewportZoomFactor: 0.9, animate: false });
              }
            });
          },
          theme: this.root?.closest<HTMLElement>(".shell")?.dataset.theme === "dark" ? "dark" : "light",
          onChange: (elements: readonly unknown[], appState: unknown, files: unknown) => {
            if (this.current !== opts) return;
            this.scene = { elements, appState, files };
            const sig = this.signature(elements);
            // The first callback is the scene as loaded: treat it as saved.
            if (this.savedSig === null) {
              this.savedSig = sig;
              return;
            }
            if (sig === this.savedSig) return;
            this.setStatus("editing…");
            this.schedule();
          }
        })
      );
    });
  }

  private signature(elements: readonly unknown[]): string {
    return (elements as { id: string; version: number; isDeleted?: boolean }[])
      .map((el) => `${el.id}:${el.version}:${el.isDeleted ? 1 : 0}`)
      .join("|");
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, SAVE_DELAY_MS);
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  // Saves pending edits now. Serialized behind earlier saves, so two writes to
  // one drawing can never interleave.
  flush(): Promise<void> {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    const opts = this.current;
    const live = this.scene;
    const ex = this.mods?.ex;
    if (!opts || !live || !ex) return this.queue;
    const sig = this.signature(live.elements);
    if (sig === this.savedSig) return this.queue;
    const hasShapes = (live.elements as { isDeleted?: boolean }[]).some((el) => !el.isDeleted);
    // Emptying an existing drawing is a real edit; a never-drawn canvas is not.
    if (!hasShapes && !this.hadInitial) return this.queue;

    this.savedSig = sig;
    const json = ex.serializeAsJSON(
      live.elements as never,
      live.appState as never,
      live.files as never,
      "local"
    );
    // The synchronous half of onSave runs here, ahead of the first await.
    const saved = Promise.resolve(opts.onSave(json));
    this.queue = this.queue
      .then(async () => {
        await saved;
        let svg = "";
        try {
          const node = await ex.exportToSvg({
            elements: live.elements as never,
            appState: { exportBackground: true, viewBackgroundColor: "#ffffff" } as never,
            files: live.files as never
          });
          svg = new XMLSerializer().serializeToString(node);
        } catch {
          /* the scene still saved; it just has no thumbnail */
        }
        if (svg) await opts.onThumb(svg);
        if (this.current === opts) this.setStatus("saved");
      })
      .catch(() => {
        // Let the next edit retry rather than believing this one landed.
        if (this.savedSig === sig) this.savedSig = null;
        this.setStatus("save failed");
      });
    return this.queue;
  }
}

const panel = new DrawingPanel();

export function openDrawingEditor(opts: DrawingOpen): Promise<void> {
  return panel.open(opts);
}

export function closeDrawingEditor(): Promise<void> {
  return panel.close();
}

export function isDrawingEditorOpen(): boolean {
  return panel.isOpen();
}
