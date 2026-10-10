# ihobs — Project Context

> Drop this file into an AI agent's context before asking it to work on this repo.
> It describes the project's intent, architecture, data model, current features,
> and conventions. Everything here reflects the code as it exists today.

## 1. What this is

`ihobs` ("IH obs") is a **local, Obsidian-style vault reader** built for
**active recall on top of documents** — primarily scanned PDFs, but also images,
markdown, and JSON.

- Pure client-side web app. No server, no backend, no network calls.
- Filesystem access via the browser **File System Access API**
  (`showDirectoryPicker`). A "vault" is a directory on disk.
- Annotations are stored **beside the vault files** in a hidden `.ihobs/`
  folder, one JSON sidecar per document. Nothing is uploaded anywhere.
- The PDF is only the bottom layer. The value of the app is what gets pinned
  on top of it: boxes, marks, notes, and play mode.

Stack: Vite + TypeScript, no UI framework (hand-built DOM). Three runtime deps:
`pdfjs-dist` (PDF rendering + text layer), `marked` (markdown), and `ts-fsrs`
(the FSRS spaced-repetition scheduler, adapted in `src/srs/fsrs.ts`).
Dev deps: `typescript`, `vite`, `@types/chrome`, `@types/node`.

## 2. Core mental model

```
Document page (Surface)
 ├─ Box            (a selected region: container, frame, or anchor line)
 ├─ Mark           (occlusion | highlight)     ← the cloze "answer"
 └─ Note           (markdown)                  ← attaches to ANY entity, or the page
        linked by `owner` + geometric containment; stored in one .ihobs sidecar
```

Every annotation is stored in **normalized page coordinates (0–1)** relative to a
surface, so it survives zoom and re-render.

A **Surface** is the unit of "page": a PDF page wrapper, the single element of an
image, or the single article element of a markdown/JSON doc. `Surface` is defined
in `src/adapters/types.ts`.

## 3. Data model (`src/store/schema.ts`)

Sidecar schema version is **6** (`Sidecar.version`). Migration from v1–v5 is
handled in `migrate()`.

Two generic primitives; all feature meaning lives in `tags`:

- **`Box`** — `{ kind:"box", id, tags[], label, spans[] }`. A region you select.
  - `tags`: `"anchor"` (a marker line), `"frame"` (a crop/viewport mask, e.g. one
    column of a two-column page), or a role: `"concept" | "questions" |
    "question" | "other"`.
  - `label`: free text where leading `#`s encode markdown heading level
    (`parseLabel`, `MAX_LEVEL = 6`). Plain text = level 0.
  - **An anchor is a `Box` tagged `"anchor"`** with a thin full-width span
    (`ANCHOR_THICKNESS`). It is found by tag, never by height.
- **`Mark`** — `{ kind:"mark", id, tags[], label, spans[], owner, groupId?,
  revealed?, color?, card? }`. The cloze overlay.
  - `tags`: `"occlusion"` (solid color cover = the hidden answer) or
    `"highlight"` (yellow wash).
  - `owner`: either `PAGE_OWNER` (`"page"`, a free floating mark) or a box id.
  - `groupId?`: a reveal group — several marks that reveal/hide together as one
    logical answer (line-tool swipes chained with Shift).
  - `card?`: presence makes the mark a flashcard (see §3a).
- **`Entity`** = `Box | Mark`, held in one `entities[]` array. Features filter by
  `kind` (`isBox`, `isMark`) and by `tags` (`isAnchor`, `isFrame`, `isCard`).
- **`Note`** — `{ target, targetKind, body, quote?, page?, createdAt, updatedAt }`.
  - `targetKind`: `"box" | "mark" | "group" | "page"`.
  - Anchored by id, so it survives when the target's geometry changes.
  - A note with no body is never persisted (treated as noise).
- **`SegmentRule`** — parameters for auto-segmentation (mode, anchor pattern,
  margin/gap/min-height fractions). Defaults in `DEFAULT_RULES`.

### 3a. Flashcards (card property)

A mark **is** a flashcard iff `mark.card` is set. No automatic promotion.

- `card.context?`: box id used as the **question side**. Omitted → the mark's
  **full-width band** (`band()`: page-wide, vertical extent of the mark's spans
  plus `CARD_PAD`).
