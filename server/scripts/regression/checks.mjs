/**
 * General parser regression checks. Each returns { pass, failures, summary? }.
 */

import {
  NARRATIVE_BODY_ANCHORS,
  WORD_COUNT_BODY_FLOOR,
  countWordsInText,
  sliceNarrativeBody,
} from "./wordCountBody.mjs"

const DANGLING_ENDING_WORDS =
  /\b(?:of|the|a|an|and|but|or|nor|for|yet|so|left|fell|was|be|in|to|with|from|at|by|on|as|into|upon|about|over|after|before|through)\s*$/i

const CONTINUATION_PRONOUN_START =
  /^(?:he|she|it|they|his|her|its|their|who|which)\b/i

const TERMINAL_PUNCTUATION_REGEX = /[.!?][\u201d"\u2019']?\s*$/

const QUOTE_START_REGEX = /^[\u201c\u2018"']/

const EBOOK_WATERMARK_SITE_REGEX =
  /\b(?:asiaing|e-?books?(?:directory|dictionary|archive)?)(?:\.(?:com|net|org|info))?\b/i

const MAX_FAILURES_PER_CHECK = 100

const CHAPTER_WORD_NUMBERS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty"

const STRUCTURAL_HEADING_WORDS =
  "chapter|letter|part|section|book|volume|preface|introduction|prologue|epilogue|conclusion|appendix|stave"

// Mirrors the shape of the parser's own chapter-heading detection in
// server/index.js (CHAPTER_PATTERN / CHAPTER_ONLY_HEADING_REGEX /
// CHAPTER_WITH_SUBTITLE_REGEX): a bare structural label like "Chapter 5" or
// "Part One".
const STRUCTURAL_HEADING_BARE_REGEX = new RegExp(
  `^(?:${STRUCTURAL_HEADING_WORDS})\\s+(?:\\d{1,3}|[ivxlcdm]+|${CHAPTER_WORD_NUMBERS})\\.?\\s*$`,
  "i"
)

// A structural label with a subtitle, e.g. "Chapter LXIII - Cutting In" or
// "Chapter 5 - Oliver Mingles With New Associates." - the subtitle's own
// grammar (dangling prepositions, length, mid-clause punctuation) says
// nothing about whether the block itself is mid-sentence prose.
const STRUCTURAL_HEADING_WITH_SUBTITLE_REGEX = new RegExp(
  `^(?:${STRUCTURAL_HEADING_WORDS})\\s+(?:\\d{1,3}|[ivxlcdm]+|${CHAPTER_WORD_NUMBERS})\\s*[-\\u2014\\u2013]\\s+\\S`,
  "i"
)

// Non-numbered structural sections that are also never mid-sentence prose.
const NON_NUMBERED_STRUCTURAL_HEADING_REGEX =
  /^(?:preface|introduction|prologue|epilogue|conclusion|dedication|contents)\.?$/i

function isStructuralChapterHeading(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }

  return (
    STRUCTURAL_HEADING_BARE_REGEX.test(trimmed) ||
    STRUCTURAL_HEADING_WITH_SUBTITLE_REGEX.test(trimmed) ||
    NON_NUMBERED_STRUCTURAL_HEADING_REGEX.test(trimmed)
  )
}

function blockText(block) {
  return (block?.text ?? "").trim()
}

function isProseBlock(block) {
  return block && !block.isHeading
}

function frontMatterBlockCount(blocks) {
  const chapterIndex = blocks.findIndex((block) =>
    /^(?:CHAPTER|Chapter|PART|Part|BOOK|Book|LETTER|Letter)\b/.test(
      blockText(block)
    )
  )

  if (chapterIndex > 0) {
    return chapterIndex
  }

  return Math.min(25, Math.max(5, Math.floor(blocks.length * 0.03)))
}

const CHAPTER_NUMBER_PATTERN = `(?:\\d{1,3}|[IVXLCDM]+|${CHAPTER_WORD_NUMBERS})`

const ACCEPTABLE_BARE_CHAPTER_REGEX = new RegExp(
  `^chapter\\s+${CHAPTER_NUMBER_PATTERN}\\.?$`,
  "i"
)

const ACCEPTABLE_CHAPTER_WITH_SUBTITLE_REGEX = new RegExp(
  `^chapter\\s+${CHAPTER_NUMBER_PATTERN}\\s*[-\\u2014\\u2013]\\s+\\S`,
  "i"
)

function isBareRomanNumeralTitle(title) {
  return /^(?:Part\s+)?[IVXLCDM]{1,6}\.?$/i.test((title ?? "").trim())
}

function endsWithAbbreviation(title) {
  return /(?:\b(?:Mr|Mrs|Ms|Miss|Dr|St|Jr|Sr|Prof)\.|\b[A-Z]\.)\s*$/.test(
    (title ?? "").trim()
  )
}

function isAcceptableChapterTitle(title) {
  const trimmed = (title ?? "").trim()
  if (!trimmed) {
    return false
  }

  if (ACCEPTABLE_BARE_CHAPTER_REGEX.test(trimmed)) {
    return true
  }

  if (ACCEPTABLE_CHAPTER_WITH_SUBTITLE_REGEX.test(trimmed)) {
    return true
  }

  if (/—\s*Chapter\s+\d+\.?\s*$/i.test(trimmed)) {
    return true
  }

  if (/^(?:VOLUME|Volume|BOOK|Book|PART|Part)\b/i.test(trimmed)) {
    return true
  }

  if (isBareRomanNumeralTitle(trimmed)) {
    return true
  }

  return false
}

function isMostlyAllCapsTitleLine(text) {
  const letters = text.replace(/[^A-Za-z]/g, "")
  if (letters.length < 4) {
    return false
  }
  const upper = letters.replace(/[^A-Z]/g, "").length
  return upper / letters.length >= 0.85
}

function countWordsInBlocks(blocks) {
  return blocks.reduce((total, block) => {
    const text = block?.text ?? ""
    const words = text.trim().split(/\s+/).filter(Boolean)
    return total + words.length
  }, 0)
}

function isKnownShortDialogue(text) {
  const trimmed = text.trim()
  if (!trimmed) {
    return false
  }

  if (QUOTE_START_REGEX.test(trimmed)) {
    return true
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length > 10) {
    return false
  }
  return TERMINAL_PUNCTUATION_REGEX.test(trimmed)
}

function isTitleCaseHeading(text) {
  const words = String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) {
    return false
  }
  return words.every((word) => {
    const letters = word.replace(/[^A-Za-z]/g, "")
    if (letters.length === 0) {
      return true
    }
    return letters[0] === letters[0].toUpperCase()
  })
}

