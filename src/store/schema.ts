export type RegionKind = "occlusion" | "highlight";

export interface Region {
  id: string;
  surface: number;
  kind: RegionKind;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  label?: string;
  revealed?: boolean;
}

export interface Sidecar {
  version: 1;
  doc: string;
  kind: "image" | "pdf" | "markdown" | "json";
  updatedAt: number;
  regions: Region[];
}

export function emptySidecar(doc: string, kind: Sidecar["kind"]): Sidecar {
  return { version: 1, doc, kind, updatedAt: Date.now(), regions: [] };
}

export function migrate(raw: unknown, doc: string, kind: Sidecar["kind"]): Sidecar {
  if (!raw || typeof raw !== "object") return emptySidecar(doc, kind);
  const data = raw as Partial<Sidecar>;
  if (data.version !== 1) return emptySidecar(doc, kind);
  return {
    version: 1,
    doc: data.doc ?? doc,
    kind: data.kind ?? kind,
    updatedAt: data.updatedAt ?? Date.now(),
    regions: Array.isArray(data.regions) ? data.regions : []
  };
}