- `card.frame?`: box id used to **clip** the crop. Omitted → no clip.
- Crop is derived by the single function `cardCrop(mark, entities)`.
- Authoring: right-click a mark → **Make card**, then optionally **Use selected
  box as context** / **Frame with …**. Right-click a `frame` box → **Play cards
  in frame**. Cards can also be assigned context/frame from the mark menu.
- Play scope is **within a frame** — cards whose *mark span* falls inside the
  selected frame's span (testing the derived crop would fail for the default
  full-width band; see `openPlayer` in `app.ts`).

### 3b. Scheduling (`src/srs/`, `src/store/review.ts`)

Cards are scheduled with **FSRS** (the `ts-fsrs` engine, adapter at
`src/srs/fsrs.ts`, defaults matching the Obsidian spaced-repetition plugin:
retention 0.9, short-term steps on, the same four grades). Everything is
dependency-free pure logic except `fsrs.ts`, and `now` is always passed in, never
read inside the algorithm.

- **Card identity is the mark id.** There is no content hashing, no anchor
  reconciliation and no orphan handling: delete a mark and its schedule row
  simply goes. A `ReviewRow` is `{ due, algo, d, reps, lapses, last }`; `d` is
  opaque to every layer but the algorithm that wrote it.
- **The review store** (`src/store/review.ts`) keeps one file per document at
  `.ihobs/review/<doc with / → __>.json`, separate from the annotation sidecar.
  This is deliberate: annotations are rewritten wholesale on every mark drag, so
  study state living there would be rewritten by geometry edits. One writer each.
  Which marks are cards stays owned by the annotation sidecar.
- **The algorithm seam** (`src/srs/registry.ts`): algorithms live in an id →
  algorithm table; each card pins `algo` at its first review, so a card never
  switches algorithms when the default changes. SM-2 is the intended second
  implementation and needs one file plus one `registerScheduleAlgorithm()` call —
  no migration. `algorithm.ts` (with optional `toRecord`/`fromRecord`) is the
  whole contract the rest of the app sees.
- **One write path** (`applyReview` in `src/srs/review.ts`); grade buttons show
  the interval each grade *would* schedule, computed by the same `next()` the
  real review runs (`previewIntervals` → `formatPreviews`).
- **Queue** (`src/srs/queue.ts`): cards due now first (longest overdue first),
  then new; cards scheduled ahead are progress, not a queue. `countDeck`,
  `sumCounts` and `buryGroup` (reveal-group siblings) live here too.

### 3c. Decks from the outline

The outline is the **deck filter**. Each row is a scope; its deck is the card
marks in that row's subtree, and counts roll up so a parent already includes its
descendants.

- A card belongs to the box that **owns** it (its deepest container). It is also
  reachable from a row that contains its `card.context` or `card.frame` box, so a
  card's crop boxes are themselves valid deck handles even if the mark sits
  elsewhere.
- Page-scoped cards (no live box owner) form one synthetic **Ungrouped cards**
  row at the top of the outline (`UNGROUPED_DECK` in `src/ui/outline.ts`); they
  would otherwise appear in no subtree and contribute to no ancestor badge.
- Each row shows a deck badge: `◇` + (due + new), blue when there is work, with
  the full `due · new · scheduled · total` breakdown in the tooltip. A dim play
  button on every row plays that subtree's cards through `buildQueue`.
- `question` and `frame` rows keep their legacy meanings (question plays the one
  box; frame plays the cards inside it). `concept`/`questions`/`other`/anchor
  rows play their subtree as a deck.

### Ownership rules (the heart of the design)

A mark is attached to structure by containment, resolved in this order:

1. Explicit selection wins (the currently selected box).
2. Otherwise the **smallest containing box** wins (`smallestContainingSpan` /
   `smallestContainingBox`; anchors and frames are skipped — a frame is a crop
   mask and must never become an owner).
3. Otherwise the mark is page-scoped (`PAGE_OWNER`).

`assignOwners(marks, boxes, rehome)` applies this:
- `rehome = false` (on load): only free/dangling marks adopt a containing
  box; valid explicit owners are left alone (loading never rewrites intent).
