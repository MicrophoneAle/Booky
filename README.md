# Booky

Booky turns PDF ebooks into a clean, chapter-aware reading experience in the browser. Upload a PDF; Booky extracts text and illustrations, detects chapters, and lays out paginated pages tuned for comfortable reading — with adjustable typography, progress tracking, a table of contents, and optional reformatted exports.

**Live app:** [booky-lemon.vercel.app](https://booky-lemon.vercel.app)

---

## What Booky does

1. **Upload** a PDF (Clerk-authenticated).
2. **Parse** it on the server into a structured block stream (prose, headings, images, chapter metadata).
3. **Store** document metadata and content in Supabase Postgres; store original PDFs and extracted artwork in object storage.
4. **Paginate** on the client for the reader's viewport, font, and line settings.
5. **Read** with TOC navigation, progress, typography controls, fullscreen, and optional HTML/PDF export of a reformatted edition.

Booky is not a PDF renderer that paints the original page bitmap. It rebuilds a reading layout from extracted content so type size, margins, and page breaks can adapt to the device.

---

## Features

| Area | Details |
|------|---------|
| Upload & library | Authenticated upload, document list, rename, delete, download original PDF |
| Reader | Single-page / spread view, chapter TOC, progress, font family/size, margins, themes |
| Chapter detection | Text headings, roman/arabic numbering, parts/volumes, poetry titles, fable story titles |
| Illustrated books | Image role classification, optional OCR of chapter plaques, printed-TOC alignment (e.g. Stormlight) |
| Caching | Client pagination cache keyed on parser + measurement versions; server `parser_version` forces re-parse |
| Export | Reformatted HTML/PDF download from parsed content |
| Ops | Parse progress API, admin reparse, optional reparse-on-boot for outdated documents |

---

## Stack

| Layer | Tech |
|-------|------|
| Client | React 19, Vite 8, React Router 7, client-side pagination (`paginator.js`) |
| Server | Node.js 20+, Express 5, `pdfjs-dist`, Tesseract.js (chapter-header OCR), PDFKit (export) |
| Auth | Clerk (`@clerk/express` server, `@clerk/clerk-react` client) |
| Storage | Supabase Postgres (`documents`) + object storage (`book-assets` / `pdfs` buckets) |
| Deploy | Vercel (client), Render (API) |

---

## Architecture overview

```
┌─────────────┐     upload / fetch      ┌──────────────────┐
│  React SPA  │ ◄──────────────────────► │  Express API     │
│  BookViewer │   chapters + content     │  parsePdfBuffer  │
│  paginator  │                          │  OCR + images    │
└─────────────┘                          └────────┬─────────┘
                                                  │
                                    ┌─────────────┼─────────────┐
                                    ▼             ▼             ▼
                              Supabase DB   PDF bucket    book-assets
                              documents     originals     illustrations
```

**SPA routes**

| Path | Purpose |
|------|---------|
| `/` | Upload a PDF |
| `/library` | Saved books |
| `/read/:id` | Paginated reader |

**Version constants** (keep in sync when changing behavior)

| Constant | Location | Role |
|----------|----------|------|
| `PARSER_VERSION` | `server/index.js` **and** `client/.../BookViewer.jsx` | Any change to server parse output. Currently **119**. |
| `PAGINATION_MEASUREMENT_VERSION` | `client/.../BookViewer.jsx` only | Client layout/measurement logic only. Currently **24**. |

Bump `PARSER_VERSION` on both sides whenever parsed blocks, chapter metadata, or TOC-related server output changes. Bump only the measurement version when pagination packing changes but stored documents stay valid.

---

## Project layout

```
Booky/
├── client/
│   ├── src/
│   │   ├── components/BookViewer.jsx   # Reader UI, TOC assembly, layout measurement
│   │   ├── utils/paginator.js          # Page measurement, chapter page map, image TOC
│   │   ├── utils/bookCache.js          # Pagination cache (localStorage + IndexedDB)
│   │   ├── pages/                      # Home, Library, Reader
│   │   └── assets/                     # Test PDFs (regression + debug scripts)
│   └── vercel.json
├── server/
│   ├── index.js                        # API + full PDF parse pipeline
│   ├── chapterGraphicService.js        # Image role → chapter banner vs illustration
│   ├── stormlightEpigraphService.js    # Printed-TOC cursor, part dividers, OCR re-anchor
│   ├── printedTocService.js            # Extract printed TOC from PDF lines
│   ├── imageOcrService.js              # Shared Tesseract worker for chapter plaques
│   ├── pdfImageRoleUtils.js            # Geometry helpers for arches / full-page art
│   ├── reformattedExportService.js     # HTML/PDF export from parsed content
│   └── scripts/
│       └── regression/                 # Snapshot + structural checks on real PDFs
├── supabase/migrations/                # parser_version, parse_status, parse_progress, …
└── README.md
```

---

## How the parser works

The entire parse path lives primarily in `server/index.js` (`parsePdfBuffer`), with specialized modules for printed TOCs, illustration roles, OCR, and Stormlight-style cursor assignment. The output is a linear **block stream** later chunked into `content` pages for storage, then reflowed by the client.

### End-to-end pipeline

```
PDF bytes
  → load + extract text lines & image candidates (pdfjs)
  → filter running headers / page numbers / watermarks
  → extract printed TOC (if present)
  → build text blocks (prose vs headings) OR poetry verse path
  → transform pipeline (merge titles/subtitles, promote sections, …)
  → strip catalog / front-matter noise; normalize matter regions
  → interleave image candidates into reading order
  → classify illustrations (+ OCR plaques) → chapter boundaries
  → upload artwork; strip binaries from blocks
  → detectChapters → chapters[] + chapterId on every block
  → persist to Supabase
```

### Phase 1 — Extract (`extractPdfStructure`)

1. Open the PDF with `pdfjs-dist` (and build a PUA → Unicode replacement map for private-use glyph fonts).
2. **Text pass:** For each page, extract positioned text lines with font size, bold/italic runs, and centering hints.
3. **Image pass:** Scan operator lists for drawable images; record geometry (`width`/`height` vs page size) as *candidates* without always resolving pixel buffers yet.
4. **Filter:** Drop scanner watermarks, recurring running headers, standalone page numbers (with carve-outs for roman part openers and Saddleback-style numbered story openers), collapsed headers, etc.
5. Resolve image buffers for candidates that survive geometry filters.

Concurrency is size-tiered. Very large illustrated books (e.g. Way of Kings) force text/image concurrency to **1/1** because all pdfjs page access is serialized per document via an access lock.

### Phase 2 — Printed TOC (optional)

`printedTocService` scans early page lines for catalog formats such as:

- `12: JUSTICE`
- `I-3: Interlude title`
- `Prologue: …` / `Epilogue: …` / prelude lines
- Dot-leader chapter listings (Saddleback-style)
- Part / volume section markers

When found, it builds an ordered list (`ordered`) and lookup maps used later so image banners can be numbered and titled from the book's own contents page instead of guessing from OCR alone.

### Phase 3 — Text blocks (`buildBlocksFromLines` or poetry)

Each retained line is classified and folded into blocks:

| Differentiation | Typical outcome |
|-----------------|-----------------|
| Wrapped all-caps display title (fables) | Single chapter-start heading |
| `Chapter N` + following subtitle lines | Compiled multiline chapter heading |
| Standalone roman numeral with following body | Part opener |
| Scene-break ornaments | Centered divider |
| Running heads / page numbers | Dropped |
| Saddleback numbered opener matching printed TOC | Story chapter start |
| Dialogue-heavy short quotes after mid-sentence prose | Split into separate prose blocks later |
| Ordinary body | Paragraph prose (reflowed across soft line wraps) |

Poetry collections take a separate path (`buildPoetryBlocksFromLines`) that preserves line breaks and treats poem titles as chapters, intentionally skipping prose reflow/merge transforms that would destroy verse.

### Phase 4 — Block transform pipeline

For prose books, `applyBlockTransformPipeline` runs a fixed sequence of normalizers, including:

- Split embedded part headings and dialogue-heavy blocks
- Merge multiline chapter / fable titles and chapter + subtitle pairs
- Merge part headings and end-of-part fragments
- Promote structural section headings and fable story titles
- Normalize chapter heading font sizes and centered decorative prose

Then front/back matter cleaners run: publisher catalogs, duplicated title-page noise, printed-TOC block exclusion, Stormlight prelude/prologue text injection when needed.

### Phase 5 — Interleave illustrations

Image candidates are inserted into the block stream near their source page coordinates so reading order matches the PDF. Each candidate carries an **`imageRole`** from geometry (`pdfImageRoleUtils.classifyPdfImageRole`):

| Role | Geometry intent |
|------|-----------------|
| `chapter_heading` | Wide arch / strip banners typical of illustrated chapter openers |
| `full_page_illustration` | Tall plates (~≥58% page height): portraits, maps, sketchbook pages |
| `illustration` | Mid-size inline art that is not a banner |
| *(null / discarded)* | Too small or decorative to keep |

Portrait-tall plates are explicitly **not** treated as chapter arches — a common failure mode for books that mix character art with real arch banners on the next page.

### Phase 6 — Finalize illustrations (`finalizeIllustrationBlocks`)

For each candidate, in document order:

1. **Front-matter gate:** Art at or before the prologue (or prelude) text heading cannot consume chapter slots or advance the printed-TOC cursor.
2. **Skip rules:** End-of-chapter tall art, spread continuations, map/gallery captions, flashbacks, etc. fall back to non-boundary images (`SAFE_FALLBACK`).
3. **OCR (selective):** Tesseract may read stone plaques / divider text when the image looks like a header or section plate and page text is sparse enough. A single shared worker runs OCR sequentially (dominant cost on illustrated books).
4. **Context analysis** (`analyzeChapterGraphicFromContext`): Combines role, nearby captions (start-anchored only — never free substring matches against prose), following epigraph/narrative signals, and OCR.
5. **Printed-TOC sequential cursor:** When a printed TOC exists, accepted chapter banners take the *next* ordered slot (`takeNextSequentialTocEntry…`). Part plates and interlude dividers advance or seek the cursor so numbering stays aligned. Duplicate boundary keys are rejected and rewind the cursor.
6. Emit final `image` blocks with `isChapterBoundary`, `chapterMetadata` (`boundaryKind`, number, title), and storage-ready payloads.

**Boundary kinds the classifier may assign**

| `boundaryKind` | Meaning |
|----------------|---------|
| `chapter` | Numbered chapter banner |
| `interlude` | Interlude (e.g. `I-3`) |
| `interlude_divider` | Name plate that implies upcoming interludes |
| `part` | Part divider plate |
| `prelude` / `prologue` / `epilogue` | Section openers |
| `flashback` | Timestamp headings (usually not TOC chapters) |
| *(null)* | Ordinary illustration |

After classification, binaries may be uploaded to `book-assets` and stripped from the persisted JSON.

### Phase 7 — Chapter list (`detectChapters`)

Walk the block stream again to build `chapters[]` and stamp every block with `chapterId` / `isChapterStart`:

- Text headings that pass `isChapterHeading` (chapter/letter patterns, parts, prelude/prologue/epilogue, fable/poem titles, …)
- Guardrails: embedded roman chapters inside arabic-numbered books (e.g. Goldstein chapters in *1984*) stay body text; book-title reprints are not TOC entries; orphan part labels demoted
- Image boundaries append TOC entries via `appendImageBoundaryChapters`
- Sort the combined list into reading order by `(pageIndex, blockIndex)`

The result stored in Supabase is:

- `chapters` — TOC entries with ids, titles, and stream positions  
- `content` — pages of blocks (text + images) each tagged with chapter membership  
- `parser_version`, `word_count`, `parse_status`, optional `parse_progress`

### Phase 8 — Client reconstruction (not the server parser, but how the “book” is built for reading)

`BookViewer` + `paginator.js`:

1. Flatten stored content into placeable visual items.
2. Measure against the current font/size/margins and pack into reader pages (single or spread).
3. Build a **chapter → reader page** map from measured boundaries.
4. Assemble TOC: when many image chapter banners exist (≥10), prefer image entries for chapters and keep text sections (prelude, parts, …); unmatched text chapters are still added for bannerless books.
5. Cache measurements under `PARSER_VERSION` + `PAGINATION_MEASUREMENT_VERSION`.

---

## Book archetypes the parser specializes for

| Archetype | Strategy highlights |
|-----------|---------------------|
| Plain prose classics | Text chapter/part headings, paragraph reflow, dialogue splits |
| *1984*-style embedded manuals | Arabic outer chapters; inner roman “Chapter I” stays body text |
| Aesop / fable anthologies | Large display titles → story chapters; wrap merge |
| Poetry collections | Verse-preserving path; decorative plates forced full-page |
| Saddleback / numbered short-story books | Printed TOC + numbered openers |
| Heavily illustrated / Stormlight | Geometry roles + OCR + printed-TOC cursor; front-matter art gated; portrait plates ≠ chapter banners |

Way of Kings is the highest-complexity fixture and is **not** in the default regression harness — use the WoK-specific verify/debug scripts under `server/scripts/` when changing illustration or TOC cursor code.

---

## Data model (Supabase)

Relevant `documents` columns (via migrations):

| Column | Purpose |
|--------|---------|
| `storage_path` | Original PDF in object storage |
| `content` / `chapters` | Parsed structure for the reader |
| `parser_version` | Invalidates stale parses |
| `parse_status` / `parse_progress` | Upload/parse lifecycle UI |
| `word_count` | Library metadata |
| `parsed_cache` | Reserved cache field (currently written null) |

Never edit existing migration files in place — add new migrations under `supabase/migrations/`.

---

## API surface (server)

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/` | Health |
| `POST` | `/upload` | Auth; start parse |
| `GET` | `/documents` | Library |
| `GET` | `/documents/:id` | Document + content |
| `GET` | `/documents/:id/status` | Parse progress |
| `PATCH` | `/documents/:id` | Metadata updates |
| `DELETE` | `/documents/:id` | Delete |
| `GET` | `/documents/:id/download` | Original PDF |
| `GET` | `/documents/:id/download/reformatted` | Reformatted export |
| `POST` | `/documents/:id/reparse` | Force re-parse |
| `POST` | `/documents/:id/retry-parse` | Retry failed parse |
| `POST` | `/admin/reparse` | Batch reparse outdated docs (`ADMIN_SECRET`) |

---

## Local development

### Prerequisites

- Node.js 20+
- Clerk application (publishable + secret keys)
- Supabase project with `documents` table and `pdfs` / `book-assets` storage buckets
- Optional: [Poppler](https://poppler.freedesktop.org/) (`pdftotext` on PATH) for regression word-count checks

### Server

```bash
cd server
npm install
```

Create `server/.env`:

```env
PORT=3000
CLIENT_URL=http://localhost:5173

# Clerk (publishable key is required by @clerk/express middleware)
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...

# Supabase (service role — server only)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...

# Optional
ADMIN_SECRET=...                    # POST /admin/reparse
BOOKY_REPARSE_ON_BOOT=1             # Re-parse outdated docs on server start
BOOKY_TEXT_EXTRACTION_CONCURRENCY=4
BOOKY_IMAGE_EXTRACTION_CONCURRENCY=2
```

```bash
npm run dev    # node --watch index.js
```

### Client

```bash
cd client
npm install
```

Create `client/.env`:

```env
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
VITE_API_URL=http://localhost:3000
```

```bash
npm run dev    # http://localhost:5173
```

### Debug flags (dev only — never leave on in production)

`BOOKY_FRONTMATTER_DEBUG`, `BOOKY_CHAPTER_GRAPHIC_DEBUG`, `BOOKY_TOC_ORDER_DEBUG`, `BOOKY_TOC_MISS_DEBUG`, `BOOKY_HEADING_DEBUG`, `BOOKY_SUBTITLE_DEBUG`, `BOOKY_BB_DEBUG`

---

## Regression & verification

Place test PDFs in `client/src/assets/`, then from `server/`:

```bash
npm run regression
npm run regression -- --book=orwell1984
npm run regression:update   # refresh local snapshots
```

**Harness books:** `oldman`, `orwell1984`, `monte-cristo`, `pride-prejudice`, `moby-dick`.

Blocking checks include mid-sentence headings, heading density, chapter structure, TOC leakage, empty blocks, dialogue split, and word count vs raw PDF (when `pdftotext` is available). See [server/scripts/regression/README.md](server/scripts/regression/README.md).

**Diff a single PDF:**

```bash
cd server
npm run diff-pdf -- "client/src/assets/My Book.pdf"
```

When changing the parser:

1. Keep the diff scoped; match surrounding conventions.
2. Bump `PARSER_VERSION` in **both** server and client.
3. Run `npm run regression` (plus book-specific scripts for illustrated titles).
4. For illustrated books, verify chapter count, TOC order, and that portrait plates are not phantom chapter boundaries.

---

## Deployment

- **Client:** Deploy `client/` to Vercel. Set `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_API_URL` (your Render API URL).
- **Server:** Deploy `server/` to Render (or similar). Set Clerk, Supabase, and `CLIENT_URL` / `ALLOWED_ORIGINS` to your Vercel origin (e.g. `https://booky-lemon.vercel.app`).

CORS allows `localhost:5173`, `localhost:4173`, and `https://booky-lemon.vercel.app` by default; add more via `ALLOWED_ORIGINS` (comma-separated). Vercel preview URLs matching `*.vercel.app` are also accepted.

---

## License

ISC (server package). See repository for details.
