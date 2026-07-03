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
  - **Monolithic parse pipeline** on the server (`server/index.js`, ~12.8K lines) - extract, block-build, transform, illustrate/OCR, chapter-detect, persist
  - **SPA routes:** `/` upload, `/library`, `/read/:id` reader
  - **Versioned invalidation:** `PARSER_VERSION` (server + client) forces re-parse and pagination cache bust
  - **Specialized modules** for Stormlight/illustrated books: `chapterGraphicService.js`, `stormlightEpigraphService.js`, `printedTocService.js`, `imageOcrService.js`
  - **Regression harness** (`server/scripts/regression/`) - not unit tests; snapshot + structural checks on real PDFs

---

## 2. Codebase Structure & Key Files

```
Booky/
├── client/
│   ├── src/
│   │   ├── components/BookViewer.jsx   # Reader UI, pagination, TOC assembly (~6.8K lines)
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
│       ├── regression/                 # `npm run regression` - 5 books, 10 general checks
│       ├── debug-*.mjs                 # Ad-hoc book-specific diagnostics (39 scripts)
│       ├── test-*.mjs, verify-*.mjs    # More ad-hoc diagnostics (~20 more scripts, not debug-* prefixed)
│       └── .index-backup.js            # STALE - do not edit or import
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
| `server/stormlightEpigraphService.js` | Printed-TOC sequential cursor, `isLikelyStructuralPartDividerPlate`, bannerless reconciliation helpers. |
| `server/printedTocService.js` | Builds `printedToc.ordered` (chapters, parts, interludes, prelude, etc.). |
| `server/imageOcrService.js` | Single shared Tesseract worker; OCR is a major parse-time bottleneck. |
| `server/scripts/regression/run.mjs` | Regression entry point; 5 books in harness, snapshots gitignored. |

**Version constants (keep in sync when bumping):**

| Constant | Location | Current | When to bump |
|----------|----------|---------|--------------|
| `PARSER_VERSION` | `server/index.js` + `client/.../BookViewer.jsx` | **115** | Any server parser output change |
| `PAGINATION_MEASUREMENT_VERSION` | `client/.../BookViewer.jsx` only | **24** | Client pagination/measurement logic only |

---

## 3. Constraints & "Don't Touch" Zones

**Frozen / high-risk:**

- **Do not alter Supabase migrations in place** - add new migrations only (`supabase/migrations/`).
- **Do not widen global chapter-arch geometry thresholds** in `chapterGraphicService.js` / `pdfImageRoleUtils.js` without regression on WoK, Treasure Island, Oliver Twist - phantom chapters are the usual failure mode.
- **Do not promote portrait illustration plates to chapter banners** to fix WoK ch69 - use printed-TOC cursor reconciliation (`bannerlessChapterAfter`) instead.
- **Do not edit** `server/scripts/.index-backup.js` or `.index-054fc07.js` - orphaned snapshots at PARSER_VERSION 97-100.
- **Do not force-push** `main`; do not skip git hooks unless explicitly requested.
- **Do not commit** `.env`, secrets, or large log dumps (`wok-*.log`, `toc-verify.log`).

**Parser change protocol:**

1. Minimal scoped diff - match surrounding naming, imports, comment style.
2. Bump `PARSER_VERSION` in **both** `server/index.js` and `client/src/components/BookViewer.jsx`.
3. Run `cd server && npm run regression` (and book-specific debug scripts for affected titles).
4. For illustrated books: verify chapter count, TOC order, no phantom image boundaries.

**Style / lint:**

- ESM throughout (`"type": "module"`).
- Prefer extending existing helpers over new abstractions.
- Comments only for non-obvious business logic (printed-TOC cursor rules, geometry carve-outs).
- Use hyphens in user-facing strings, not em dashes.
- Client has ESLint; server does not - follow `index.js` conventions manually.
- **Only commit when explicitly asked.**

**Debug flags (never leave enabled in production):**

`BOOKY_FRONTMATTER_DEBUG`, `BOOKY_CHAPTER_GRAPHIC_DEBUG`, `BOOKY_TOC_ORDER_DEBUG`, `BOOKY_TOC_MISS_DEBUG`, `BOOKY_HEADING_DEBUG`, `BOOKY_SUBTITLE_DEBUG`, `BOOKY_BB_DEBUG`

---

## 4. Known Roadblocks & Historical Pitfalls

### Way of Kings (Stormlight) - highest complexity

- **Ch69 "Justice" / Ch70 "Sea Of Glass"** - ch69 has no arch banner; opener is a portrait illustration (p1051). Fixed in v115 via: (1) exclude portrait band from `isLikelyStructuralPartDividerPlate`, (2) `bannerlessReconcile` advances printed-TOC cursor past ch69 + Part Five, (3) `bannerlessChapterAfter` surfaces ch69 in server `chapters[]`, (4) client `unmatchedTextChapterEntries` adds bannerless text chapters when `useImageChapterToc` (>=10 image banners).
- **False part-divider match on p1051** historically skipped slots 83-84 and mislabeled p1052 as ch69 - do not reintroduce.
- **Parts Four/Five** exist in printed-TOC cursor but are **absent from reader TOC** by design (no text headings, filtered from image boundaries). Separate future work.
- **WoK is NOT in `npm run regression`** - only ad-hoc scripts (`verify-wok-ch68-72.mjs`, `verify-wok-ch9-12.mjs`, `verify-wok-part5.mjs`, `debug-parse-wok.mjs`, `test-wok-graphic-fixes.mjs`, `server/scripts/_toc-verify.mjs`). Easy to regress silently.
- Stale artifacts (`wok-ch68-72-debug.json`, old logs) show pre-fix behavior - ignore them.
- `chapterGraphicService.js` has a `logPortraitOpenerBandDiagnostic` ("Step-A diagnostic", `[portraitBandScan]` logs) gated on `BOOKY_CHAPTER_GRAPHIC_DEBUG`, added while chasing ch69 - commented `// Remove in the cleanup commit`, still present.