- `rehome = true` (after split / auto-segment): a mark owned by a coarser
  box is moved down to the inner box that now contains it, so occlusions
  end up owned by the specific question.

## 4. The outline tree

`buildOutlineTree(entities)` produces the nested outline shown in the
right rail, from boxes and anchors (marks are published by the overlay). Nesting
comes from two sources, **geometric containment taking priority**:

1. A box whose span sits inside another box's span becomes its child
   (question splits nest under their questions container).
2. Markdown heading levels (`#`) nest the way they do in a document.

Order is document position (page, then y).

## 5. Features (current)

### Marking
- **Free rectangle draw**: occlusion or highlight (`src/overlay/overlay.ts`).
- **Line tool**: fixed-height band follows the cursor (mouse wheel resizes it);
  swipe sideways to stamp it. Built for occluding one text line at a time in a
  scanned book. Hold **Shift** on a swipe to link it into the previous swipe's
  reveal group. Click a mark to reveal/hide; right-click for options.
- **Mark from text selection**: converts the DOM selection into one union box per
  surface (`src/selection/textSelection.ts`). Works because scanned PDFs here
  carry a word-level OCR text layer over the raster page.
- Mark context menu: reveal/hide, add/edit note, convert occlusion↔highlight,
  color quick-pick + custom color, attach/detach to a box, "snap to
  containing box", remove.

### Structure
- **Boxes** tagged with a role: `frame` / `concept` / `questions` / `question` /
  `other`, drawn manually or produced by split/auto-segment.
- **Anchors** (marker lines): click a page to place a full-width line — a `Box`
  tagged `"anchor"`. **Frames** (crop masks): drawn with the `frame` tool, used
  to scope card play and clip crops.
- **Split tool**: select a `questions` container, click boundary lines on the
  page; the container is sliced into child `question` boxes (one per band).
- **Auto-segment**: OCR-free layout analysis *inside* a manually drawn
  `questions` container (`src/segment/detect.ts` + `src/segment/layout.ts`):
  Otsu threshold → row-ink bands → detect anchor lines by narrow leading indent
  at the left margin or a large vertical gap → merge to boxes. Uses
  `pdf.getPageImages()` to rasterize the container's pages at 1.2x.
- Boxes & anchors can be renamed in place; labels use `#` for heading levels.

### Notes
- Markdown editor popover with Write/Preview (`src/ui/notePopover.ts`).
- One note per target; `[[wikilinks]]` resolve relative to the document
  (`src/notes/render.ts`). Output is lightly sanitized (`safe()`).
- Notes panel in the right rail with filter, focus, edit, delete
  (`src/ui/notesPanel.ts`).

### Recall
- **Play mode** (`src/ui/player.ts`): one question at a time. Crops the
  question's span from the page image, paints its marks, and lets the user
  reveal/navigate. Scope = a deck's cards, the selected questions container's
  descendants, a single question, or all questions. Keyboard: ←/→ navigate,
  Space/Enter reveal, `1`–`4` grade, `n` note, Esc close. A question shows marks
  attached to it plus marks geometrically inside it that aren't owned by another
  question (`marksForBox` in `app.ts`).
- **Cards** (schema v6): a mark with `card` set is a flashcard; its question side
  is `card.context` or a full-width band, clipped by `card.frame`. A `frame` box
  plays the cards inside it (▶ in the outline, or the box context menu); a mark's
  menu can play just that card. See §3a.
- **Grading**: revealing a card shows four grade buttons (Again/Hard/Good/Easy)
  labelled with the interval each would schedule. Grading advances the FSRS
  schedule and buries reveal-group siblings. See §3b.
- **Decks**: each outline row is a playable deck with a due/new badge; see §3c.
- **Reveal controls**: toggle reveal, hide all, per-mark click toggle.
- **Notes in play** (schema unchanged): a note strip under the crop, shown only
  once the answer is revealed — a note usually restates the answer, so it is
  gated exactly like the grade row. It renders the note as markdown and offers
  `add note` / `note` (or `n`), which swaps the strip for an inline textarea:
  ⌘/Ctrl+Enter or blur commits, Esc cancels, an empty body removes the note.
  The item id is resolved through `playerNoteAnchor`, so a note written in play
  lands on the same target the overlay's note editor would use (a grouped mark
  writes to its reveal group) and appears in the notes panel and outline dot.
  Because the note strip is reveal-gated, the player's window key handler must
  ignore keys from a text field — otherwise the space in a note would hide the
  answer and take the strip down with it.

