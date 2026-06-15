/**
 * Align Stormlight chapter banners with printed TOC entries using sequential
 * cursor assignment, re-anchored by OCR'd plaque numbers when confident.
 */

const BACK_MATTER_HEADING_PATTERNS = [
  /^ARS\s+ARCANUM$/i,
  /^ENDNOTE$/i,
  /^THE\s+END\s+OF$/i,
  /^BOOK\s+ONE\s+OF$/i,
  /^ILLUSTRATIONS$/i,
  /^THE TEN ESSENCES AND THEIR HISTORICAL ASSOCIATIONS$/i,
  /^ON THE CREATION OF FABRIALS$/i,
]

function collectFollowingTextBlocks(blocks, blockIndex, limit = 14) {
  const results = []

  for (let index = blockIndex + 1; index < blocks.length && results.length < limit; index += 1) {
    const block = blocks[index]
    if (block?.type === "image" || block?.type === "image_candidate") {
      break
    }

    const text = (block?.text ?? "").trim()
    if (text) {
      results.push(text)
    }
  }

  return results
}

function hasBackMatterHeadingText(blocks, blockIndex) {
  const followingText = collectFollowingTextBlocks(blocks, blockIndex, 8)

  return followingText.some((text) =>
    BACK_MATTER_HEADING_PATTERNS.some((pattern) => pattern.test(text.trim()))
  )
}

function printedTocEntryToOcrMetadata(entry) {
  if (!entry) {
    return null
  }

  return {
    boundaryKind: entry.kind,
    number: entry.label,
    title: entry.title,
    rawText: entry.title ? `${entry.label}: ${entry.title}` : entry.label,
  }
}

function findPrintedTocEntryIndex(printedToc, entry) {
  if (!printedToc?.ordered?.length || !entry) {
    return -1
  }

  return printedToc.ordered.indexOf(entry)
}

function advanceTocCursorAfterEntry(printedToc, tocOrderCursor, entry) {
  if (!printedToc?.ordered?.length || !tocOrderCursor || !entry) {
    return
  }

  const index = findPrintedTocEntryIndex(printedToc, entry)
  if (index >= 0) {
    tocOrderCursor.index = index + 1
  }
}

function peekNextNonPartTocEntry(printedToc, tocOrderCursor) {
  if (!printedToc?.ordered?.length || !tocOrderCursor) {
    return null
  }

  let index = tocOrderCursor.index
  while (index < printedToc.ordered.length) {
    const entry = printedToc.ordered[index]
    if (entry.kind !== "part") {
      return entry
    }
    index += 1
  }

  return null
}

function extractChapterKeyFromOcrNumber(ocrNumberLabel) {
  const label = (ocrNumberLabel ?? "").trim()
  if (!label || /interlude|prelude|prologue|epilogue|part/i.test(label)) {
    return null
  }

  const match = label.match(/\bchapter\s+(\d{1,3})\b/i) ?? label.match(/^(\d{1,3})$/)
  if (!match) {
    return null
  }

  const value = Number.parseInt(match[1], 10)
  return value >= 1 && value <= 75 ? String(value) : null
}

function findChapterEntryByKeyFromCursor(printedToc, tocOrderCursor, key) {
  for (let index = tocOrderCursor.index; index < printedToc.ordered.length; index += 1) {
    const entry = printedToc.ordered[index]
    if (entry.kind === "chapter" && String(entry.key) === key) {
      return { entry, index }
    }
  }

  return null
}

function buildTocMetadataForChapterHeading(
  blocks,
  blockIndex,
  printedToc,
  {
    tocOrderCursor = null,
    forceInterludeBoundary = false,
    buildSequentialEntry = null,
    ocrNumberLabel = null,
  } = {}
) {
  if (!printedToc?.ordered?.length) {
    return null
  }

  if (forceInterludeBoundary) {
    return buildSequentialEntry?.() ?? null
  }

  if (hasBackMatterHeadingText(blocks, blockIndex)) {
    return null
  }

  if (tocOrderCursor) {
    const key = extractChapterKeyFromOcrNumber(ocrNumberLabel)
    if (key) {
      const located = findChapterEntryByKeyFromCursor(printedToc, tocOrderCursor, key)
      if (located) {
        tocOrderCursor.index = located.index + 1
        return printedTocEntryToOcrMetadata(located.entry)
      }

      return null
    }
  }

  return buildSequentialEntry?.() ?? null
}

function takeNextSequentialTocEntry(printedToc, tocOrderCursor) {
  const entry = peekNextNonPartTocEntry(printedToc, tocOrderCursor)
  if (!entry) {
    return null
  }

  advanceTocCursorAfterEntry(printedToc, tocOrderCursor, entry)
  return printedTocEntryToOcrMetadata(entry)
}

function supplementBannerlessPrintedChapters(blocks, _printedToc) {
  return blocks
}

export {
  buildTocMetadataForChapterHeading,
  collectFollowingTextBlocks,
  extractChapterKeyFromOcrNumber,
  hasBackMatterHeadingText,
  supplementBannerlessPrintedChapters,
  takeNextSequentialTocEntry,
}
