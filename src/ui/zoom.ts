export interface ZoomControllerOptions {
  viewer: HTMLElement;
  onChange(zoom: number): void;
  onRepaint(): void;
  getZoom(): number;
}

export class ZoomController {
  private readonly viewer: HTMLElement;
  private readonly onChange: (zoom: number) => void;
  private readonly onRepaint: () => void;
  private readonly getZoom: () => number;
  private readonly onWheel: (e: WheelEvent) => void;
  private readonly onKey: (e: KeyboardEvent) => void;

  constructor(opts: ZoomControllerOptions) {
    this.viewer = opts.viewer;
    this.onChange = opts.onChange;
    this.onRepaint = opts.onRepaint;
    this.getZoom = opts.getZoom;
    this.onWheel = (e) => this.wheel(e);
    this.onKey = (e) => this.key(e);
    this.viewer.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKey);
  }

  private wheel(e: WheelEvent): void {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.apply(this.getZoom() * factor);
  }

  private key(e: KeyboardEvent): void {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "=" || e.key === "+") {
      e.preventDefault();
      this.apply(this.getZoom() * 1.15);
    } else if (e.key === "-") {
      e.preventDefault();
      this.apply(this.getZoom() / 1.15);
    } else if (e.key === "0") {
      e.preventDefault();
      this.apply(1);
    }
  }

  private apply(zoom: number): void {
    this.onChange(zoom);
    this.onRepaint();
  }

  destroy(): void {
    this.viewer.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKey);
  }
}
