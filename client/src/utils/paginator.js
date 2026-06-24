/**
 * Flattens parsed API document content into a single block stream for layout measurement.
 */

/** Attribution lines (structural ~13px) rendered as author, not subtitle. */
export const AUTHOR_LINE_REGEX = /^(by|written by|translated by)\s+/i

export const DEDICATION_SUBTITLE_REGEX = /^To\s+[A-Z]/i

const CHAPTER_WORD_NUMBERS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty"

export const TOC_CHAPTER_LISTING_REGEX = new RegExp(
  `^(?:Chapter\\s+(\\d+|[IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty)\\s*:\\s+\\S|\\d{1,3}:\\s+[A-Z][A-Z0-9\\s''.,\\-]+)$`,
  "i"
)

export const CHAPTER_BOUNDARY_REGEX = new RegExp(
  `^(?:(?:chapter|letter|part|section|book|volume|preface|introduction|prologue|epilogue|conclusion|appendix|stave)\\s+(?:\\d+|[ivxlcdm]+|${CHAPTER_WORD_NUMBERS})|(?:preface|introduction|prologue|epilogue|conclusion|dedication))\\.?$`,
  "i"
)

const STRUCTURAL_HEADING_PREFIX_REGEX =
  /^(chapter|letter|part|section|book|volume|preface|introduction|prologue|epilogue|conclusion|appendix|stave)\s+/i

const STRUCTURAL_HEADING_MAX_CHARS = 80
const STRUCTURAL_HEADING_MAX_WORDS = 12

export const CHAPTER_NUMBER_REGEX = new RegExp(
  `^(\\d{1,2}|[ivxlcdm]+|${CHAPTER_WORD_NUMBERS})\\.?$`,
  "i"
)

export const CHAPTER_WITH_SUBTITLE_REGEX = new RegExp(
  `^(chapter|letter)\\s+(\\d{1,3}|[ivxlcdm]+|${CHAPTER_WORD_NUMBERS})\\s*-\\s+\\S`,
  "i"
)

export const CHAPTER_HEADING_MIN_FONT_SIZE = 12.5

const VOLUME_PART_LABEL_REGEX =
  /\b(volume|part|book)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+|[ivxlcdm]+)\b/i

/**
 * Maps API chapter ids to first reader page numbers from measured layout pages.
 */
const ROMAN_CHAPTER_VALUES = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
  xi: 11,
  xii: 12,
}

function extractChapterNumberLabel(text) {
  const trimmed = (text ?? "").trim()
  const digitMatch = trimmed.match(/\bchapter\s+(\d{1,3})\b/i)
  if (digitMatch) {
    return digitMatch[1]
  }

  const romanMatch = trimmed.match(/\bchapter\s+([ivxlcdm]+)\b/i)
  if (romanMatch) {
    const value = ROMAN_CHAPTER_VALUES[romanMatch[1].toLowerCase()]
    return value !== undefined ? String(value) : romanMatch[1].toLowerCase()
  }

  return null
}

function extractVolumePartKey(text) {
  const match = (text ?? "").trim().match(VOLUME_PART_LABEL_REGEX)
  if (!match) {
    return null
  }
  return `${match[1]} ${match[2]}`.toLowerCase()
}

function isChapterBoundaryVisualItem(item) {
  if (!item) {
    return false
  }
  if (item.type === "chapter") {
    return true
  }
  if (item.type === "title" && item.isChapterStart) {
    return true
  }
  return Boolean(item.isChapterStart && isChapterBoundaryText(item.text))
}

function pageDeclaresChapter(page, chapter) {
  if (!page?.isChapterStart) {
    return false
  }

  const titles = [page.chapterTitle, ...(page.chaptersOnPage ?? [])].filter(
    Boolean
  )

  return titles.some((title) =>
    chapterTitlesReferToSameChapter(chapter.title, title)
  )
}

/** Keeps volume/chapter labels on one line in the narrow TOC sidebar. */
export function formatTocChapterTitle(title) {
  return (title ?? "")
    .trim()
    .replace(/\s*—\s*/g, "\u00a0—\u00a0")
    .replace(/\b(Chapter)\s+(\d{1,3})\b/gi, "$1\u00a0$2")
    .replace(/(\d{1,3})\s*-\s*/g, "$1\u00a0-\u00a0")
}

