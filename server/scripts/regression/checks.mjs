/**
 * General parser regression checks. Each returns { pass, failures, summary? }.
 */

const DANGLING_ENDING_WORDS =
  /\b(?:of|the|a|an|and|but|or|nor|for|yet|so|left|fell|was|be|in|to|with|from|at|by|on|as|into|upon|about|over|after|before|through)\s*$/i

const CONTINUATION_PRONOUN_START =
  /^(?:he|she|it|they|his|her|its|their|who|which)\b/i

const TERMINAL_PUNCTUATION_REGEX = /[.!?][\u201d"\u2019']?\s*$/

const QUOTE_START_REGEX = /^[\u201c\u2018"']/

const EBOOK_WATERMARK_SITE_REGEX =
  /\b(?:asiaing|e-?books?(?:directory|dictionary|archive)?)(?:\.(?:com|net|org|info))?\b/i

const MAX_FAILURES_PER_CHECK = 100

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

function isAcceptableChapterTitle(title) {
  const trimmed = (title ?? "").trim()
  if (!trimmed) {
    return false
  }

  if (/^chapter\s+\d+\.?$/i.test(trimmed)) {
    return true
  }

  if (/—\s*Chapter\s+\d+\.?\s*$/i.test(trimmed)) {
    return true
  }

  if (/^(?:VOLUME|Volume|BOOK|Book|PART|Part)\b/i.test(trimmed)) {
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

    if (/^To\s+.+\s+And$/i.test(text)) {
      return
    }

    if (/[,;:\u2014\u2013\u2026-]\s*$/.test(text) || DANGLING_ENDING_WORDS.test(text)) {
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

    if (CONTINUATION_PRONOUN_START.test(text)) {
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
  if (!config?.rawWordCount) {
    return {
      pass: true,
      failures: [],
      skipped: true,
      summary: "skipped (pdftotext unavailable)",
    }
  }

  const parsedWords = countWordsInBlocks(blocks)
  const rawWords = config.rawWordCount
  const ratio = rawWords > 0 ? parsedWords / rawWords : 1
  const percent = (ratio * 100).toFixed(1)
  const summary = `${parsedWords.toLocaleString()} parsed vs ${rawWords.toLocaleString()} raw (${percent}%)`

  if (ratio < 0.85) {
    return {
      pass: false,
      failures: [
        `Word count: ${parsedWords} parsed vs ${rawWords} raw (${percent}%) — below 85% threshold`,
      ],
      summary,
    }
  }

  return result([], summary)
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
    if (!title || title.length < 2) {
      failures.push(`[chapter ${index}] Suspicious title: '${title}'`)
      return
    }

    if (title.length > 150) {
      failures.push(`[chapter ${index}] Suspicious title: '${truncate(title, 80)}'`)
      return
    }

    const looksLikeProseSentence =
      /[.!?]\s*$/.test(title) && !isAcceptableChapterTitle(title)

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

export function noTocLeakage(blocks) {
  const failures = []
  const cutoff = Math.max(1, Math.floor(blocks.length * 0.05))
  const prefix = blocks.slice(0, cutoff)

  let run = 0
  let maxRun = 0

  for (const block of prefix) {
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
