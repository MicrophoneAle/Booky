/**
 * Parser regression runner.
 *
 *   node scripts/regression/run.mjs
 *   node scripts/regression/run.mjs --book=oldman
 *   node scripts/regression/run.mjs --update-snapshots
 */

import { execSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  GENERAL_CHECKS,
  MAX_FAILURES_PER_CHECK,
  countWordsInBlocks,
} from "./checks.mjs"
import oldman from "./books/oldman.mjs"
import orwell1984 from "./books/orwell1984.mjs"
import monteCristo from "./books/monte-cristo.mjs"
import pridePrejudice from "./books/pride-prejudice.mjs"
import mobyDick from "./books/moby-dick.mjs"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = path.resolve(__dirname, "../../../client/src/assets")
const SNAPSHOTS_DIR = path.resolve(__dirname, "snapshots")

const BOOKS = [oldman, orwell1984, monteCristo, pridePrejudice, mobyDick]

const MAX_FAILURE_LINES = 4
const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

/** Checks that must pass for exit code 0 (book-specific + snapshot also required). */
const BLOCKING_GENERAL_CHECK_IDS = new Set([
  "noMidSentenceHeadings",
  "headingDensitySane",
  "chapterStructureSane",
  "noTocLeakage",
  "noEmptyBlocks",
  "dialogueSplitCheck",
  "wordCountVsRaw",
])

const args = process.argv.slice(2)
const bookFilter = parseArgValue("--book")
const updateSnapshots = args.includes("--update-snapshots")

const { parsePdfBuffer, PARSER_VERSION } = await import("../../index.js")

let booksToRun = BOOKS
if (bookFilter) {
  booksToRun = BOOKS.filter((book) => book.id === bookFilter)
  if (booksToRun.length === 0) {
    console.error(`Unknown book id: ${bookFilter}`)
    console.error(`Available: ${BOOKS.map((book) => book.id).join(", ")}`)
    process.exit(1)
  }
}

mkdirSync(SNAPSHOTS_DIR, { recursive: true })

let booksPassed = 0
let booksFailed = 0

for (const book of booksToRun) {
  const bookResult = await runBook(book)
  if (bookResult.pass) {
    booksPassed += 1
  } else {
    booksFailed += 1
  }
}

console.log("")
console.log(DIVIDER)
console.log(
  `FINAL: ${booksPassed}/${booksToRun.length} books passed.` +
    (booksFailed > 0 ? ` ${booksFailed} book(s) had failures.` : "")
)
console.log(DIVIDER)

process.exit(booksFailed > 0 ? 1 : 0)

async function runBook(book) {
  const pdfPath = path.join(ASSETS_DIR, book.file)

  if (!existsSync(pdfPath)) {
    console.error(`Missing PDF for ${book.name}: ${pdfPath}`)
    return { pass: false }
  }

  const started = performance.now()
  const buffer = readFileSync(pdfPath)
  const parseResult = await parsePdfBuffer(buffer, book.file)
  const elapsedSec = ((performance.now() - started) / 1000).toFixed(1)

  const contentWithChapters = parseResult.contentWithChapters ?? []
  const blocks = contentWithChapters.flatMap((page) => page.blocks ?? [])
  const chapters = parseResult.chapters ?? []
  const pageCount =
    parseResult.parsedText?.numpages ?? contentWithChapters.length
  const wordCount = parseResult.wordCount ?? countWordsInBlocks(blocks)
  const joined = blocks.map((block) => block.text ?? "").join(" ")

  const rawWordCount = tryRawWordCount(pdfPath)
  if (rawWordCount == null) {
    console.warn(
      `[${book.id}] pdftotext not available — skipping word count vs raw check`
    )
  }

  const checkConfig = {
    chapters,
    pageCount,
    rawWordCount,
    sampleRng: createSeededRng(hashString(book.id)),
  }

  const ctx = {
    blocks,
    chapters,
    contentWithChapters,
    parseResult,
    pdfPath,
    pageCount,
    wordCount,
    joined,
  }

  console.log("")
  console.log(DIVIDER)
  console.log(`BOOK: ${book.name} (${pageCount} pages, ${elapsedSec}s)`)
  console.log(DIVIDER)

  let bookPass = true
  let blockingGeneralPass = true

  console.log("General checks:")
  const generalResults = []

  const skipChecks = new Set(book.skipGeneralChecks ?? [])

  for (const check of GENERAL_CHECKS) {
    if (skipChecks.has(check.id)) {
      console.log(`  [SKIP] ${check.label} (skipped for this book)`)
      continue
    }

    const outcome = check.run(blocks, checkConfig)
    generalResults.push({ check, outcome })
    const blocking = BLOCKING_GENERAL_CHECK_IDS.has(check.id)

    if (outcome.skipped) {
      console.log(`  [SKIP] ${check.label} (${outcome.summary})`)
      continue
    }

    if (outcome.pass) {
      const detail = outcome.summary ? ` (${outcome.summary})` : ""
      console.log(`  [PASS] ${check.label}${detail}`)
      continue
    }

    const count =
      outcome.failures.length === 1
        ? "1 instance"
        : `${outcome.failures.length} instances`
    const tag = blocking ? "FAIL" : "WARN"
    if (blocking) {
      blockingGeneralPass = false
      bookPass = false
    }
    console.log(`  [${tag}] ${check.label}: ${count}`)
    for (const line of outcome.failures.slice(0, MAX_FAILURE_LINES)) {
      console.log(`         > ${line}`)
    }
    const extra = outcome.failures.length - MAX_FAILURE_LINES
    const capped = outcome.truncated
      ? ` (stopped after ${MAX_FAILURES_PER_CHECK} findings)`
      : ""
    if (extra > 0 || capped) {
      console.log(
        `         > … and ${extra > 0 ? extra : "more"}${capped ? " (capped)" : ""}`
      )
    }
  }

  console.log("")
  console.log("Book-specific assertions:")
  for (const [label, fn] of book.assertions ?? []) {
    let ok = false
    try {
      ok = Boolean(fn(ctx))
    } catch (error) {
      ok = false
      console.log(`  [FAIL] ${label} (threw: ${error.message})`)
      bookPass = false
      continue
    }

    if (ok) {
      console.log(`  [PASS] ${label}`)
    } else {
      console.log(`  [FAIL] ${label}`)
      bookPass = false
    }
  }

  console.log("")
  console.log("Snapshot diff:")
  const snapshot = buildSnapshot(blocks, chapters, wordCount)
  const snapshotPath = path.join(SNAPSHOTS_DIR, `${book.id}.json`)

  if (updateSnapshots) {
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
    console.log(`  [PASS] Snapshot updated (parser v${PARSER_VERSION})`)
  } else if (!existsSync(snapshotPath)) {
    console.log(
      "  [SKIP] No snapshot yet (run with --update-snapshots after verifying output)"
    )
  } else {
    const snapshotOutcome = compareSnapshot(
      JSON.parse(readFileSync(snapshotPath, "utf8")),
      snapshot
    )
    if (snapshotOutcome.pass) {
      console.log(
        `  [PASS] No changes from last snapshot (parser v${snapshotOutcome.baselineVersion})`
      )
    } else {
      bookPass = false
      console.log("  [FAIL] Snapshot regression:")
      for (const line of snapshotOutcome.failures) {
        console.log(`         > ${line}`)
      }
    }
  }

  console.log("")
  const statusLabel = bookPass
    ? "PASS"
    : blockingGeneralPass
      ? "FAILURE (book-specific or snapshot)"
      : "FAILURE"
  console.log(`RESULT: ${statusLabel}`)

  return { pass: bookPass }
}

