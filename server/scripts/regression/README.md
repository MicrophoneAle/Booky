# Parser regression harness

General-purpose checks for `parsePdfBuffer` output, plus thin per-book assertion configs and JSON snapshots for drift detection.

## Run

From the `server` directory:

```bash
node scripts/regression/run.mjs
node scripts/regression/run.mjs --book=oldman
node scripts/regression/run.mjs --book=monte-cristo
node scripts/regression/run.mjs --update-snapshots
```

Exit code `0` when every selected book passes **blocking** checks, book-specific assertions, and snapshot diff.

**Blocking general checks** (must pass): mid-sentence headings, heading density, chapter structure, TOC leakage, empty blocks, dialogue split, word count vs raw (when `pdftotext` is available).

**Advisory general checks** (reported as `[WARN]`, do not fail the run): orphaned fragments, paragraph continuity, indentation sampling. These surface parser debt on large books without blocking legacy parity tests.

`monte-cristo` is large and may take several minutes. `oldman` and `orwell1984` are faster.

### Prerequisites

- Dummy Supabase env vars are set automatically in `run.mjs`.
- **Optional:** `pdftotext` on your PATH (Poppler). If missing, the word-count-vs-raw check is skipped with a warning.

## Layout

```
scripts/regression/
  run.mjs           # Entry point
  checks.mjs        # General checks (exported functions)
  snapshots/        # Gitignored JSON baselines
  books/
    oldman.mjs
    orwell1984.mjs
    monte-cristo.mjs
```

Legacy scripts (`test-oldman.mjs`, etc.) are unchanged and can still be run directly.

### npm scripts (from `server/`)

```bash
npm run regression
npm run regression:update
```

### Per-book options

| Field | Purpose |
|-------|---------|
| `skipGeneralChecks` | Array of check ids to skip (e.g. `indentationConsistency` when `isIndented` is high for the whole book) |

### Current baseline

- **oldman** and **orwell1984**: pass blocking checks and book-specific assertions (parity with legacy scripts).
- **monte-cristo**: book-specific assertions pass; blocking check may still flag rare false headings (e.g. long prose lines misclassified). Fix in `index.js`, then re-run with `--update-snapshots`.

## Add a new book

1. Put the PDF in `client/src/assets/`.
2. Create `server/scripts/regression/books/mybook.mjs`:

```javascript
export default {
  id: "mybook",
  name: "My Book Title",
  file: "My Book.pdf",
  assertions: [
    // Optional: ["label", (ctx) => boolean],
  ],
}
```

3. Import the config and add it to the `BOOKS` array in `run.mjs`.
4. Run once to verify output:

```bash
node scripts/regression/run.mjs --book=mybook --update-snapshots
```

5. Commit the book config; snapshots stay local (gitignored) unless you choose to check them in.

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

1. **No mid-sentence headings** — dangling endings, lowercase start, length, continuation pronouns
2. **No orphaned fragments** — short non-terminal prose, lowercase continuations
3. **Paragraph continuity** — split mid-sentence / mid-clause across prose blocks
4. **Heading density sane** — global ratio and 20-block windows
5. **Word count vs raw** — parsed vs `pdftotext` (≥ 85%)
6. **Chapter structure sane** — count, title length, duplicates, prose-like titles
7. **No TOC leakage** — heading runs in first 5% of blocks
8. **Indentation consistent** — sampled middle prose blocks (`isIndented` rate)
9. **No empty blocks**
10. **Dialogue split check** — quoted short lines after mid-sentence prose

## Snapshots

Written to `snapshots/<id>.json` with `--update-snapshots`. Normal runs diff:

- Word count ± 2%
- Chapter count and titles
- Heading count ± 10%
- First / last block text (first 80 chars)

## Extending checks

Add a function in `checks.mjs` returning `{ pass, failures, summary? }`, then register it in `GENERAL_CHECKS` in `run.mjs` (via the export list in `checks.mjs`).
