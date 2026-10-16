// Schema v6 — generic entities.
//
// Two primitives only:
//   Box  — a region you select on the document (container, frame, or anchor line)
//   Mark — a cloze overlay (occlusion / highlight)
// An "anchor" is a Box tagged "anchor" with a thin full-width span; it is
// identified by tag, never by height.
//
// Feature meaning lives entirely in `tags`. Features (outline, overlay,
// ownership, notes, flashcards) interpret the core; the core encodes none of
// them. See docs/schema-v6.md.

export type DocKindSidecar = "image" | "pdf" | "markdown" | "json";

// ---- Constants -------------------------------------------------------------

// Owner is either the PAGE sentinel (a free, floating mark) or a box id.
export const PAGE_OWNER = "page";

// A solid, friendly cover on a book page; a near-black box (the old default)
// looked like a redaction instead.
export const DEFAULT_OCCLUSION_COLOR = "#3b82f6";

// Quick-pick swatches offered before falling back to a full color picker.
// Shared by occlusions and highlights.
export const MARK_PALETTE: string[] = [
  "#3b82f6", // blue
  "#f5c518", // yellow
  "#22c55e", // green
  "#f43f5e", // pink
  "#a78bfa" // purple
];

export const HIGHLIGHT_COLOR = "#f5c518";

// Default pen color and stroke width (fraction of page width, so it scales).
export const INK_COLOR = "#ef4444";
export const INK_WEIGHT = 0.004;

// Highlights are a translucent tint, not a solid cover, so the page text shows
// through. Custom highlight colors reuse the same hex the occlusion picker
// produces; this turns one into the rgba() the paint layers need. Falls back to
// the input unchanged if it is not a 6-digit hex (e.g. an already-rgba value).
export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Anchor line thickness, normalized (≈2px on a ~500px-tall page).
export const ANCHOR_THICKNESS = 0.004;
// Smallest span a resize handle may shrink an entity to, so nothing collapses
// to an unclickable sliver.
export const MIN_SPAN = 0.006;

export const MAX_LEVEL = 6;

// ---- Tag registry ----------------------------------------------------------

export const TAGS = {
  anchor: "anchor",
  frame: "frame",
  concept: "concept",
  questions: "questions",
  question: "question",
  other: "other",
  occlusion: "occlusion",
  highlight: "highlight",
  ink: "ink"
} as const;

export type BoxTag = "anchor" | "frame" | "concept" | "questions" | "question" | "other";
export type MarkTag = "occlusion" | "highlight" | "ink";
// The two cover kinds drawn by the rectangle/line tools (ink is a stroke, not a
// cover, and is handled separately).
export type MarkKind = "occlusion" | "highlight";

// The role tags a box may carry. An anchor is not a role (it is structural),
// so it is deliberately absent; a frame is a role because it is selected and
// named like one, and the split/auto-segment verbs only target question boxes.
export const BOX_ROLES: BoxTag[] = ["frame", "concept", "questions", "question", "other"];

// ---- Geometry --------------------------------------------------------------

