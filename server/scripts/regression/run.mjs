/**
 * Parser regression runner.
 *
 *   node scripts/regression/run.mjs
 *   node scripts/regression/run.mjs --book=oldman
 *   node scripts/regression/run.mjs --full
 *   node scripts/regression/run.mjs --update-snapshots
 *   node scripts/regression/run.mjs --update-snapshots --full
 *   node scripts/regression/run.mjs --full --update-wrap-tail-baseline
 *
 * --update-snapshots without --book refreshes all 14 books (includes Way of
 * Kings). Pairing it with --book= still updates a single title.
 * --update-wrap-tail-baseline rewrites wrapTailBaseline.mjs only when no
 * selected book increased its known-bad wrap-tail count.
 */

import { execSync } from "node:child_process"
import { createHash } from "node:crypto"
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
import {
  WRAP_TAIL_BOOK_BASELINE,
  WRAP_TAIL_CORPUS_BASELINE,
  WRAP_TAIL_MECHANISM_BASELINE,
} from "./wrapTailBaseline.mjs"
import {
  WRAP_TAIL_MECHANISM_LABELS,
  WRAP_TAIL_MECHANISM_ORDER,
  formatMechanismBreakdown,
} from "./wrapTail.mjs"
import oldman from "./books/oldman.mjs"
import orwell1984 from "./books/orwell1984.mjs"
import monteCristo from "./books/monte-cristo.mjs"
import pridePrejudice from "./books/pride-prejudice.mjs"
import mobyDick from "./books/moby-dick.mjs"
import treasureIsland from "./books/treasure-island.mjs"
import frankenstein from "./books/frankenstein.mjs"
import oliverTwist from "./books/oliver-twist.mjs"
import jungleBook from "./books/jungle-book.mjs"
import aesop from "./books/aesop.mjs"
import metamorphosis from "./books/metamorphosis.mjs"
import narnia from "./books/narnia.mjs"
import mayaAngelou from "./books/maya-angelou.mjs"
import wayOfKings from "./books/way-of-kings.mjs"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = path.resolve(__dirname, "../../../client/src/assets")
const SNAPSHOTS_DIR = path.resolve(__dirname, "snapshots")

// Default suite: original five plus the newly covered sample books that parse
// in a routine local timeframe. Way of Kings is OCR-heavy (~minutes) and is
// opt-in via --full / npm run regression:full so CI can still run it without
// forcing every local invocation to pay that cost.
const CORE_BOOKS = [oldman, orwell1984, monteCristo, pridePrejudice, mobyDick]
const EXTENDED_BOOKS = [
  treasureIsland,
  frankenstein,
  oliverTwist,
  jungleBook,
  aesop,
  metamorphosis,
  narnia,
  mayaAngelou,
]
const SLOW_BOOKS = [wayOfKings]

const MAX_FAILURE_LINES = 25
const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
const KNOWN_DEBT_MIN_REASON = 24

/** Checks that must pass for exit code 0 (book-specific + snapshot also required). */
const BLOCKING_GENERAL_CHECK_IDS = new Set([
  "noMidSentenceHeadings",
  "headingDensitySane",
  "chapterStructureSane",
  "noTocLeakage",
  "noEmptyBlocks",
  "dialogueSplitCheck",
  "wordCountVsRaw",
  "chapterOrderPagesMonotonic",
  "wrapTailExtract",
])

const args = process.argv.slice(2)
const bookFilter = parseArgValue("--book")
const updateSnapshots = args.includes("--update-snapshots")
const updateWrapTailBaseline = args.includes("--update-wrap-tail-baseline")
const includeFull = args.includes("--full")

// Snapshot refresh must include Way of Kings. The default parse suite still
// omits it unless --full / --book= is passed, so a plain --update-snapshots
// used to leave the WoK baseline stale.
const BOOKS =
  includeFull || (updateSnapshots && !bookFilter)
    ? [...CORE_BOOKS, ...EXTENDED_BOOKS, ...SLOW_BOOKS]
    : [...CORE_BOOKS, ...EXTENDED_BOOKS]
const ALL_KNOWN_BOOKS = [...CORE_BOOKS, ...EXTENDED_BOOKS, ...SLOW_BOOKS]