export function normalizeImageDimensions(source) {
  const dimensions = source?.dimensions ?? {}
  const coordinates = source?.coordinates ?? {}
  const width = Number(dimensions.width ?? coordinates.width ?? 0)
  const height = Number(dimensions.height ?? coordinates.height ?? 0)
  let aspectRatio = Number(dimensions.aspectRatio)

  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    aspectRatio = width > 0 && height > 0 ? width / height : 4 / 3
  }

  return {
    width,
    height,
    aspectRatio,
  }
}

export function isFullPageIllustrationItem(item) {
  if (item?.imageRole === "full_page_illustration") {
    return true
  }

  const coords = item?.coordinates ?? {}
  const pageHeight = coords.pageHeight ?? 0
  const pageWidth = coords.pageWidth ?? 0
  const height = coords.height ?? 0
  const width = coords.width ?? 0
  if (!pageHeight || !pageWidth || !height || !width) {
    return false
  }

  const heightRatio = height / pageHeight
  const widthRatio = width / pageWidth
  const aspectRatio = width / height

  // Tall plates use full-page layout even when mis-tagged as chapter boundaries.
  if (heightRatio >= 0.58) {
    return true
  }

  if (item?.isChapterBoundary) {
    return false
  }

  if (
    widthRatio >= 0.33 &&
    heightRatio >= 0.1 &&
    heightRatio <= 0.28 &&
    aspectRatio >= 1.45
  ) {
    return false
  }

  return heightRatio >= 0.4 && widthRatio >= 0.35 && aspectRatio >= 0.55 && aspectRatio <= 1.35
}

export function resolveImageLayoutMetrics(
  item,
  { contentMaxHeight = 0, contentWidth = 328 } = {}
) {
  const dimensions = normalizeImageDimensions(item)
  const isChapterHeading = item?.imageRole === "chapter_heading"
  const isFullPageIllustration = isFullPageIllustrationItem(item)
  const safeContentWidth = Math.max(120, contentWidth)

  if (isFullPageIllustration && contentMaxHeight > 0) {
    const maxHeight = Math.round(contentMaxHeight)
    const widthBasedHeight = safeContentWidth / dimensions.aspectRatio
    let displayWidth = safeContentWidth
    let displayHeight = widthBasedHeight

    if (displayHeight > maxHeight) {
      displayHeight = maxHeight
      displayWidth = maxHeight * dimensions.aspectRatio
    }

    const wrapperStyle = {
      width: `${Math.round(displayWidth)}px`,
      maxWidth: "100%",
      height: `${Math.round(displayHeight)}px`,
      maxHeight: `${maxHeight}px`,
      marginLeft: "auto",
      marginRight: "auto",
    }

    return {
      dimensions,
      wrapperStyle,
      measuredHeight: Math.max(120, Math.round(displayHeight)),
    }
  }

  const maxHeightFraction = isChapterHeading ? 0.42 : 0.7
  const maxHeightCap =
    contentMaxHeight > 0 ? Math.round(contentMaxHeight * maxHeightFraction) : null
  let naturalHeight = safeContentWidth / dimensions.aspectRatio

  const wrapperStyle = {
    width: "100%",
    aspectRatio: String(dimensions.aspectRatio),
    maxWidth: "100%",
  }

  if (maxHeightCap && naturalHeight > maxHeightCap) {
    const scaledWidth = Math.round(maxHeightCap * dimensions.aspectRatio)
    wrapperStyle.width = `${scaledWidth}px`
    wrapperStyle.maxWidth = "100%"
    wrapperStyle.height = `${maxHeightCap}px`
    wrapperStyle.maxHeight = `${maxHeightCap}px`
    wrapperStyle.marginLeft = "auto"
    wrapperStyle.marginRight = "auto"
    naturalHeight = maxHeightCap
  }

  return {
    dimensions,
    wrapperStyle,
    measuredHeight: Math.max(120, Math.round(naturalHeight)),
  }
}

