/**
 * Parse every PDF in client/src/assets and report errors + key metrics.
 *   node scripts/test-all-assets.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  GENERAL_CHECKS,
  MAX_FAILURES_PER_CHECK,
  countWordsInBlocks,
} from "./regression/checks.mjs"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = path.resolve(__dirname, "../../client/src/assets")

const BLOCKING_CHECK_IDS = new Set([
  "noMidSentenceHeadings",
  "headingDensitySane",
  "chapterStructureSane",
  "noTocLeakage",
  "noEmptyBlocks",
  "dialogueSplitCheck",
])

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")

const pdfs = readdirSync(ASSETS_DIR)
  .filter((name) => name.toLowerCase().endsWith(".pdf"))
  .sort()

console.log(`Parser v${PARSER_VERSION} — testing ${pdfs.length} PDFs\n`)

const results = []

for (const file of pdfs) {
  const pdfPath = path.join(ASSETS_DIR, file)
  const started = performance.now()
  let entry = { file, ok: false, error: null, seconds: 0 }

  try {
    const parseResult = await parsePdfBuffer(readFileSync(pdfPath), file)
    const blocks = (parseResult.contentWithChapters ?? []).flatMap(
      (page) => page.blocks ?? []
    )
    const chapters = parseResult.chapters ?? []
    const pageCount =
      parseResult.parsedText?.numpages ?? parseResult.contentWithChapters?.length ?? 0
    const wordCount = parseResult.wordCount ?? countWordsInBlocks(blocks)

    const checkConfig = { chapters, pageCount, rawWordCount: null }
    const failures = []
    const warnings = []

    for (const check of GENERAL_CHECKS) {
      if (!BLOCKING_CHECK_IDS.has(check.id)) {
        continue
      }
      const outcome = check.run(blocks, checkConfig)
      if (outcome.skipped) {
        continue
      }
      if (!outcome.pass) {
        const bucket = check.id === "noEmptyBlocks" ? warnings : failures
        bucket.push({
          check: check.id,
          count: outcome.failures.length,
          samples: outcome.failures.slice(0, 2),
        })
      }
    }

    const romanPartChapters = chapters.filter((chapter) =>
      /^[IVXLCDM]+$/.test((chapter.title ?? "").trim())
    )
    const singleLetterChapters = chapters.filter((chapter) =>
      /^[IVXLCDM]$/.test((chapter.title ?? "").trim())
    )
    const falseRomanHeadings = blocks.filter(
      (block) =>
        block.isHeading &&
        block.isChapterStart &&
        /^[IVXLCDM]$/.test((block.text ?? "").trim()) &&
        (block.fontSize ?? 0) < 14
    )

    entry = {
      file,
      ok: !entry.error && failures.length === 0,
      error: null,
      seconds: ((performance.now() - started) / 1000).toFixed(1),
      bookTitle: parseResult.bookTitle ?? "",
      pages: pageCount,
      chapters: chapters.length,
      chapterSample: chapters.slice(0, 4).map((c) => c.title),
      lastChapter: chapters[chapters.length - 1]?.title ?? "",
      blocks: blocks.length,
      words: wordCount,
      headings: blocks.filter((b) => b.isHeading).length,
      images: blocks.filter((b) => b.type === "image").length,
      romanPartChapters: romanPartChapters.length,
      singleLetterChapters: singleLetterChapters.length,
      falseRomanHeadings: falseRomanHeadings.length,
      failures,
      warnings,
    }
  } catch (error) {
    entry = {
      file,
      ok: false,
      error: error.message,
      seconds: ((performance.now() - started) / 1000).toFixed(1),
    }
  }

  results.push(entry)

  const status = entry.error
    ? "CRASH"
    : entry.failures?.length
      ? "FAIL"
      : entry.warnings?.length
        ? "WARN"
        : "OK"
  const chapterInfo = entry.chapters != null ? `${entry.chapters} ch` : "—"
  console.log(
    `[${status.padEnd(5)}] ${entry.file} (${entry.seconds}s, ${entry.pages ?? "?"} pg, ${chapterInfo})`
  )
  if (entry.bookTitle) {
    console.log(`         title: ${entry.bookTitle}`)
  }
  if (entry.chapterSample?.length) {
    console.log(`         chapters: ${entry.chapterSample.join(" | ")}${entry.chapters > 4 ? " | …" : ""}`)
  }
  if (entry.error) {
    console.log(`         ERROR: ${entry.error}`)
  }
  for (const failure of entry.failures ?? []) {
    console.log(`         FAIL ${failure.check}: ${failure.count} issue(s)`)
    for (const sample of failure.samples ?? []) {
      console.log(`           > ${sample}`)
    }
  }
}

console.log("\n" + "═".repeat(60))
const crashed = results.filter((r) => r.error)
const failed = results.filter((r) => !r.error && r.failures?.length)
const warned = results.filter((r) => !r.error && !r.failures?.length && r.warnings?.length)
const passed = results.filter((r) => r.ok)

console.log(
  `SUMMARY: ${passed.length} OK, ${warned.length} warn-only, ${failed.length} fail, ${crashed.length} crash — ${results.length} total`
)

console.log("\nChapter counts:")
for (const r of results) {
  if (r.chapters != null) {
    console.log(`  ${r.chapters.toString().padStart(4)}  ${r.file}`)
  }
}

if (failed.length || crashed.length) {
  process.exit(1)
}
