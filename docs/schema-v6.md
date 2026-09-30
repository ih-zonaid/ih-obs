# Schema v6 — Design

> **Status: implemented.** Schema v6 ships (`src/store/schema.ts`,
> `Sidecar.version = 6`) and the flashcard feature is live. See
> `docs/schema-v6-plan.md` for the implementation record and any deviations.

## 0. Goal

Collapse the three near-identical primitives (`Segment`, `Marker`, `Region`) into
**two generic entities** and move all meaning into **tags**, so features
interpret the core instead of the core encoding features. Keep the mental model
minimal: no automatic promotion, no inference — everything a feature needs is
either a tag or an explicitly assigned id.

## 1. Two primitives

```ts
interface Span {
  page: number;
  x: number; y: number; w: number; h: number; // normalized (0–1) within the page
}

interface Base {
  id: string;
  spans: Span[];
  label: string;      // leading '#'s encode outline level, exactly as today
  tags: string[];     // feature vocabulary; schema assigns no meaning
}

interface Box extends Base {
  kind: "box";
}

interface Mark extends Base {
  kind: "mark";
  owner: string;      // box id, or PAGE_OWNER ("page")
  groupId?: string;   // reveal group (line-tool swipes chained with Shift)
  revealed?: boolean;
  color?: string;
  card?: Card;        // presence of this object = this mark is a flashcard
}

interface Card {
  context?: string;   // box id → the question side; omitted → full-width band
  frame?: string;     // box id → clip rect; omitted → no clip
}

type Entity = Box | Mark;
```

### Anchor = a Box

There is no third kind. A **marker line / anchor** is a `Box` tagged `"anchor"`,
with a single span spanning the page width and a **small fixed line thickness**
(≈ 2px, stored normalized). It is identified *by tag*, never by height.

```ts
// anchor
{
  kind: "box",
  tags: ["anchor"],
  spans: [{ page, x: 0, y, w: 1, h: anchorThickness }],
  label
}
```

Because anchors are found by tag, no code needs an `h === 0` special case.

## 2. Tags are the feature boundary

```
Box tags:   anchor | frame | concept | questions | question | other
Mark tags:  occlusion | highlight
```

The schema knows none of these. Each feature reads tags:

| Feature | Reads | Uses tags for |
|---|---|---|
| Outline | `Box` (incl. anchors) | anchor glyph `▸`, `#` heading level, role |
| Overlay | `Mark` | `occlusion` = solid cover, `highlight` = wash |
| Ownership | `Mark` + `Box` | explicit owner → smallest containing box → page |
| Notes | any entity id | nothing (already generic) |
| **Flashcards** | `Mark.card` + `Box` | context + frame resolution |

**One tag registry** (`TAGS`, `isFrame(box)`, `isAnchor(box)`,
`isOcclusion(mark)`, …). Raw string comparisons live only there.

## 3. Card rules

- A mark **is** a card **iff** `mark.card` is set. **No automatic promotion.**
- One card = one mark. No group cards, no reverse cards (for now).
- **Question side** (crop rectangle), resolved in order:
  1. `mark.card.context` names a box → use that box's span.
  2. otherwise → the mark's **full-width band** (see below).
  3. finally, if `mark.card.frame` names a box → **intersect** the result with
     the frame's span.
- **Full-width band** = union of the mark's spans, page-wide (`x: 0, w: 1`),
  with a small vertical pad above and below.
- A **frame** is a box tagged `"frame"` — purely a crop mask. It is never a card
  and never carries content. Its job is e.g. to mask a two-column PDF to one
  column.

## 4. Derivation — one function

```ts
const PAD = 0.01;

function band(mark: Mark): Span {
  const s = mark.spans[0];
  const y0 = Math.min(...mark.spans.map((p) => p.y));
  const y1 = Math.max(...mark.spans.map((p) => p.y + p.h));
  return { page: s.page, x: 0, y: Math.max(0, y0 - PAD), w: 1, h: y1 - y0 + 2 * PAD };
}

function cardCrop(mark: Mark, boxes: Box[]): Span {
  const base = mark.card?.context
    ? spanOf(boxes, mark.card.context) ?? band(mark)
    : band(mark);
  const frame = mark.card?.frame ? spanOf(boxes, mark.card.frame) : null;
  return frame ? intersect(base, frame) : base;
}
```

Play = render `cardCrop`, cover the mark; reveal clears the mark. That is the
entire flashcard feature on top of the core.

This derivation lives in **exactly one place**. Outline, player, and any
inspector must call it rather than re-deriving.

### Play scope

**Within a frame.** A play session collects the cards inside one frame box.

Membership rule, as implemented:

- If the mark assigns `card.frame`, it belongs to that frame.
- Otherwise the card belongs to a frame that **contains the mark's own span**
  (`containsSpan`). Do *not* test the derived **crop**: the default full-width
  band never fits inside a column frame, so a crop test would drop exactly the
  cards frames exist for. A frame is still a valid `card.frame` crop clip; the
  two uses (clip vs. scope) are independent.

A frame is selected the same way any box is selected today (pick it in the
outline or on the page). The outline shows a `▶` on frame rows, and the box
context menu offers **Play cards in frame**. A single mark's menu can play just
that card.

Because a frame is a crop mask, it is **never an owner**: `smallestContainingBox`
/ `smallestContainingSpan` skip `isFrame` boxes the same way they skip anchors.

## 5. Geometry guards

- **Anchors never contain.** Containment/ownership/context ignore boxes tagged
  `"anchor"` — identified by tag, not by height.
- **Frames never own.** `smallestContainingBox` / `smallestContainingSpan` also
  skip boxes tagged `"frame"`; a frame is a crop mask, not a container.
- **Card crop uses the first span** for now; a mark spread across pages is not
  split into multiple cards.
- An explicitly assigned `context` box need **not** contain the mark — explicit
  assignment is trusted, no validation or auto-correction.

## 6. Migration v5 → v6

`migrate()` remains the single migration path. Bump `Sidecar.version` to `6`.

| v5 | v6 |
|---|---|
| `Segment { role, label, spans }` | `Box { kind:"box", tags:[role], label, spans }` |
| `Marker { page, y, label }` | `Box { kind:"box", tags:["anchor"], spans:[{page, x:0, y, w:1, h:anchorThickness}], label }` |
| `Region { kind, surface, x, y, w, h, owner, groupId?, revealed?, color }` | `Mark { kind:"mark", tags:[kind], spans:[{page: surface, x, y, w, h}], owner, groupId?, revealed?, color }` |
| `Note { target, targetKind }` | unchanged; `targetKind` vocabulary shrinks to `box \| mark \| group \| page` |

## 7. What this removes

- `SegmentRole` enum and `asRole()` → tags.
- `Marker` as a separate type/array → anchor boxes in the same array.
- `Region`'s flat `surface` + x/y/w/h → `spans[]`.
- Automatic card membership, reverse cards, group cards.
- The `h === 0` anchor special case.

Net shape: **one array, two kinds, one optional `card` object, one crop
function.**

## 8. Open items (deferred)

- Reverse cards.
- Group / multi-mark cards (the `groupId` reveal logic already exists and can be
  reused later).
- Per-card hint text / labels.
- Automatic card promotion from enclosing boxes (deliberately omitted for now).
- Additional play scopes beyond "within a frame": a whole-frame session and a
  single-card session exist; a document-wide "play all cards" does not.