export function getImageChapterAccessibilityLabel(item) {
  const rawText = (item?.chapterMetadata?.rawText ?? "").trim()
  if (rawText) {
    return rawText
  }

  return formatImageChapterTocTitle(item?.chapterMetadata)
}

export function formatImageChapterTocTitle(chapterMetadata) {
  const boundaryKind = chapterMetadata?.boundaryKind ?? null
  const number = (chapterMetadata?.number ?? "").trim()
  const title = (chapterMetadata?.title ?? "").trim()
  const rawText = (chapterMetadata?.rawText ?? "").trim()

  if (boundaryKind === "prelude" || boundaryKind === "prologue" || boundaryKind === "epilogue") {
    if (number && title) {
      return `${number}: ${title}`
    }
    if (title) {
      return title
    }
    return number || boundaryKind.charAt(0).toUpperCase() + boundaryKind.slice(1)
  }

  if (boundaryKind === "interlude_divider") {
    return number || title || "Interludes"
  }

  if (boundaryKind === "part") {
    if (number && title) {
      return `${number}: ${title}`
    }
    return number || title || "Part"
  }

  if (boundaryKind === "interlude") {
    if (number && title) {
      return `${number}: ${title}`
    }
    return number || title || "Interlude"
  }

  if (boundaryKind === "flashback") {
    return title || number || "Flashback"
  }

  if (number && title) {
    const numberLower = number.toLowerCase()
    const titleLower = title.toLowerCase()
    if (numberLower.includes(titleLower) || titleLower.includes(numberLower)) {
      return number
    }
    return `${number}: ${title}`
  }

  if (title) {
    return title
  }

  if (number) {
    return number
  }

  if (rawText && /^Chapter\s+\d{1,3}(?::\s+[A-Za-z][A-Za-z\s'\-]{3,})?$/i.test(rawText)) {
    return rawText
  }

  return "Chapter"
}

export function extractImageChapterTocEntries(document) {
  const entries = []

  for (const page of document?.content ?? []) {
    for (const block of page?.blocks ?? []) {
      if (block?.type !== "image" || block.isChapterBoundary !== true) {
        continue
      }

      const metadata = block.chapterMetadata ?? {}
      if (metadata.includeInToc === false) {
        continue
      }

      entries.push({
        id: block.id,
        chapterMetadata: metadata,
        sourcePageNumber: block.pageNumber ?? null,
      })
    }
  }

  return entries
}

export function buildImageChapterPageMap(measuredPages) {
  const map = {}

  for (const page of measuredPages ?? []) {
    for (const item of page.visualItems ?? []) {
      if (item.type === "image" && item.isChapterBoundary === true && item.id) {
        if (map[item.id] == null) {
          map[item.id] = page.pageNumber
        }
      }
    }
  }

  return map
}

export function chapterTitlesReferToSameChapter(apiTitle, candidateTitle) {
  const api = (apiTitle ?? "").trim()
  const candidate = (candidateTitle ?? "").trim()
  if (!api || !candidate) {
    return false
  }
  if (api === candidate) {
    return true
  }

  const apiPart = extractVolumePartKey(api)
  const candidatePart = extractVolumePartKey(candidate)
  if (apiPart && candidatePart && apiPart !== candidatePart) {
    return false
  }

  const apiNumber = extractChapterNumberLabel(api)
  const candidateNumber = extractChapterNumberLabel(candidate)
  if (apiNumber && candidateNumber) {
    return (
      apiNumber === candidateNumber &&
      /\bchapter\s+\d/i.test(api) &&
      /\bchapter\s+\d/i.test(candidate)
    )
  }

  if (apiPart && !candidatePart) {
    return false
  }

  // Part/volume-only headings (e.g. "PART TWO") or roman chapter labels without digits.
  if (!apiNumber && !candidateNumber) {
    const apiLower = api.toLowerCase()
    const candidateLower = candidate.toLowerCase()
    const apiNamesChapter = /\bchapter\s+/i.test(api)
    const candidateNamesChapter = /\bchapter\s+/i.test(candidate)

    if (apiNamesChapter !== candidateNamesChapter) {
      return false
    }

    if (!apiNamesChapter) {
      return apiPart
        ? apiPart === candidatePart
        : apiLower === candidateLower
    }

    return (
      apiLower === candidateLower ||
      (apiLower.length >= 16 && candidateLower.includes(apiLower)) ||
      (candidateLower.length >= 16 && apiLower.includes(candidateLower))
    )
  }

  return false
}

export function buildChapterPageMap(measuredPages, apiChapters) {
  const map = {}

  if (!Array.isArray(apiChapters) || apiChapters.length === 0) {
    return map
  }

  let minPage = 1

  for (const chapter of apiChapters) {
    for (const page of measuredPages) {
      if (page.pageNumber < minPage) {
        continue
      }

      let matched = false

      for (const item of page.visualItems ?? []) {
        if (item.chapterId !== chapter.id) {
          continue
        }
        if (!isChapterBoundaryVisualItem(item)) {
          continue
        }
        map[chapter.id] = page.pageNumber
        minPage = page.pageNumber
        matched = true
        break
      }

      if (matched) {
        break
      }

      if (pageDeclaresChapter(page, chapter)) {
        map[chapter.id] = page.pageNumber
        minPage = page.pageNumber
        break
      }
    }
  }

  return map
}

export function isTocChapterListingText(text) {
  return TOC_CHAPTER_LISTING_REGEX.test((text ?? "").trim())
}

export function isShortDialogueLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 48) {
    return false
  }
  if (/^[''\u2018\u201c][^''""]{0,40}[''\u2019\u201d]?\.?$/.test(trimmed)) {
    return true
  }
  return /^[''\u2018]?\s*(yes|no|ok|okay)\.?\s*[''\u2019]?\.?$/i.test(trimmed)
}

