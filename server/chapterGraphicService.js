/**
 * Heuristic chapter-graphic analysis — no vision LLM or paid API calls.
 * Uses PDF layout metrics plus nearby extracted text to classify illustration blocks.
 */

import { isPlausibleTitle } from "./imageOcrService.js"
import {
  lookupPrintedTocNumberLabel,
  lookupPrintedTocTitle,
} from "./printedTocService.js"
import { buildTocMetadataForChapterHeading } from "./stormlightEpigraphService.js"

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
/** Ignore part/interlude-divider art in front matter (maps, printed TOC graphics). */
const MIN_SECTION_BOUNDARY_PAGE = 28

const FLASHBACK_TIMESTAMP_REGEX =
  /^FIVE (?:AND A HALF )?YEARS (?:LATER|AGO)|^TWO YEARS AGO|^ONE YEAR LATER/i

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

function countSamePageTextChars(blocks, imageBlock, precomputedPageCharCounts = null) {
  const pageIndex = Math.max(0, (imageBlock?.pageNumber ?? 1) - 1)

  if (precomputedPageCharCounts instanceof Map) {
    return precomputedPageCharCounts.get(pageIndex) ?? 0
  }

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

  if (!previousImage || previousImage.pageNumber !== pageNumber - 1) {
    return false
  }

  // Chapter banners after an illustration start a new chapter, not a spread half.
  if (imageBlock.imageRole === "chapter_heading") {
    return false
  }

  // Full-page art on page N-1 (end-of-chapter illustration) is not a spread with page N.
  if (previousImage.imageRole === "full_page_illustration") {
    return false
  }

  return imageBlock.imageRole === "full_page_illustration"
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

function isFlashbackChapterHeading(imageBlock, blocks, blockIndex) {
  for (const { text } of collectFollowingTextBlocks(blocks, blockIndex, 8)) {
    const trimmed = (text ?? "").trim()
    if (!trimmed) {
      continue
    }

    if (FLASHBACK_TIMESTAMP_REGEX.test(trimmed)) {
      return true
    }

    if (/YEARS (?:LATER|AGO)/i.test(trimmed) && trimmed.length <= 40) {
      return true
    }
  }

  return false
}

function analyzeFlashbackTimestampHeading(imageBlock, blocks, blockIndex) {
  if (!isFlashbackChapterHeading(imageBlock, blocks, blockIndex)) {
    return null
  }

  for (const { text } of collectFollowingTextBlocks(blocks, blockIndex, 8)) {
    const trimmed = (text ?? "").trim()
    if (!trimmed) {
      continue
    }

    if (FLASHBACK_TIMESTAMP_REGEX.test(trimmed) || /YEARS (?:LATER|AGO)/i.test(trimmed)) {
      logChapterGraphicDecision("flashback_timestamp_heading", {
        pageNumber: imageBlock.pageNumber,
        text: trimmed,
      })

      return {
        isChapterBoundary: true,
        includeInToc: false,
        boundaryKind: "flashback",
        title: trimmed,
        number: null,
        rawText: trimmed,
      }
    }
  }

  return null
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
    if (imageBlock.imageRole === "chapter_heading") {
      return false
    }

    logChapterGraphicDecision("skip_front_matter_illustration", {
      pageNumber: imageBlock.pageNumber,
    })
    return true
  }

  if (isSpreadContinuation(blocks, blockIndex, imageBlock)) {
    if (imageBlock.imageRole === "chapter_heading") {
      return false
    }

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
function analyzeFullPageSectionDivider(ocrMetadata, imageBlock = null) {
  if (!ocrMetadata?.boundaryKind) {
    return { ...SAFE_FALLBACK }
  }

  const pageNumber = imageBlock?.pageNumber ?? 0
  if (pageNumber < MIN_SECTION_BOUNDARY_PAGE) {
    return { ...SAFE_FALLBACK }
  }

  if (ocrMetadata.boundaryKind === "part") {
    return {
      isChapterBoundary: true,
      includeInToc: true,
      boundaryKind: "part",
      title: ocrMetadata.title ?? null,
      number: ocrMetadata.number ?? null,
      rawText: ocrMetadata.rawText ?? null,
    }
  }

  if (ocrMetadata.boundaryKind === "interlude_divider") {
    return {
      isChapterBoundary: true,
      includeInToc: true,
      boundaryKind: "interlude_divider",
      title: ocrMetadata.title ?? null,
      number: ocrMetadata.number ?? null,
      rawText: ocrMetadata.rawText ?? null,
    }
  }

  return { ...SAFE_FALLBACK }
}

function extractChapterNumberDigits(numberLabel) {
  const match = (numberLabel ?? "").match(/(?:chapter\s+)?(\d{1,3})\b/i)
  return match ? match[1] : null
}

function shouldPreferTocNumberOverOcr(ocrNumber, tocNumber) {
  const ocrDigits = extractChapterNumberDigits(ocrNumber)
  const tocDigits = extractChapterNumberDigits(tocNumber)
  if (!ocrDigits || !tocDigits || ocrDigits === tocDigits) {
    return false
  }

  // Narrow OCR crops often clip "51" → "1"; prefer the sequential TOC digit when longer.
  if (ocrDigits.length === 1 && tocDigits.length >= 2) {
    return tocDigits.endsWith(ocrDigits) || Number(tocDigits) > 9
  }

  return false
}

function enrichOcrMetadataFromPrintedToc(ocrMetadata, tocMetadata) {
  if (!tocMetadata) {
    return ocrMetadata ?? null
  }
  if (!ocrMetadata) {
    return tocMetadata
  }

  const ocrTitle = parseTitleFromOcr(ocrMetadata.title)
  const tocTitle = tocMetadata.title?.trim() || null
  const ocrNumber = (ocrMetadata.number ?? "").trim()
  const tocNumber = (tocMetadata.number ?? "").trim()
  const ocrNumberValid = ocrNumber.length > 0 && !/^chapter$/i.test(ocrNumber)

  const title = ocrTitle || tocTitle
  const number = shouldPreferTocNumberOverOcr(ocrNumber, tocNumber)
    ? tocNumber
    : ocrNumberValid
      ? ocrNumber
      : tocNumber
  const boundaryKind = ocrMetadata.boundaryKind ?? tocMetadata.boundaryKind

  return {
    boundaryKind,
    number: number || null,
    title: title || null,
    rawText:
      number && title
        ? `${number}: ${title}`
        : number || title || ocrMetadata.rawText || tocMetadata.rawText || null,
  }
}

/**
 * Merge illustration OCR with printed TOC metadata (sequential cursor / death-rattle matching).
 */
function mergeOcrIntoAnalysis(
  analysisResult,
  ocrMetadata,
  imageRole,
  {
    printedToc = null,
    chapterSequence = 1,
    interludeSequence = 1,
    imageBlock = null,
    forceInterludeBoundary = false,
  } = {}
) {
  if (analysisResult?.boundaryKind === "flashback") {
    return analysisResult
  }

  if (imageRole === "full_page_illustration" && printedToc) {
    if (
      ocrMetadata?.boundaryKind === "part" ||
      ocrMetadata?.boundaryKind === "interlude_divider"
    ) {
      return analyzeFullPageSectionDivider(ocrMetadata, imageBlock)
    }
    return { ...SAFE_FALLBACK }
  }

  if (imageRole === "full_page_illustration" && ocrMetadata) {
    const section = analyzeFullPageSectionDivider(ocrMetadata, imageBlock)
    if (section.isChapterBoundary) {
      return section
    }

    if (printedToc && ocrMetadata.boundaryKind === "chapter") {
      return { ...SAFE_FALLBACK }
    }
  }

  if (!ocrMetadata && !analysisResult?.isChapterBoundary) {
    return analysisResult
  }

  if (!analysisResult?.isChapterBoundary && imageRole !== "chapter_heading") {
    return analysisResult
  }

  const boundaryKind = forceInterludeBoundary
    ? "interlude"
    : ocrMetadata?.boundaryKind ??
      analysisResult.boundaryKind ??
      (imageRole === "chapter_heading" ? "chapter" : null)

  let number = ocrMetadata?.number ?? analysisResult.number ?? null
  let title = parseTitleFromOcr(ocrMetadata?.title) ?? analysisResult.title ?? null

  const lookupSequence =
    boundaryKind === "interlude" ? interludeSequence : chapterSequence

  if (!title && printedToc) {
    title = lookupPrintedTocTitle(printedToc, {
      number,
      boundaryKind,
      chapterSequence: lookupSequence,
    })
  }

  if ((!number || /^chapter$/i.test(number)) && printedToc) {
    const tocNumber = lookupPrintedTocNumberLabel(printedToc, {
      number,
      boundaryKind,
      chapterSequence: lookupSequence,
    })
    if (tocNumber) {
      number = tocNumber
    }
  }

  const rawText =
    number && title
      ? `${number}: ${title}`
      : number ?? title ?? analysisResult.rawText ?? null

  return {
    isChapterBoundary: true,
    includeInToc:
      boundaryKind !== "flashback",
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
  precomputedPageCharCounts = null,
}) {
  if (shouldSkipChapterGraphicAnalysis(imageBlock, blocks, blockIndex)) {
    return { ...SAFE_FALLBACK }
  }

  const followingBlocks = collectFollowingTextBlocks(blocks, blockIndex)
  const samePageTextChars = countSamePageTextChars(
    blocks,
    imageBlock,
    precomputedPageCharCounts
  )

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
  forceInterludeBoundary = false,
  precomputedPageCharCounts = null,
  tocOrderCursor = null,
  buildSequentialTocEntry = null,
}) {
  if (!imageBlock || imageBlock.type !== "image_candidate") {
    return { ...SAFE_FALLBACK }
  }

  if (imageBlock.imageRole === "full_page_illustration" && ocrMetadata) {
    const section = analyzeFullPageSectionDivider(ocrMetadata, imageBlock)
    if (section.isChapterBoundary) {
      return section
    }
  }

  let analysisResult = { ...SAFE_FALLBACK }

  if (imageBlock.imageRole === "chapter_heading") {
    // Flashback timestamps ("SEVEN YEARS AGO") follow the banner — they are not the chapter start.
    analysisResult = analyzeChapterHeadingBanner({
      imageBlock,
      blocks,
      blockIndex,
      chapterSequence,
    })
  } else if (imageBlock.imageRole === "full_page_illustration") {
    if (!printedToc) {
      analysisResult = analyzeFullPageIllustration({
        imageBlock,
        blocks,
        blockIndex,
        chapterSequence,
        precomputedPageCharCounts,
      })
    }
  }

  let effectiveOcrMetadata = ocrMetadata

  if (
    printedToc &&
    tocOrderCursor &&
    buildSequentialTocEntry &&
    imageBlock.imageRole === "chapter_heading"
  ) {
    const tocMetadata = buildTocMetadataForChapterHeading(
      blocks,
      blockIndex,
      printedToc,
      {
        tocOrderCursor,
        forceInterludeBoundary,
        buildSequentialEntry: buildSequentialTocEntry,
      }
    )
    effectiveOcrMetadata = enrichOcrMetadataFromPrintedToc(ocrMetadata, tocMetadata)
  }

  return mergeOcrIntoAnalysis(analysisResult, effectiveOcrMetadata, imageBlock.imageRole, {
    printedToc,
    chapterSequence,
    interludeSequence,
    imageBlock,
    forceInterludeBoundary,
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
  analyzeChapterHeadingBanner,
  analyzeFlashbackTimestampHeading,
  isFlashbackChapterHeading,
  mergeOcrIntoAnalysis,
  shouldSkipChapterGraphicAnalysis,
  SAFE_FALLBACK,
}
