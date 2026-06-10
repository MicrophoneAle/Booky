/**
 * Heuristic chapter-graphic analysis — no vision LLM or paid API calls.
 * Uses PDF layout metrics plus nearby extracted text to classify illustration blocks.
 */

import { isPlausibleTitle } from "./imageOcrService.js"
import {
  lookupPrintedTocNumberLabel,
  lookupPrintedTocTitle,
} from "./printedTocService.js"

const SAFE_FALLBACK = Object.freeze({
  isChapterBoundary: false,
  boundaryKind: null,
  title: null,
  number: null,
  rawText: null,
})

const CHAPTER_LABEL_REGEX =
  /^(chapter|letter)\s+(\d{1,3}|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i

const CHAPTER_WITH_SUBTITLE_REGEX =
  /^(chapter|letter)\s+(\d{1,3}|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\s*[-:–—]\s+\S/i

const NON_CHAPTER_CAPTION_PATTERNS = [
  /^map of\b/i,
  /\bmap of\b/i,
  /^gallery of maps\b/i,
  /^detail of\b/i,
  /^relief of\b/i,
  /^charcoal rubbing of\b/i,
  /^circa \d{4}\.?$/i,
  /created by His Majesty/i,
  /by the painter/i,
  /^old friend,/i,
  /^scholar, circa/i,
  /^adolin, the visions/i,
]

const FRONT_MATTER_SERIES_MARKERS = [
  /^THE STORMLIGHT ARCHIVE$/i,
  /^THE WAY OF KINGS$/i,
]

const EPIGRAPH_PREFIX_REGEX = /^["'\u201c\u2018]|^—(?:Collected|Noted|Dated|Purports|Though|Kakashah|Tanatanev)/i

const INTERSTITIAL_TITLE_REGEX = /^[A-Z][A-Z0-9\s'’\-]{3,}$/

const MIN_CHAPTER_ILLUSTRATION_PAGE = 30
const MIN_CHAPTER_HEADING_BANNER_PAGE = 20

function normalizeNullableString(value) {
  if (value == null) {
    return null
  }

  const trimmed = String(value).trim()
  return trimmed.length > 0 ? trimmed : null
}

function logChapterGraphicDecision(message, context = {}) {
  if (process.env.BOOKY_CHAPTER_GRAPHIC_DEBUG === "1") {
    console.log("[chapterGraphicService]", JSON.stringify({ message, ...context }))
  }
}

function isCoverPageImage(imageBlock) {
  const width = imageBlock?.coordinates?.width ?? 0
  const height = imageBlock?.coordinates?.height ?? 0
  return imageBlock?.pageNumber === 1 && width >= 500 && height >= 700
}

function collectFollowingTextBlocks(blocks, blockIndex, limit = 10) {
  const results = []

  for (let index = blockIndex + 1; index < blocks.length && results.length < limit; index += 1) {
    const block = blocks[index]
    if (block?.type === "image") {
      break
    }

    const text = (block?.text ?? "").trim()
    if (text) {
      results.push({ block, text })
    }
  }

  return results
}

function countSamePageTextChars(blocks, imageBlock) {
  const pageIndex = Math.max(0, (imageBlock?.pageNumber ?? 1) - 1)
  let total = 0

  for (const block of blocks) {
    if (block?.type === "image") {
      continue
    }

    if ((block?.sourcePdfPageIndex ?? -1) === pageIndex) {
      total += (block?.text ?? "").length
    }
  }

  return total
}

function hasNonChapterCaption(followingBlocks) {
  return followingBlocks.some(({ text }) =>
    NON_CHAPTER_CAPTION_PATTERNS.some((pattern) => pattern.test(text))
  )
}

function isFrontMatterIllustration(followingBlocks) {
  return followingBlocks.some(({ text }) =>
    FRONT_MATTER_SERIES_MARKERS.some((pattern) => pattern.test(text))
  )
}

function findPreviousImageBlock(blocks, blockIndex) {
  for (let index = blockIndex - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block?.type === "image" || block?.type === "image_candidate") {
      return block
    }
  }

  return null
}

function isSpreadContinuation(blocks, blockIndex, imageBlock) {
  const pageNumber = imageBlock?.pageNumber ?? 0
  const previousImage = findPreviousImageBlock(blocks, blockIndex)

  return Boolean(previousImage && previousImage.pageNumber === pageNumber - 1)
}

function hasEpigraphFollowUp(followingBlocks) {
  return followingBlocks.some(({ text }) => EPIGRAPH_PREFIX_REGEX.test(text))
}

function hasInterstitialTitle(followingBlocks) {
  return followingBlocks.some(
    ({ text }) =>
      text.length <= 60 &&
      INTERSTITIAL_TITLE_REGEX.test(text) &&
      !/^THE\s/.test(text)
  )
}

function hasNarrativeFollowUp(followingBlocks) {
  return followingBlocks.some(
    ({ text }) => text.length >= 60 && /^[A-Z][a-z]/.test(text)
  )
}

function parseChapterLabel(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return null
  }

  if (CHAPTER_WITH_SUBTITLE_REGEX.test(trimmed) || CHAPTER_LABEL_REGEX.test(trimmed)) {
    return trimmed
  }

  return null
}

function extractChapterMetadata(
  followingBlocks,
  chapterSequence,
  { allowSequentialFallback = true } = {}
) {
  let title = null
  let number = null
  let rawText = null

  for (const { text } of followingBlocks) {
    const chapterLabel = parseChapterLabel(text)
    if (chapterLabel) {
      number = chapterLabel
      continue
    }

    if (!title && hasInterstitialTitle([{ text }])) {
      title = text
      continue
    }

    if (!rawText && EPIGRAPH_PREFIX_REGEX.test(text)) {
      rawText = text.length > 140 ? `${text.slice(0, 137)}...` : text
    }
  }

  if (!number && allowSequentialFallback) {
    number = `Chapter ${chapterSequence}`
  }

  return {
    title: normalizeNullableString(title),
    number: normalizeNullableString(number),
    rawText: normalizeNullableString(rawText),
  }
}

function shouldSkipChapterGraphicAnalysis(imageBlock, blocks, blockIndex) {
  if (isCoverPageImage(imageBlock)) {
    logChapterGraphicDecision("skip_cover", { pageNumber: imageBlock.pageNumber })
    return true
  }

  const followingBlocks = collectFollowingTextBlocks(blocks, blockIndex)

  if (hasNonChapterCaption(followingBlocks)) {
    logChapterGraphicDecision("skip_non_chapter_caption", {
      pageNumber: imageBlock.pageNumber,
    })
    return true
  }

  if (isFrontMatterIllustration(followingBlocks)) {
    logChapterGraphicDecision("skip_front_matter_illustration", {
      pageNumber: imageBlock.pageNumber,
    })
    return true
  }

  if (isSpreadContinuation(blocks, blockIndex, imageBlock)) {
    logChapterGraphicDecision("skip_spread_continuation", {
      pageNumber: imageBlock.pageNumber,
    })
    return true
  }

  return false
}

/**
 * Wide banner chapter headers (e.g. Stormlight arch + "CITY OF BELLS").
 * Title/number are usually embedded in the artwork; nearby text supplies epigraphs.
 */
function analyzeChapterHeadingBanner({
  imageBlock,
  blocks,
  blockIndex,
  chapterSequence = 1,
}) {
  if (shouldSkipChapterGraphicAnalysis(imageBlock, blocks, blockIndex)) {
    return { ...SAFE_FALLBACK }
  }

  const pageNumber = imageBlock.pageNumber ?? 0
  if (pageNumber < MIN_CHAPTER_HEADING_BANNER_PAGE) {
    logChapterGraphicDecision("skip_early_chapter_heading", { pageNumber })
    return { ...SAFE_FALLBACK }
  }

  const followingBlocks = collectFollowingTextBlocks(blocks, blockIndex)
  let rawText = null

  for (const { text } of followingBlocks) {
    if (EPIGRAPH_PREFIX_REGEX.test(text)) {
      rawText = text.length > 140 ? `${text.slice(0, 137)}...` : text
      break
    }
  }

  logChapterGraphicDecision("chapter_heading_banner", {
    pageNumber,
    chapterSequence,
  })

  return {
    isChapterBoundary: true,
    boundaryKind: "chapter",
    title: null,
    number: null,
    rawText: normalizeNullableString(rawText),
  }
}

/**
 * Full-page section dividers (PART N, INTERLUDES) detected via OCR.
 */
function analyzeFullPageSectionDivider(ocrMetadata) {
  if (!ocrMetadata?.boundaryKind) {
    return { ...SAFE_FALLBACK }
  }

  if (ocrMetadata.boundaryKind === "part" || ocrMetadata.boundaryKind === "interlude_divider") {
    return {
      isChapterBoundary: true,
      boundaryKind: ocrMetadata.boundaryKind,
      title: ocrMetadata.title ?? null,
      number: ocrMetadata.number ?? null,
      rawText: ocrMetadata.rawText ?? null,
    }
  }

  return { ...SAFE_FALLBACK }
}

/**
 * Merge local OCR + printed TOC into heuristic analysis.
 * Printed TOC titles win when available; OCR titles must pass plausibility checks.
 */
function mergeOcrIntoAnalysis(
  analysisResult,
  ocrMetadata,
  imageRole,
  { printedToc = null, chapterSequence = 1, interludeSequence = 1 } = {}
) {
  if (imageRole === "full_page_illustration" && ocrMetadata) {
    const section = analyzeFullPageSectionDivider(ocrMetadata)
    if (section.isChapterBoundary) {
      return section
    }
  }

  if (!ocrMetadata && !analysisResult?.isChapterBoundary) {
    return analysisResult
  }

  if (!analysisResult?.isChapterBoundary && imageRole !== "chapter_heading") {
    return analysisResult
  }

  const boundaryKind =
    ocrMetadata?.boundaryKind ??
    analysisResult.boundaryKind ??
    (imageRole === "chapter_heading" ? "chapter" : null)

  let number = ocrMetadata?.number ?? analysisResult.number ?? null
  let title = parseTitleFromOcr(ocrMetadata?.title) ?? analysisResult.title ?? null

  const lookupSequence =
    boundaryKind === "interlude" ? interludeSequence : chapterSequence

  const tocTitle = lookupPrintedTocTitle(printedToc, {
    number,
    boundaryKind,
    chapterSequence: lookupSequence,
  })
  const tocNumber = lookupPrintedTocNumberLabel(printedToc, {
    number,
    boundaryKind,
    chapterSequence: lookupSequence,
  })

  if (tocTitle) {
    title = tocTitle
  }

  if (tocNumber) {
    number = tocNumber
  }

  const rawText =
    number && title
      ? `${number}: ${title}`
      : number ?? title ?? analysisResult.rawText ?? null

  return {
    isChapterBoundary: true,
    boundaryKind,
    number,
    title,
    rawText,
  }
}

function parseTitleFromOcr(title) {
  if (!title) {
    return null
  }

  const trimmed = String(title).trim()
  if (!isPlausibleTitle(trimmed)) {
    return null
  }

  return trimmed
}

/**
 * Full-page chapter opener illustrations (character art, etc.).
 */
function analyzeFullPageIllustration({
  imageBlock,
  blocks,
  blockIndex,
  chapterSequence = 1,
}) {
  if (shouldSkipChapterGraphicAnalysis(imageBlock, blocks, blockIndex)) {
    return { ...SAFE_FALLBACK }
  }

  const followingBlocks = collectFollowingTextBlocks(blocks, blockIndex)
  const samePageTextChars = countSamePageTextChars(blocks, imageBlock)

  if (samePageTextChars > 220) {
    logChapterGraphicDecision("skip_text_heavy_page", {
      pageNumber: imageBlock.pageNumber,
      samePageTextChars,
    })
    return { ...SAFE_FALLBACK }
  }

  const pageNumber = imageBlock.pageNumber ?? 0
  const sparsePage = samePageTextChars <= 50
  const hasFollowUpSignal =
    hasEpigraphFollowUp(followingBlocks) ||
    hasInterstitialTitle(followingBlocks) ||
    hasNarrativeFollowUp(followingBlocks)

  const isChapterBoundary =
    followingBlocks.length > 0 &&
    sparsePage &&
    hasFollowUpSignal &&
    pageNumber >= MIN_CHAPTER_ILLUSTRATION_PAGE

  if (!isChapterBoundary) {
    logChapterGraphicDecision("not_chapter_boundary", {
      pageNumber,
      samePageTextChars,
      followingCount: followingBlocks.length,
    })
    return { ...SAFE_FALLBACK }
  }

  const metadata = extractChapterMetadata(followingBlocks, chapterSequence)

  logChapterGraphicDecision("full_page_chapter_boundary", {
    pageNumber,
    chapterSequence,
    metadata,
  })

  return {
    isChapterBoundary: true,
    boundaryKind: "chapter",
    ...metadata,
  }
}

/**
 * Classify an illustration block using layout metrics and nearby PDF text.
 *
 * @param {object} params
 * @param {object} params.imageBlock The image_candidate block.
 * @param {Array<object>} params.blocks Full interleaved block stream.
 * @param {number} params.blockIndex Index of the image block in `blocks`.
 * @param {number} [params.chapterSequence] Sequential chapter number for fallback labels.
 * @returns {{ isChapterBoundary: boolean, title: string | null, number: string | null, rawText: string | null }}
 */
function analyzeChapterGraphicFromContext({
  imageBlock,
  blocks,
  blockIndex,
  chapterSequence = 1,
  interludeSequence = 1,
  ocrMetadata = null,
  printedToc = null,
}) {
  if (!imageBlock || imageBlock.type !== "image_candidate") {
    return { ...SAFE_FALLBACK }
  }

  if (imageBlock.imageRole === "full_page_illustration" && ocrMetadata) {
    const section = analyzeFullPageSectionDivider(ocrMetadata)
    if (section.isChapterBoundary) {
      return section
    }
  }

  let analysisResult = { ...SAFE_FALLBACK }

  if (imageBlock.imageRole === "chapter_heading") {
    analysisResult = analyzeChapterHeadingBanner({
      imageBlock,
      blocks,
      blockIndex,
      chapterSequence,
    })
  } else if (imageBlock.imageRole === "full_page_illustration") {
    analysisResult = analyzeFullPageIllustration({
      imageBlock,
      blocks,
      blockIndex,
      chapterSequence,
    })
  }

  return mergeOcrIntoAnalysis(analysisResult, ocrMetadata, imageBlock.imageRole, {
    printedToc,
    chapterSequence,
    interludeSequence,
  })
}

/**
 * Backwards-compatible entry point — ignores image bytes and uses block context when provided.
 *
 * @param {string} _base64Image Unused; kept for API compatibility.
 * @param {object} [context]
 * @returns {Promise<{ isChapterBoundary: boolean, title: string | null, number: string | null, rawText: string | null }>}
 */
async function analyzeChapterGraphic(_base64Image, context = {}) {
  if (context?.imageBlock && Array.isArray(context.blocks) && context.blockIndex != null) {
    return analyzeChapterGraphicFromContext({
      imageBlock: context.imageBlock,
      blocks: context.blocks,
      blockIndex: context.blockIndex,
      chapterSequence: context.chapterSequence ?? 1,
    })
  }

  return { ...SAFE_FALLBACK }
}

export {
  analyzeChapterGraphic,
  analyzeChapterGraphicFromContext,
  mergeOcrIntoAnalysis,
  SAFE_FALLBACK,
}
