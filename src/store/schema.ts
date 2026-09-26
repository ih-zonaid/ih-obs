export type RegionKind = "occlusion" | "highlight";

// Owner is either the PAGE sentinel (a free, floating mark) or a segment id
// (the mark belongs to that segment). One field covers both scopes.
export const PAGE_OWNER = "page";

export interface Region {
  id: string;
  surface: number;
  kind: RegionKind;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  owner: string;
  label?: string;
  revealed?: boolean;
}

export type SegmentRole = "concept" | "questions" | "question" | "other";

export const SEGMENT_ROLES: SegmentRole[] = ["concept", "questions", "question", "other"];

export const MAX_LEVEL = 6;

export interface Span {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Segment {
  id: string;
  role: SegmentRole;
  label: string;
  spans: Span[];
}

// A marker is a full-width anchor line at a normalized y on a page.
// It marks where a section starts; it carries no geometry of its own.
export interface Marker {
  id: string;
  page: number;
  y: number;
  label: string;
}

export interface OutlineNode {
  id: string;
  kind: "segment" | "marker";
  label: string;
  level: number;
  text: string;
  page: number;
  depth: number;
  role?: SegmentRole;
  children: OutlineNode[];
}

const HEADING_RE = /^(#{1,6})\s*(.*)$/;

// A label is free single-line text. Leading '#' runs are the heading level,
// exactly like markdown; anything else is a paragraph-level entry (level 0).
export function parseLabel(label: string): { level: number; text: string } {
  const m = HEADING_RE.exec(label.trim());
  if (m) return { level: m[1].length, text: m[2].trim() };
  return { level: 0, text: label.trim() };
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
  version: 4;
  doc: string;
  kind: "image" | "pdf" | "markdown" | "json";
  updatedAt: number;
  regions: Region[];
  segments: Segment[];
  markers: Marker[];
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

interface OutlineRaw {
  id: string;
  kind: "segment" | "marker";
  label: string;
  level: number;
  text: string;
  page: number;
  y: number;
  role?: SegmentRole;
  box?: { page: number; y0: number; y1: number; x0: number; x1: number; area: number };
}

const EPS = 1e-6;

// Builds the outline as a tree. Order is document position (page, then y).
// Nesting comes from two sources, with geometric containment taking priority:
//   1. A segment whose box sits inside another segment's box becomes its child,
//      so question splits nest under their questions container.
//   2. Markdown heading levels ('#') nest the way they do in a document.
export function buildOutlineTree(segments: Segment[], markers: Marker[]): OutlineNode[] {
  const items: OutlineRaw[] = [];
  for (const seg of segments) {
    const span = seg.spans[0];
    const { level, text } = parseLabel(seg.label);
    items.push({
      id: seg.id,
      kind: "segment",
      label: seg.label,
      level,
      text,
      page: span?.page ?? 0,
      y: span?.y ?? 0,
      role: seg.role,
      box: span
        ? {
            page: span.page,
            y0: span.y,
            y1: span.y + span.h,
            x0: span.x,
            x1: span.x + span.w,
            area: span.h * span.w
          }
        : undefined
    });
  }
  for (const m of markers) {
    const { level, text } = parseLabel(m.label);
    items.push({
      id: m.id,
      kind: "marker",
      label: m.label,
      level,
      text,
      page: m.page,
      y: m.y
    });
  }
  items.sort((a, b) => a.page - b.page || a.y - b.y);
  const index = new Map<string, number>();
  items.forEach((it, i) => index.set(it.id, i));

  const parentOf = new Map<string, string | null>();

  for (const it of items) {
    if (!it.box) continue;
    let best: OutlineRaw | null = null;
    for (const cand of items) {
      if (cand === it || !cand.box) continue;
      if ((index.get(cand.id) ?? 0) >= (index.get(it.id) ?? 0)) continue;
      if (cand.box.page !== it.box.page) continue;
      const contains =
        cand.box.y0 <= it.box.y0 + EPS &&
        cand.box.y1 >= it.box.y1 - EPS &&
        cand.box.x0 <= it.box.x0 + EPS &&
        cand.box.x1 >= it.box.x1 - EPS;
      if (!contains) continue;
      if (!best || cand.box.area < (best.box?.area ?? Infinity)) best = cand;
    }
    if (best) parentOf.set(it.id, best.id);
  }

  const stack: OutlineRaw[] = [];
  for (const it of items) {
    if (!parentOf.has(it.id)) {
      if (it.level > 0) {
        while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
        if (stack.length) parentOf.set(it.id, stack[stack.length - 1].id);
      } else if (stack.length) {
        // A paragraph/bullet attaches under the nearest open heading.
        parentOf.set(it.id, stack[stack.length - 1].id);
      }
    }
    if (it.level > 0) {
      while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
      stack.push(it);
    }
  }

  const nodes = new Map<string, OutlineNode>();
  for (const it of items) {
    nodes.set(it.id, {
      id: it.id,
      kind: it.kind,
      label: it.label,
      level: it.level,
      text: it.text,
      page: it.page,
      role: it.role,
      depth: 0,
      children: []
    });
  }
  const roots: OutlineNode[] = [];
  for (const it of items) {
    const node = nodes.get(it.id) as OutlineNode;
    const parentId = parentOf.get(it.id) ?? null;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const assignDepth = (node: OutlineNode, depth: number): void => {
    node.depth = depth;
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  for (const root of roots) assignDepth(root, 0);

  return roots;
}

function asRole(value: unknown): SegmentRole {
  if (value === "concept" || value === "info") return "concept";
  if (value === "questions" || value === "section") return "questions";
  if (value === "question") return "question";
  return "other";
}

export function emptySidecar(doc: string, kind: Sidecar["kind"]): Sidecar {
  return {
    version: 4,
    doc,
    kind,
    updatedAt: Date.now(),
    regions: [],
    segments: [],
    markers: []
  };
}

interface LegacySegment {
  id?: string;
  type?: string;
  role?: string;
  title?: string;
  heading?: string;
  label?: string;
  level?: number;
  spans?: Span[];
}

function legacyLabel(s: LegacySegment): string {
  if (typeof s.label === "string") return s.label;
  const text = typeof s.heading === "string" ? s.heading : typeof s.title === "string" ? s.title : "";
  if (typeof s.level === "number" && s.level > 0 && text) return `${"#".repeat(Math.min(6, s.level))} ${text}`;
  return text;
}

function migrateSegments(raw: unknown): Segment[] {
  if (!Array.isArray(raw)) return [];
  const legacy = raw as LegacySegment[];
  const out: Segment[] = [];
  for (const s of legacy) {
    if (!s || typeof s !== "object" || !Array.isArray(s.spans)) continue;
    out.push({
      id: s.id ?? `s_${Math.random().toString(36).slice(2, 9)}`,
      role: asRole(s.role ?? s.type),
      label: legacyLabel(s),
      spans: s.spans
    });
  }
  return out;
}

function migrateMarkers(raw: unknown): Marker[] {
  if (!Array.isArray(raw)) return [];
  const out: Marker[] = [];
  for (const m of raw as Marker[]) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.page !== "number" || typeof m.y !== "number") continue;
    out.push({
      id: m.id ?? `m_${Math.random().toString(36).slice(2, 9)}`,
      page: m.page,
      y: m.y,
      label: typeof m.label === "string" ? m.label : ""
    });
  }
  return out;
}

export interface MarkGeom {
  surface: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function containsSpan(seg: Segment, r: MarkGeom): boolean {
  return seg.spans.some(
    (s) =>
      s.page === r.surface &&
      s.x <= r.x + 1e-6 &&
      s.y <= r.y + 1e-6 &&
      s.x + s.w >= r.x + r.w - 1e-6 &&
      s.y + s.h >= r.y + r.h - 1e-6
  );
}

// Smallest containing segment wins, so nested questions beat their container.
export function smallestContainingSegment(geom: MarkGeom, segments: Segment[]): Segment | null {
  let best: Segment | null = null;
  for (const seg of segments) {
    if (!containsSpan(seg, geom)) continue;
    const area = seg.spans[0] ? seg.spans[0].w * seg.spans[0].h : Infinity;
    const bestArea = best?.spans[0] ? best.spans[0].w * best.spans[0].h : Infinity;
    if (!best || area <= bestArea) best = seg;
  }
  return best;
}

// One-time containment pass: free marks that clearly sit inside a segment are
// promoted to be owned by it. Explicit owners are always preserved.
export function adoptOrphanMarks(regions: Region[], segments: Segment[]): Region[] {
  const ids = new Set(segments.map((s) => s.id));
  for (const r of regions) {
    if (r.owner && r.owner !== PAGE_OWNER && ids.has(r.owner)) continue;
    r.owner = PAGE_OWNER;
    const best = smallestContainingSegment(r, segments);
    if (best) r.owner = best.id;
  }
  return regions;
}

function migrateRegions(raw: unknown): Region[] {
  if (!Array.isArray(raw)) return [];
  const out: Region[] = [];
  for (const r of raw as Region[]) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.surface !== "number") continue;
    out.push({
      id: r.id ?? `r_${Math.random().toString(36).slice(2, 9)}`,
      surface: r.surface,
      kind: r.kind === "highlight" ? "highlight" : "occlusion",
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      color: r.color ?? "#1f2430",
      owner: typeof r.owner === "string" && r.owner ? r.owner : PAGE_OWNER,
      label: r.label,
      revealed: r.revealed
    });
  }
  return out;
}

export function migrate(raw: unknown, doc: string, kind: Sidecar["kind"]): Sidecar {
  if (!raw || typeof raw !== "object") return emptySidecar(doc, kind);
  const data = raw as Partial<Omit<Sidecar, "version">> & { version?: number };
  const v = data.version;
  if (v !== 1 && v !== 2 && v !== 3 && v !== 4) return emptySidecar(doc, kind);
  const segments = migrateSegments(data.segments);
  const regions = adoptOrphanMarks(migrateRegions(data.regions), segments);
  return {
    version: 4,
    doc: data.doc ?? doc,
    kind: data.kind ?? kind,
    updatedAt: data.updatedAt ?? Date.now(),
    regions,
    segments,
    markers: migrateMarkers(data.markers),
    rule: data.rule
  };
}
