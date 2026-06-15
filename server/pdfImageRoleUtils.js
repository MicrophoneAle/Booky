/** Shared PDF illustration metrics helpers (chapter arch vs full-page art). */

const CHAPTER_ARCH_MIN_WIDTH_RATIO = 0.33
const CHAPTER_ARCH_MIN_HEIGHT_RATIO = 0.28
const CHAPTER_ARCH_MAX_HEIGHT_RATIO = 0.57
const CHAPTER_ARCH_MIN_ASPECT_RATIO = 0.55
const CHAPTER_ARCH_MAX_ASPECT_RATIO = 1.35
const CHAPTER_STRIP_MIN_WIDTH_RATIO = 0.33
const CHAPTER_STRIP_MIN_HEIGHT_RATIO = 0.10
const CHAPTER_STRIP_MAX_HEIGHT_RATIO = 0.28
const CHAPTER_STRIP_MIN_ASPECT_RATIO = 1.45
const FULL_PAGE_MIN_HEIGHT_RATIO = 0.58
const FULL_PAGE_SPREAD_MIN_HEIGHT_RATIO = 0.72
const TALL_CHAPTER_ARCH_MIN_HEIGHT_RATIO = 0.40

export function isLikelyHorizontalChapterStrip({ width, height, pageWidth, pageHeight }) {
  if (!pageWidth || !pageHeight || !width || !height) {
    return false
  }

  const widthRatio = width / pageWidth
  const heightRatio = height / pageHeight
  const aspectRatio = width / height

  return (
    widthRatio >= CHAPTER_STRIP_MIN_WIDTH_RATIO &&
    heightRatio >= CHAPTER_STRIP_MIN_HEIGHT_RATIO &&
    heightRatio <= CHAPTER_STRIP_MAX_HEIGHT_RATIO &&
    aspectRatio >= CHAPTER_STRIP_MIN_ASPECT_RATIO &&
    heightRatio < FULL_PAGE_MIN_HEIGHT_RATIO
  )
}

export function isLikelyChapterArchBanner({ width, height, pageWidth, pageHeight }) {
  if (!pageWidth || !pageHeight || !width || !height) {
    return false
  }

  const widthRatio = width / pageWidth
  const heightRatio = height / pageHeight
  const aspectRatio = width / height

  if (widthRatio < CHAPTER_ARCH_MIN_WIDTH_RATIO || heightRatio < 0.06) {
    return false
  }

  if (heightRatio >= FULL_PAGE_MIN_HEIGHT_RATIO) {
    return false
  }

  if (isLikelyHorizontalChapterStrip({ width, height, pageWidth, pageHeight })) {
    return true
  }

  if (
    heightRatio >= CHAPTER_ARCH_MIN_HEIGHT_RATIO &&
    heightRatio <= CHAPTER_ARCH_MAX_HEIGHT_RATIO &&
    aspectRatio >= CHAPTER_ARCH_MIN_ASPECT_RATIO &&
    aspectRatio <= CHAPTER_ARCH_MAX_ASPECT_RATIO
  ) {
    return true
  }

  if (widthRatio >= 0.55 && aspectRatio >= 0.95) {
    return true
  }

  return false
}

export function isLikelyChapterArchBannerBlock(block) {
  const coords = block?.coordinates ?? {}
  return isLikelyChapterArchBanner({
    width: coords.width ?? 0,
    height: coords.height ?? 0,
    pageWidth: coords.pageWidth ?? 0,
    pageHeight: coords.pageHeight ?? 0,
  })
}

export function isTallChapterArchBannerBlock(block) {
  const coords = block?.coordinates ?? {}
  const pageHeight = coords.pageHeight ?? 0
  const height = coords.height ?? 0
  if (!pageHeight || !height) {
    return false
  }

  return (
    isLikelyChapterArchBannerBlock(block) &&
    height / pageHeight >= TALL_CHAPTER_ARCH_MIN_HEIGHT_RATIO
  )
}

export function isFullPageSpreadHalf(block, previousImage) {
  if (block?.imageRole !== "full_page_illustration") {
    return false
  }
  if (previousImage?.imageRole !== "full_page_illustration") {
    return false
  }

  const pageNumber = block.pageNumber ?? 0
  if ((previousImage.pageNumber ?? 0) !== pageNumber - 1) {
    return false
  }

  const coords = block.coordinates ?? {}
  const prevCoords = previousImage.coordinates ?? {}
  const heightRatio =
    coords.pageHeight > 0 ? (coords.height ?? 0) / coords.pageHeight : 0
  const prevHeightRatio =
    prevCoords.pageHeight > 0 ? (prevCoords.height ?? 0) / prevCoords.pageHeight : 0

  return (
    heightRatio >= FULL_PAGE_SPREAD_MIN_HEIGHT_RATIO &&
    prevHeightRatio >= FULL_PAGE_SPREAD_MIN_HEIGHT_RATIO
  )
}

export const PDF_IMAGE_ROLE = Object.freeze({
  FULL_PAGE_ILLUSTRATION: "full_page_illustration",
  CHAPTER_HEADING: "chapter_heading",
})

/** Minimum rendered height (px) for a wide banner to count as a chapter heading graphic. */
export const CHAPTER_HEADING_MIN_HEIGHT_PX = 36

/**
 * @returns {"full_page_illustration"|"chapter_heading"|null}
 */
export function classifyPdfImageRole(metrics) {
  const { width, height, pageHeight, pageWidth } = metrics ?? {}
  if (!pageHeight || !pageWidth || !width || !height) {
    return null
  }

  const widthRatio = width / pageWidth
  const heightRatio = height / pageHeight
  const aspectRatio = width / height

  if (widthRatio < CHAPTER_ARCH_MIN_WIDTH_RATIO) {
    return null
  }

  if (isLikelyChapterArchBanner({ width, height, pageWidth, pageHeight })) {
    return PDF_IMAGE_ROLE.CHAPTER_HEADING
  }

  if (heightRatio >= FULL_PAGE_MIN_HEIGHT_RATIO) {
    return PDF_IMAGE_ROLE.FULL_PAGE_ILLUSTRATION
  }

  if (
    height >= CHAPTER_HEADING_MIN_HEIGHT_PX &&
    widthRatio >= CHAPTER_STRIP_MIN_WIDTH_RATIO &&
    heightRatio >= CHAPTER_STRIP_MIN_HEIGHT_RATIO &&
    heightRatio <= CHAPTER_STRIP_MAX_HEIGHT_RATIO &&
    aspectRatio >= CHAPTER_STRIP_MIN_ASPECT_RATIO
  ) {
    return PDF_IMAGE_ROLE.CHAPTER_HEADING
  }

  if (
    height >= CHAPTER_HEADING_MIN_HEIGHT_PX &&
    widthRatio >= 0.55 &&
    heightRatio >= 0.06 &&
    heightRatio < FULL_PAGE_MIN_HEIGHT_RATIO &&
    aspectRatio >= 1.05
  ) {
    return PDF_IMAGE_ROLE.CHAPTER_HEADING
  }

  return null
}

export function isChapterLikeOcrMetadata(ocrMetadata) {
  const kind = ocrMetadata?.boundaryKind
  return (
    kind === "chapter" ||
    kind === "interlude" ||
    kind === "prelude" ||
    kind === "prologue" ||
    kind === "epilogue"
  )
}