const SNAPSHOT_OPEN_BLOCKS = 6
const SNAPSHOT_OPEN_CHARS = 60
const SNAPSHOT_OPEN_PAGES = 8
const SNAPSHOT_CLOSE_BLOCKS = 3
const SNAPSHOT_FULL_PREFIX_LIMIT = 24

const { parsePdfBuffer, PARSER_VERSION } = await import("../../index.js")

requirePdftotext()

let booksToRun = BOOKS
if (bookFilter) {
  booksToRun = ALL_KNOWN_BOOKS.filter((book) => book.id === bookFilter)
  if (booksToRun.length === 0) {
    console.error(`Unknown book id: ${bookFilter}`)
    console.error(
      `Available: ${ALL_KNOWN_BOOKS.map((book) => book.id).join(", ")}`
    )
    process.exit(1)
  }
}

mkdirSync(SNAPSHOTS_DIR, { recursive: true })

let booksPassed = 0
let booksFailed = 0
let knownDebtTotal = 0
const wrapTailScores = []

for (const book of booksToRun) {
  const bookResult = await runBook(book)
  knownDebtTotal += bookResult.knownDebt ?? 0
  if (bookResult.wrapTail) {
    wrapTailScores.push(bookResult.wrapTail)
  }
  if (bookResult.pass) {
    booksPassed += 1
  } else {
    booksFailed += 1
  }
}

console.log("")
console.log(DIVIDER)
console.log(
  `FINAL: ${booksPassed} pass, ${booksFailed} fail, ${knownDebtTotal} known-debt (${booksToRun.length} books)`
)
console.log(DIVIDER)

reportWrapTailCorpus(wrapTailScores, booksToRun)

if (updateWrapTailBaseline) {
  applyWrapTailBaselineUpdate(wrapTailScores)
}

process.exit(booksFailed > 0 ? 1 : 0)

