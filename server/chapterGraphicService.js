/**
 * Heuristic chapter-graphic analysis — no vision LLM or paid API calls.
 * Uses PDF layout metrics plus nearby extracted text to classify illustration blocks.
 */

import { isPlausibleTitle } from "./imageOcrService.js"
import {
  isChapterLikeOcrMetadata,
  isFullPageHeightIllustrationBlock,
  isFullPageSpreadHalf,
  isLikelyChapterArchBannerBlock,
  isLikelyHorizontalChapterStrip,
  isTallChapterArchBannerBlock,
} from "./pdfImageRoleUtils.js"
import {
  lookupPrintedTocNumberLabel,
  lookupPrintedTocTitle,
} from "./printedTocService.js"
import {
  buildTocMetadataForChapterHeading,
  hasBackMatterHeadingText,
} from "./stormlightEpigraphService.js"

const SAFE_FALLBACK = Object.freeze({
  isChapterBoundary: false,
  boundaryKind: null,
  title: null,
  number: null,
  rawText: null,
})

const NARRATIVE_START_HEADING_REGEX =
  /^(?:Prelude to the Stormlight Archive|Prologue:\s+\S|Part\s+(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|[IVXLCDM]+|\d+)\b|(?:chapter|letter)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b)/i

/**
 * True once a narrative section heading (Prelude, Prologue, Part, or a numbered
 * Chapter/Letter) has appeared in the text stream before blockIndex. The injected
 * Prelude and Prologue headings precede every real chapter banner, so this is false
 * only for front-matter art (the Roshar map spread, title-page art) that sits ahead
 * of the Prelude.
 */
function hasNarrativeStartedBefore(blocks, blockIndex) {
  for (let index = 0; index < blockIndex; index += 1) {
    const block = blocks[index]
    if (block?.type === "image" || block?.type === "image_candidate") {
      continue
    }
    const text = (block?.text ?? "").trim()
    if (text && NARRATIVE_START_HEADING_REGEX.test(text)) {
      return true
    }
  }
  return false
}

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
  /^ROSHAR$/i,
  /\broshar\b/i,
  /codes of war/i,
  /alethi codes/i,
  /sketchbook/i,
  /journal entry/i,
  /^purports to be\b/i,
]

const MAP_OR_DIVIDER_TEXT_PATTERNS = [
  /^ROSHAR$/i,
  /^THE STORMLIGHT ARCHIVE$/i,
  /^BOOK$/i,
  /^ONE$/i,
  /^TWO$/i,
  /^THREE$/i,
  /^THE WAY OF KINGS$/i,
  /4,500 years later/i,
  /codes of war/i,
  /alethi codes/i,
  /sketchbook/i,
]

const FRONT_MATTER_SERIES_MARKERS = [
  /^THE STORMLIGHT ARCHIVE$/i,
  /^THE WAY OF KINGS$/i,
]

