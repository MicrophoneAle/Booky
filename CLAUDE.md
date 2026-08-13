# Project Context & AI Guidelines (`claude.md`)

## 1. Project Overview & Tech Stack

- **Core Mission:** Booky ingests PDF ebooks and reconstructs them into a paginated, chapter-aware reading experience in the browser - adjustable typography, progress tracking, table of contents, and optional reformatted exports. Live: [booky-lemon.vercel.app](https://booky-lemon.vercel.app).

- **Stack:**
  - **Client:** React 19, Vite 8, React Router 7, client-side pagination (`client/src/utils/paginator.js`)
  - **Server:** Node.js 20+, Express 5, `pdfjs-dist` (text + image extraction), Tesseract.js (chapter-header OCR), PDFKit (reformatted export)
  - **Auth:** Clerk (`@clerk/express` server, `@clerk/clerk-react` client)
  - **Storage:** Supabase Postgres (`documents` table) + object storage (`book-assets` / `pdfs` buckets)
  - **Deploy:** Vercel (client), Render (API)

- **Architectural Patterns:**
  - **Monolithic parse pipeline** on the server (`server/index.js`, ~12.3K lines) - extract, block-build, transform, illustrate/OCR, chapter-detect, persist
  - **SPA routes:** `/` upload, `/library`, `/read/:id` reader
  - **Versioned invalidation:** `PARSER_VERSION` (server + client, must match) forces re-parse and pagination cache bust
  - **Specialized modules** for Stormlight/illustrated books: `chapterGraphicService.js`, `stormlightEpigraphService.js`, `printedTocService.js`, `imageOcrService.js`
  - **Regression harness** (`server/scripts/regression/`) - not unit tests; snapshot + structural checks on real PDFs (13 books by default, 14 with `--full`)

---

## 2. Codebase Structure & Key Files

```
Booky/
├── client/
│   ├── src/
│   │   ├── components/BookViewer.jsx   # Reader UI, pagination, TOC assembly (~5.9K lines)
│   │   ├── utils/paginator.js          # Page measurement, chapter page map, image TOC extraction
│   │   ├── utils/bookCache.js          # Pagination cache (localStorage + IndexedDB)
│   │   ├── pages/                      # Home (upload), Library, Reader
│   │   └── assets/                     # 14 test PDFs (also used by regression/debug scripts)
│   └── vercel.json
├── server/
│   ├── index.js                        # API + entire PDF parse pipeline (critical)
│   ├── chapterGraphicService.js        # Image role / chapter-banner classification
│   ├── stormlightEpigraphService.js    # Printed-TOC cursor, part dividers, OCR re-anchor
│   ├── printedTocService.js            # Extract printed TOC from PDF lines
│   ├── imageOcrService.js              # Tesseract OCR for chapter-header artwork
│   ├── pdfImageRoleUtils.js            # Image geometry constants and helpers
│   ├── reformattedExportService.js     # HTML/PDF export path (separate from reader parse)
│   └── scripts/
│       ├── regression/                 # `npm run regression` (13) / `regression:full` (14); 12 general checks
│       ├── debug-*.mjs                 # Ad-hoc book-specific diagnostics (~40 scripts)
│       └── test-*.mjs, verify-*.mjs    # More ad-hoc diagnostics (not debug-* prefixed)
├── supabase/migrations/                # parser_version, parse_status, parse_progress, parsed_cache
└── README.md
```

**Crucial files:**

| File | Role |
|------|------|
| `server/index.js` | Express API, `parsePdfBuffer`, block pipeline, `finalizeIllustrationBlocks`, `detectChapters`, `PARSER_VERSION`. **Any parser change starts here.** |
| `client/src/components/BookViewer.jsx` | Reader, `tocEntries` assembly, `PAGINATION_MEASUREMENT_VERSION`, layout measurement. **Client TOC bugs live here.** |
| `client/src/utils/paginator.js` | `buildChapterPageMap`, `extractImageChapterTocEntries`, pagination measurement. |
| `server/chapterGraphicService.js` | `analyzeChapterGraphicFromContext` - decides if an image is a chapter banner vs illustration. |
| `server/stormlightEpigraphService.js` | Printed-TOC sequential cursor, `isLikelyStructuralPartDividerPlate`, part-divider cursor helpers. |
| `server/printedTocService.js` | Builds `printedToc.ordered` (chapters, parts, interludes, prelude, etc.). |
| `server/imageOcrService.js` | Single shared Tesseract worker; OCR is a major parse-time bottleneck. |
| `server/scripts/regression/run.mjs` | Regression entry point; CORE+EXTENDED by default, SLOW (WoK) via `--full`; snapshots committed under `snapshots/`. |

**Version constants (keep in sync when bumping):**

| Constant | Location | Current | When to bump |
|----------|----------|---------|--------------|
| `PARSER_VERSION` | `server/index.js` + `client/.../BookViewer.jsx` (**both**) | Read from those files - do not trust a hardcoded doc number | Any server parser output change |
| `PAGINATION_MEASUREMENT_VERSION` | `client/.../BookViewer.jsx` only | Read from `BookViewer.jsx` | Client pagination/measurement logic only |

Bump `PARSER_VERSION` in **both** files together. A bump invalidates parsed document caches and forces a from-scratch re-parse. Mismatching the two copies is a recurring footgun.

---

## 3. Constraints & "Don't Touch" Zones

**Frozen / high-risk:**

- **Do not alter Supabase migrations in place** - add new migrations only (`supabase/migrations/`).
- **Do not widen global chapter-arch geometry thresholds** in `chapterGraphicService.js` / `pdfImageRoleUtils.js` without regression on WoK, Treasure Island, Oliver Twist - phantom chapters are the usual failure mode.
- **Do not promote portrait illustration plates to chapter banners** - WoK ch69/ch70 openers (p1051/p1073) are plain art; both chapters have real arch banners (p1052/p1074). Keep `NON_CHAPTER_CAPTION_PATTERNS` / `MAP_OR_DIVIDER_TEXT_PATTERNS` start-anchored and caption-length-gated - unanchored substring matching against nearby prose is what suppressed the ch70 arch through v115.
- **Do not force-push** `main`; do not skip git hooks unless explicitly requested.
- **Do not commit** `.env`, secrets, or large log dumps (`wok-*.log`, `wok-*.txt`, `toc-verify.log`, `*-debug.json` under `server/scripts/`).

**Parser change protocol:**

1. Minimal scoped diff - match surrounding naming, imports, comment style.
2. Bump `PARSER_VERSION` in **both** `server/index.js` and `client/src/components/BookViewer.jsx`.
3. Run `cd server; npm run regression` (and `npm run regression:full` or book-specific debug scripts for illustrated titles).
4. If output intentionally changed, refresh committed snapshots with `npm run regression:update` and include them in the same change.
5. For illustrated books: verify chapter count, TOC order, no phantom image boundaries.

**Style / lint:**

- ESM throughout (`"type": "module"`).
- Prefer extending existing helpers over new abstractions.
- Comments only for non-obvious business logic (printed-TOC cursor rules, geometry carve-outs).
- Use hyphens in user-facing strings, not em dashes.
- Client has ESLint; server does not - follow `index.js` conventions manually.
- **Only commit when explicitly asked.**

**Debug flags (never leave enabled in production):**

`BOOKY_FRONTMATTER_DEBUG`, `BOOKY_CHAPTER_GRAPHIC_DEBUG`, `BOOKY_TOC_ORDER_DEBUG`, `BOOKY_TOC_MISS_DEBUG`, `BOOKY_HEADING_DEBUG`, `BOOKY_SUBTITLE_DEBUG`, `BOOKY_BB_DEBUG`, `BOOKY_OCR_DEBUG`

**Ops / concurrency env (not debug logging):**

`BOOKY_REPARSE_ON_BOOT`, `BOOKY_TEXT_EXTRACTION_CONCURRENCY`, `BOOKY_IMAGE_EXTRACTION_CONCURRENCY`

---

## 4. Known Roadblocks & Historical Pitfalls

### Way of Kings (Stormlight) - highest complexity

- **Ch69 "Justice" / Ch70 "Sea Of Glass"** - corrected in v116. The v115 "bannerless ch69" model was WRONG: ch69 has a real arch banner (p1052, followed by the Tanatanev death-rattle epigraph + Navani warcamp prose) and ch70 has one too (p1074, followed by Shallan's hospital-room prose and the Shadesmar beads scene). Through v115 the p1074 arch was silently suppressed because unanchored `/sketchbook/i` in `isMapOrGalleryIllustration`'s +-1-page scan matched ordinary narration on p1075 ("...a blank page in her sketchbook"), and `bannerlessReconcile` then papered over the missing slot by skipping ch69 + Part Five at the cursor, mislabeling p1052 as ch70 (both TOC entries navigated to Justice; Sea Of Glass was unreachable). v116 removed `bannerlessReconcile`/`bannerlessChapterAfter` entirely, start-anchored all caption patterns, and added a caption line-length gate. Both plates (p1051, p1073) stay plain illustrations. Verify this region with content evidence (Navani/Shallan/Jasnah name counts between arches), never with title greps - contiguous numbering does NOT prove correct anchoring.
- **False part-divider match on p1051** historically skipped printed-TOC slots and shifted the tail; the portrait-band carve-out in `isLikelyStructuralPartDividerPlate` prevents this - do not remove it.
- **Parts Four/Five** exist in printed-TOC cursor but are **absent from reader TOC** by design (no text headings, filtered from image boundaries). Separate future work.
- **WoK is opt-in** via `npm run regression:full` / `--book=way-of-kings` (not in the default 13-book `npm run regression`). Ad-hoc scripts remain useful (`verify-wok-ch68-72.mjs`, `verify-wok-ch9-12.mjs`, `verify-wok-part5.mjs`, `debug-parse-wok.mjs`, `test-wok-graphic-fixes.mjs`, `server/scripts/_toc-verify.mjs`). Easy to regress if you only run the default suite.
- Do not re-commit WoK debug dumps under `server/` or `server/scripts/` - they encode pre-v116 cursor behavior.
- The TEMPORARY ch69 diagnostics (`[tocOrderedDump]`, `[regionDump]`, `[cursorTrace]`, `[tocReanchor]`, `[portraitBandScan]`, Step-A dumps) were removed in the cleanup pass; `[bannerlessReconcile]` went with the mechanism in v116. The load-bearing operational logs (`[partCursor]`, `[boundarySummary]`, `[chapterAssign]`, and `printed_toc_banner_slot_rejected` which names the sub-gate on every rejected banner slot) remain behind their debug flags.

### Parse performance

- **`withPdfDocumentAccessLock`** serializes all pdfjs page access per document - env concurrency vars do not parallelize PDF I/O.
- **Two-pass image extraction** - metadata pass then sequential `resolvePageImageCandidateBuffers`.
- **Sequential OCR** in `finalizeIllustrationBlocks` with a single Tesseract worker - dominant cost for illustrated books (~90-150s for WoK).
- WoK hits size tier: text/image concurrency forced to **1/1**.
- `parsed_cache` DB column is always written `null` - no server parse cache benefit today.
- **Render free-tier RAM (~512MB)** shapes `resolvePdfExtractionConcurrency` - high parallel pdfjs work OOMs or hangs on large illustrated books. Prefer memory-safe designs over local-CPU max throughput.

### Parser correctness (other books)

- **Monte Cristo** - long prose lines misclassified as headings; blocking checks may still fail.
- **Moby Dick** - regression **skips** `indentationConsistency` and `headingDensitySane` - can pass those while still having other debt (e.g. dialogue-split warnings/failures).
- **Treasure Island** - part titles, drop-caps, image boundaries (many debug scripts).
- **Oliver Twist** - drop-cap fused subtitles, truncated chapter titles.
- **Aesop's Fables** - poetry collection / story-title paths.
- **1984** - embedded Goldstein roman chapters must stay as body text, not TOC entries.

### Known open / accepted state

- **Maya Angelou - "On the Pulse of Morning":** no title in the PDF text layer at the poem opening; harness marks `[KNOWN GAP]` and deliberately fails that assertion rather than inventing a synthetic boundary.
- **Maya Angelou - "Shaker, Why Don't You Sing?":** collection/section title promoted as a chapter in current output (present in the committed snapshot; not a printed Contents poem in `_maya-titles.mjs`). Accepted extra for now - do not "fix" by deleting it without a dedicated poetry-TOC pass.
- **Deferred prose-reflow review:** `endsWithSentenceTerminator` (multi-closer after `[.!?]`) is wired only into the heading-continuation gate. Widening the same test inside `isProseLineContinuation` / dialogue-split / extract-merge moved block boundaries on most sample books; those consumers stay on the legacy single-closer pattern until a dedicated reflow review. Related dialogue-split debt across several prose books is likely the same underlying issue.

### Client TOC assembly (`BookViewer.jsx`)

- When `imageEntries.length >= 10`, `useImageChapterToc` uses **image banners only** for chapters plus text *sections* (prelude, parts, etc.). `unmatchedTextChapterEntries` additively covers text chapters with no matching banner - as of v116 no WoK chapter depends on it (all 75 have banners), but keep it for genuinely bannerless books.
- `chapterPageMap` maps chapters via `isChapterBoundary` visual items - a chapter entry without its own measured page borrows the next banner's page for display.

### TOC cursor / sequential assignment

- `tocOrderCursor` state in `finalizeIllustrationBlocks` is order-dependent - parallelizing OCR without ordered merge will break chapter numbering.
- `boundaryDedupeKey` collisions drop boundaries to `SAFE_FALLBACK` and rewind cursor - watch for duplicate chapter numbers in logs.
- `readingOrderPageIndex`/`readingOrderBlockIndex` (`server/index.js`, used by `sortChaptersByReadingOrder`) fall back to `Number.MAX_SAFE_INTEGER` when a chapter's `pageIndex`/`blockIndex` is missing/non-finite - an entry with no finite position sorts to the **end** of the TOC rather than clustering at the top or throwing. A chapter silently landing last in the TOC is a symptom of a missing `pageIndex`/`blockIndex` upstream, not a sort bug.
- `chapterTitlesReferToSameChapter` dedupes by chapter **number**, not exact title string.

### Caching / stale data

- Documents parsed before current `PARSER_VERSION` need re-parse (`documentNeedsReparse`, `BOOKY_REPARSE_ON_BOOT`, admin reparse).
- Client pagination cache keyed on `parserVersion` + `PAGINATION_MEASUREMENT_VERSION` - parser bump alone invalidates; client-only TOC fixes may need hard refresh.

### Repo hygiene debt

- Many ad-hoc scripts under `server/scripts/` (~40 `debug-*.mjs` plus `test-*`/`verify-*`/misc). Prefer the regression harness for parity; keep ad-hoc scripts only when they probe regions the harness does not cover.

---

## 5. Token Efficiency & Output Protocols (Strict)

- **Code modifications:** Targeted snippets or focused diffs. Do not dump entire `index.js` or `BookViewer.jsx` unless explicitly requested as complete drop-in functions.
- **Exclusions:** Do not read or analyze `client/src/assets/*.pdf`, `*.log`, `wok-*.txt`, `eng.traineddata`, `node_modules/`, build output, or minified bundles.
- **Brevity:** Skip conversational filler and long post-code narration. State what changed, why, and how to verify.
- **Investigation:** Use `grep`/`glob` before reading multi-thousand-line files; read only the relevant function regions.
- **Ground-truth convention (harness):** Book-specific assertions must come from the edition's printed TOC (raw pdfjs/`pdftotext`) or a reliable external source - never from current parser output (self-derived expectations hide truncation).
- **Verification commands:**
  ```bash
  cd server; npm run regression
  cd server; npm run regression -- --book=orwell1984
  cd server; npm run regression:full
  cd server; npm run test:assets
  cd server; node scripts/debug-parse-wok.mjs
  ```
- **Default regression (13):** `oldman`, `orwell1984`, `monte-cristo`, `pride-prejudice`, `moby-dick`, `treasure-island`, `frankenstein`, `oliver-twist`, `jungle-book`, `aesop`, `metamorphosis`, `narnia`, `maya-angelou`.
- **Opt-in (`regression:full`):** also `way-of-kings`.
- **General checks:** 12 in `server/scripts/regression/checks.mjs` (see regression README for blocking vs advisory).
- **Snapshots:** committed under `server/scripts/regression/snapshots/` (refreshed with `npm run regression:update` when output intentionally changes).