async function runBook(book) {
  const pdfPath = path.join(ASSETS_DIR, book.file)

  if (!existsSync(pdfPath)) {
    console.error(`Missing PDF for ${book.name}: ${pdfPath}`)
    return { pass: false }
  }

  const started = performance.now()
  const buffer = readFileSync(pdfPath)
  const extractDrops = []
  const parseResult = await parsePdfBuffer(buffer, book.file, {
    onExtractDrop(entry) {
      extractDrops.push(entry)
    },
  })
  const elapsedSec = ((performance.now() - started) / 1000).toFixed(1)

  const contentWithChapters = parseResult.contentWithChapters ?? []
  const blocks = contentWithChapters.flatMap((page) => page.blocks ?? [])
  const chapters = parseResult.chapters ?? []
  const pageCount =
    parseResult.parsedText?.numpages ?? contentWithChapters.length
  const wordCount = parseResult.wordCount ?? countWordsInBlocks(blocks)
  const joined = blocks.map((block) => block.text ?? "").join(" ")

  const rawWordCountResult = tryRawWordCount(pdfPath)
  if (rawWordCountResult.error) {
    console.error(`[${book.id}] ${rawWordCountResult.error}`)
  }

  const checkConfig = {
    bookId: book.id,
    chapters,
    contentWithChapters,
    pageCount,
    rawWordCount: rawWordCountResult.count,
    rawText: rawWordCountResult.text,
    pdftotextError: rawWordCountResult.error,
    sampleRng: createSeededRng(hashString(book.id)),
    extractDrops,
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
  let wrapTailScore = null

  for (const check of GENERAL_CHECKS) {
    if (skipChecks.has(check.id)) {
      console.log(`  [SKIP] ${check.label} (skipped for this book)`)
      continue
    }

    const outcome = check.run(blocks, checkConfig)
    generalResults.push({ check, outcome })
    if (check.id === "wrapTailExtract" && outcome.wrapTail) {
      wrapTailScore = outcome.wrapTail
    }
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
  const assertionOutcomes = []
  for (const entry of book.assertions ?? []) {
    assertionOutcomes.push(evaluateAssertion(entry, ctx))
  }

  const assertionPass = assertionOutcomes.filter((item) => item.status === "pass").length
  const assertionFail = assertionOutcomes.filter((item) => item.status === "fail").length
  const assertionDebt = assertionOutcomes.filter(
    (item) => item.status === "known-debt"
  ).length
  const knownDebt = assertionDebt

  if ((book.assertions ?? []).length > 0) {
    console.log(
      `Book-specific assertions (${assertionPass} pass, ${assertionFail} fail, ${assertionDebt} known-debt):`
    )
  } else {
    console.log("Book-specific assertions:")
  }

  for (const outcome of assertionOutcomes) {
    if (outcome.status === "pass") {
      console.log(`  [PASS] ${outcome.label}`)
      continue
    }
    if (outcome.status === "known-debt") {
      console.log(`  [KNOWN-DEBT] ${outcome.label}`)
      console.log(`           known-debt: ${outcome.knownDebt}`)
      continue
    }
    if (outcome.threw) {
      console.log(`  [FAIL] ${outcome.label} (threw: ${outcome.threw})`)
    } else {
      console.log(`  [FAIL] ${outcome.label}`)
    }
    bookPass = false
  }

  console.log("")
  console.log("Snapshot diff:")
  const snapshot = buildSnapshot(contentWithChapters, chapters, wordCount)
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

  return { pass: bookPass, knownDebt, wrapTail: wrapTailScore }
}

function evaluateAssertion(entry, ctx) {
  if (
    !Array.isArray(entry) ||
    typeof entry[0] !== "string" ||
    typeof entry[1] !== "function"
  ) {
    return {
      label: String(entry?.[0] ?? "(invalid assertion)"),
      status: "fail",
      threw: "assertion must be [label, fn] or [label, fn, { knownDebt }]",
    }
  }

  const [label, fn, options] = entry
  let knownDebt = null
  if (options !== undefined) {
    const reason = options?.knownDebt
    if (typeof reason !== "string" || reason.trim().length < KNOWN_DEBT_MIN_REASON) {
      return {
        label,
        status: "fail",
        threw: `knownDebt must be a reason string of at least ${KNOWN_DEBT_MIN_REASON} characters`,
      }
    }
    knownDebt = reason.trim()
  }

  try {
    const ok = Boolean(fn(ctx))
    if (ok) {
      return { label, status: "pass", knownDebt }
    }
    if (knownDebt) {
      return { label, status: "known-debt", knownDebt }
    }
    return { label, status: "fail" }
  } catch (error) {
    return { label, status: "fail", threw: error.message }
  }
}

function flattenContentBlocks(contentWithChapters) {
  const items = []
  for (const page of contentWithChapters ?? []) {
    const blocks = page.blocks ?? []
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      items.push({
        pageIndex: page.pageIndex,
        blockIndex,
        block: blocks[blockIndex],
      })
    }
  }
  return items
}

function chapterBlockSlices(contentWithChapters, chapters) {
  const flat = flattenContentBlocks(contentWithChapters)
  const starts = (chapters ?? []).map((chapter) => {
    const index = flat.findIndex(
      (item) =>
        item.pageIndex === chapter.pageIndex &&
        item.blockIndex === chapter.blockIndex
    )
    return { chapter, index }
  })

  let frontEnd = flat.length
  for (const start of starts) {
    if (start.index >= 0 && start.index < frontEnd) {
      frontEnd = start.index
    }
  }

  const slices = starts.map((start) => {
    if (start.index < 0) {
      return { chapter: start.chapter, blocks: [] }
    }
    let end = flat.length
    for (const other of starts) {
      if (other.index > start.index && other.index < end) {
        end = other.index
      }
    }
    return {
      chapter: start.chapter,
      blocks: flat.slice(start.index, end).map((item) => item.block),
    }
  })

  return {
    frontBlocks: flat.slice(0, frontEnd).map((item) => item.block),
    slices,
  }
}

function blockTypeCode(block) {
  if (block?.type === "image") {
    return block.isChapterBoundary ? "b" : "i"
  }
  if (block?.isHeading) {
    return "h"
  }
  return "p"
}

function blockPreview(block) {
  if (block?.type === "image") {
    const kind = block.isChapterBoundary ? "banner" : "image"
    const title = (block.chapterMetadata?.title ?? "").trim()
    const text = title ? `[${kind}] ${title}` : `[${kind}]`
    return text.slice(0, SNAPSHOT_OPEN_CHARS)
  }
  return (block?.text ?? "").replace(/\s+/g, " ").trim().slice(0, SNAPSHOT_OPEN_CHARS)
}

function blockFingerprint(block) {
  if (block?.type === "image") {
    const kind = block.isChapterBoundary ? "b" : "i"
    const title = (block.chapterMetadata?.title ?? "").trim()
    return `[${kind}]${title}`
  }
  return block?.text ?? ""
}

function snapshotHash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12)
}