export function noMidSentenceHeadings(blocks) {
  const failures = []

  blocks.forEach((block, index) => {
    if (!block?.isHeading) {
      return
    }

    const text = blockText(block)
    if (!text) {
      return
    }

    if (isStructuralChapterHeading(text)) {
      return
    }

    if (/^To\s+.+\s+And$/i.test(text)) {
      return
    }

    // Cover/title-page byline, e.g. "by Robert Louis Stevenson". Requires a
    // capital after "by" so "by the time he arrived" still flags.
    if (/^by\s+[A-Z]/.test(text)) {
      return
    }

    const wordCount = text.split(/\s+/).filter(Boolean).length
    const titleCase = isTitleCaseHeading(text)
    const dangling =
      /[,;:\u2014\u2013\u2026-]\s*$/.test(text) || DANGLING_ENDING_WORDS.test(text)

    if (dangling && !(titleCase && wordCount === 1)) {
      failures.push(`[block ${index}] False heading: '${truncate(text)}'`)
      return
    }

    if (
      /^[a-z]/.test(text) &&
      !TERMINAL_PUNCTUATION_REGEX.test(text) &&
      !/[\u201d"\u2019']\s*$/.test(text)
    ) {
      failures.push(`[block ${index}] False heading: '${truncate(text)}'`)
      return
    }

    if (text.length > 120) {
      failures.push(`[block ${index}] False heading: '${truncate(text)}'`)
      return
    }

    if (CONTINUATION_PRONOUN_START.test(text) && !titleCase) {
      failures.push(`[block ${index}] False heading: '${truncate(text)}'`)
    }
  })

  return result(failures)
}

export function noOrphanedFragments(blocks) {
  const failures = []
  const frontMatterEnd = frontMatterBlockCount(blocks)

  blocks.forEach((block, index) => {
    if (failures.length >= MAX_FAILURES_PER_CHECK) {
      return
    }
    if (!isProseBlock(block)) {
      return
    }

    const text = blockText(block)
    if (!text) {
      return
    }

    const prev = index > 0 ? blocks[index - 1] : null
    const wordCount = text.split(/\s+/).filter(Boolean).length

    if (index < frontMatterEnd || isMostlyAllCapsTitleLine(text)) {
      return
    }

    if (
      text.length < 60 &&
      wordCount < 12 &&
      !TERMINAL_PUNCTUATION_REGEX.test(text) &&
      !isKnownShortDialogue(text) &&
      !/["'\u201c\u2018\u201d\u2019]/.test(text)
    ) {
      failures.push(`[block ${index}] Orphaned fragment: '${truncate(text)}'`)
    }

    if (
      /^[a-z]/.test(text) &&
      prev &&
      isProseBlock(prev) &&
      !TERMINAL_PUNCTUATION_REGEX.test(blockText(prev))
    ) {
      failures.push(`[block ${index}] Orphaned fragment: '${truncate(text)}'`)
    }
  })

  return result(failures)
}

export function paragraphContinuity(blocks) {
  const failures = []
  const frontMatterEnd = frontMatterBlockCount(blocks)

  for (let index = 1; index < blocks.length; index += 1) {
    if (failures.length >= MAX_FAILURES_PER_CHECK) {
      break
    }
    if (index <= frontMatterEnd) {
      continue
    }
    const blockA = blocks[index - 1]
    const blockB = blocks[index]

    if (!isProseBlock(blockA) || !isProseBlock(blockB)) {
      continue
    }

    const endA = blockText(blockA)
    const startB = blockText(blockB)

    if (!endA || !startB) {
      continue
    }

    if (/["'\u201c\u2018]\s*$/.test(endA)) {
      continue
    }

    if (isMostlyAllCapsTitleLine(endA) || isMostlyAllCapsTitleLine(startB)) {
      continue
    }

    const definiteSplit =
      !TERMINAL_PUNCTUATION_REGEX.test(endA) &&
      /^[a-z]/.test(startB) &&
      !QUOTE_START_REGEX.test(startB)

    const commaSplit =
      /,\s*$/.test(endA) && !QUOTE_START_REGEX.test(startB)

    if (definiteSplit || commaSplit) {
      failures.push(
        `[blocks ${index - 1}-${index}] Likely split paragraph: '...${truncate(endA, 40)}' / '${truncate(startB, 40)}'`
      )
    }
  }

  return result(failures)
}

export function headingDensitySane(blocks) {
  const failures = []
  const proseBlocks = blocks.filter(isProseBlock)
  const headingBlocks = blocks.filter((block) => block?.isHeading)

  if (proseBlocks.length > 0) {
    const perHundred = (headingBlocks.length / proseBlocks.length) * 100
    const maxPerHundred = 100 / 15

    if (perHundred > maxPerHundred) {
      failures.push(
        `Heading density too high: ${headingBlocks.length} headings per ${proseBlocks.length} prose blocks (${perHundred.toFixed(1)} per 100 prose, max ${maxPerHundred.toFixed(1)})`
      )
    }
  }

  const windowSize = 20
  const frontMatterEnd = frontMatterBlockCount(blocks)

  for (
    let start = frontMatterEnd;
    start <= blocks.length - windowSize;
    start += 1
  ) {
    const window = blocks.slice(start, start + windowSize)
    const headingCount = window.filter((block) => block?.isHeading).length
    if (headingCount > 3) {
      failures.push(
        `Heading density too high: ${headingCount} headings in blocks ${start}-${start + windowSize - 1}`
      )
      break
    }
  }

  const summary =
    proseBlocks.length > 0
      ? `${headingBlocks.length} headings / ${proseBlocks.length} prose blocks`
      : `${headingBlocks.length} headings`

  return result(failures, summary)
}

export function wordCountVsRaw(blocks, config) {
  if (config?.rawWordCount == null && config?.rawText == null) {
    const reason =
      config?.pdftotextError ??
      "pdftotext is not available (install Poppler and put pdftotext on PATH)"
    return {
      pass: false,
      failures: [
        `Word-count-vs-raw truncation check could not run: ${reason}. This check is required and is not skippable.`,
      ],
      summary: reason,
    }
  }

  const rawText = config?.rawText
  const bookId = config?.bookId
  const anchors =
    config?.wordCountBody ??
    (bookId ? NARRATIVE_BODY_ANCHORS[bookId] : null)

  let parsedWords
  let rawWords
  let scopeLabel = "full document"

  if (rawText != null && anchors) {
    const rawBody = sliceNarrativeBody(rawText, anchors)
    const parsedJoined = (blocks ?? [])
      .map((block) => block?.text ?? "")
      .join("\n")
    const parsedBody = sliceNarrativeBody(parsedJoined, anchors)

    if (rawBody.error || parsedBody.error) {
      const reason = rawBody.error || parsedBody.error
      return {
        pass: false,
        failures: [
          `Word-count-vs-raw body window could not be located: ${reason}`,
        ],
        summary: reason,
      }
    }

    parsedWords = countWordsInText(parsedBody.slice)
    rawWords = countWordsInText(rawBody.slice)
    scopeLabel = "body"
  } else {
    parsedWords = countWordsInBlocks(blocks)
    rawWords = config.rawWordCount
  }

  const ratio = rawWords > 0 ? parsedWords / rawWords : 1
  const percent = (ratio * 100).toFixed(1)
  const floorPercent = (WORD_COUNT_BODY_FLOOR * 100).toFixed(0)
  const summary = `${parsedWords.toLocaleString()} parsed vs ${rawWords.toLocaleString()} raw ${scopeLabel} (${percent}%)`

  if (ratio < WORD_COUNT_BODY_FLOOR) {
    return {
      pass: false,
      failures: [
        `Word count: ${parsedWords} parsed vs ${rawWords} raw ${scopeLabel} (${percent}%) - below ${floorPercent}% threshold`,
      ],
      summary,
    }
  }

  return result([], summary)
}

/**
 * Asserts that a block's sourcePdfPageIndex is a member of its recorded
 * constituent-line provenance set (sourcePdfPageProvenance).
 *
 * "Consistent" means:
 *   - sourcePdfPageProvenance is a non-empty array of PDF page indexes whose
 *     extracted lines were merged into this block during parse, and
 *   - block.sourcePdfPageIndex is an element of that set.
 *
 * Cross-page paragraph wraps pass because the first page remains in the set.
 * Merge and reorder bugs surface when attribution drifts outside the set.
 *
 * Synthetic blocks (injectCoverTitlePage and similar) carry an explicit empty
 * provenance array and are exempt. Missing provenance on a non-image block is
 * its own failure (not silently skipped).
 */
export function sourcePdfPageIndexConsistentWithProvenance(blocks) {
  const failures = []

  let synthCount = 0
  let mergeCount = 0
  let reorderCount = 0
  let missingProvenanceCount = 0

  blocks.forEach((block, blockIndex) => {
    if (!block || block.type === "image") {
      return
    }

    const srcPage = block?.sourcePdfPageIndex
    if (!Number.isFinite(srcPage)) {
      return
    }

    const provenance = block?.sourcePdfPageProvenance

    if (block?.isTitlePage === true) {
      synthCount += 1
      return
    }

    if (Array.isArray(provenance) && provenance.length === 0) {
      synthCount += 1
      return
    }

    if (!Array.isArray(provenance) || provenance.length === 0) {
      missingProvenanceCount += 1
      failures.push(
        `[block ${blockIndex}] missing sourcePdfPageProvenance text='${truncate(block?.text ?? "", 100)}'`
      )
      return
    }

    if (provenance.includes(srcPage)) {
      return
    }

    const text = block?.text ?? ""
    const firstConstituent = Math.min(...provenance)
    const category = provenance.length > 1 ? "MERGE" : "REORDER"
    if (category === "MERGE") {
      mergeCount += 1
    } else {
      reorderCount += 1
    }

    failures.push(
      `[block ${blockIndex}] [${category}] src=${srcPage} provenance=[${provenance.join(",")}] firstConstituent=${firstConstituent} text='${truncate(text, 140)}'`
    )
  })

  const parts = [
    `violations: reorder=${reorderCount}, merge=${mergeCount}`,
    `syntheticSkipped=${synthCount}`,
  ]
  if (missingProvenanceCount > 0) {
    parts.push(`missingProvenance=${missingProvenanceCount}`)
  }

  const summary = parts.join(", ")
  return result(failures, failures.length ? summary : "no violations found")
}

function flattenContentBlocksForPageRanges(contentWithChapters) {
  const items = []
  for (const page of contentWithChapters ?? []) {
    const pageBlocks = page.blocks ?? []
    for (let blockIndex = 0; blockIndex < pageBlocks.length; blockIndex += 1) {
      items.push({
        pageIndex: page.pageIndex,
        blockIndex,
        block: pageBlocks[blockIndex],
      })
    }
  }
  return items
}

function sourcePdfPageRange(blocks) {
  const pages = (blocks ?? [])
    .map((block) => block?.sourcePdfPageIndex)
    .filter((page) => Number.isFinite(page))
  if (pages.length === 0) {
    return { pageMin: null, pageMax: null }
  }
  return {
    pageMin: Math.min(...pages),
    pageMax: Math.max(...pages),
  }
}

/**
 * Same chapterOrder slicing the snapshots use: reading-order spans from each
 * TOC entry's content-stream start to the next entry. Front matter is the
 * prefix before the first entry and is not part of this sequence.
 */
function chapterOrderPageRanges(contentWithChapters, chapters) {
  const flat = flattenContentBlocksForPageRanges(contentWithChapters)
  const starts = (chapters ?? []).map((chapter) => {
    const index = flat.findIndex(
      (item) =>
        item.pageIndex === chapter.pageIndex &&
        item.blockIndex === chapter.blockIndex
    )
    return { chapter, index }
  })

  return starts.map((start, orderIndex) => {
    const title = (start.chapter?.title ?? "").trim() || `(untitled ${orderIndex})`
    if (start.index < 0) {
      return {
        orderIndex,
        title,
        pageMin: null,
        pageMax: null,
        missingStart: true,
      }
    }

    let end = flat.length
    for (const other of starts) {
      if (other.index > start.index && other.index < end) {
        end = other.index
      }
    }

    const range = sourcePdfPageRange(
      flat.slice(start.index, end).map((item) => item.block)
    )
    return {
      orderIndex,
      title,
      pageMin: range.pageMin,
      pageMax: range.pageMax,
      missingStart: false,
    }
  })
}

/**
 * TOC entries must not step backwards in sourcePdfPageIndex order.
 *
 * Front matter is not in this sequence (it sits before the first chapter by
 * construction). Equal pageMin is allowed - a part heading and its first
 * chapter often share a page. Entries with no finite sourcePdfPageIndex are
 * failures, not skips: an unanchored TOC slot cannot be shown to be in order.
 * Cover-title and scene-break blocks are not TOC entries, so they never
 * appear here.
 */
export function chapterOrderPagesMonotonic(blocks, config) {
  const failures = []
  const entries = chapterOrderPageRanges(
    config?.contentWithChapters,
    config?.chapters
  )

  if (entries.length <= 1) {
    return result(failures, "fewer than 2 TOC entries")
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.missingStart) {
      failures.push(
        `[${index}] '${truncate(entry.title, 80)}' has no content-stream start`
      )
      continue
    }
    if (!Number.isFinite(entry.pageMin) || !Number.isFinite(entry.pageMax)) {
      failures.push(
        `[${index}] '${truncate(entry.title, 80)}' has no sourcePdfPageIndex range`
      )
      continue
    }
    if (entry.pageMax < entry.pageMin) {
      failures.push(
        `[${index}] '${truncate(entry.title, 80)}' inverted range ${entry.pageMin}-${entry.pageMax}`
      )
    }
  }

  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]
    const current = entries[index]
    if (!Number.isFinite(previous.pageMin) || !Number.isFinite(current.pageMin)) {
      continue
    }

    if (current.pageMin < previous.pageMin) {
      failures.push(
        `[${index}] '${truncate(current.title, 80)}' pageMin ${current.pageMin} sits behind [${index - 1}] '${truncate(previous.title, 80)}' ${previous.pageMin}-${previous.pageMax}`
      )
      continue
    }

    if (
      Number.isFinite(current.pageMax) &&
      Number.isFinite(previous.pageMin) &&
      current.pageMax < previous.pageMin
    ) {
      failures.push(
        `[${index}] '${truncate(current.title, 80)}' range ${current.pageMin}-${current.pageMax} sits entirely behind [${index - 1}] '${truncate(previous.title, 80)}' ${previous.pageMin}-${previous.pageMax}`
      )
    }
  }

  return result(
    failures,
    failures.length
      ? `${failures.length} TOC page-order step(s)`
      : `${entries.length} TOC entries monotonic`
  )
}