export interface Span {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

// A frame's optional free-quad outline: four page-normalized corners, clockwise
// from the top-left (TL, TR, BR, BL). It is a refinement *over* `spans[0]`, which
// always holds the corners' axis-aligned bounding box — so outline order,
// containment, crop derivation and hit-testing keep reading a plain rect and a
// skewed frame costs them nothing. Absent = a plain rectangular frame.
export type CornerIndex = 0 | 1 | 2 | 3;
export type Corners = [Point, Point, Point, Point];

// ---- Entities --------------------------------------------------------------

export interface EntityBase {
  id: string;
  spans: Span[];
  // Leading '#' runs encode the outline heading level, exactly as in v5.
  label: string;
  // Feature vocabulary. The core never interprets these.
  tags: string[];
}

export interface Card {
  // Box id used as the question side. Omitted -> full-width band.
  context?: string;
  // Box id used to clip the crop. Omitted -> no clip.
  frame?: string;
}

export interface Box extends EntityBase {
  kind: "box";
  // Set only on a frame whose corners have been pulled into a quad. `spans[0]`
  // is kept as its bounding box (see Corners).
  quad?: Corners;
}

// A freehand stroke. Points are page-normalized (0–1) like every other
// geometry, so ink survives zoom and re-render. `weight` is normalized to the
// page width so the stroke scales with the page like a real PDF annotation.
export interface InkPoint {
  x: number;
  y: number;
}

export interface Mark extends EntityBase {
  kind: "mark";
  owner: string;
  groupId?: string;
  revealed?: boolean;
  color?: string;
  // Present (tagged "ink") when the mark is a freehand stroke. `spans[0]` is
  // kept as the stroke's bounding box, so ownership/containment still work.
  path?: InkPoint[];
  weight?: number;
  // Presence of this object is what makes the mark a flashcard.
  card?: Card;
  // A short markdown recall cue for this mark. Authorable on any mark; it shows
  // as the question side when the mark is played as a card. Independent of
  // `card` on purpose: "has a cue" and "is a card" are separate facts, so no
  // promotion happens automatically.
  cue?: string;
}

export type Entity = Box | Mark;

export type NoteTargetKind = "box" | "mark" | "group" | "page" | "point";

// A pinned note's own geometry: a point on a page, normalized (0–1) like every
// other annotation so it survives zoom and re-render. Only "point" notes carry
// one; every other kind locates itself through its target entity instead.
export interface NoteAnchor {
  page: number;
  x: number;
  y: number;
}

export interface Note {
  id: string;
  target: string;
  targetKind: NoteTargetKind;
  body: string;
  // Set only on "point" notes (a note pinned to a spot with nothing under it).
  // Such a note is self-anchored: its `target` is its own id, so it keeps the
  // one lookup key every other note uses and nothing can orphan it.
  at?: NoteAnchor;
  // Snapshot of the text the note was made from, when it came from a selection.
  quote?: string;
  // Page the target lives on, for list ordering.
  page?: number;
  createdAt: number;
  updatedAt: number;
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
  version: 6;
  doc: string;
  kind: DocKindSidecar;
  updatedAt: number;
  entities: Entity[];
  notes: Note[];
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

// ---- Predicates ------------------------------------------------------------

export function isBox(e: Entity): e is Box {
  return e.kind === "box";
}

export function isMark(e: Entity): e is Mark {
  return e.kind === "mark";
}

// Tag tests are plain booleans, not type predicates: their argument is often
// already narrowed (a Box), and `e is Box` on a Box would collapse to never.
export function isAnchor(e: Entity): boolean {
  return e.kind === "box" && e.tags.includes(TAGS.anchor);
}

export function isFrame(e: Entity): boolean {
  return e.kind === "box" && e.tags.includes(TAGS.frame);
}

// A box that can contain and own marks (i.e. not an anchor line).
export function isContainer(e: Entity): boolean {
  return e.kind === "box" && !e.tags.includes(TAGS.anchor);
}

export function isOcclusion(e: Entity): boolean {
  return e.kind === "mark" && e.tags.includes(TAGS.occlusion);
}

export function isHighlight(e: Entity): boolean {
  return e.kind === "mark" && e.tags.includes(TAGS.highlight);
}

export function isCard(e: Entity): boolean {
  return e.kind === "mark" && !!e.card;
}

// A freehand stroke. Ink is a Mark so it gets ownership, notes and persistence
// for free, but it is never an occlusion/highlight cover.
export function isInk(e: Entity): boolean {
  return e.kind === "mark" && e.tags.includes(TAGS.ink);
}

// ---- Factories -------------------------------------------------------------

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function newMarkId(): string {
  return uid("m");
}

export function newBoxId(): string {
  return uid("s");
}

export function newNoteId(): string {
  return uid("n");
}

// A box's primary role tag, falling back to "other".
export function roleOf(box: Box): BoxTag {
  for (const t of box.tags) {
    if ((BOX_ROLES as string[]).includes(t)) return t as BoxTag;
  }
  return TAGS.other;
}

// Frame helpers. A frame is a box tagged "frame" used purely to mask a card's
// crop (e.g. one column of a two-column page). It never contains marks, so it
// is excluded from ownership by the same rule that excludes anchors.
export function frames(boxes: Box[]): Box[] {
  return boxes.filter(isFrame);
}

export function markKind(mark: Mark): MarkKind {
  return mark.tags.includes(TAGS.highlight) ? "highlight" : "occlusion";
}

export function setMarkKind(mark: Mark, kind: MarkKind): void {
  const rest = mark.tags.filter((t) => t !== TAGS.occlusion && t !== TAGS.highlight);
  mark.tags = [...rest, kind];
}

// ---- Geometry transforms ---------------------------------------------------

// The eight resize handles, named by the compass edge/corner they move.
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

// The four side handles, which move a whole side of a frame in parallel.
export type Edge = "n" | "e" | "s" | "w";

// Translate a span by a normalized delta, clamped so it stays on the page.
export function translateSpan(span: Span, dx: number, dy: number): Span {
  const x = Math.min(1 - span.w, Math.max(0, span.x + dx));
  const y = Math.min(1 - span.h, Math.max(0, span.y + dy));
  return { ...span, x, y };
}

// Resize a span by dragging one handle. `dx`/`dy` are normalized pointer
// deltas; only the edges the handle owns move. The span is clamped to the page
// and to MIN_SPAN so it never inverts or collapses.
export function resizeSpan(span: Span, handle: Handle, dx: number, dy: number): Span {
  let x0 = span.x;
  let y0 = span.y;
  let x1 = span.x + span.w;
  let y1 = span.y + span.h;
  if (handle.includes("w")) x0 = Math.min(x1 - MIN_SPAN, Math.max(0, x0 + dx));
  if (handle.includes("e")) x1 = Math.max(x0 + MIN_SPAN, Math.min(1, x1 + dx));
  if (handle.includes("n")) y0 = Math.min(y1 - MIN_SPAN, Math.max(0, y0 + dy));
  if (handle.includes("s")) y1 = Math.max(y0 + MIN_SPAN, Math.min(1, y1 + dy));
  return { ...span, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---- Quad frames -----------------------------------------------------------

// The four corners a frame is drawn and cropped by: its stored quad when it has
// one, otherwise the corners of its rectangular span (TL, TR, BR, BL).
export function quadCorners(box: Box): Corners {
  if (box.quad) return box.quad;
  const s = box.spans[0];
  if (!s) return [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
  return [
    { x: s.x, y: s.y },
    { x: s.x + s.w, y: s.y },
    { x: s.x + s.w, y: s.y + s.h },
    { x: s.x, y: s.y + s.h }
  ];
}

// The axis-aligned bounding box of a set of corners.
function aabbOfSpan(page: number, corners: Corners): Span {
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys);
  return { page, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Writes a set of corners onto a frame and re-derives its bounding span, so the
// stored quad and `spans[0]` can never drift apart. A set of corners that is
// still an axis-aligned rectangle drops the quad entirely, so a frame that was
// only ever resized on its sides stays a plain rectangle (no SVG outline path).
export function applyQuad(box: Box, corners: Corners): void {
  box.spans[0] = aabbOfSpan(box.spans[0]?.page ?? 0, corners);
  box.quad = isAxisAligned(corners) ? undefined : corners;
}

const QUAD_EPS = 1e-9;

function isAxisAligned(c: Corners): boolean {
  const [tl, tr, br, bl] = c;
  return (
    Math.abs(tl.y - tr.y) <= QUAD_EPS &&
    Math.abs(br.y - bl.y) <= QUAD_EPS &&
    Math.abs(tl.x - bl.x) <= QUAD_EPS &&
    Math.abs(tr.x - br.x) <= QUAD_EPS
  );
}

// Pulls one corner of a frame to a normalized point. The point is clamped to the
// page and bounded by the corner's two neighbours, so the quad can shear but
// never fold over itself. `quad` is materialized from the current (rectangular)
// corners on first use, which is what lets a plain frame be skewed corner by
// corner.
export function setQuadCorner(box: Box, index: CornerIndex, x: number, y: number): void {
  const corners = quadCorners(box).map((c) => ({ ...c })) as Corners;
  const [tl, tr, br, bl] = corners;
  switch (index) {
    case 0: // TL: left of TR, above BL
      x = Math.min(x, tr.x);
      y = Math.min(y, bl.y);
      break;
    case 1: // TR: right of TL, above BR
      x = Math.max(x, tl.x);
      y = Math.min(y, br.y);
      break;
    case 2: // BR: right of BL, below TR
      x = Math.max(x, bl.x);
      y = Math.max(y, tr.y);
      break;
    case 3: // BL: left of BR, below TL
      x = Math.min(x, br.x);
      y = Math.max(y, tl.y);
      break;
  }
  corners[index] = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  applyQuad(box, corners);
}

// Translates a whole quad (and its bounding span) by a normalized delta, clamped
// so the bounding box stays on the page.
export function translateQuad(box: Box, dx: number, dy: number): void {
  const page = box.spans[0]?.page ?? 0;
  const corners = quadCorners(box).map((c) => ({ ...c })) as Corners;
  const aabb = aabbOfSpan(page, corners);
  const ndx = Math.min(1 - (aabb.x + aabb.w), Math.max(-aabb.x, dx));
  const ndy = Math.min(1 - (aabb.y + aabb.h), Math.max(-aabb.y, dy));
  applyQuad(box, corners.map((c) => ({ x: c.x + ndx, y: c.y + ndy })) as Corners);
}

// Moves one whole side of a frame by a normalized delta. Both corners of the side
// move by the same amount, so the side travels parallel to itself: a rectangle
// stays a rectangle and a quad keeps its skew. Clamped to the page and to
// MIN_SPAN against the opposite side, the same guard `resizeSpan` uses.
export function moveQuadEdge(box: Box, edge: Edge, dx: number, dy: number): void {
  const corners = quadCorners(box).map((c) => ({ ...c })) as Corners;
  const [tl, tr, br, bl] = corners;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  if (edge === "n" || edge === "s") {
    const topMin = Math.min(tl.y, tr.y);
    const topMax = Math.max(tl.y, tr.y);
    const botMin = Math.min(bl.y, br.y);
    const botMax = Math.max(bl.y, br.y);
    let d = dy;
    if (edge === "n") d = Math.min(d, botMin - MIN_SPAN - topMax);
    else d = Math.max(d, topMax + MIN_SPAN - botMin);
    // Only the moving side is clamped to the page.
    if (edge === "n") d = Math.max(d, -topMin);
    else d = Math.min(d, 1 - botMax);
    if (edge === "n") {
      corners[0].y = clamp(tl.y + d);
      corners[1].y = clamp(tr.y + d);
    } else {
      corners[2].y = clamp(br.y + d);
      corners[3].y = clamp(bl.y + d);
    }
  } else {
    const leftMin = Math.min(tl.x, bl.x);
    const leftMax = Math.max(tl.x, bl.x);
    const rightMin = Math.min(tr.x, br.x);
    const rightMax = Math.max(tr.x, br.x);
    let d = dx;
    if (edge === "w") d = Math.min(d, rightMin - MIN_SPAN - leftMax);
    else d = Math.max(d, leftMax + MIN_SPAN - rightMin);
    // Only the moving side is clamped to the page.
    if (edge === "w") d = Math.max(d, -leftMin);
    else d = Math.min(d, 1 - rightMax);
    if (edge === "e") {
      corners[1].x = clamp(tr.x + d);
      corners[2].x = clamp(br.x + d);
    } else {
      corners[0].x = clamp(tl.x + d);
      corners[3].x = clamp(bl.x + d);
    }
  }
  applyQuad(box, corners);
}

// Anchor helpers: anchors are boxes whose geometry is a thin full-width line.
export function anchorOf(page: number, y: number, label: string): Box {
  return {
    kind: "box",
    id: newBoxId(),
    tags: [TAGS.anchor],
    label,
    spans: [
      {
        page,
        x: 0,
        y: Math.max(0, y - ANCHOR_THICKNESS / 2),
        w: 1,
        h: ANCHOR_THICKNESS
      }
    ]
  };
}

export function anchorPage(box: Box): number {
  return box.spans[0]?.page ?? 0;
}

// ---- Label parsing ---------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s*(.*)$/;

// A label is free single-line text. Leading '#' runs are the heading level,
// exactly like markdown; anything else is a paragraph-level entry (level 0).
export function parseLabel(label: string): { level: number; text: string } {
  const m = HEADING_RE.exec(label.trim());
  if (m) return { level: m[1].length, text: m[2].trim() };
  return { level: 0, text: label.trim() };
}

// ---- Card derivation -------------------------------------------------------

export function intersect(a: Span, b: Span): Span {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return { page: a.page, x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

export function spanOf(entities: Entity[], id: string): Span | null {
  return entities.find((e) => e.id === id)?.spans[0] ?? null;
}

// Full page width, the mark's vertical extent on its first page. The fallback
// context for a card when no context box is assigned. No vertical pad: the band
// is exactly the marked line, so the player's up/down controls are the only way
// context is added (a fixed pad cannot know how tall a text line is).
export function band(mark: Mark): Span {
  const first = mark.spans[0];
  if (!first) return { page: 0, x: 0, y: 0, w: 1, h: 0 };
  const same = mark.spans.filter((s) => s.page === first.page);
  const y0 = Math.min(...same.map((s) => s.y));
  const y1 = Math.max(...same.map((s) => s.y + s.h));
  return {
    page: first.page,
    x: 0,
    y: y0,
    w: 1,
    h: y1 - y0
  };
}

// The single card-crop derivation. Outline, player and any inspector must call
// this rather than re-deriving it.
export function cardCrop(mark: Mark, entities: Entity[]): Span {
  const contextId = mark.card?.context;
  const base = contextId ? spanOf(entities, contextId) ?? band(mark) : band(mark);
  const frameId = mark.card?.frame;
  const frame = frameId ? spanOf(entities, frameId) : null;
  return frame ? intersect(base, frame) : base;
}

// ---- Containment / ownership ----------------------------------------------

const EPS = 1e-6;

export function containsSpan(box: Box, r: Span): boolean {
  return box.spans.some(
    (s) =>
      s.page === r.page &&
      s.x <= r.x + EPS &&
      s.y <= r.y + EPS &&
      s.x + s.w >= r.x + r.w - EPS &&
      s.y + s.h >= r.y + r.h - EPS
  );
}

// A box contains a mark when it contains any of the mark's spans.
export function containsMark(box: Box, mark: Mark): boolean {
  return mark.spans.some((s) => containsSpan(box, s));
}

function boxArea(box: Box): number {
  const s = box.spans[0];
  return s ? s.w * s.h : Infinity;
}

// Smallest containing container wins, so nested boxes beat their container.
// Anchors and frames are skipped: anchors are lines, and a frame is a crop
// mask that should never become an owner.
export function smallestContainingSpan(span: Span, boxes: Box[]): Box | null {
  let best: Box | null = null;
  let bestArea = Infinity;
  for (const box of boxes) {
    if (isAnchor(box) || isFrame(box)) continue;
    if (!containsSpan(box, span)) continue;
    const area = boxArea(box);
    if (!best || area <= bestArea) {
      best = box;
      bestArea = area;
    }
  }
  return best;
}

export function smallestContainingBox(mark: Mark, boxes: Box[]): Box | null {
  let best: Box | null = null;
  let bestArea = Infinity;
  for (const box of boxes) {
    if (isAnchor(box) || isFrame(box)) continue;
    if (!containsMark(box, mark)) continue;
    const area = boxArea(box);
    if (!best || area <= bestArea) {
      best = box;
      bestArea = area;
    }
  }
  return best;
}

// Assigns owners by containment.
//   rehome=false (load): keep valid explicit owners; only free/dangling marks
//     adopt the smallest containing box, so loading never rewrites intent.
//   rehome=true (after split/auto-segment): also move a mark owned by a coarser
//     box down to the inner box that contains it.
export function assignOwners(marks: Mark[], boxes: Box[], rehome = false): Mark[] {
  const ids = new Set(boxes.map((b) => b.id));
  for (const m of marks) {
    const best = smallestContainingBox(m, boxes);
    const explicit = m.owner !== PAGE_OWNER && ids.has(m.owner);
    if (!best) {
      if (m.owner !== PAGE_OWNER && !explicit) m.owner = PAGE_OWNER;
      continue;
    }
    if (!explicit) {
      m.owner = best.id;
      continue;
    }
    if (!rehome) continue;
    const current = boxes.find((b) => b.id === m.owner);
    if (!current) {
      m.owner = best.id;
      continue;
    }
    if (boxArea(best) < boxArea(current)) m.owner = best.id;
  }
  return marks;
}

// ---- Outline ---------------------------------------------------------------

export interface OutlineNode {
  id: string;
  kind: "box";
  label: string;
  level: number;
  text: string;
  page: number;
  tags: string[];
  depth: number;
  children: OutlineNode[];
}

interface OutlineRaw {
  id: string;
  label: string;
  level: number;
  text: string;
  page: number;
  y: number;
  tags: string[];
  container: boolean;
  box?: { page: number; y0: number; y1: number; x0: number; x1: number; area: number };
}

// Builds the outline as a tree of boxes (including anchors, which render as
// marker rows). Marks are published by the overlay, not the outline.
// Nesting comes from two sources, with geometric containment taking priority:
//   1. A box whose span sits inside another box's span becomes its child.
//   2. Markdown heading levels ('#') nest the way they do in a document.
export function buildOutlineTree(entities: Entity[]): OutlineNode[] {
  const items: OutlineRaw[] = [];
  for (const e of entities) {
    if (!isBox(e)) continue;
    const span = e.spans[0];
    const { level, text } = parseLabel(e.label);
    items.push({
      id: e.id,
      label: e.label,
      level,
      text,
      page: span?.page ?? 0,
      y: span?.y ?? 0,
      tags: e.tags,
      container: isContainer(e),
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
  items.sort((a, b) => a.page - b.page || a.y - b.y);
  const index = new Map<string, number>();
  items.forEach((it, i) => index.set(it.id, i));

  const parentOf = new Map<string, string | null>();

  for (const it of items) {
    if (!it.box) continue;
    let best: OutlineRaw | null = null;
    for (const cand of items) {
      if (cand === it || !cand.box || !cand.container) continue;
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
      kind: "box",
      label: it.label,
      level: it.level,
      text: it.text,
      page: it.page,
      tags: it.tags,
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

// ---- Empty / migration -----------------------------------------------------

export function emptySidecar(doc: string, kind: Sidecar["kind"]): Sidecar {
  return {
    version: 6,
    doc,
    kind,
    updatedAt: Date.now(),
    entities: [],
    notes: []
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

interface LegacyMarker {
  id?: string;
  page?: number;
  y?: number;
  label?: string;
}

interface LegacyRegion {
  id?: string;
  surface?: number;
  kind?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
  owner?: string;
  label?: string;
  revealed?: boolean;
  groupId?: string;
}

function asRole(value: unknown): BoxTag {
  if (value === "concept" || value === "info") return "concept";
  if (value === "questions" || value === "section") return "questions";
  if (value === "question") return "question";
  if (value === "frame") return "frame";
  if (value === "anchor" || value === "marker") return "anchor";
  return "other";
}

function legacyLabel(s: LegacySegment): string {
  if (typeof s.label === "string") return s.label;
  const text = typeof s.heading === "string" ? s.heading : typeof s.title === "string" ? s.title : "";
  if (typeof s.level === "number" && s.level > 0 && text) return `${"#".repeat(Math.min(6, s.level))} ${text}`;
  return text;
}

function migrateSegments(raw: unknown): Box[] {
  if (!Array.isArray(raw)) return [];
  const out: Box[] = [];
  for (const s of raw as LegacySegment[]) {
    if (!s || typeof s !== "object" || !Array.isArray(s.spans)) continue;
    out.push({
      kind: "box",
      id: s.id ?? newBoxId(),
      tags: [asRole(s.role ?? s.type)],
      label: legacyLabel(s),
      spans: s.spans
    });
  }
  return out;
}

function migrateMarkers(raw: unknown): Box[] {
  if (!Array.isArray(raw)) return [];
  const out: Box[] = [];
  for (const m of raw as LegacyMarker[]) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.page !== "number" || typeof m.y !== "number") continue;
    out.push({
      kind: "box",
      id: m.id ?? newBoxId(),
      tags: [TAGS.anchor],
      label: typeof m.label === "string" ? m.label : "",
      spans: [
        {
          page: m.page,
          x: 0,
          y: Math.max(0, m.y - ANCHOR_THICKNESS / 2),
          w: 1,
          h: ANCHOR_THICKNESS
        }
      ]
    });
  }
  return out;
}

function migrateRegions(raw: unknown): Mark[] {
  if (!Array.isArray(raw)) return [];
  const out: Mark[] = [];
  for (const r of raw as LegacyRegion[]) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.surface !== "number") continue;
    out.push({
      kind: "mark",
      id: r.id ?? newMarkId(),
      tags: [r.kind === "highlight" ? "highlight" : "occlusion"],
      label: r.label ?? "",
      spans: [{ page: r.surface, x: r.x, y: r.y, w: r.w, h: r.h }],
      color: r.color ?? DEFAULT_OCCLUSION_COLOR,
      owner: typeof r.owner === "string" && r.owner ? r.owner : PAGE_OWNER,
      revealed: r.revealed,
      groupId: typeof r.groupId === "string" ? r.groupId : undefined
    });
  }
  return out;
}

function asNoteTargetKind(value: unknown): NoteTargetKind {
  if (value === "region") return "mark";
  if (value === "segment" || value === "marker") return "box";
  if (value === "box" || value === "mark" || value === "group" || value === "page" || value === "point") {
    return value;
  }
  return "page";
}

// A pin without a usable point is not a pin (it would render nowhere), so a
// malformed `at` is dropped rather than guessed at.
function asNoteAnchor(raw: unknown): NoteAnchor | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Partial<NoteAnchor>;
  if (typeof a.page !== "number" || typeof a.x !== "number" || typeof a.y !== "number") return undefined;
  if (!Number.isFinite(a.page) || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return undefined;
  return { page: a.page, x: a.x, y: a.y };
}

// A frame's quad is kept only when it is four finite points; a malformed one is
// dropped, so the frame falls back to its rectangular span rather than throwing.
function asCorners(raw: unknown): Corners | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const out: Point[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") return undefined;
    const q = p as Partial<Point>;
    if (typeof q.x !== "number" || typeof q.y !== "number") return undefined;
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return undefined;
    out.push({ x: q.x, y: q.y });
  }
  return out as Corners;
}

// A note is only kept when it has a body and a target id; an empty note is
// noise the user did not mean to keep.
function migrateNotes(raw: unknown): Note[] {
  if (!Array.isArray(raw)) return [];
  const out: Note[] = [];
  const seen = new Set<string>();
  for (const n of raw as Note[]) {
    if (!n || typeof n !== "object") continue;
    if (typeof n.target !== "string" || !n.target) continue;
    if (typeof n.body !== "string" || !n.body.trim()) continue;
    const id = typeof n.id === "string" && n.id ? n.id : newNoteId();
    if (seen.has(id)) continue;
    seen.add(id);
    const at = asNoteAnchor(n.at);
    out.push({
      id,
      target: n.target,
      targetKind: asNoteTargetKind(n.targetKind),
      body: n.body,
      at,
      quote: typeof n.quote === "string" ? n.quote : undefined,
      page: typeof n.page === "number" ? n.page : at?.page,
      createdAt: typeof n.createdAt === "number" ? n.createdAt : Date.now(),
      updatedAt: typeof n.updatedAt === "number" ? n.updatedAt : Date.now()
    });
  }
  return out;
}

// Validates and normalizes entities from an already-v6 sidecar.
function migrateEntities(raw: unknown): Entity[] {
  if (!Array.isArray(raw)) return [];
  const out: Entity[] = [];
  const seen = new Set<string>();
  for (const e of raw as Entity[]) {
    if (!e || typeof e !== "object") continue;
    if (typeof e.id !== "string" || !e.id) continue;
    if (seen.has(e.id)) continue;
    if (!Array.isArray(e.spans)) continue;
    seen.add(e.id);
    const tags = Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === "string") : [];
    if (e.kind === "mark") {
      out.push({
        kind: "mark",
        id: e.id,
        tags,
        label: typeof e.label === "string" ? e.label : "",
        spans: e.spans,
        owner: typeof e.owner === "string" && e.owner ? e.owner : PAGE_OWNER,
        groupId: typeof e.groupId === "string" ? e.groupId : undefined,
        revealed: !!e.revealed,
        color: typeof e.color === "string" ? e.color : undefined,
        path: Array.isArray(e.path) ? e.path : undefined,
        weight: typeof e.weight === "number" ? e.weight : undefined,
        card: e.card,
        cue: typeof e.cue === "string" && e.cue.trim() ? e.cue : undefined
      });
    } else {
      out.push({
        kind: "box",
        id: e.id,
        tags,
        label: typeof e.label === "string" ? e.label : "",
        spans: e.spans,
        quad: asCorners((e as Box).quad)
      });
    }
  }
  return out;
}

// Migrates any supported version (1–6) to v6. Unknown shapes yield an empty
// sidecar rather than throwing.
export function migrate(raw: unknown, doc: string, kind: Sidecar["kind"]): Sidecar {
  if (!raw || typeof raw !== "object") return emptySidecar(doc, kind);
  const data = raw as {
    version?: number;
    doc?: string;
    kind?: Sidecar["kind"];
    updatedAt?: number;
    entities?: unknown;
    regions?: unknown;
    segments?: unknown;
    markers?: unknown;
    notes?: unknown;
    rule?: SegmentRule;
  };
  const v = data.version;
  if (v !== 1 && v !== 2 && v !== 3 && v !== 4 && v !== 5 && v !== 6) {
    return emptySidecar(doc, kind);
  }

  let entities: Entity[];
  if (v === 6) {
    entities = migrateEntities(data.entities);
  } else {
    entities = [
      ...migrateSegments(data.segments),
      ...migrateMarkers(data.markers),
      ...migrateRegions(data.regions)
    ];
  }
  const boxes = entities.filter(isBox);
  const marks = entities.filter(isMark);
  assignOwners(marks, boxes);

  return {
    version: 6,
    doc: data.doc ?? doc,
    kind: data.kind ?? kind,
    updatedAt: data.updatedAt ?? Date.now(),
    entities,
    notes: migrateNotes(data.notes),
    rule: data.rule
  };
}
