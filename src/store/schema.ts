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

export type SegmentType = "question" | "info" | "section" | "other";

export interface Span {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Segment {
  id: string;
  type: SegmentType;
  title: string;
  order: number;
  spans: Span[];
}

export interface SegmentRule {
  id: string;
  name: string;
  mode: "text" | "margin";
  anchorPattern: string;
  marginFraction: number;
  mergeGapFraction: number;
  minHeightFraction: number;
}

export interface Sidecar {
  version: 2;
  doc: string;
  kind: "image" | "pdf" | "markdown" | "json";
  updatedAt: number;
  regions: Region[];
  segments: Segment[];
  rule?: SegmentRule;
}

export const DEFAULT_RULES: SegmentRule[] = [
  {
    id: "mcq-left-number",
    name: "MCQ (numbered, left margin)",
    mode: "margin",
    anchorPattern: "^\\s*(\\d{1,3})[.)]",
    marginFraction: 0.06,
    mergeGapFraction: 0.018,
    minHeightFraction: 0.012
  },
  {
    id: "generic-text",
    name: "Generic (text anchors)",
    mode: "text",
    anchorPattern: "^\\s*(\\d{1,3})[.)]",
    marginFraction: 0.08,
    mergeGapFraction: 0.02,
    minHeightFraction: 0.015
  }
];

export function emptySidecar(doc: string, kind: Sidecar["kind"]): Sidecar {
  return {
    version: 2,
    doc,
    kind,
    updatedAt: Date.now(),
    regions: [],
    segments: []
  };
}

export function migrate(raw: unknown, doc: string, kind: Sidecar["kind"]): Sidecar {
  if (!raw || typeof raw !== "object") return emptySidecar(doc, kind);
  const data = raw as Partial<Omit<Sidecar, "version">> & { version?: number };
  if (data.version !== 1 && data.version !== 2) return emptySidecar(doc, kind);
  return {
    version: 2,
    doc: data.doc ?? doc,
    kind: data.kind ?? kind,
    updatedAt: data.updatedAt ?? Date.now(),
    regions: Array.isArray(data.regions) ? data.regions : [],
    segments: Array.isArray(data.segments) ? data.segments : [],
    rule: data.rule
  };
}