### Debugging / authoring aids
- **Inspect mode**: paints each mark's resolved owner as a badge, and shows a
  per-box mark count in the outline (`inspectCounts`) — surfaces
  under-attached marks (a question showing 0 while it visually has occlusions).
- **Text-layer debug**: toolbar button cycles off → glyph boxes → glyphs, or
  `?debug=text` / `?debug=text-full` in the URL (PDF only).

### Shell / app
- Multi-vault hub: add, open, rename, forget vaults; handles persisted in
  IndexedDB; permission re-request flow.
- Explorer tree, quick-open palette (⌘/Ctrl+P), home with recents + pins,
  per-document scroll memory, last-opened restore.
- Zoom (buttons, ctrl+wheel, keys) with page-aware re-render; page indicator
  with type-to-jump; light/dark theme; themed scrollbars (`color-scheme` +
  `scrollbar-color` + `::-webkit-scrollbar`).
- **Side layout**: a durable 46px activity spine on the far left (Files,
  quick-open, Bookmarks — the latter filters the tree to pinned files) with the
  explorer beside it. Both sidebars have a thin drag handle on their inside edge;
  widths are clamped and persisted per vault (`leftWidth`/`rightWidth`), reset by
  double-click. On the hub the spine/explorer are not rendered.
- **Responsive**: at ≤900px the sidebars become slide-in drawers (with scrim,
  Escape/tap-to-close, one at a time) and the toolbar splits into a slim top
  identity row plus a fixed bottom action bar; every remaining control lives in a
  labelled "all tools" bottom sheet. The app tracks the breakpoint with
  `matchMedia` and restores the stored desktop layout when leaving mobile.
- Only supported files are listed: `.md/.markdown/.mdx`, images, `.pdf`, `.json`.
  `.ihobs` is shown; other dotfiles, `.git`, `node_modules` are ignored.

## 6. File map

```
src/app/          app.ts (main orchestration, ~1660 lines), main.ts (mount)
src/adapters/     types.ts (DocView/Surface/Adapter iface), index.ts (pickAdapter),
                  pdf.ts, image.ts, markdown.ts, json.ts
src/overlay/      overlay.ts (marks: draw, paint, reveal, owner menus)
src/segment/      detect.ts (layout-based detection), layout.ts (bitmap/band/otsu)
src/selection/    textSelection.ts (DOM selection → normalized hulls)
src/store/        schema.ts (types, outline tree, ownership, migration),
                  sidecar.ts (read/write .ihobs JSON), review.ts (per-document
                  SRS state, .ihobs/review/*.json), prefs.ts, kv.ts
src/srs/          algorithm.ts (contract), registry.ts (id → algorithm seam),
                  fsrs.ts (ts-fsrs adapter), review.ts (applyReview, previews),
                  queue.ts (buildQueue, deck counts), workload.ts, format.ts,
                  status.ts, row.ts, grade.ts, index.ts (barrel)
src/notes/        render.ts (markdown → sanitized HTML + wikilinks)
src/ui/           toolbar, explorer, home, vaultHub, palette, outline,
                  segmentDraw, segmentLayer, notesPanel, notePopover,
                  player, contextMenu, zoom, styles.css
src/vault/        fs.ts (FileSystem API helpers), tree.ts (walk + type predicates),
                  types.ts (path helpers)
src/host/         idb.ts (vault handle registry), dom.d.ts (extra DOM typings)
build/            pwa.ts (web app manifest, generated icons, service worker)
```

## 7. Persistence & storage

- **Annotations**: `.ihobs/<path with / → __>.json` inside the vault
  (`src/store/sidecar.ts`). One file per document. `SidecarStore` caches in
  memory and writes the whole model atomically per save.
  - `saveEntities`, `saveNotes`, `saveRule` each merge into the existing
    model and rewrite version 6. `saveEntities` writes the whole entity array
    (boxes, anchors and marks together), so there is a single writer.
