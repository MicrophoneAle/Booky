import { READING_ANCHOR_PREFIX_LENGTH } from "./constants.js"
import { flattenListText } from "./listRendering.jsx"
export function visualItemPlainText(item) {
  if (!item) {
    return ""
  }
  if (
    item.type === "prose" ||
    item.type === "heading" ||
    item.type === "chapter" ||
    item.type === "title" ||
    item.type === "subtitle" ||
    item.type === "author"
  ) {
    return item.text ?? ""
  }
  if (item.type === "list") {
    return flattenListText(item.items).join(" ")
  }
  return ""
}

export function getReadingAnchorPrefix(pages, currentPage, isSpreadView) {
  const pageIndices = isSpreadView
    ? [currentPage - 1, currentPage]
    : [currentPage - 1]

  for (const pageIndex of pageIndices) {
    const page = pages[pageIndex]
    if (!page) {
      continue
    }

    for (const item of page.visualItems ?? []) {
      const text = visualItemPlainText(item).trim()
      if (text) {
        return text.slice(0, READING_ANCHOR_PREFIX_LENGTH)
      }
    }
  }

  return null
}

export function findPageIndexWithAnchorPrefix(pages, anchorPrefix) {
  if (!anchorPrefix) {
    return null
  }

  const normalizedAnchor = anchorPrefix.trim().toLowerCase()
  if (!normalizedAnchor) {
    return null
  }

  for (const page of pages) {
    for (const item of page.visualItems ?? []) {
      const text = visualItemPlainText(item).trim().toLowerCase()
      if (text.startsWith(normalizedAnchor)) {
        return page.pageNumber
      }
    }
  }

  return null
}

/** Concatenated plain text of a page's visual items (stable across page heights). */
export function getPagePlainText(page) {
  return (page?.visualItems ?? [])
    .map((item) => visualItemPlainText(item).trim())
    .filter(Boolean)
    .join(" ")
}

/**
 * Whitespace-insensitive character count of a page's text. Whitespace is stripped
 * so the cumulative offset of a given sentence is identical regardless of how many
 * pages precede it (different page heights produce different page counts, and any
 * per-page separator would otherwise drift the offset and misalign the swap).
 */
export function getPageTextLength(page) {
  return getPagePlainText(page).replace(/\s+/g, "").length
}

/**
 * Character offset (in the book's whitespace-stripped text) of the first character
 * shown on `currentPage`. Robust to page-height changes because the total text is
 * identical regardless of where pages break.
 */
export function getReadingAnchorCharOffset(pages, currentPage) {
  const startIndex = Math.max(0, currentPage - 1)
  let offset = 0
  for (let i = 0; i < startIndex && i < pages.length; i += 1) {
    offset += getPageTextLength(pages[i])
  }
  return offset
}

/** Find the page whose text range contains `targetOffset` (mirrors the forward walk). */
export function resolvePageByCharOffset(newPages, targetOffset) {
  if (!Number.isFinite(targetOffset) || targetOffset <= 0 || newPages.length === 0) {
    return newPages.length > 0 ? newPages[0].pageNumber : 1
  }

  let cumulative = 0
  for (let i = 0; i < newPages.length; i += 1) {
    const span = getPageTextLength(newPages[i])
    if (targetOffset < cumulative + span) {
      return newPages[i].pageNumber
    }
    cumulative += span
  }

  return newPages[newPages.length - 1].pageNumber
}

/** Map a whitespace-stripped offset into the original plain-text string. */
export function mapStrippedOffsetToPlain(plainText, strippedOffset) {
  let stripped = 0
  for (let i = 0; i < plainText.length; i += 1) {
    if (!/\s/.test(plainText[i])) {
      if (stripped >= strippedOffset) {
        return i
      }
      stripped += 1
    }
  }
  return plainText.length
}

