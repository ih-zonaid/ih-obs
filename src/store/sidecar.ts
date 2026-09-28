import { ensureDirPath, readText, writeText } from "../vault/fs";
import {
  emptySidecar,
  migrate,
  type Marker,
  type Note,
  type Region,
  type Segment,
  type SegmentRule,
  type Sidecar
} from "./schema";

const ROOT = ".ihobs";
const EXT = ".json";

function sidecarName(docPath: string): string {
  return docPath.replace(/[\\/]/g, "__") + EXT;
}

export class SidecarStore {
  private readonly vault: FileSystemDirectoryHandle;
  private readonly cache = new Map<string, Sidecar>();

  constructor(vault: FileSystemDirectoryHandle) {
    this.vault = vault;
  }

  private async dir(): Promise<FileSystemDirectoryHandle> {
    return ensureDirPath(this.vault, [ROOT]);
  }

  async load(docPath: string, kind: Sidecar["kind"]): Promise<Sidecar> {
    const hit = this.cache.get(docPath);
    if (hit) return hit;
    const dir = await this.dir();
    let parsed: unknown = null;
    try {
      const file = await dir.getFileHandle(sidecarName(docPath));
      parsed = JSON.parse(await readText(file));
    } catch {
      parsed = null;
    }
    const model = parsed ? migrate(parsed, docPath, kind) : emptySidecar(docPath, kind);
    this.cache.set(docPath, model);
    return model;
  }

  async saveRegions(docPath: string, kind: Sidecar["kind"], regions: Region[]): Promise<Sidecar> {
    const current = await this.load(docPath, kind);
    return this.write(docPath, { ...current, regions });
  }

  async saveSegments(
    docPath: string,
    kind: Sidecar["kind"],
    segments: Segment[],
    markers: Marker[],
    rule?: SegmentRule
  ): Promise<Sidecar> {
    const current = await this.load(docPath, kind);
    return this.write(docPath, { ...current, segments, markers, rule: rule ?? current.rule });
  }

  async saveNotes(docPath: string, kind: Sidecar["kind"], notes: Note[]): Promise<Sidecar> {
    const current = await this.load(docPath, kind);
    return this.write(docPath, { ...current, notes });
  }

  private async write(docPath: string, model: Omit<Sidecar, "version" | "updatedAt">): Promise<Sidecar> {
    const next: Sidecar = { ...model, version: 5, updatedAt: Date.now() };
    const dir = await this.dir();
    await writeText(dir, sidecarName(docPath), JSON.stringify(next, null, 2));
    this.cache.set(docPath, next);
    return next;
  }

  invalidate(docPath: string): void {
    this.cache.delete(docPath);
  }
}