export function proseShouldBeCentered(proseItem) {
  if (proseItem?.textAlign !== "center") {
    return false
  }
  return !isShortDialogueLine(proseItem?.text ?? "")
}

function countStructuralMarkers(text) {
  const pattern =
    /\b(chapter|letter|volume|part|section|book)\s+([IVXLCDM]+|\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi
  let count = 0
  while (pattern.exec(text)) {
    count += 1
  }
  return count
}

function isHeaderPageMarkerText(text) {
  const trimmed = (text ?? "").trim()
  return /^(?:preface|introduction|prologue|epilogue|conclusion)\s+[ivxlcdm]{1,4}$/i.test(
    trimmed
  )
}

function normalizeHeadingCandidate(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return ""
  }

  if (CHAPTER_BOUNDARY_REGEX.test(trimmed)) {
    return trimmed
  }

  const withoutPrintedPage = trimmed.replace(
    /^(?:(?:chapter|letter|volume|part|section|book|stave)\s+(?:[IVXLCDM]+|\d+|one|two|three|four|five|six|seven|eight|nine|ten))\s+\d{1,4}$/i,
    "$1"
  )
  if (CHAPTER_BOUNDARY_REGEX.test(withoutPrintedPage)) {
    return withoutPrintedPage
  }

  return withoutPrintedPage
    .replace(/\s+[ivxlcdm]+\s*$/i, "")
    .replace(/\s+\d{1,3}\s*$/, "")
    .trim()
}

function isTocDenseListingText(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || countStructuralMarkers(trimmed) >= 2) {
    return countStructuralMarkers(trimmed) >= 2
  }
  return /\b(?:letter|chapter|volume)\s+[IVXLCDM\d]+\s+\d{1,4}\b.*\b(?:letter|chapter|volume)\s+/i.test(
    trimmed
  )
}

function isTocPageReferenceText(text) {
  const trimmed = (text ?? "").trim()
  return /^(?:(?:chapter|letter|volume|part)\s+[IVXLCDM\d]+\s+\d{1,4}|volume\s+[IVXLCDM\d]+\s+\d{1,4})$/i.test(
    trimmed
  )
}

function isRunningHeaderMergedText(text) {
  const trimmed = (text ?? "").trim()
  if (isTocPageReferenceText(trimmed)) {
    return true
  }
  return (
    /^(?:chapter|letter)\s+[IVXLCDM\d]+\s+\d{0,3}\s+[a-z]/i.test(trimmed) ||
    /^(?:chapter|letter)\s+[IVXLCDM\d]+\s+\d{1,3}\s+[A-Z][a-z]{2,}/.test(trimmed)
  )
}

