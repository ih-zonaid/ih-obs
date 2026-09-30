# Schema v6 — Implementation Plan

> Companion to `docs/schema-v6.md` (the design). This file is the *how*: phases,
> files touched, risks, and the order of operations.

## Status

- **Phase 1: done.** `src/store/entities.ts` was written, then folded straight
  into `schema.ts` (there was no long-lived coexistence — nothing imported the
  separate module, so the fold happened in one pass with the Phase 2 rewrite).
- **Phase 2: done.** `schema.ts` is v6; `sidecar.ts` exposes `saveEntities`;
  overlay, segmentLayer, segmentDraw, outline, player and app all speak
  `Entity[]`. `npm run typecheck` and `npm run build` are green.
- **Phase 3: done.** A `frame` role + draw tool; mark menu gains Make card /
  context / frame / Remove card; a frame plays the cards inside it (span-based
  membership, since the default band never fits a column frame); the player
  crops by `cardCrop`.

### Deviations from the plan below

- `entities.ts` was deleted after the fold (never shipped as a parallel module).
- `RegionKind` was renamed `MarkKind`; overlay `getRegions`/`setRegions` became
  `getMarks`/`setMarks`.
- The overlay still owns the marks array it mutates; `app.ts` recomposes
  `entities` from `boxes + overlay.getMarks()` before each save
  (`syncMarksFromOverlay`). A follow-up could give the app sole ownership of the
  array, but the current arrangement keeps the existing drawing code unchanged.

## Goal

Land schema v6 (two generic entities, tag-driven features, flashcards) **without
a moment where `npm run typecheck` is red**, and without breaking a vault a user
already has open on disk.

## Constraints

1. **Keep typecheck green at every step.** `npm run build` runs `tsc --noEmit`
   first, so a red typecheck blocks builds.
2. **One-way on-disk change.** A v6 sidecar cannot be read by a v5 build. Do the
   format switch only once, in a single deliberate step, and only when the app
   can also *write* v6 consistently.
3. **No framework added.** Imperative DOM, class components, handler interfaces
   — unchanged.

## Phase 1 — core module (additive, no behavior change)

Add `src/store/entities.ts`, a **new** module beside the existing `schema.ts`.
`schema.ts` keeps working exactly as today; nothing imports the new module yet.
This lets the v6 core be written and typechecked in isolation.

`src/store/entities.ts` contains:

- Types: `EntityBase`, `Box`, `Mark`, `Card`, `Entity`, `SidecarV6`, `V6Note`.
- Tag registry: `TAGS`, `isAnchor`, `isFrame`, `isOcclusion`, `isHighlight`,
  `isCard`, plus `boxOf` / `markOf` filters.
- Geometry: `band()`, `intersect()`, `cardCrop()`, `CARD_PAD`.
- Containment: `containsSpan()` (anchor-aware), `smallestContainingBox()`,
  `assignOwners()`.
- Outline: `buildOutlineTree()` over `Box[]`, with a v6 `OutlineNode`.
- Migration: `toV6(v5: Sidecar): SidecarV6`, including note `targetKind`
  remapping (`region→mark`, `segment|marker→box`).

**Deviation from the design doc:** the design puts these in `schema.ts`. Phase 1
puts them in `entities.ts` so `schema.ts`'s many consumers keep compiling.
Phase 2 folds the survivors back into `schema.ts` and deletes the rest.

Exit criteria: `npm run typecheck` green; `entities.ts` importable; no file
outside `entities.ts` changed.

## Phase 2 — swap the app to `Entity[]`

Now `schema.ts` is rewritten in place (v6) and every consumer moves at once.

| File | Change |
|---|---|
| `src/store/schema.ts` | v6 types replace `Segment`/`Marker`/`Region`; `Sidecar.entities`; `version: 6`; `migrate()` emits v6 (v1–v5 upgraded via `toV6`). |
| `src/store/sidecar.ts` | Replace `saveRegions`/`saveSegments` with `saveEntities(path, kind, entities)`; keep `saveNotes`. Whole-array save. |
| `src/overlay/overlay.ts` | Marks carry `spans` + `tags`; occlusion/highlight read by tag. |
| `src/ui/segmentLayer.ts` | Draw from `entities`: marks as spans, boxes as spans, anchors as lines (`isAnchor`). |
| `src/ui/segmentDraw.ts` | Emit `Box`/anchor entities, not bare `Span`/`Marker`. |
| `src/ui/outline.ts` | Read `tags` for glyph/role; anchors via `isAnchor`. |
| `src/ui/player.ts` | Item carries `crop: Span` instead of hard-using `span`. |
| `src/app/app.ts` | Single `entities[]`; ownership/context via new helpers; `openPlayer` gains frame scope. |

Key mechanics:

- **Whole-array writer.** All mutations (draw mark, add box, split,
  auto-segment, note save) go through one in-memory `entities[]` and one
  `saveEntities`. This removes the v5 split of three writers over three slices.
- **Ownership** uses `smallestContainingBox`, which skips anchors by tag.
- **Notes** unchanged in mechanics; `targetKind` vocabulary becomes
  `box | mark | group | page`.

Exit criteria: app runs against a migrated vault; existing marks/segments/
anchors all appear; typecheck green.

## Phase 3 — flashcards (done)

- `Mark.card?: { context?: boxId; frame?: boxId }` (already in the type).
- A new `frame` box role + draw tool.
- Mark menu: Make card, clear/assign context (from the selected box), clear/
  assign frame (listed from existing frame boxes), Open in play, Remove card.
- Play collects marks with `isCard(m)` inside the selected **frame** box:
  explicit `card.frame` match, else containment of the *mark span* (not the
  crop — see the design's play-scope note). Played in page→y order.
- Player renders `cardCrop` and covers/clears the mark on reveal.
- The `▶` in the outline works on frame rows too.

Exit criteria met: draw a frame, tag marks as cards, play → context shown, mark
revealed/hidden.

## Risks and mitigations

1. **Duplicate primitives during Phase 1.** `schema.ts` v5 and `entities.ts` v6
   coexist briefly. Mitigation: Phase 1 is additive and short-lived; nothing
   imports `entities.ts` until Phase 2.
2. **One-way migration.** Mitigation: Phase 2 backs up is the user's
   responsibility; note it in the changelog. Migration is pure v5→v6; keep the
   v5 readers (`migrateSegments` etc.) until Phase 2 is done.
3. **Anchor vs height.** Anchors are found by tag, so no `h === 0` special case.
   `smallestContainingBox` must exclude `isAnchor` boxes.
4. **Lost updates.** With one array, a stale in-memory model could overwrite.
   Mitigation: the app owns the single `entities[]`; `SidecarStore` caches the
   same object graph and is the only writer.
5. **Multi-page marks.** v6 keeps "first span" semantics for crop/outline.
   Documented in the design; do not try to fix here.

## Deferred (not in this plan)

Reverse cards; group cards; per-card hints; automatic card promotion; additional
play scopes beyond "within a frame" (play-all, play-one are reachable only via a
frame or a single mark).

## Commit plan

1. **Phase 1**: `entities.ts` + this plan doc. Typecheck green.
2. **Phase 2**: schema rewrite + sidecar + all consumers. Typecheck green, app runs.
3. **Phase 3**: card feature on top. Typecheck green.