export function chapterStructureSane(blocks, config) {
  const failures = []
  const chapters = config?.chapters ?? []
  const pageCount = config?.pageCount ?? 0

  if (pageCount > 50 && chapters.length < 1) {
    failures.push("No chapters detected for book over 50 pages")
  }

  const titles = chapters.map((chapter) => (chapter?.title ?? "").trim())

  titles.forEach((title, index) => {
    if (!title) {
      failures.push(`[chapter ${index}] Suspicious title: '${title}'`)
      return
    }

    if (title.length < 2 && !isBareRomanNumeralTitle(title)) {
      failures.push(`[chapter ${index}] Suspicious title: '${title}'`)
      return
    }

    if (title.length > 400) {
      failures.push(`[chapter ${index}] Suspicious title: '${truncate(title, 80)}'`)
      return
    }

    if (title.length > 150 && !isAcceptableChapterTitle(title)) {
      failures.push(`[chapter ${index}] Suspicious title: '${truncate(title, 80)}'`)
      return
    }

    // Period-terminated titles only. Exclamatory and interrogative titles
    // (Tiger! Tiger!, Ain't That Bad?) are legitimate printed headings.
    const looksLikeProseSentence =
      /\.\s*$/.test(title) &&
      !isAcceptableChapterTitle(title) &&
      !endsWithAbbreviation(title)

    if (looksLikeProseSentence) {
      failures.push(`[chapter ${index}] Suspicious title: '${truncate(title, 80)}'`)
    }
  })

  for (let index = 1; index < titles.length; index += 1) {
    if (titles[index] && titles[index] === titles[index - 1]) {
      failures.push(
        `[chapter ${index}] Suspicious title: duplicate of previous ('${truncate(titles[index], 60)}')`
      )
    }
  }

  return result(failures)
}