export function isCleanStructuralHeadingText(text, block = null) {
  const raw = (text ?? "").trim()
  if (!raw || /^contents$/i.test(raw)) {
    return false
  }
  if (isTocChapterListingText(raw)) {
    return false
  }
  if (isTocDenseListingText(raw)) {
    return false
  }
  if (isRunningHeaderMergedText(raw)) {
    return false
  }
  if (isHeaderPageMarkerText(raw)) {
    return false
  }

  const trimmed = normalizeHeadingCandidate(raw)
  if (!trimmed) {
    return false
  }
  if (trimmed.length > STRUCTURAL_HEADING_MAX_CHARS) {
    return false
  }
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length > STRUCTURAL_HEADING_MAX_WORDS) {
    return false
  }
  if ((trimmed.match(/[.!?]/g) ?? []).length >= 2) {
    return false
  }
  if (CHAPTER_BOUNDARY_REGEX.test(trimmed)) {
    return true
  }
  if (STRUCTURAL_HEADING_PREFIX_REGEX.test(trimmed)) {
    const fontSize = block?.fontSize ?? 0
    if (fontSize >= CHAPTER_HEADING_MIN_FONT_SIZE || words.length <= 4) {
      return true
    }
  }
  return false
}

export function isChapterBoundaryText(text) {
  const trimmed = (text ?? "").trim()
  if (CHAPTER_WITH_SUBTITLE_REGEX.test(trimmed)) {
    return true
  }
  if (/^prelude to\b/i.test(trimmed)) {
    return true
  }
  return isCleanStructuralHeadingText(text)
}

const FABLE_NON_STORY_HEADING_REGEX =
  /^(introduction|preface|prologue|epilogue|conclusion|contents|illustrations)$/i

const FABLE_DISPLAY_TITLE_MIN_FONT_SIZE = 20
const FABLE_DISPLAY_TITLE_MAX_FONT_SIZE = 35

