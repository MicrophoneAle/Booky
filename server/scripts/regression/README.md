# Parser regression harness

General-purpose checks for `parsePdfBuffer` output, plus thin per-book assertion configs and JSON snapshots for drift detection.

## Run

From the `server` directory:

```bash
node scripts/regression/run.mjs
node scripts/regression/run.mjs --book=oldman
node scripts/regression/run.mjs --book=way-of-kings
node scripts/regression/run.mjs --full
node scripts/regression/run.mjs --update-snapshots
```

Exit code `0` when every selected book passes **blocking** checks, book-specific assertions, and snapshot diff.

**Blocking general checks** (must pass): mid-sentence headings, heading density, chapter structure, TOC leakage, empty blocks, dialogue split, word count vs raw (when `pdftotext` is available).

**Advisory general checks** (reported as `[WARN]`, do not fail the run): scanner watermarks, dialogue attribution centering, orphaned fragments, paragraph continuity, indentation sampling. These surface parser debt on large books without blocking legacy parity tests.

### Suite tiers

| Command | Books |
|---------|-------|
| `npm run regression` | 13 books - original five plus Treasure Island, Frankenstein, Oliver Twist, Jungle Book, Aesop, Metamorphosis, Narnia, Maya Angelou |
| `npm run regression:full` | All 14 sample PDFs, including Way of Kings (OCR-heavy; minutes, not seconds) |
| `npm run test:assets` | Lightweight parse of every PDF under `client/src/assets/` (blocking general checks only; no book-specific assertions) |

Way of Kings is opt-in via `--full` because a full illustrated parse dominates local turnaround. It remains runnable in CI through `regression:full` / `--book=way-of-kings`.

### Prerequisites

- Dummy Supabase env vars are set automatically in `run.mjs`.
- **Optional:** `pdftotext` on your PATH (Poppler). If missing, the word-count-vs-raw check is skipped with a warning.

## Layout

```
scripts/regression/
  run.mjs           # Entry point
  checks.mjs        # General checks (exported functions)
  helpers.mjs       # Shared assertion helpers (contiguity, roman/arabic)
  snapshots/        # Committed JSON baselines (diffed on every run)
  books/
    oldman.mjs
    orwell1984.mjs
    monte-cristo.mjs
    pride-prejudice.mjs
    moby-dick.mjs
    treasure-island.mjs
    frankenstein.mjs
    oliver-twist.mjs
    jungle-book.mjs
    aesop.mjs
    metamorphosis.mjs
    narnia.mjs
    maya-angelou.mjs
    way-of-kings.mjs
```

Legacy scripts (`test-oldman.mjs`, etc.) are unchanged and can still be run directly.

### npm scripts (from `server/`)

```bash
npm run regression
npm run regression:full
npm run regression:update
npm run test:assets
```

### Per-book options

| Field | Purpose |
|-------|---------|
| `skipGeneralChecks` | Array of check ids to skip (e.g. `indentationConsistency` when `isIndented` is high for the whole book) |

### Current baseline

- Snapshots for all 14 books are **committed** under `snapshots/` and were refreshed at `PARSER_VERSION` 134 (`75610b9`). Normal runs fail on snapshot drift without needing a prior `--update-snapshots` on a fresh clone.
- Book-specific assertions follow the ground-truth convention below. Maya Angelou intentionally fails `[KNOWN GAP] On the Pulse of Morning` (no title in the PDF text layer); see `maya-angelou.mjs`.
- Moby Dick skips `indentationConsistency` and `headingDensitySane` via `skipGeneralChecks`.
- Advisory general checks (watermarks, dialogue attribution centering, orphaned fragments, paragraph continuity, indentation) report as `[WARN]` and do not fail the run - they surface ongoing prose-reflow / dialogue-split debt without blocking structural parity.
- Only refresh snapshots with `npm run regression:update` when parser output **intentionally** changed, then commit the JSON with the code change.

## Ground-truth convention

Book-specific assertions must be derived **independently of parser output**:

1. Prefer the edition's own printed Contents / TOC pages (raw pdfjs or `pdftotext`).
2. Otherwise use a reliable external reference for that edition (standard chapter maps, publisher listings).
3. Never set expected counts or title lists from a fresh `parsePdfBuffer` run of the same book - that makes truncation invisible by construction.

Numbered books should assert **true contiguity** (all of `1..N` present, no gaps), not a count threshold or endpoint-only presence. Named-chapter books should assert the printed title set (or a complete enumerated list from the printed TOC).

## Add a new book

1. Put the PDF in `client/src/assets/`.
2. Establish ground truth from the PDF's printed TOC / raw text (see above).
3. Create `server/scripts/regression/books/mybook.mjs`:

```javascript
export default {
  id: "mybook",
  name: "My Book Title",
  file: "My Book.pdf",
  assertions: [
    // ["label", (ctx) => boolean],
  ],
}
```

4. Import the config in `run.mjs` and add it to `EXTENDED_BOOKS` (or `SLOW_BOOKS` if it is too heavy for the default suite).
5. Run once to verify:

```bash
node scripts/regression/run.mjs --book=mybook
```

6. Commit the book config **and** its snapshot JSON after an intentional `--update-snapshots` run for that book.

## Book config

Each book exports:

| Field | Description |
|-------|-------------|
| `id` | CLI name for `--book=` and snapshot filename |
| `name` | Display name in reports |
| `file` | PDF filename under `client/src/assets/` |
| `assertions` | `[label, (ctx) => boolean]` pairs |

`ctx` includes: `blocks`, `chapters`, `contentWithChapters`, `parseResult`, `pdfPath`, `pageCount`, `wordCount`, `joined`.

## General checks (`checks.mjs`)

1. **No mid-sentence headings** — dangling endings, lowercase start, length, continuation pronouns; exempts chapter-shaped headings (`Chapter N`, `Chapter N - Subtitle`, `Part One`, etc.) regardless of how their subtitle reads
2. **No scanner watermarks** — ebook-site watermark phrases in block text
3. **Dialogue attribution not centered** — short centered lines shaped like a name/attribution
4. **No orphaned fragments** — short non-terminal prose, lowercase continuations
5. **Paragraph continuity** — split mid-sentence / mid-clause across prose blocks
6. **Heading density sane** — global ratio and 20-block windows
7. **Word count vs raw** — parsed vs `pdftotext` (≥ 85%)
8. **Chapter structure sane** — count, title length, duplicates, prose-like titles
9. **No TOC leakage** — heading runs in first 5% of blocks
10. **Indentation consistent** — sampled middle prose blocks (`isIndented` rate)
11. **No empty blocks** — skips `type: "image"` blocks, which legitimately have no text
12. **Dialogue split check** — quoted short lines after mid-sentence prose

## Snapshots

Written to `snapshots/<id>.json` with `--update-snapshots` (`npm run regression:update`). These files are **tracked in git**. Normal runs diff against the committed baseline:

- Word count ± 2%
- Chapter count and titles
- Heading count ± 10%
- First / last block text (first 80 chars)

Do not treat `--update-snapshots` as a prerequisite for drift detection on a fresh clone - the baselines are already present. Refresh only when parser output is meant to change.

## Extending checks

Add a function in `checks.mjs` returning `{ pass, failures, summary? }`, then register it in `GENERAL_CHECKS` in `run.mjs` (via the export list in `checks.mjs`).