// Heading-styled blocks that legitimately cluster in front matter: the cover
// title and author byline that injectCoverTitlePage synthesizes (both marked
// isTitlePage), plus the source title page's own byline and dedication lines.
// Several of these in a row is normal front matter, not leaked contents text.
//
// The byline/dedication test intentionally mirrors isDedicationAddresseeLine in
// server/index.js, added for the stripPublisherCatalogBlocks fix. It is
// duplicated rather than imported because checks.mjs is dependency-free -
// importing server/index.js would start the Express app and require Supabase
// credentials just to run the checks. Keep the two in sync.
function isFrontMatterHeadingBlock(block) {
  if (block?.isTitlePage === true) {
    return true
  }

  return /^(?:to|by)\s+[a-z]/i.test(String(block?.text ?? "").trim())
}

export function noTocLeakage(blocks) {
  const failures = []
  const cutoff = Math.max(1, Math.floor(blocks.length * 0.05))
  const prefix = blocks.slice(0, cutoff)

  let run = 0
  let maxRun = 0

  for (const block of prefix) {
    // Front matter is transparent to the run: it neither extends a run nor
    // breaks one. Breaking would let a genuine contents leak escape detection
    // whenever one of its entries happened to be dedication-shaped ("To the
    // Lighthouse"), which is the shape this check does still catch.
    if (block?.isHeading && isFrontMatterHeadingBlock(block)) {
      continue
    }

    if (block?.isHeading) {
      run += 1
      maxRun = Math.max(maxRun, run)
    } else {
      run = 0
    }
  }

  if (maxRun >= 5) {
    failures.push(
      `Possible TOC leakage: ${maxRun} consecutive headings in first ${cutoff} blocks`
    )
  }

  return result(failures)
}