/** Split prose into sentence spans with start/end indices in the source string. */
export function splitIntoSentenceSpans(text) {
  const hasReadableChars = (value) => /[\p{L}\p{N}]/u.test(value)
  const hasEnoughBody = (value) =>
    value.replace(/^[\s"'`“”‘’()[\]{}<>-–—]+/, "").trim().length >= 2

  const sentences = []
  // Prefer full sentences that end in terminal punctuation, while still allowing
  // dialogue-style paragraph lines that are separated by line breaks.
  const regex =
    /[^.!?…\n]+[.!?…]+["'`“”‘’)\]]*(?=\s|$)|[^.!?…\n]+(?=\n|$)/g
  let match = regex.exec(text)
  while (match) {
    const raw = match[0]
    const trimmed = raw.trim()
    if (trimmed && hasReadableChars(trimmed) && hasEnoughBody(trimmed)) {
      const start = match.index + raw.indexOf(trimmed)
      sentences.push({
        text: trimmed,
        start,
        end: start + trimmed.length,
      })
    }
    match = regex.exec(text)
  }
  return sentences
}

/**
 * Returns the first full sentence at the reading anchor on `targetPageNumber`.
 * When the page starts mid-paragraph, skips the partial fragment and marks the
 * next complete sentence instead.
 */
export function findResumeAnchorSentence(newPages, targetPageNumber, targetOffset) {
  if (!newPages?.length || !Number.isFinite(targetOffset)) {
    return null
  }

  let cumulative = 0
  let targetPage = null
  for (const page of newPages) {
    if (page.pageNumber === targetPageNumber) {
      targetPage = page
      break
    }
    cumulative += getPageTextLength(page)
  }

  if (!targetPage) {
    return null
  }

  const items = targetPage.visualItems ?? []
  const offsetIntoPage = Math.max(0, targetOffset - cumulative)
  let itemCumulative = 0

  for (let i = 0; i < items.length; i += 1) {
    const plain = visualItemPlainText(items[i])
    const strippedLen = plain.replace(/\s+/g, "").length
    if (strippedLen === 0) {
      continue
    }

    if (offsetIntoPage < itemCumulative + strippedLen) {
      const offsetInItem = offsetIntoPage - itemCumulative
      const plainOffset = mapStrippedOffsetToPlain(plain, offsetInItem)
      const sentences = splitIntoSentenceSpans(plain)
      if (sentences.length === 0) {
        return null
      }

      const pageStartsMidItem = offsetInItem > 0
      if (pageStartsMidItem) {
        const nextFull = sentences.find((sentence) => sentence.start >= plainOffset)
        if (nextFull) {
          return { itemIndex: i, sentenceText: nextFull.text }
        }
        // This item starts mid-sentence and has no later full sentence.
        // Continue scanning the following items for the first complete one.
        itemCumulative += strippedLen
        continue
      }

      const containing = sentences.find(
        (sentence) => plainOffset >= sentence.start && plainOffset < sentence.end
      )
      if (containing) {
        return { itemIndex: i, sentenceText: containing.text }
      }

      const following = sentences.find((sentence) => sentence.start >= plainOffset)
      if (following) {
        return { itemIndex: i, sentenceText: following.text }
      }
      return { itemIndex: i, sentenceText: sentences[0].text }
    }

    itemCumulative += strippedLen
  }

  return null
}

/**
 * Builds a reading anchor capturing both a text prefix and a character offset.
 * Used to preserve reading position across repagination / fullscreen swaps.
 */
export function getReadingAnchor(pages, currentPage, isSpreadView) {
  return {
    prefix: getReadingAnchorPrefix(pages, currentPage, isSpreadView),
    charOffset: getReadingAnchorCharOffset(pages, currentPage),
  }
}

export function resolvePageAfterRepagination({
  newPages,
  anchor,
  oldPage,
  oldTotal,
  isSpreadView,
  normalizeBookmarkPage,
}) {
  const prefix = typeof anchor === "string" ? anchor : anchor?.prefix ?? null
  const charOffset =
    anchor && typeof anchor === "object" ? anchor.charOffset : null

  // Character-offset matching first — robust both ways (default <-> fullscreen)
  // and across split paragraphs, where prefix matching can miss.
  if (Number.isFinite(charOffset) && charOffset > 0 && newPages.length > 0) {
    const byOffset = resolvePageByCharOffset(newPages, charOffset)
    if (byOffset) {
      return normalizeBookmarkPage(byOffset, newPages.length, isSpreadView)
    }
  }

  const matched = findPageIndexWithAnchorPrefix(newPages, prefix)
  if (matched) {
    return normalizeBookmarkPage(matched, newPages.length, isSpreadView)
  }

  if (oldTotal > 0 && newPages.length > 0) {
    const proportional = Math.round((oldPage / oldTotal) * newPages.length)
    return normalizeBookmarkPage(proportional, newPages.length, isSpreadView)
  }

  return 1
}

export function buildPaginationLoadingLabel(percent, isComplete, mode = "opening") {
  if (isComplete || percent >= 100) {
    return mode === "typesetting" ? "Typesetting complete" : "Ready"
  }
  if (percent >= 90) {
    return mode === "typesetting" ? "Finishing typesetting..." : "Almost there..."
  }
  if (percent <= 0) {
    return mode === "typesetting" ? "Applying typesetting..." : "Preparing pages..."
  }
  return mode === "typesetting"
    ? `Applying typesetting… ${percent}%`
    : `Preparing pages… ${percent}%`
}

export function computeOpeningLoadingPercent(
  donePages,
  estimatedTotal,
  isComplete,
  placeableProgress = null
) {
  if (isComplete) {
    return 100
  }

  let percent = 0

  if (placeableProgress != null) {
    percent = Math.round(placeableProgress * 100)
  } else if (donePages > 0) {
    const safeTotal = Math.max(donePages, estimatedTotal || donePages, 1)
    percent = Math.round((donePages / safeTotal) * 100)
  }

  if (!Number.isFinite(percent)) {
    percent = 0
  }

  return Math.max(0, Math.min(99, percent))
}

export function schedulePageTextMapBuild(measuredPages, buildIdRef, setPageTextMap) {
  const buildId = buildIdRef.current + 1
  buildIdRef.current = buildId

  const runBuild = () => {
    if (buildIdRef.current !== buildId) {
      return
    }
    setPageTextMap(buildPageTextMap(measuredPages))
  }

  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(runBuild, { timeout: 2500 })
  } else {
    setTimeout(runBuild, 0)
  }
}

export function buildPageTextMap(measuredPages) {
  const textMap = {}

  for (const page of measuredPages) {
    const pageText = (page.visualItems ?? [])
      .map((item) => {
        if (
          item.type === "prose" ||
          item.type === "heading" ||
          item.type === "chapter" ||
          item.type === "title" ||
          item.type === "subtitle" ||
          item.type === "author"
        ) {
          return item.text
        }
        if (item.type === "list") {
          return flattenListText(item.items).join(" ")
        }
        return ""
      })
      .filter(Boolean)
      .join(" ")

    textMap[page.pageNumber] = pageText.toLowerCase()
  }

  return textMap
}

/**
 * Text area budget from typesetting: available height, line height, and max prose lines.
 */