function summarizeBlockRun(blocks, title) {
  const list = blocks ?? []
  const pages = list
    .map((block) => block.sourcePdfPageIndex)
    .filter((page) => Number.isFinite(page))
  const fullPrefix = list.length > 0 && list.length <= SNAPSHOT_FULL_PREFIX_LIMIT
  const openCount = fullPrefix ? list.length : SNAPSHOT_OPEN_BLOCKS
  const pageCount = fullPrefix ? list.length : SNAPSHOT_OPEN_PAGES
  const closeList = fullPrefix ? [] : list.slice(-SNAPSHOT_CLOSE_BLOCKS)
  return {
    ...(title !== undefined ? { title } : {}),
    blockCount: list.length,
    types: list.map(blockTypeCode).join(""),
    pageMin: pages.length > 0 ? Math.min(...pages) : null,
    pageMax: pages.length > 0 ? Math.max(...pages) : null,
    openPages: list.slice(0, pageCount).map((block) =>
      Number.isFinite(block.sourcePdfPageIndex) ? block.sourcePdfPageIndex : null
    ),
    open: list.slice(0, openCount).map((block) => blockPreview(block)),
    closePages: closeList.map((block) =>
      Number.isFinite(block.sourcePdfPageIndex) ? block.sourcePdfPageIndex : null
    ),
    close: closeList.map((block) => blockPreview(block)),
    textHash: snapshotHash(list.map(blockFingerprint).join("\n")),
    pageHash: snapshotHash(
      list
        .map((block) =>
          Number.isFinite(block.sourcePdfPageIndex)
            ? String(block.sourcePdfPageIndex)
            : "x"
        )
        .join(",")
    ),
  }
}

function buildSnapshot(contentWithChapters, chapters, wordCount) {
  const blocks = (contentWithChapters ?? []).flatMap((page) => page.blocks ?? [])
  const proseBlocks = blocks.filter((block) => !block.isHeading)
  const headingBlocks = blocks.filter((block) => block.isHeading)
  const totalTextLength = blocks.reduce(
    (sum, block) => sum + (block.text?.length ?? 0),
    0
  )

  const first = blocks[0]?.text ?? ""
  const last = blocks[blocks.length - 1]?.text ?? ""
  const { frontBlocks, slices } = chapterBlockSlices(contentWithChapters, chapters)

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
    frontMatter:
      frontBlocks.length > 0 ? summarizeBlockRun(frontBlocks) : null,
    chapterOrder: slices.map((slice) =>
      summarizeBlockRun(slice.blocks, slice.chapter.title ?? "")
    ),
  }
}

function compareBlockRun(label, baseline, current, failures) {
  if (!baseline && !current) {
    return
  }
  if (!baseline || !current) {
    failures.push(`${label} ${baseline ? "removed" : "added"}`)
    return
  }

  if (baseline.blockCount !== current.blockCount) {
    failures.push(
      `${label} blockCount ${baseline.blockCount} → ${current.blockCount}`
    )
  }
  if (baseline.types !== current.types) {
    const index = firstStringDiff(baseline.types ?? "", current.types ?? "")
    failures.push(
      `${label} types changed at ${index} (${(baseline.types ?? "").length} → ${(current.types ?? "").length})`
    )
  }
  if (baseline.pageMin !== current.pageMin || baseline.pageMax !== current.pageMax) {
    failures.push(
      `${label} page range ${baseline.pageMin}-${baseline.pageMax} -> ${current.pageMin}-${current.pageMax}`
    )
  }
  if (JSON.stringify(baseline.openPages) !== JSON.stringify(current.openPages)) {
    failures.push(`${label} openPages changed`)
  }
  const baselineOpen = baseline.open ?? []
  const currentOpen = current.open ?? []
  const openLen = Math.max(baselineOpen.length, currentOpen.length)
  for (let index = 0; index < openLen; index += 1) {
    if (baselineOpen[index] !== currentOpen[index]) {
      failures.push(`${label} open[${index}] changed`)
    }
  }
  if (JSON.stringify(baseline.closePages ?? []) !== JSON.stringify(current.closePages ?? [])) {
    failures.push(`${label} closePages changed`)
  }
  const baselineClose = baseline.close ?? []
  const currentClose = current.close ?? []
  const closeLen = Math.max(baselineClose.length, currentClose.length)
  for (let index = 0; index < closeLen; index += 1) {
    if (baselineClose[index] !== currentClose[index]) {
      failures.push(`${label} close[${index}] changed`)
    }
  }
  if (baseline.textHash !== current.textHash) {
    failures.push(`${label} textHash changed`)
  }
  if (baseline.pageHash !== current.pageHash) {
    failures.push(`${label} pageHash changed`)
  }
}

