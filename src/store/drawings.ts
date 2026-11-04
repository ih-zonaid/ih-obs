import { ensureDirPath, readText, writeText } from "../vault/fs";

const SEGMENTS = [".ihobs", "drawings"];
const EXT = ".excalidraw";

// One Excalidraw scene per file, kept out of the annotation sidecar: the
// sidecar is rewritten wholesale on every mark drag, and a scene (with pasted
// images) can be large. The format is Excalidraw's own, so the file also opens
// on excalidraw.com.
export class DrawingStore {
  private readonly vault: FileSystemDirectoryHandle;

  constructor(vault: FileSystemDirectoryHandle) {
    this.vault = vault;
  }

  async read(id: string): Promise<string | null> {
    try {
      const dir = await ensureDirPath(this.vault, SEGMENTS);
      return await readText(await dir.getFileHandle(id + EXT));
    } catch {
      return null;
    }
  }

  async write(id: string, json: string): Promise<void> {
    const dir = await ensureDirPath(this.vault, SEGMENTS);
    await writeText(dir, id + EXT, json);
  }

  // A rendered SVG of the scene, written with it so lists and the player can
  // show a thumbnail without loading Excalidraw.
  async writeSvg(id: string, svg: string): Promise<void> {
    const dir = await ensureDirPath(this.vault, SEGMENTS);
    await writeText(dir, id + ".svg", svg);
  }

  async readSvg(id: string): Promise<string | null> {
    try {
      const dir = await ensureDirPath(this.vault, SEGMENTS);
      return await readText(await dir.getFileHandle(id + ".svg"));
    } catch {
      return null;
    }
  }

  async remove(id: string): Promise<void> {
    const dir = await ensureDirPath(this.vault, SEGMENTS);
    for (const name of [id + EXT, id + ".svg"]) {
      try {
        await dir.removeEntry(name);
      } catch {
        /* already gone */
      }
    }
  }
}
