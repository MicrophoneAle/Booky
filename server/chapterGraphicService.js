/**
 * Heuristic chapter-graphic analysis — no vision LLM or paid API calls.
 * Uses PDF layout metrics plus nearby extracted text to classify illustration blocks.
 */

const SAFE_FALLBACK = Object.freeze({
  isChapterBoundary: false,
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

function extractChapterMetadata(followingBlocks, chapterSequence) {
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

  if (!number) {
    number = `Chapter ${chapterSequence}`
  }

  return {
    title: normalizeNullableString(title),
    number: normalizeNullableString(number),
    rawText: normalizeNullableString(rawText),
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
}) {
  if (!imageBlock || imageBlock.type !== "image_candidate") {
    return { ...SAFE_FALLBACK }
  }

  if (isCoverPageImage(imageBlock)) {
    logChapterGraphicDecision("skip_cover", { pageNumber: imageBlock.pageNumber })
    return { ...SAFE_FALLBACK }
  }

  const followingBlocks = collectFollowingTextBlocks(blocks, blockIndex)
  const samePageTextChars = countSamePageTextChars(blocks, imageBlock)

  if (hasNonChapterCaption(followingBlocks)) {
    logChapterGraphicDecision("skip_non_chapter_caption", {
      pageNumber: imageBlock.pageNumber,
    })
    return { ...SAFE_FALLBACK }
  }

  if (isFrontMatterIllustration(followingBlocks)) {
    logChapterGraphicDecision("skip_front_matter_illustration", {
      pageNumber: imageBlock.pageNumber,
    })
    return { ...SAFE_FALLBACK }
  }

  if (isSpreadContinuation(blocks, blockIndex, imageBlock)) {
    logChapterGraphicDecision("skip_spread_continuation", {
      pageNumber: imageBlock.pageNumber,
    })
    return { ...SAFE_FALLBACK }
  }

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

  logChapterGraphicDecision("chapter_boundary", {
    pageNumber,
    chapterSequence,
    metadata,
  })

  return {
    isChapterBoundary: true,
    ...metadata,
  }
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
  SAFE_FALLBACK,
}