function firstStringDiff(left, right) {
  const limit = Math.min(left.length, right.length)
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      return index
    }
  }
  return left.length === right.length ? -1 : limit
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

  if (!Object.prototype.hasOwnProperty.call(baseline, "chapterOrder")) {
    failures.push("Baseline missing chapterOrder (refresh snapshots)")
  } else {
    compareBlockRun("frontMatter", baseline.frontMatter, current.frontMatter, failures)
    const baselineOrder = baseline.chapterOrder ?? []
    const currentOrder = current.chapterOrder ?? []
    if (baselineOrder.length !== currentOrder.length) {
      failures.push(
        `chapterOrder length ${baselineOrder.length} → ${currentOrder.length}`
      )
    }
    const orderLen = Math.min(baselineOrder.length, currentOrder.length)
    for (let index = 0; index < orderLen; index += 1) {
      const title = currentOrder[index]?.title || baselineOrder[index]?.title || index
      compareBlockRun(
        `chapterOrder[${index}] ${title}`,
        baselineOrder[index],
        currentOrder[index],
        failures
      )
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    baselineVersion: baseline.parserVersion ?? "?",
  }
}

function requirePdftotext() {
  try {
    execSync("pdftotext -v", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error("")
      console.error(DIVIDER)
      console.error(
        "ERROR: pdftotext is required for regression (word-count-vs-raw truncation check)."
      )
      console.error(
        "Install Poppler and ensure pdftotext is on PATH. The suite will not run without it."
      )
      console.error(
        "A missing truncation check is a failure, not a skip."
      )
      console.error(DIVIDER)
      process.exit(1)
    }
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
    return {
      count: output.split(/\s+/).filter(Boolean).length,
      text: output,
      error: null,
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        count: null,
        text: null,
        error:
          "pdftotext is not on PATH (install Poppler). Word-count-vs-raw cannot run.",
      }
    }
    return {
      count: null,
      text: null,
      error: `pdftotext failed to extract text from this PDF (${error.message}).`,
    }
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

function mergeWrapTailMechanisms(scores) {
  const byMechanism = {}
  for (const score of scores) {
    for (const [key, count] of Object.entries(score.byMechanism ?? {})) {
      byMechanism[key] = (byMechanism[key] || 0) + count
    }
  }
  return byMechanism
}

function reportWrapTailCorpus(scores, books) {
  if (scores.length === 0) {
    return
  }

  const liveTotal = scores.reduce((sum, score) => sum + score.count, 0)
  const byMechanism = mergeWrapTailMechanisms(scores)
  const fullIds = Object.keys(WRAP_TAIL_BOOK_BASELINE)
  const ranFullCorpus =
    books.length === fullIds.length &&
    fullIds.every((id) => scores.some((score) => score.bookId === id))

  console.log("")
  console.log("Wrap-tail extract drops (known-bad, not a target):")
  if (ranFullCorpus) {
    const delta = liveTotal - WRAP_TAIL_CORPUS_BASELINE
    const deltaNote =
      delta === 0
        ? `matches recorded ${WRAP_TAIL_CORPUS_BASELINE}`
        : delta < 0
          ? `${liveTotal} vs recorded ${WRAP_TAIL_CORPUS_BASELINE} (${delta})`
          : `${liveTotal} vs recorded ${WRAP_TAIL_CORPUS_BASELINE} (+${delta})`
    console.log(`  corpus ${liveTotal} (${deltaNote})`)
  } else {
    console.log(
      `  corpus ${liveTotal} across ${scores.length} books (full-suite recorded total is ${WRAP_TAIL_CORPUS_BASELINE})`
    )
  }

  for (const score of scores) {
    const bookDelta = score.count - score.baseline
    const deltaLabel =
      bookDelta === 0 ? "" : bookDelta < 0 ? ` (${bookDelta})` : ` (+${bookDelta})`
    console.log(`  ${score.bookId}: ${score.count}${deltaLabel}`)
  }

  console.log(`  mechanisms: ${formatMechanismBreakdown(byMechanism)}`)
  if (ranFullCorpus) {
    const expectedParts = WRAP_TAIL_MECHANISM_ORDER.map((key) => {
      const live = byMechanism[key] || 0
      const recorded = WRAP_TAIL_MECHANISM_BASELINE[key] || 0
      const label = WRAP_TAIL_MECHANISM_LABELS[key] ?? key
      return live === recorded
        ? `${label} ${live}`
        : `${label} ${live} (recorded ${recorded})`
    })
    console.log(`  recorded mechanisms: ${expectedParts.join(", ")}`)
  }
}

function applyWrapTailBaselineUpdate(scores) {
  const increased = scores.filter((score) => score.count > score.baseline)
  if (increased.length > 0) {
    console.error("")
    console.error(
      "Refusing --update-wrap-tail-baseline: known-bad count went up (do not raise the floor):"
    )
    for (const score of increased) {
      console.error(`  ${score.bookId}: ${score.baseline} -> ${score.count}`)
    }
    process.exitCode = 1
    return
  }

  const nextBooks = { ...WRAP_TAIL_BOOK_BASELINE }
  for (const score of scores) {
    nextBooks[score.bookId] = score.count
  }

  const fullIds = Object.keys(WRAP_TAIL_BOOK_BASELINE)
  const ranFullCorpus =
    scores.length === fullIds.length &&
    fullIds.every((id) => scores.some((score) => score.bookId === id))
  const nextMechanisms = ranFullCorpus
    ? mergeWrapTailMechanisms(scores)
    : { ...WRAP_TAIL_MECHANISM_BASELINE }
  const nextCorpus = Object.values(nextBooks).reduce((sum, count) => sum + count, 0)

  const bookLines = Object.entries(nextBooks)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([id, count]) => `  ${JSON.stringify(id)}: ${count},`)
    .join("\n")

  const mechanismLines = [
    ...WRAP_TAIL_MECHANISM_ORDER.filter((key) => nextMechanisms[key] != null),
    ...Object.keys(nextMechanisms).filter(
      (key) => !WRAP_TAIL_MECHANISM_ORDER.includes(key)
    ),
  ]
    .map((key) => `  ${JSON.stringify(key)}: ${nextMechanisms[key]},`)
    .join("\n")

  const contents = `/**
 * Known-bad wrap-tail counts. These are defects to drive DOWN, not targets
 * to maintain. Do not raise a number to make the check pass. A higher count
 * means more leftover wrap lines were deleted at extract and never reached
 * the reader.
 *
 * Recorded from parsePdfBuffer({ onExtractDrop }) + looksLikeWrapTail.
 * Refresh with --update-wrap-tail-baseline after a real reduction. That
 * flag refuses to write if any selected book went up.
 */

export const WRAP_TAIL_BASELINE_NOTE =
  "known-bad extract wrap-tails; drive down, never treat as a target"

export const WRAP_TAIL_BOOK_BASELINE = {
${bookLines}
}

export const WRAP_TAIL_MECHANISM_BASELINE = {
${mechanismLines}
}

export const WRAP_TAIL_CORPUS_BASELINE = ${nextCorpus}
`

  const baselinePath = path.join(__dirname, "wrapTailBaseline.mjs")
  writeFileSync(baselinePath, contents, "utf8")
  console.log("")
  if (!ranFullCorpus) {
    console.log(
      `Updated ${baselinePath} for ${scores.length} book(s); mechanism totals left unchanged (run --full to refresh them).`
    )
  } else {
    console.log(`Updated ${baselinePath} (corpus ${nextCorpus}).`)
  }
}