function buildSnapshot(blocks, chapters, wordCount) {
  const proseBlocks = blocks.filter((block) => !block.isHeading)
  const headingBlocks = blocks.filter((block) => block.isHeading)
  const totalTextLength = blocks.reduce(
    (sum, block) => sum + (block.text?.length ?? 0),
    0
  )

  const first = blocks[0]?.text ?? ""
  const last = blocks[blocks.length - 1]?.text ?? ""

  return {
    parserVersion: PARSER_VERSION,
    totalBlocks: blocks.length,
    totalWords: wordCount,
    chapterCount: chapters.length,
    chapterTitles: chapters.map((chapter) => chapter.title ?? ""),
    firstBlockText: first.slice(0, 80),
    lastBlockText: last.slice(0, 80),
    headingCount: headingBlocks.length,
    avgBlockLength:
      blocks.length > 0 ? Math.round(totalTextLength / blocks.length) : 0,
    proseBlockCount: proseBlocks.length,
  }
}

function compareSnapshot(baseline, current) {
  const failures = []

  if (baseline.parserVersion !== undefined) {
    // Report baseline version in pass message only.
  }

  if (baseline.totalWords > 0) {
    const delta =
      Math.abs(current.totalWords - baseline.totalWords) / baseline.totalWords
    if (delta > 0.02) {
      failures.push(
        `Word count changed by ${(delta * 100).toFixed(1)}% (${baseline.totalWords} → ${current.totalWords})`
      )
    }
  }

  if (baseline.chapterCount !== current.chapterCount) {
    failures.push(
      `Chapter count changed (${baseline.chapterCount} → ${current.chapterCount})`
    )
  }

  const baselineTitles = baseline.chapterTitles ?? []
  const currentTitles = current.chapterTitles ?? []
  const titleLen = Math.max(baselineTitles.length, currentTitles.length)

  for (let index = 0; index < titleLen; index += 1) {
    if (baselineTitles[index] !== currentTitles[index]) {
      failures.push(
        `Chapter title [${index}] changed: '${baselineTitles[index] ?? ""}' → '${currentTitles[index] ?? ""}'`
      )
    }
  }

  if (baseline.headingCount > 0) {
    const headingDelta =
      Math.abs(current.headingCount - baseline.headingCount) /
      baseline.headingCount
    if (headingDelta > 0.1) {
      failures.push(
        `Heading count changed by ${(headingDelta * 100).toFixed(1)}% (${baseline.headingCount} → ${current.headingCount})`
      )
    }
  } else if (baseline.headingCount !== current.headingCount) {
    failures.push(
      `Heading count changed (${baseline.headingCount} → ${current.headingCount})`
    )
  }

  if (baseline.firstBlockText !== current.firstBlockText) {
    failures.push("First block text changed")
  }

  if (baseline.lastBlockText !== current.lastBlockText) {
    failures.push("Last block text changed")
  }

  return {
    pass: failures.length === 0,
    failures,
    baselineVersion: baseline.parserVersion ?? "?",
  }
}

function tryRawWordCount(pdfPath) {
  try {
    const quoted = process.platform === "win32" ? `"${pdfPath}"` : `'${pdfPath}'`
    const output = execSync(`pdftotext -enc UTF-8 ${quoted} -`, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
    return output.split(/\s+/).filter(Boolean).length
  } catch {
    return null
  }
}

function parseArgValue(flag) {
  const direct = args.find((arg) => arg.startsWith(`${flag}=`))
  if (direct) {
    return direct.slice(flag.length + 1)
  }

  const index = args.indexOf(flag)
  if (index >= 0 && args[index + 1]) {
    return args[index + 1]
  }

  return null
}

function hashString(value) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash || 1
}

function createSeededRng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}
