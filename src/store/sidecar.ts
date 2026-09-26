import { ensureDirPath, readText, writeText } from "../vault/fs";
import { emptySidecar, migrate, type Region, type Sidecar } from "./schema";

const ROOT = ".ihobs";
const EXT = ".json";

function sidecarName(docPath: string): string {
  return docPath.replace(/[\\/]/g, "__") + EXT;
}

function cacheKey(docPath: string): string {
  return docPath;
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
    const hit = this.cache.get(cacheKey(docPath));
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
    this.cache.set(cacheKey(docPath), model);
    return model;
  }

  async save(docPath: string, kind: Sidecar["kind"], regions: Region[]): Promise<Sidecar> {
    const model: Sidecar = {
      version: 1,
      doc: docPath,
      kind,
      updatedAt: Date.now(),
      regions
    };
    const dir = await this.dir();
    await writeText(dir, sidecarName(docPath), JSON.stringify(model, null, 2));
    this.cache.set(cacheKey(docPath), model);
    return model;
  }

  invalidate(docPath: string): void {
    this.cache.delete(docPath);
  }
}