const EPIGRAPH_PREFIX_REGEX = /^["'\u201c\u2018]|^—(?:Collected|Noted|Dated|Purports|Though|Kakashah|Tanatanev)/i

const INTERSTITIAL_TITLE_REGEX = /^[A-Z][A-Z0-9\s'’\-]{3,}$/

const MIN_CHAPTER_ILLUSTRATION_PAGE = 30
/** Ignore part/interlude-divider art in front matter (maps, printed TOC graphics). */
const MIN_SECTION_BOUNDARY_PAGE = 28
/** Decorative title-spread arches before the narrative begins. */
const MIN_TALL_CHAPTER_ARCH_BOUNDARY_PAGE = 24
/** Inline story plates on pages that already carry narrative prose (e.g. Aesop fables). */
const TEXT_HEAVY_CHAPTER_PLATE_PAGE_CHARS = 120

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

function collectNearbyTextLines(blocks, imageBlock, maxPageDelta = 1) {
  const pageNumber = imageBlock?.pageNumber ?? 0
  const lines = []

  for (const block of blocks) {
    if (block?.type === "image" || block?.type === "image_candidate") {
      continue
    }

    const blockPage =
      block?.pageNumber ??
      (Number.isFinite(block?.sourcePdfPageIndex)
        ? block.sourcePdfPageIndex + 1
        : 0)

    if (Math.abs(blockPage - pageNumber) > maxPageDelta) {
      continue
    }

    const text = (block?.text ?? "").trim()
    if (text) {
      lines.push(text)
    }
  }

  return lines
}

function hasNearbyNonChapterCaption(blocks, imageBlock) {
  // Only same-page captions disqualify a block. Captions on the previous page
  // belong to the illustration there and must not suppress the next page's
  // chapter arch banner.
  return collectNearbyTextLines(blocks, imageBlock, 0).some((text) =>
    NON_CHAPTER_CAPTION_PATTERNS.some((pattern) => pattern.test(text))
  )
}

function isFrontMatterIllustration(followingBlocks) {
  return followingBlocks.some(({ text }) =>
    FRONT_MATTER_SERIES_MARKERS.some((pattern) => pattern.test(text))
  )
}

function findPreviousImageBlock(blocks, blockIndex) {
  const originPage = blocks[blockIndex]?.pageNumber ?? 0
  let closest = null
  let closestDelta = Infinity

  for (let index = 0; index < blocks.length; index += 1) {
    if (index === blockIndex) {
      continue
    }

    const block = blocks[index]
    if (block?.type !== "image" && block?.type !== "image_candidate") {
      continue
    }

    const pageDelta = originPage - (block.pageNumber ?? 0)
    if (pageDelta <= 0 || pageDelta > 2) {
      continue
    }

    if (pageDelta < closestDelta) {
      closest = block
      closestDelta = pageDelta
    }
  }

  return closest
}

function findNextImageBlock(blocks, blockIndex, maxPageDelta = 2) {
  const originPage = blocks[blockIndex]?.pageNumber ?? 0
  let closest = null
  let closestDelta = Infinity

  for (let index = 0; index < blocks.length; index += 1) {
    if (index === blockIndex) {
      continue
    }

    const block = blocks[index]
    if (block?.type !== "image" && block?.type !== "image_candidate") {
      continue
    }

    const pageDelta = (block.pageNumber ?? 0) - originPage
    if (pageDelta <= 0 || pageDelta > maxPageDelta) {
      continue
    }

    if (pageDelta < closestDelta) {
      closest = block
      closestDelta = pageDelta
    }
  }

  return closest
}

function isHorizontalChapterStripBlock(block) {
  const coords = block?.coordinates ?? {}
  return isLikelyHorizontalChapterStrip({
    width: coords.width ?? 0,
    height: coords.height ?? 0,
    pageWidth: coords.pageWidth ?? 0,
    pageHeight: coords.pageHeight ?? 0,
  })
}

function isChapterTitleStripBlock(block) {
  if (isHorizontalChapterStripBlock(block)) {
    return true
  }

  const coords = block?.coordinates ?? {}
  const pageHeight = coords.pageHeight ?? 0
  const height = coords.height ?? 0
  if (!pageHeight || !height) {
    return false
  }

  return block?.imageRole === "chapter_heading" && height / pageHeight <= 0.25
}

function hasSamePageProseBeforeImage(blocks, blockIndex, imageBlock) {
  const pageIndex = Number.isFinite(imageBlock?.sourcePdfPageIndex)
    ? imageBlock.sourcePdfPageIndex
    : Math.max(0, (imageBlock?.pageNumber ?? 1) - 1)

  let charsBefore = 0

  for (let index = 0; index < blockIndex; index += 1) {
    const block = blocks[index]
    if (block?.type === "image" || block?.type === "image_candidate") {
      continue
    }

    const blockPage = Number.isFinite(block?.sourcePdfPageIndex)
      ? block.sourcePdfPageIndex
      : Math.max(0, (block?.pageNumber ?? 1) - 1)

    if (blockPage === pageIndex) {
      charsBefore += (block?.text ?? "").length
    }
  }

  return charsBefore > 80
}

function isMapOrGalleryIllustration(blocks, blockIndex, imageBlock) {
  if (imageBlock?.imageRole === "full_page_illustration") {
    return true
  }

  if (isFullPageHeightIllustrationBlock(imageBlock)) {
    return true
  }

  const nearby = collectNearbyTextLines(blocks, imageBlock, 1)
  if (nearby.some((text) => MAP_OR_DIVIDER_TEXT_PATTERNS.some((pattern) => pattern.test(text)))) {
    return true
  }

  const previousImage = findPreviousImageBlock(blocks, blockIndex)
  const nextImage = findNextImageBlock(blocks, blockIndex, 2)

  if (
    isFullPageHeightIllustrationBlock(previousImage) &&
    isFullPageHeightIllustrationBlock(imageBlock)
  ) {
    return true
  }

  if (
    isFullPageHeightIllustrationBlock(imageBlock) &&
    isFullPageHeightIllustrationBlock(nextImage)
  ) {
    return true
  }

  if (isFullPageSpreadHalf(imageBlock, previousImage)) {
    return true
  }

  // Stormlight often ends one chapter and opens the next on the same PDF page
  // (prose above, stone arch below). That layout is a chapter transition, not a
  // map plate — never reject a chapter arch for same-page prose.
  const isChapterArch =
    imageBlock.imageRole === "chapter_heading" ||
    isLikelyChapterArchBannerBlock(imageBlock) ||
    isChapterTitleStripBlock(imageBlock)

  if (!isChapterArch && hasSamePageProseBeforeImage(blocks, blockIndex, imageBlock)) {
    return true
  }

  return false
}

/**
 * Gate printed-TOC slot assignment so full-page maps and in-chapter plates
 * never consume sequential chapter numbers.
 */
function qualifiesAsPrintedTocBannerSlot(imageBlock, blocks, blockIndex, ocrMetadata) {
  if (!imageBlock) {
    return false
  }

  if (ocrMetadata?.boundaryKind === "book_divider") {
    return false
  }

  // OCR-confirmed part and interlude dividers never take a sequential chapter slot.
  const ocrKind = ocrMetadata?.boundaryKind
  if (ocrKind === "part" || ocrKind === "interlude_divider") {
    return false
  }

  // Full-page art (tall plates, character portraits, sketchbook pages) is never
  // a chapter banner, even when its plaque OCR misreads as a chapter number.
  // These rejections run before any OCR shortcut so a plate cannot consume a
  // sequential chapter slot and shift every later banner.
  if (imageBlock.imageRole === "full_page_illustration") {
    return false
  }
  if (isFullPageHeightIllustrationBlock(imageBlock)) {
    return false
  }
  if (isMapOrGalleryIllustration(blocks, blockIndex, imageBlock)) {
    return false
  }

  const isStandardChapterArch =
    imageBlock.imageRole === "chapter_heading" &&
    isLikelyChapterArchBannerBlock(imageBlock)

  if (!isStandardChapterArch && hasNearbyNonChapterCaption(blocks, imageBlock)) {
    return false
  }

  const followingBlocks = collectFollowingTextBlocks(blocks, blockIndex, 8)
  if (!isStandardChapterArch && hasNonChapterCaption(followingBlocks)) {
    return false
  }

  const hasBannerGeometry =
    imageBlock.imageRole === "chapter_heading" ||
    isLikelyChapterArchBannerBlock(imageBlock) ||
    isChapterTitleStripBlock(imageBlock)

  if (!hasBannerGeometry) {
    return false
  }

  // Interleave already classified these as chapter_heading on arch geometry.
  // Requiring post-arch narrative fails for mid-page transitions and late-book
  // chapters whose following text is sparse or back-matter adjacent.
  if (isStandardChapterArch) {
    return true
  }

  // A genuine chapter arch always opens onto an epigraph, an interstitial title,
  // or narrative prose. Requiring this even when OCR looks chapter-like stops a
  // plate whose plaque misreads as a number from taking a slot.
  const hasOpenerSignal =
    hasEpigraphFollowUp(followingBlocks) ||
    hasInterstitialTitle(followingBlocks) ||
    hasNarrativeFollowUp(followingBlocks) ||
    hasSamePageProseBeforeImage(blocks, blockIndex, imageBlock)

  return hasOpenerSignal
}

function isEndOfChapterTallArt(blocks, blockIndex, imageBlock) {
  if (!isTallChapterArchBannerBlock(imageBlock)) {
    return false
  }

  const followingBlocks = collectFollowingTextBlocks(blocks, blockIndex, 8)
  if (hasEpigraphFollowUp(followingBlocks) || hasInterstitialTitle(followingBlocks)) {
    return false
  }

  const previousImage = findPreviousImageBlock(blocks, blockIndex)
  if (isTallChapterArchBannerBlock(previousImage)) {
    return false
  }

  const nextImage = findNextImageBlock(blocks, blockIndex, 2)
  if (!nextImage) {
    return false
  }

  if (isHorizontalChapterStripBlock(nextImage)) {
    return true
  }

  return false
}

function isChapterArchSpreadContinuation(blocks, blockIndex, imageBlock) {
  const previousImage = findPreviousImageBlock(blocks, blockIndex)
  if (!previousImage) {
    return false
  }

  const pageNumber = imageBlock?.pageNumber ?? 0
  if ((previousImage.pageNumber ?? 0) !== pageNumber - 1) {
    return false
  }

  if (
    !isTallChapterArchBannerBlock(imageBlock) ||
    !isTallChapterArchBannerBlock(previousImage)
  ) {
    return false
  }

  // Two tall arches on consecutive pages are usually two different chapters,
  // not one image split across the fold. Only treat this as a continuation when
  // the geometry matches a real across-the-fold spread: the previous half hugs
  // the right page edge, this half hugs the left edge, and both are the same
  // height. Independent centered chapter/interlude banners never satisfy this,
  // so they survive and get their own boundary.
  const prev = previousImage.coordinates ?? {}
  const cur = imageBlock.coordinates ?? {}

  const prevPageWidth = prev.pageWidth ?? 0
  const curPageWidth = cur.pageWidth ?? 0
  if (prevPageWidth <= 0 || curPageWidth <= 0) {
    return false
  }

  const prevRightGap = prevPageWidth - ((prev.x ?? 0) + (prev.width ?? 0))
  const curLeftGap = cur.x ?? 0
  const prevHugsRight = prevRightGap <= prevPageWidth * 0.08
  const curHugsLeft = curLeftGap <= curPageWidth * 0.08

  const prevHeight = prev.height ?? 0
  const curHeight = cur.height ?? 0
  const heightsMatch =
    prevHeight > 0 &&
    curHeight > 0 &&
    Math.abs(prevHeight - curHeight) <= Math.max(prevHeight, curHeight) * 0.15

  return prevHugsRight && curHugsLeft && heightsMatch
}

function isSpreadContinuation(blocks, blockIndex, imageBlock) {
  if (isChapterArchSpreadContinuation(blocks, blockIndex, imageBlock)) {
    return true
  }

  const previousImage = findPreviousImageBlock(blocks, blockIndex)
  return isFullPageSpreadHalf(imageBlock, previousImage)
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

  const samePageTextChars = countSamePageTextChars(blocks, imageBlock)
  if (
    imageBlock.imageRole !== "chapter_heading" &&
    isLikelyChapterArchBannerBlock(imageBlock) &&
    samePageTextChars > TEXT_HEAVY_CHAPTER_PLATE_PAGE_CHARS &&
    !isTallChapterArchBannerBlock(imageBlock)
  ) {
    logChapterGraphicDecision("skip_text_heavy_chapter_plate", {
      pageNumber: imageBlock.pageNumber,
      samePageTextChars,
    })
    return true
  }

  const followingBlocks = collectFollowingTextBlocks(blocks, blockIndex)

  const isChapterArch =
    imageBlock.imageRole === "chapter_heading" ||
    isLikelyChapterArchBannerBlock(imageBlock) ||
    isChapterTitleStripBlock(imageBlock)

  if (
    !isChapterArch &&
    (hasNonChapterCaption(followingBlocks) || hasNearbyNonChapterCaption(blocks, imageBlock))
  ) {
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

  if (hasBackMatterHeadingText(blocks, blockIndex) && !isChapterArch) {
    logChapterGraphicDecision("skip_back_matter_illustration", {
      pageNumber: imageBlock.pageNumber,
    })
    return true
  }

  const pageNumber = imageBlock.pageNumber ?? 0
  if (
    pageNumber < MIN_TALL_CHAPTER_ARCH_BOUNDARY_PAGE &&
    isTallChapterArchBannerBlock(imageBlock) &&
    !isHorizontalChapterStripBlock(imageBlock)
  ) {
    const openerFollowingBlocks = collectFollowingTextBlocks(blocks, blockIndex, 8)
    const looksLikeSectionOpener =
      hasEpigraphFollowUp(openerFollowingBlocks) ||
      hasInterstitialTitle(openerFollowingBlocks) ||
      hasNarrativeFollowUp(openerFollowingBlocks)

    if (!looksLikeSectionOpener) {
      logChapterGraphicDecision("skip_front_matter_tall_arch", { pageNumber })
      return true
    }
  }

  if (isEndOfChapterTallArt(blocks, blockIndex, imageBlock)) {
    logChapterGraphicDecision("skip_end_of_chapter_tall_art", { pageNumber })
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

  const followingBlocks = collectFollowingTextBlocks(blocks, blockIndex)
  let rawText = null

  for (const { text } of followingBlocks) {
    if (EPIGRAPH_PREFIX_REGEX.test(text)) {
      rawText = text.length > 140 ? `${text.slice(0, 137)}...` : text
      break
    }
  }

  logChapterGraphicDecision("chapter_heading_banner", {
    pageNumber: imageBlock.pageNumber ?? 0,
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
  if (!tocDigits) {
    return false
  }
  if (!ocrDigits) {
    return true
  }
  if (ocrDigits === tocDigits) {
    return false
  }

  const ocrValue = Number.parseInt(ocrDigits, 10)
  if (!Number.isFinite(ocrValue) || ocrValue < 1 || ocrValue > 75) {
    return true
  }

  if (ocrDigits.length === 1 && tocDigits.length >= 2) {
    return true
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
  const tocKind = tocMetadata.boundaryKind ?? null
  const ocrKind = ocrMetadata.boundaryKind ?? null
  const boundaryKind =
    tocKind === "epilogue" || tocKind === "prelude" || tocKind === "prologue"
      ? tocKind
      : ocrKind ?? tocKind

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
 * Merge illustration OCR with printed TOC metadata (sequential cursor re-anchored by plaque OCR).
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
    tocAssigned = false,
  } = {}
) {
  if (analysisResult?.boundaryKind === "flashback") {
    return analysisResult
  }

  if (ocrMetadata?.boundaryKind === "book_divider") {
    return { ...SAFE_FALLBACK }
  }

  if (imageRole === "full_page_illustration" && printedToc && !isChapterLikeOcrMetadata(ocrMetadata)) {
    if (
      ocrMetadata?.boundaryKind === "part" ||
      ocrMetadata?.boundaryKind === "interlude_divider"
    ) {
      return analyzeFullPageSectionDivider(ocrMetadata, imageBlock)
    }
    return { ...SAFE_FALLBACK }
  }

  const resolvedBoundaryKind =
    forceInterludeBoundary
      ? "interlude"
      : ocrMetadata?.boundaryKind ?? analysisResult?.boundaryKind ?? null

  if (
    resolvedBoundaryKind === "prelude" ||
    resolvedBoundaryKind === "prologue" ||
    resolvedBoundaryKind === "epilogue"
  ) {
    const label =
      resolvedBoundaryKind.charAt(0).toUpperCase() + resolvedBoundaryKind.slice(1)
    const tocTitle = printedToc
      ? lookupPrintedTocTitle(printedToc, { boundaryKind: resolvedBoundaryKind })
      : null
    const title = parseTitleFromOcr(ocrMetadata?.title) ?? tocTitle ?? null
    return {
      isChapterBoundary: true,
      includeInToc: true,
      boundaryKind: resolvedBoundaryKind,
      number: label,
      title,
      rawText: title ? `${label}: ${title}` : label,
    }
  }

  if (imageRole === "full_page_illustration" && ocrMetadata && !isChapterLikeOcrMetadata(ocrMetadata)) {
    const section = analyzeFullPageSectionDivider(ocrMetadata, imageBlock)
    if (section.isChapterBoundary) {
      return section
    }

    if (printedToc) {
      return { ...SAFE_FALLBACK }
    }
  }

  if (!ocrMetadata && !analysisResult?.isChapterBoundary) {
    return analysisResult
  }

  const effectiveImageRole =
    imageRole === "chapter_heading" ||
    isChapterLikeOcrMetadata(ocrMetadata) ||
    isLikelyChapterArchBannerBlock(imageBlock)
      ? "chapter_heading"
      : imageRole

  if (!analysisResult?.isChapterBoundary && effectiveImageRole !== "chapter_heading") {
    return analysisResult
  }

  const boundaryKind = forceInterludeBoundary
    ? "interlude"
    : ocrMetadata?.boundaryKind ??
      analysisResult.boundaryKind ??
      (imageRole === "chapter_heading" ? "chapter" : null)

  let number = ocrMetadata?.number ?? analysisResult.number ?? null
  let title = parseTitleFromOcr(ocrMetadata?.title) ?? analysisResult.title ?? null

  const effectiveBoundaryKind = boundaryKind

  const ocrNumber = (number ?? "").trim()
  const ocrNumberValid = ocrNumber.length > 0 && !/^chapter$/i.test(ocrNumber)

  const lookupSequence =
    effectiveBoundaryKind === "interlude" ? interludeSequence : chapterSequence

  if (!title && printedToc && tocAssigned) {
    title = lookupPrintedTocTitle(printedToc, {
      number,
      boundaryKind: effectiveBoundaryKind,
      chapterSequence: lookupSequence,
    })
  }

  if ((!number || /^chapter$/i.test(number)) && printedToc && tocAssigned) {
    const tocNumber = lookupPrintedTocNumberLabel(printedToc, {
      number,
      boundaryKind: effectiveBoundaryKind,
      chapterSequence: lookupSequence,
    })
    if (tocNumber) {
      number = tocNumber
    }
  }

  if (
    printedToc &&
    !tocAssigned &&
    !ocrNumberValid &&
    !parseTitleFromOcr(ocrMetadata?.title)
  ) {
    if (!isLikelyChapterArchBannerBlock(imageBlock)) {
      return { ...SAFE_FALLBACK }
    }

    const fallbackKind =
      effectiveBoundaryKind === "interlude" ? "interlude" : "chapter"
    const fallbackNumber = lookupPrintedTocNumberLabel(printedToc, {
      number: null,
      boundaryKind: fallbackKind,
      chapterSequence: lookupSequence,
    })
    const fallbackTitle = lookupPrintedTocTitle(printedToc, {
      number: fallbackNumber,
      boundaryKind: fallbackKind,
      chapterSequence: lookupSequence,
    })

    if (!fallbackNumber && !fallbackTitle) {
      return { ...SAFE_FALLBACK }
    }

    number = fallbackNumber ?? number
    title = fallbackTitle ?? title
  }

  const rawText =
    number && title
      ? `${number}: ${title}`
      : number ?? title ?? analysisResult.rawText ?? null

  return {
    isChapterBoundary: true,
    includeInToc:
      effectiveBoundaryKind !== "flashback",
    boundaryKind: effectiveBoundaryKind,
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
  buildSequentialInterludeTocEntry = null,
}) {
  if (!imageBlock || imageBlock.type !== "image_candidate") {
    return { ...SAFE_FALLBACK }
  }

  // Front-matter art (the Roshar map spread, title-page art) is interleaved before
  // the injected Prelude heading. It must never be classified as a chapter banner,
  // never consume a printed-TOC chapter slot, and never advance the sequential TOC
  // cursor. Returning here before any cursor work keeps the cursor aligned, so later
  // real chapters (12, 33, 35, 67, 71, 74, Epilogue, ...) get their correct numbers
  // instead of colliding and being dropped by boundaryDedupeKey (which is what was
  // suppressing their newpage flush).
  if (!hasNarrativeStartedBefore(blocks, blockIndex)) {
    return { ...SAFE_FALLBACK }
  }

  if (imageBlock.imageRole === "full_page_illustration" && ocrMetadata) {
    const section = analyzeFullPageSectionDivider(ocrMetadata, imageBlock)
    if (section.isChapterBoundary) {
      return section
    }
  }

  let analysisResult = { ...SAFE_FALLBACK }

  const isSectionBanner =
    ocrMetadata?.boundaryKind === "prelude" ||
    ocrMetadata?.boundaryKind === "prologue" ||
    ocrMetadata?.boundaryKind === "epilogue"

  const qualifiesForBannerSlot =
    isSectionBanner ||
    qualifiesAsPrintedTocBannerSlot(imageBlock, blocks, blockIndex, ocrMetadata)

  const isChapterBanner =
    qualifiesForBannerSlot &&
    (imageBlock.imageRole === "chapter_heading" ||
      isChapterLikeOcrMetadata(ocrMetadata) ||
      isLikelyChapterArchBannerBlock(imageBlock))

  if (isChapterBanner) {
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
  let tocMetadata = null
  const tocCursorBefore = tocOrderCursor?.index ?? 0

  if (
    printedToc &&
    tocOrderCursor &&
    buildSequentialTocEntry &&
    isChapterBanner &&
    !isSectionBanner
  ) {
    tocMetadata = buildTocMetadataForChapterHeading(
      blocks,
      blockIndex,
      printedToc,
      {
        tocOrderCursor,
        forceInterludeBoundary,
        buildSequentialEntry: buildSequentialTocEntry,
        buildSequentialInterludeEntry: buildSequentialInterludeTocEntry,
        ocrNumberLabel: ocrMetadata?.number ?? null,
      }
    )

    effectiveOcrMetadata = enrichOcrMetadataFromPrintedToc(ocrMetadata, tocMetadata)
  }

  const merged = mergeOcrIntoAnalysis(analysisResult, effectiveOcrMetadata, imageBlock.imageRole, {
    printedToc,
    chapterSequence,
    interludeSequence,
    imageBlock,
    forceInterludeBoundary,
    tocAssigned: Boolean(tocMetadata),
  })

  if (!merged.isChapterBoundary && tocOrderCursor) {
    tocOrderCursor.index = tocCursorBefore
  }

  return merged
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