export function indentationConsistency(blocks, config) {
  const failures = []
  const proseBlocks = blocks.filter(isProseBlock)

  if (proseBlocks.length < 10) {
    return result([], "insufficient prose blocks to sample")
  }

  const start = Math.floor(proseBlocks.length * 0.25)
  const end = Math.floor(proseBlocks.length * 0.75)
  const middle = proseBlocks.slice(start, end)

  const sampleSize = Math.min(50, middle.length)
  const sampled = pickRandom(middle, sampleSize, config?.sampleRng)
  const indentedCount = sampled.filter((block) => block.isIndented).length
  const rate = sampled.length > 0 ? indentedCount / sampled.length : 0
  const percent = Math.round(rate * 100)
  const summary = `${percent}% of sampled blocks indented`

  if (rate < 0.2 || rate > 0.8) {
    failures.push(`Indentation rate suspicious: ${percent}% of sampled blocks indented`)
  }

  return result(failures, summary)
}

export function noEmptyBlocks(blocks) {
  const failures = []

  blocks.forEach((block, index) => {
    if (block?.type === "image") {
      return
    }

    const text = block?.text ?? ""
    if (!text.trim()) {
      failures.push(`[block ${index}] Empty block`)
    }
  })

  return result(failures)
}

const DIALOGUE_ATTRIBUTION_CENTERED_REGEX =
  /^(?:(?:Mr\.|Mrs\.|Miss|Ms\.|Dr\.|Sir|Lady|Colonel|Captain|Professor)\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?[.!?]?$/

function isMostlyAllCapsLine(text) {
  const letters = text.replace(/[^A-Za-z]/g, "")
  if (letters.length < 4) {
    return false
  }
  const upper = letters.replace(/[^A-Z]/g, "").length
  return upper / letters.length >= 0.85
}

export function noScannerWatermarks(blocks) {
  const failures = []

  blocks.forEach((block, index) => {
    const text = blockText(block)
    if (!text) {
      return
    }
    if (
      EBOOK_WATERMARK_SITE_REGEX.test(text) ||
      /^ebd$/i.test(text)
    ) {
      failures.push(`[block ${index}] Scanner watermark: '${truncate(text)}'`)
    }
  })

  return result(failures)
}

export function noDialogueAttributionCentered(blocks) {
  const failures = []

  blocks.forEach((block, index) => {
    const text = blockText(block)
    if (!text || text.length > 40) {
      return
    }
    if (isMostlyAllCapsLine(text)) {
      return
    }
    if (!DIALOGUE_ATTRIBUTION_CENTERED_REGEX.test(text)) {
      return
    }
    if (block.textAlign === "center" || block.centered === true) {
      failures.push(
        `[block ${index}] Dialogue attribution centered: '${truncate(text)}'`
      )
    }
  })

  return result(failures)
}

export function dialogueSplitCheck(blocks) {
  const failures = []

  blocks.forEach((block, index) => {
    const text = blockText(block)
    if (!text || text.length >= 80 || !QUOTE_START_REGEX.test(text)) {
      return
    }

    if (index === 0) {
      return
    }

    const previous = blocks[index - 1]
    const prevText = blockText(previous)

    if (!prevText) {
      return
    }

    const prevIsDialogue = QUOTE_START_REGEX.test(prevText)
    const prevEndsParagraph = TERMINAL_PUNCTUATION_REGEX.test(prevText)

    if (
      isProseBlock(previous) &&
      !prevIsDialogue &&
      !prevEndsParagraph &&
      !/[,;:\u2014\u2013-]\s*$/.test(prevText)
    ) {
      failures.push(
        `[block ${index}] Dialogue may be split from surrounding prose: '${truncate(text)}'`
      )
    }
  })

  return result(failures)
}

/** Ordered registry for the runner. */
export const GENERAL_CHECKS = [
  { id: "noMidSentenceHeadings", label: "No mid-sentence headings", run: noMidSentenceHeadings },
  { id: "noScannerWatermarks", label: "No scanner watermarks", run: noScannerWatermarks },
  {
    id: "noDialogueAttributionCentered",
    label: "Dialogue attribution not centered",
    run: noDialogueAttributionCentered,
  },
  { id: "noOrphanedFragments", label: "No orphaned fragments", run: noOrphanedFragments },
  {
    id: "paragraphContinuity",
    label: "Paragraph continuity",
    run: paragraphContinuity,
  },
  {
    id: "headingDensitySane",
    label: "Heading density sane",
    run: headingDensitySane,
  },
  { id: "wordCountVsRaw", label: "Word count vs raw PDF", run: wordCountVsRaw },
  {
    id: "chapterStructureSane",
    label: "Chapter structure sane",
    run: chapterStructureSane,
  },
  { id: "noTocLeakage", label: "No TOC leakage", run: noTocLeakage },
  {
    id: "indentationConsistency",
    label: "Indentation consistent",
    run: indentationConsistency,
  },
  { id: "noEmptyBlocks", label: "No empty blocks", run: noEmptyBlocks },
  {
    id: "dialogueSplitCheck",
    label: "Dialogue split check",
    run: dialogueSplitCheck,
  },
  {
    id: "sourcePdfPageIndexConsistentWithProvenance",
    label: "Block sourcePdfPageIndex in provenance set",
    run: (blocks) => sourcePdfPageIndexConsistentWithProvenance(blocks),
  },
  {
    id: "chapterOrderPagesMonotonic",
    label: "TOC page ranges monotonic",
    run: chapterOrderPagesMonotonic,
  },
]

function result(failures, summary = undefined) {
  const truncated = failures.length >= MAX_FAILURES_PER_CHECK
  return {
    pass: failures.length === 0,
    failures,
    truncated,
    ...(summary !== undefined ? { summary } : {}),
  }
}

function truncate(text, max = 70) {
  const value = String(text ?? "")
  if (value.length <= max) {
    return value
  }
  return `${value.slice(0, max)}…`
}

function pickRandom(items, count, rng = Math.random) {
  if (items.length <= count) {
    return [...items]
  }

  const copy = [...items]
  const picked = []

  while (picked.length < count && copy.length > 0) {
    const index = Math.floor(rng() * copy.length)
    picked.push(copy.splice(index, 1)[0])
  }

  return picked
}

export { countWordsInBlocks, MAX_FAILURES_PER_CHECK }