function isPureAllCapsTitleText(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || isTocChapterListingText(trimmed) || isTocDenseListingText(trimmed)) {
    return false
  }
  if (/[.!?][\u201d"\u2019']?\s*$/.test(trimmed)) {
    return false
  }

  const letters = trimmed.replace(/[^A-Za-z]/g, "")
  if (letters.length < 3 || letters !== letters.toUpperCase()) {
    return false
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  return words.length >= 1 && words.length <= 14
}

export function isFableStoryTitleBlock(block) {
  if (!block?.isHeading) {
    return false
  }

  const text = (block.text ?? "").trim()
  if (!text || text.length > 90) {
    return false
  }

  const fontSize = block.fontSize ?? 0
  if (fontSize >= 40) {
    return false
  }

  if (FABLE_NON_STORY_HEADING_REGEX.test(text)) {
    return false
  }
  if (CHAPTER_BOUNDARY_REGEX.test(text)) {
    return false
  }
  if (isTocChapterListingText(text) || isTocDenseListingText(text)) {
    return false
  }
  if (isCleanStructuralHeadingText(text, block)) {
    return false
  }

  if (
    block.isChapterStart &&
    (block.textAlign === "center" || block.centered)
  ) {
    return true
  }

  if (
    fontSize >= FABLE_DISPLAY_TITLE_MIN_FONT_SIZE &&
    fontSize <= FABLE_DISPLAY_TITLE_MAX_FONT_SIZE &&
    isPureAllCapsTitleText(text)
  ) {
    return true
  }

  if (
    block.isChapterStart &&
    (block.textAlign === "center" || block.centered)
  ) {
    return true
  }

  return false
}

export function inferBlockIsChapterStart(block) {
  if (block?.isChapterStart === true) {
    return true
  }
  if (block?.isChapterStart === false) {
    if (!isFableStoryTitleBlock(block)) {
      return false
    }
    return true
  }
  if (!block?.isHeading) {
    return false
  }

  const text = (block.text ?? "").trim()

  if (!block.chapterId && isTocChapterListingText(text)) {
    return false
  }

  if (CHAPTER_WITH_SUBTITLE_REGEX.test(text)) {
    return true
  }

  if (isCleanStructuralHeadingText(text, block)) {
    return true
  }

  if (isFableStoryTitleBlock(block)) {
    return true
  }

  const numericCheckRegex =
    /^(\d{1,2}|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\.?$/i
  if (
    numericCheckRegex.test(text) &&
    (block.fontSize ?? 0) >= CHAPTER_HEADING_MIN_FONT_SIZE
  ) {
    return true
  }

  return false
}

export function isAuthorLineText(text) {
  return AUTHOR_LINE_REGEX.test((text ?? "").trim())
}

export function isDedicationSubtitleItem(item) {
  return (
    item?.type === "subtitle" &&
    DEDICATION_SUBTITLE_REGEX.test((item.text ?? "").trim())
  )
}

export function isDedicationSubtitlePlaceable(placeable) {
  return isDedicationSubtitleItem(placeable?.item)
}

/**
 * Maps parser heading font sizes to viewer visual item types.
 * @param {number} fontSize
 * @param {string} [text]
 * @returns {"title"|"heading"|"subtitle"|"author"}
 */
export function resolveHeadingVisualType(fontSize, text = "") {
  if (isAuthorLineText(text)) {
    return "author"
  }
  const size = fontSize ?? 16
  if (size > 18) return "title"
  if (size >= 14) return "heading"
  if (size >= 13) return "subtitle"
  return "subtitle"
}

export function isFrontMatterVisualType(type) {
  return type === "title" || type === "subtitle" || type === "author"
}

function qualifiesAsFrontMatterPlaceable(placeable) {
  const item = placeable.item
  if (isTocChapterListingText(item?.text)) {
    return false
  }
  if (isChapterBoundaryText(item?.text) || item?.type === "chapter") {
    return false
  }
  return (
    isFrontMatterVisualType(item?.type) ||
    isDedicationSubtitlePlaceable(placeable) ||
    (item?.type === "heading" && (item.fontSize ?? 16) <= 13)
  )
}

/**
 * Groups a front-matter pack into placement units (consecutive title/subtitle/author lines).
 * @param {Array<{ type: string, item?: object }>} pack
 * @returns {Array<Array<{ type: string, item?: object }>>}
 */
export function groupFrontMatterPlacementUnits(pack) {
  if (!pack.length) {
    return []
  }

  const units = []
  let unit = []

  const continuesFrontMatterRun = (item) =>
    item &&
    (isFrontMatterVisualType(item.type) || isDedicationSubtitleItem(item))

  for (const placeable of pack) {
    const item = placeable.item

    if (unit.length === 0) {
      unit.push(placeable)
      continue
    }

    const lastItem = unit[unit.length - 1].item
    if (continuesFrontMatterRun(item) && continuesFrontMatterRun(lastItem)) {
      unit.push(placeable)
    } else {
      units.push(unit)
      unit = [placeable]
    }
  }

  if (unit.length > 0) {
    units.push(unit)
  }

  return units.length > 0 ? units : [pack]
}

/**
 * First real chapter / body boundary (not title-page structural lines).
 * @param {object|null} item - grouped visual item
 */
export function isChapterContentBoundaryItem(item) {
  if (!item) return false

  if (item.type === "chapter") {
    return true
  }

  const text = (item.text ?? "").trim()
  if (isChapterBoundaryText(text)) {
    return true
  }

  if (item.type === "prose" && item.chapterId) {
    return true
  }

  if (item.isChapterStart) {
    return true
  }

  return false
}

const DEDICATION_SCAN_AFTER_CHAPTER = 30

/**
 * Splits placeables into a front-matter pack (before first chapter) and the rest.
 * @param {Array<{ type: string, item?: object }>} placeables
 */
export function buildFrontMatterPack(placeables) {
  let chapterStartIndex = placeables.length

  for (let index = 0; index < placeables.length; index += 1) {
    if (isChapterContentBoundaryItem(placeables[index].item)) {
      chapterStartIndex = index
      break
    }
  }

  const packedIndices = new Set()
  const dedicationScanEnd = Math.min(
    placeables.length,
    chapterStartIndex + DEDICATION_SCAN_AFTER_CHAPTER
  )

  for (let index = 0; index < chapterStartIndex; index += 1) {
    if (qualifiesAsFrontMatterPlaceable(placeables[index])) {
      packedIndices.add(index)
    }
  }

  for (let index = chapterStartIndex; index < dedicationScanEnd; index += 1) {
    if (isDedicationSubtitlePlaceable(placeables[index])) {
      packedIndices.add(index)
    }
  }

  const frontMatterPack = []
  const remainder = []

  for (let index = 0; index < placeables.length; index += 1) {
    if (packedIndices.has(index)) {
      frontMatterPack.push(placeables[index])
    } else {
      remainder.push(placeables[index])
    }
  }

  return { frontMatterPack, remainder }
}

export function isEpigraphOrChapterOpenerProse(placeable) {
  if (placeable?.type !== "prose") {
    return false
  }

  const text = (placeable.item?.text ?? "").trim()
  if (!text) {
    return false
  }

  if (/^[\u2014\u2013—-]/.test(text)) {
    return true
  }

  if (/^—(?:Collected|Noted|Dated|Purports|Though)/i.test(text)) {
    return true
  }

  if (
    text.length <= 60 &&
    /^[A-Z][A-Z0-9\s'’\-]{3,}$/.test(text) &&
    !/^THE\s/.test(text)
  ) {
    return true
  }

  return false
}

export function shouldCenterTitlePage(visualItems) {
  return isTitlePageVisualItems(visualItems)
}

export function isTitlePageVisualItems(visualItems) {
  return (
    visualItems.length > 0 &&
    visualItems.every((item) => isFrontMatterVisualType(item.type))
  )
}

/**
 * @param {object} document - API document with content and chapters
 * @returns {Array<{ text: string, isHeading: boolean, fontSize: number, chapterId: string|null, chapterTitle: string|null, isChapterStart: boolean }>}
 */
export function flattenDocument(document) {
  const chapters = document?.chapters ?? []
  const chapterTitleById = Object.fromEntries(
    chapters.map((chapter) => [chapter.id, chapter.title])
  )

  const flatBlocks = []

  for (const page of document?.content ?? []) {
    for (const block of page?.blocks ?? []) {
      if (block?.type === "image") {
        if (!block.src) {
          continue
        }

        flatBlocks.push({
          type: "image",
          id: block.id ?? null,
          src: block.src,
          imageRole: block.imageRole ?? null,
          isChapterBoundary: Boolean(block.isChapterBoundary),
          boundaryKind: block.chapterMetadata?.boundaryKind ?? null,
          chapterMetadata: {
            ...(block.chapterMetadata ?? {}),
            includeInToc: block.chapterMetadata?.includeInToc !== false,
          },
          coordinates: block.coordinates ?? null,
          dimensions: normalizeImageDimensions(block),
          pageNumber: block.pageNumber ?? null,
        })
        continue
      }

      const text = block?.text ?? ""
      const chapterId = block.chapterId ?? null

      if (!chapterId && isTocChapterListingText(text)) {
        continue
      }

      flatBlocks.push({
        text,
        isHeading: Boolean(block.isHeading),
        fontSize: block.fontSize,
        chapterId,
        chapterTitle: chapterId
          ? block.chapterTitle ?? chapterTitleById[chapterId] ?? null
          : null,
        isChapterStart: inferBlockIsChapterStart(block),
        ...(block.isIndented ? { isIndented: true } : {}),
        ...(block.textAlign === "center" ? { textAlign: "center" } : {}),
        ...(block.bold ? { bold: true } : {}),
        ...(block.italic ? { italic: true } : {}),
        ...(block.runs?.length ? { runs: block.runs } : {}),
      })
    }
  }

  return flatBlocks
}

/**
 * @param {Array<{ pageNumber: number, blocks: object[] }>} pages
 * @returns {Record<string, number>}
 */
export function getChapterPages(pages) {
  const chapterPages = {}

  for (const page of pages) {
    for (const block of page.blocks) {
      const chapterId = block.chapterId
      if (chapterId && chapterPages[chapterId] === undefined) {
        chapterPages[chapterId] = page.pageNumber
      }
    }
  }

  return chapterPages
}
