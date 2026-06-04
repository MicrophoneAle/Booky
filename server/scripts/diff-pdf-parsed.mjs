/**
 * Compare naive PDF text extraction vs Booky parsePdfBuffer output.
 *
 * Usage:
 *   node scripts/diff-pdf-parsed.mjs [path/to/book.pdf]
 *   node scripts/diff-pdf-parsed.mjs --all
 *   node scripts/diff-pdf-parsed.mjs --help
 *
 * Options:
 *   --min-phrase <n>       Min words in a checked phrase (default 4)
 *   --max-phrase <n>       Max words in a checked phrase (default 6)
 *   --min-phrase-freq <n>  Min occurrences in raw PDF to flag missing (default 2)
 *   --max-report <n>       Max missing words/phrases to print (default 25)
 *   --fail-under <pct>     Exit 1 if fair unique-word coverage is below this (default 0 = off)
 *   --strict               Exit 1 if any missing phrases are flagged
 *   --json <path>          Write machine-readable report
 *
 * Raw PDF text is run through normalizeExtractedText before compare so ligature
 * splits (fi/rst) are not reported as missing content.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = path.resolve(__dirname, "../../client/src/assets")

const STOPWORDS = new Set(
  `
  a an the and or but if in on at to for of by with from as is was were be been
  am are has have had do does did will would could should may might must shall can
  it its he she they we you i me my his her their our your this that these those
  not no nor so than then there here when where who whom what which while up down
  out into over under again further once
  `.split(/\s+/)
)

const PAGE_NOISE_WORDS = new Set(
  "i ii iii iv v vi vii viii ix x xi xii xiii xiv xv xvi xvii xviii xix xx".split(
    /\s+/
  )
)

function parseArgs(argv) {
  const options = {
    paths: [],
    all: false,
    minPhrase: 4,
    maxPhrase: 6,
    minPhraseFreq: 2,
    maxReport: 25,
    failUnder: 0,
    strict: false,
    jsonPath: null,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") {
      options.help = true
    } else if (arg === "--all") {
      options.all = true
    } else if (arg === "--min-phrase") {
      options.minPhrase = Number(argv[++i])
    } else if (arg === "--max-phrase") {
      options.maxPhrase = Number(argv[++i])
    } else if (arg === "--min-phrase-freq") {
      options.minPhraseFreq = Number(argv[++i])
    } else if (arg === "--max-report") {
      options.maxReport = Number(argv[++i])
    } else if (arg === "--fail-under") {
      options.failUnder = Number(argv[++i])
    } else if (arg === "--json") {
      options.jsonPath = argv[++i]
    } else if (arg === "--strict") {
      options.strict = true
    } else if (!arg.startsWith("-")) {
      options.paths.push(path.resolve(arg))
    }
  }

  return options
}

function printHelp() {
  console.log(`diff-pdf-parsed — compare raw PDF text vs Booky parser output

Usage:
  node scripts/diff-pdf-parsed.mjs <file.pdf> [more.pdf ...]
  node scripts/diff-pdf-parsed.mjs --all

Options:
  --min-phrase <n>       Min words per phrase (default 4)
  --max-phrase <n>       Max words per phrase (default 6)
  --min-phrase-freq <n>  Min raw occurrences to report missing phrase (default 2)
  --max-report <n>       Lines to show per section (default 25)
  --fail-under <pct>     Exit 1 if fair unique-word coverage % is below threshold
  --strict               Exit 1 if missing phrases are flagged
  --json <path>          Write JSON report
`)
}

const HEADER_PHRASE_PATTERNS = [
  /asiaing\.com/,
  /project gutenberg/,
  /gutenberg of australia/,
  /readng\.com/,
  /typeset by/,
  /^chapter\s+\d{1,2}\s+\d{1,4}$/,
  /^letter\s+\d{1,2}\s+\d{1,4}$/,
  /^volume\s+[ivxlcdm]+\s+\d{1,4}$/,
  /the old man and the sea asiaing/,
  /^nineteen eighty four$/,
  /^george orwell$/,
]

function isExpectedDroppedPhrase(phrase, freq) {
  if (freq > 35) {
    return true
  }
  return HEADER_PHRASE_PATTERNS.some((re) => re.test(phrase))
}

function normalizeText(text) {
  return (text ?? "")
    .normalize("NFKD")
    .replace(/\u00AD/g, "")
    .toLowerCase()
    .replace(/[''`´]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function phraseInHaystack(phrase, haystackNorm) {
  const needle = normalizeText(phrase)
  return needle.length > 0 && haystackNorm.includes(needle)
}

function tokenize(text) {
  if (!text) {
    return []
  }
  return text.split(/\s+/).filter(Boolean)
}

function isNoiseToken(word) {
  if (!word || word.length <= 1) {
    return true
  }
  if (/^\d+$/.test(word)) {
    return true
  }
  if (PAGE_NOISE_WORDS.has(word)) {
    return true
  }
  if (STOPWORDS.has(word)) {
    return true
  }
  return false
}

async function extractRawPdfText(buffer) {
  const pdf = await getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
  }).promise

  const parts = []
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const textContent = await page.getTextContent()
      for (const item of textContent.items) {
        const piece = (item.str ?? "").trim()
        if (piece) {
          parts.push(piece)
        }
      }
      if (typeof page.cleanup === "function") {
        page.cleanup()
      }
    }
  } finally {
    if (typeof pdf.destroy === "function") {
      await pdf.destroy()
    }
  }

  return parts.join(" ")
}

function countWordFrequencies(tokens) {
  const counts = new Map()
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  return counts
}

function phraseStopwordRatio(words) {
  let stop = 0
  for (const word of words) {
    if (STOPWORDS.has(word) || /^\d+$/.test(word)) {
      stop += 1
    }
  }
  return stop / words.length
}

function collectPhraseCounts(tokens, minLen, maxLen) {
  const counts = new Map()
  const n = tokens.length
  if (n < minLen) {
    return counts
  }

  for (let len = minLen; len <= maxLen; len += 1) {
    for (let i = 0; i <= n - len; i += 1) {
      const slice = tokens.slice(i, i + len)
      if (phraseStopwordRatio(slice) > 0.55) {
        continue
      }
      const phrase = slice.join(" ")
      if (phrase.length < 12) {
        continue
      }
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1)
    }
  }

  return counts
}

function analyzeWordOverlap(rawTokens, parsedTokens, maxReport) {
  const rawCounts = countWordFrequencies(rawTokens)
  const parsedSet = new Set(parsedTokens)

  const rawUnique = rawCounts.size
  let rawUniquePresent = 0
  const missingByImpact = []

  for (const [word, rawFreq] of rawCounts) {
    if (parsedSet.has(word)) {
      rawUniquePresent += 1
    } else if (!isNoiseToken(word)) {
      missingByImpact.push({
        word,
        rawFreq,
        impact: rawFreq * Math.min(word.length, 12),
      })
    }
  }

  missingByImpact.sort((a, b) => b.impact - a.impact)

  let rawTokenHits = 0
  for (const token of rawTokens) {
    if (parsedSet.has(token)) {
      rawTokenHits += 1
    }
  }

  const parsedOnly = []
  const rawSet = new Set(rawTokens)
  const parsedCounts = countWordFrequencies(parsedTokens)
  for (const [word, freq] of parsedCounts) {
    if (!rawSet.has(word) && !isNoiseToken(word) && word.length >= 4) {
      parsedOnly.push({ word, parsedFreq: freq })
    }
  }
  parsedOnly.sort((a, b) => b.parsedFreq - a.parsedFreq)

  return {
    rawTokenCount: rawTokens.length,
    parsedTokenCount: parsedTokens.length,
    rawUnique,
    rawUniquePresent,
    rawUniqueMissing: rawUnique - rawUniquePresent,
    parsedUnique: parsedSet.size,
    uniqueCoveragePct:
      rawUnique === 0 ? 100 : (rawUniquePresent / rawUnique) * 100,
    tokenCoveragePct:
      rawTokens.length === 0
        ? 100
        : (rawTokenHits / rawTokens.length) * 100,
    missingWords: missingByImpact.slice(0, maxReport),
    parsedOnlyWords: parsedOnly.slice(0, maxReport),
  }
}

function analyzeMissingPhrases(
  rawNorm,
  parsedNorm,
  rawTokens,
  options
) {
  const { minPhrase, maxPhrase, minPhraseFreq, maxReport } = options
  const phraseCounts = collectPhraseCounts(rawTokens, minPhrase, maxPhrase)
  const missing = []

  for (const [phrase, freq] of phraseCounts) {
    if (freq < minPhraseFreq) {
      continue
    }
    if (phraseInHaystack(phrase, parsedNorm)) {
      continue
    }
    if (isExpectedDroppedPhrase(phrase, freq)) {
      continue
    }
    missing.push({
      phrase,
      rawFreq: freq,
      score: freq * phrase.split(/\s+/).length,
    })
  }

  missing.sort((a, b) => b.score - a.score)

  const deduped = []
  const seen = new Set()
  for (const entry of missing) {
    const key = entry.phrase
    if (seen.has(key)) {
      continue
    }
    let dominated = false
    for (const kept of deduped) {
      if (kept.phrase.includes(key) || key.includes(kept.phrase)) {
        dominated = true
        break
      }
    }
    if (!dominated) {
      deduped.push(entry)
      seen.add(key)
    }
    if (deduped.length >= maxReport) {
      break
    }
  }

  return deduped
}

async function diffOnePdf(pdfPath, options) {
  const { parsePdfBuffer, normalizeExtractedText, PARSER_VERSION } =
    await import("../index.js")
  const buffer = readFileSync(pdfPath)
  const basename = path.basename(pdfPath)

  const [rawText, parseResult] = await Promise.all([
    extractRawPdfText(buffer),
    parsePdfBuffer(buffer, basename),
  ])

  const parsedText = (parseResult.contentWithChapters ?? [])
    .flatMap((page) => page.blocks ?? [])
    .map((block) => block.text ?? "")
    .join(" ")

  const rawClean = normalizeExtractedText(rawText)
  const parsedClean = normalizeExtractedText(parsedText)
  const rawNorm = normalizeText(rawClean)
  const parsedNorm = normalizeText(parsedClean)
  const rawTokens = tokenize(rawNorm)
  const parsedTokens = tokenize(parsedNorm)

  const words = analyzeWordOverlap(rawTokens, parsedTokens, options.maxReport)
  const missingPhrases = analyzeMissingPhrases(
    rawNorm,
    parsedNorm,
    rawTokens,
    options
  )

  return {
    file: basename,
    path: pdfPath,
    parserVersion: PARSER_VERSION,
    chapters: parseResult.chapters?.length ?? 0,
    blocks:
      parseResult.contentWithChapters?.reduce(
        (n, page) => n + (page.blocks?.length ?? 0),
        0
      ) ?? 0,
    words,
    missingPhrases,
    pass:
      words.uniqueCoveragePct >= (options.failUnder || 0) &&
      missingPhrases.length === 0,
  }
}

function printReport(report, options) {
  const { words, missingPhrases } = report
  console.log(`\n=== ${report.file} ===`)
  console.log(`Parser version: ${report.parserVersion}`)
  console.log(`Chapters: ${report.chapters}  Blocks: ${report.blocks}`)
  console.log("")
  console.log("Word counts (fair compare — both sides text-normalized):")
  console.log(`  Raw PDF (normalized):     ${words.rawTokenCount}`)
  console.log(`  Parsed output:            ${words.parsedTokenCount}`)
  console.log(`  Unique raw words:         ${words.rawUnique}`)
  console.log(`  Unique parsed words:      ${words.parsedUnique}`)
  console.log("")
  console.log("Coverage (raw present in parsed):")
  console.log(
    `  By unique word: ${words.uniqueCoveragePct.toFixed(1)}%  (${words.rawUniqueMissing} raw unique not in parsed)`
  )
  console.log(`  By token:       ${words.tokenCoveragePct.toFixed(1)}%`)

  if (words.missingWords.length > 0) {
    console.log("")
    console.log(
      `Top missing words in raw (not stopwords/page nums), up to ${options.maxReport}:`
    )
    for (const { word, rawFreq } of words.missingWords) {
      console.log(`  - ${word} (×${rawFreq} in raw)`)
    }
  } else {
    console.log("")
    console.log("Missing content words: none flagged")
  }

  if (words.parsedOnlyWords.length > 0) {
    console.log("")
    console.log(
      `Words only in parsed (possible merge artifacts), up to ${options.maxReport}:`
    )
    for (const { word, parsedFreq } of words.parsedOnlyWords) {
      console.log(`  - ${word} (×${parsedFreq} in parsed)`)
    }
  }

  if (missingPhrases.length > 0) {
    console.log("")
    console.log(
      `Missing phrases (${options.minPhrase}-${options.maxPhrase} words, freq ≥ ${options.minPhraseFreq} in raw):`
    )
    for (const { phrase, rawFreq } of missingPhrases) {
      console.log(`  - [×${rawFreq}] "${phrase}"`)
    }
  } else {
    console.log("")
    console.log("Missing repeated phrases: none flagged")
  }

  const coverageOk =
    options.failUnder <= 0 || words.uniqueCoveragePct >= options.failUnder
  const phrasesOk = missingPhrases.length === 0
  console.log("")
  if (coverageOk && phrasesOk) {
    console.log("Status: OK (no high-signal gaps flagged)")
  } else if (!coverageOk) {
    console.log(
      `Status: FAIL (unique-word coverage ${words.uniqueCoveragePct.toFixed(1)}% < ${options.failUnder}%)`
    )
  } else {
    console.log(
      `Status: REVIEW (${missingPhrases.length} missing phrase(s) — use --strict to fail CI)`
    )
  }
}

function listAssetPdfs() {
  if (!existsSync(ASSETS_DIR)) {
    return []
  }
  return readdirSync(ASSETS_DIR)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .map((name) => path.join(ASSETS_DIR, name))
    .sort((a, b) => a.localeCompare(b))
}

const options = parseArgs(process.argv.slice(2))

if (options.help) {
  printHelp()
  process.exit(0)
}

let pdfPaths = options.paths
if (options.all) {
  pdfPaths = listAssetPdfs()
}
if (pdfPaths.length === 0) {
  pdfPaths = [path.join(ASSETS_DIR, "orwell1984.pdf")]
}

const reports = []
let exitCode = 0

for (const pdfPath of pdfPaths) {
  if (!existsSync(pdfPath)) {
    console.error(`File not found: ${pdfPath}`)
    exitCode = 1
    continue
  }

  try {
    const report = await diffOnePdf(pdfPath, options)
    reports.push(report)
    printReport(report, options)

    if (
      options.failUnder > 0 &&
      report.words.uniqueCoveragePct < options.failUnder
    ) {
      exitCode = 1
    }
    if (options.strict && report.missingPhrases.length > 0) {
      exitCode = 1
    }
  } catch (error) {
    console.error(`\nFailed: ${pdfPath}`)
    console.error(error)
    exitCode = 1
  }
}

if (options.jsonPath) {
  writeFileSync(options.jsonPath, JSON.stringify({ reports }, null, 2), "utf8")
  console.log(`\nWrote JSON report to ${options.jsonPath}`)
}

if (reports.length > 1) {
  console.log("\n=== Summary ===")
  for (const r of reports) {
    const phraseFlag = r.missingPhrases.length > 0 ? " phrases!" : ""
    console.log(
      `  ${r.file}: ${r.words.uniqueCoveragePct.toFixed(1)}% unique coverage, ${r.missingPhrases.length} missing phrase(s)${phraseFlag}`
    )
  }
}

process.exit(exitCode)