### Parse performance

- **`withPdfDocumentAccessLock`** serializes all pdfjs page access per document - env concurrency vars do not parallelize PDF I/O.
- **Two-pass image extraction** - metadata pass then sequential `resolvePageImageCandidateBuffers`.
- **Sequential OCR** in `finalizeIllustrationBlocks` with a single Tesseract worker - dominant cost for illustrated books (~90-150s for WoK).
- WoK hits size tier: text/image concurrency forced to **1/1**.
- `parsed_cache` DB column is always written `null` - no server parse cache benefit today.

### Parser correctness (other books)

- **Monte Cristo** - long prose lines misclassified as headings; blocking checks may still fail.
- **Moby Dick** - regression **skips** `noMidSentenceHeadings` and `headingDensitySane` - can pass while broken.
- **Treasure Island** - part titles, drop-caps, image boundaries (14+ debug scripts).
- **Oliver Twist** - drop-cap fused subtitles, truncated chapter titles.
- **Aesop's Fables** - poetry collection / story-title paths.
- **1984** - embedded Goldstein roman chapters must stay as body text, not TOC entries.

### Client TOC assembly (`BookViewer.jsx`)

- When `imageEntries.length >= 10`, `useImageChapterToc` uses **image banners only** for chapters plus text *sections* (prelude, parts, etc.). Bannerless chapters need `unmatchedTextChapterEntries` - without it they vanish from rendered TOC even if present in `bookDocument.chapters`.
- `chapterPageMap` maps chapters via `isChapterBoundary` visual items - bannerless ch69 may lack its own measured page and borrow the next banner's page for display.

### TOC cursor / sequential assignment

- `tocOrderCursor` state in `finalizeIllustrationBlocks` is order-dependent - parallelizing OCR without ordered merge will break chapter numbering.
- `boundaryDedupeKey` collisions drop boundaries to `SAFE_FALLBACK` and rewind cursor - watch for duplicate chapter numbers in logs.
- `readingOrderPageIndex`/`readingOrderBlockIndex` (`server/index.js`, used by `sortChaptersByReadingOrder`) fall back to `Number.MAX_SAFE_INTEGER` when a chapter's `pageIndex`/`blockIndex` is missing/non-finite - an entry with no finite position sorts to the **end** of the TOC rather than clustering at the top or throwing. A chapter silently landing last in the TOC is a symptom of a missing `pageIndex`/`blockIndex` upstream, not a sort bug.
- `chapterTitlesReferToSameChapter` dedupes by chapter **number**, not exact title string.

### Caching / stale data

- Documents parsed before current `PARSER_VERSION` need re-parse (`documentNeedsReparse`, `BOOKY_REPARSE_ON_BOOT`, admin reparse).
- Client pagination cache keyed on `parserVersion` + `PAGINATION_MEASUREMENT_VERSION` - parser bump alone invalidates; client-only TOC fixes may need hard refresh.

### Repo hygiene debt

- README still says PARSER_VERSION 89 (actual: 115).
- ~60 ad-hoc scripts under `server/scripts/` (39 `debug-*.mjs` plus `test-*`/`verify-*`/misc), committed log files (`server/*.log`, e.g. `wok-cursor.log`, `wok-stepA.log`, `toc-verify.log` - these violate the "don't commit log dumps" rule in §3 but are already in the repo), TEMPORARY diagnostics marked "Remove in cleanup" in both `finalizeIllustrationBlocks` (`server/index.js`) and `chapterGraphicService.js` (`logPortraitOpenerBandDiagnostic`).
- `visionService.js` deprecated/unused; `client/src/lib/supabase.js` unused; root `package.json` `canvas` dep unused.

---

## 5. Token Efficiency & Output Protocols (Strict)

- **Code modifications:** Targeted snippets or focused diffs. Do not dump entire `index.js` or `BookViewer.jsx` unless explicitly requested as complete drop-in functions.
- **Exclusions:** Do not read or analyze `client/src/assets/*.pdf`, `server/scripts/.index-backup.js`, `server/scripts/.index-054fc07.js`, `*.log`, `wok-*.txt`, `eng.traineddata`, `node_modules/`, build output, or minified bundles.
- **Brevity:** Skip conversational filler and long post-code narration. State what changed, why, and how to verify.
- **Investigation:** Use `grep`/`glob` before reading multi-thousand-line files; read only the relevant function regions.
- **Verification commands:**
  ```bash
  cd server && npm run regression
  cd server && npm run regression -- --book=orwell1984
  cd server && node scripts/debug-parse-wok.mjs
  cd server && node scripts/test-all-assets.mjs
  ```
- **Regression books in harness:** `oldman`, `orwell1984`, `monte-cristo`, `pride-prejudice`, `moby-dick` (PDFs in `client/src/assets/`).
- **Test PDFs NOT in harness:** WoK, Treasure Island, Oliver Twist, Aesop's Fables, Frankenstein, Jungle Book, Narnia, Metamorphosis, Maya Angelou.
