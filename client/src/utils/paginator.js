/**
 * Flattens parsed API document content into a single block stream for layout measurement.
 */

/** Attribution lines (structural ~13px) rendered as author, not subtitle. */
export const AUTHOR_LINE_REGEX = /^(by|written by|translated by)\s+/i

export function isAuthorLineText(text) {
  return AUTHOR_LINE_REGEX.test((text ?? "").trim())
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

/**
 * First real chapter / body boundary (not title-page structural lines).
 * @param {object|null} item - grouped visual item
 */
export function isChapterContentBoundaryItem(item) {
  if (!item) return false

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

  const frontMatterPack = []
  const beforeChapterOther = []

  for (let index = 0; index < chapterStartIndex; index += 1) {
    const placeable = placeables[index]
    if (isFrontMatterVisualType(placeable.item?.type)) {
      frontMatterPack.push(placeable)
    } else {
      beforeChapterOther.push(placeable)
    }
  }

  const remainder = [...beforeChapterOther, ...placeables.slice(chapterStartIndex)]

  return { frontMatterPack, remainder }
}

export function shouldCenterTitlePage(visualItems) {
  const frontMatter = (visualItems ?? []).filter((item) =>
    isFrontMatterVisualType(item.type)
  )
  return frontMatter.length > 0 && frontMatter.length <= 2
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

      flatBlocks.push({
        text,
        isHeading: Boolean(block.isHeading),
        fontSize: block.fontSize,
        chapterId,
        chapterTitle: chapterId ? chapterTitleById[chapterId] ?? null : null,
        isChapterStart: Boolean(block.isHeading),
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
