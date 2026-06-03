/**
 * Flattens parsed API document content into a single block stream for layout measurement.
 */

/** Attribution lines (structural ~13px) rendered as author, not subtitle. */
export const AUTHOR_LINE_REGEX = /^(by|written by|translated by)\s+/i

export const DEDICATION_SUBTITLE_REGEX = /^To\s+[A-Z]/i

export const TOC_CHAPTER_LISTING_REGEX =
  /^Chapter\s+(\d+|[IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)\s*:\s+\S/i

export const CHAPTER_BOUNDARY_REGEX =
  /^(chapter\s+(\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)|part\s+(\d+|[ivxlcdm]+|one|two|three|four|five|six)|prologue|epilogue|introduction|conclusion)\.?$/i

/**
 * Maps API chapter ids to first reader page numbers from measured layout pages.
 */
export function buildChapterPageMap(measuredPages, apiChapters) {
  const map = {}

  if (!Array.isArray(apiChapters) || apiChapters.length === 0) {
    return map
  }

  for (const chapter of apiChapters) {
    for (const page of measuredPages) {
      if (map[chapter.id] !== undefined) {
        continue
      }

      if (
        page.isChapterStart &&
        (page.chapterTitle === chapter.title ||
          page.activeChapterTitle === chapter.title)
      ) {
        map[chapter.id] = page.pageNumber
        continue
      }

      for (const item of page.visualItems ?? []) {
        if (item.chapterId !== chapter.id) {
          continue
        }
        if (
          item.type === "chapter" ||
          item.type === "heading" ||
          item.type === "title"
        ) {
          map[chapter.id] = page.pageNumber
          break
        }
      }
    }
  }

  return map
}

export function isTocChapterListingText(text) {
  return TOC_CHAPTER_LISTING_REGEX.test((text ?? "").trim())
}

export function inferBlockIsChapterStart(block) {
  if (block?.isChapterStart === true) {
    return true
  }
  if (block?.isChapterStart === false) {
    return false
  }
  if (!block?.isHeading) {
    return false
  }

  const text = (block.text ?? "").trim()

  if (!block.chapterId && isTocChapterListingText(text)) {
    return false
  }

  if (CHAPTER_BOUNDARY_REGEX.test(text)) {
    return true
  }
  if (isTocChapterListingText(text)) {
    return true
  }
  if (/^\d{1,2}\.?$/.test(text) && (block.fontSize ?? 0) >= 13) {
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

  if (item.type === "prose" && item.chapterId) {
    return true
  }

  if (item.type === "heading" && item.chapterId) {
    const text = (item.text ?? "").trim()
    if (
      item.isChapterStart ||
      /^(Chapter|Part|Section|Prologue|Epilogue)\s+(\d+|[IVXLCDM]+|[A-Za-z]+)$/i.test(text)
    ) {
      return true
    }
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
        chapterTitle: chapterId ? chapterTitleById[chapterId] ?? null : null,
        isChapterStart: inferBlockIsChapterStart({
          ...block,
          isHeading: Boolean(block.isHeading),
        }),
        ...(block.isIndented ? { isIndented: true } : {}),
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