- **Review state**: `.ihobs/review/<path with / → __>.json` — one file per
  document, keyed by mark id, written only by `ReviewStore` (§3b). A document
  whose last row is dropped removes its file.
- **Prefs / theme / scroll / recents**: `localStorage` (or
  `chrome.storage.local` if present) via `src/store/kv.ts`.
  Per-vault pref keys: `ihobs:prefs:<vaultId>`.
- **Vault handles / current vault**: IndexedDB (`src/host/idb.ts`).
- **Offline shell**: a service worker precaches `index.html`, `assets/*` and the
  pdf worker into a cache named for a hash of their contents. The app reads its
  vault from disk handles and fetches nothing at runtime, so a cached shell plus
  a granted handle is a fully offline session. Two consequences worth knowing:
  - Nothing is cached in dev — the worker would shadow HMR — so the offline path
    is only observable through `npm run build && npx vite preview`.
  - `chrome-extension://` pages cannot register a worker, so the extension build
    gets its offline behaviour from being local, not from this cache.

## 8. Adapters (how documents load)

`pickAdapter(path)` picks the first adapter whose `matches(path)` is true, in
order: image, pdf, markdown, json. `registerAdapter()` unshifts — the extension
point for new formats.

Each adapter returns a `DocView` with `surfaces`. Optional capabilities gate UI:
`setZoom/getZoom`, `getPageImages` (required for segmentation and play mode),
`pageCount/currentPage/goToPage/onPageChange`, `setTextDebug`. Markdown and JSON
are excluded from overlay/box features (JSON is view-only; overlay skipped
for `kind === "json"`).

## 9. Conventions & invariants

- **No framework**: UI is imperative DOM construction in class-based
  components with handler interfaces (`XxxHandlers` / `XxxOptions`).
- **Normalized coordinates** everywhere; convert to pixels only at paint time
  using the surface's `clientWidth/clientHeight`.
- **Non-destructive ownership**: loading a document never rewrites explicit
  owner intent; only split/auto-segment re-home marks.
- **Comments explain "why", not "what"** — the codebase favors dense rationale
  comments on non-obvious decisions (e.g. binary search over getBoundingClientRect,
  instant scrollIntoView to avoid rasterizing flown-past pages).
- **Deletion cascades**: deleting a box deletes its notes and returns its
  marks to page scope; deleting an anchor deletes its notes.
- Types are strict-ish; `npm run typecheck` = `tsc --noEmit` and is part of
  `npm run build`.

## 10. Scripts

```
npm run dev        # vite dev server
npm run build      # tsc --noEmit && vite build
npm run typecheck  # tsc --noEmit
```

The web app is installable (PWA). `vite build` also emits `webmanifest.json`,
`sw.js` and `icons/`; install and offline behaviour can only be exercised against
a served build (`npx vite preview`), never the dev server.

## 11. Schema version history

- **v6 (current):** two generic entities (`Box`, `Mark`) in one `entities[]`
  array; feature meaning in `tags`; anchor = a `Box` tagged `"anchor"`; optional
  `card` property on a mark for flashcards. See `docs/schema-v6.md` for the full
  design and `docs/schema-v6-plan.md` for how it was implemented.
- **v5 and earlier:** three primitives (`Segment`, `Marker`, `Region`), migrated
  automatically by `migrate()`.

## 12. Known scope / limitations

- Auto-segment and play mode currently **PDF-only** (`getPageImages`).
- Outline only makes sense for paged surfaces (pdf/image); notes work for all
  kinds; JSON is read-only.
- Auto-segment rules are tuned for numbered MCQ-style layouts (`DEFAULT_RULES`);
  splitting manually is the fallback.
- No OCR in-house — relies on the PDF already having a text layer for
  selection-based marks.
- The installed web app is **desktop Chromium only**. Safari and Firefox have no
  File System Access API, so `showDirectoryPicker` is absent and no vault can be
  opened there; the extension is the fallback on those browsers. Whether a
  directory handle survives a cold start also varies by platform and by whether
  the user chose "Allow on every visit" — the hub's permission re-request flow
  is the answer when it does not, and it works offline.
- Folder names like `hoguth` in prompts are typos for "thought" — this doc is the
  source of truth for intent.
