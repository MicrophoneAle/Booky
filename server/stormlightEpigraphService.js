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

function extractTocAnchorFromOcrLabel(ocrNumberLabel) {
  const label = (ocrNumberLabel ?? "").trim()
  if (!label) {
    return null
  }

  if (/^prelude$/i.test(label)) {
    return { kind: "prelude", key: "prelude" }
  }
  if (/^prologue$/i.test(label)) {
    return { kind: "prologue", key: "prologue" }
  }
  if (/^epilogue$/i.test(label)) {
    return { kind: "epilogue", key: "epilogue" }
  }

  const interludeMatch = label.match(/interlude\s+i[\s-]*(\d{1,2})/i)
  if (interludeMatch) {
    return { kind: "interlude", key: interludeMatch[1] }
  }

  const interludePlaqueMatch = label.match(/^i[\s\-–—]*(\d{1,2})$/i)
  if (interludePlaqueMatch) {
    return { kind: "interlude", key: interludePlaqueMatch[1] }
  }

  const chapterKey = extractChapterKeyFromOcrNumber(label)
  if (chapterKey) {
    return { kind: "chapter", key: chapterKey }
  }

  return null
}

function findTocEntryByAnchorFromCursor(printedToc, tocOrderCursor, anchor) {
  if (!printedToc?.ordered?.length || !tocOrderCursor || !anchor) {
    return null
  }

  for (let index = tocOrderCursor.index; index < printedToc.ordered.length; index += 1) {
    const entry = printedToc.ordered[index]
    if (entry.kind !== anchor.kind) {
      continue
    }

    if (entry.kind === "chapter" || entry.kind === "interlude") {
      if (String(entry.key) === String(anchor.key)) {
        return { entry, index }
      }
      continue
    }

    return { entry, index }
  }

  return null
}

function peekExpectedTocAnchor(printedToc, tocOrderCursor) {
  const entry = peekNextNonPartTocEntry(printedToc, tocOrderCursor)
  if (!entry) {
    return null
  }

  if (entry.kind === "interlude") {
    const interludeNum = String(entry.key).split("-").pop()
    return { kind: "interlude", key: interludeNum }
  }

  return { kind: entry.kind, key: entry.key }
}

function shouldAcceptTocReanchor(expected, anchor, located, tocOrderCursor) {
  if (!located || located.index < tocOrderCursor.index) {
    return false
  }

  if (!expected || !anchor || expected.kind !== anchor.kind) {
    return Boolean(located)
  }

  if (expected.kind === "chapter") {
    const expectedNum = Number.parseInt(expected.key, 10)
    const anchorNum = Number.parseInt(anchor.key, 10)
    if (Number.isFinite(expectedNum) && Number.isFinite(anchorNum)) {
      return anchorNum >= expectedNum && anchorNum <= expectedNum + 2
    }
  }

  if (expected.kind === "interlude") {
    const expectedNum = Number.parseInt(expected.key, 10)
    const anchorNum = Number.parseInt(anchor.key, 10)
    if (Number.isFinite(expectedNum) && Number.isFinite(anchorNum)) {
      return anchorNum >= expectedNum && anchorNum <= expectedNum + 1
    }
  }

  return true
}

function countInterludesAfterUpcomingBannerlessChapters(printedToc, tocOrderCursor) {
  if (!printedToc?.ordered?.length || !tocOrderCursor) {
    return 0
  }

  let index = tocOrderCursor.index
  let bannerlessChapters = 0
  let firstChapterKey = null

  while (index < printedToc.ordered.length) {
    const entry = printedToc.ordered[index]
    if (entry.kind === "part") {
      index += 1
      continue
    }

    if (entry.kind === "chapter") {
      if (!firstChapterKey) {
        firstChapterKey = entry.key
      }
      bannerlessChapters += 1
      index += 1
      continue
    }

    if (entry.kind === "interlude") {
      const firstChapterNum = Number.parseInt(firstChapterKey, 10)
      // Only the first interlude batch is preceded by bannerless chapters 10
      // and 11 (they have no arch banners in this edition). Later interlude
      // sections follow real chapter arches and must not skip chapter slots.
      if (
        bannerlessChapters === 2 &&
        firstChapterNum === 10
      ) {
        let interludeCount = 0
        while (index < printedToc.ordered.length) {
          const next = printedToc.ordered[index]
          if (next.kind === "part") {
            index += 1
            continue
          }
          if (next.kind === "interlude") {
            interludeCount += 1
            index += 1
            continue
          }
          break
        }
        return interludeCount
      }
      return 0
    }

    break
  }

  return 0
}

function countInterludeNamesFromTextBlocks(blocks, interludesIndex) {
  for (
    let index = interludesIndex + 1;
    index < Math.min(blocks.length, interludesIndex + 10);
    index += 1
  ) {
    const block = blocks[index]
    if (block?.type === "image" || block?.type === "image_candidate") {
      break
    }

    const text = (block?.text ?? "").trim()
    if (!text) {
      continue
    }

    const names = text
      .split(/\s*[•·]\s*/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3)
    if (names.length >= 2) {
      return names.length
    }
  }

  return 3
}

/**
 * Scan narrative text blocks for an "Interludes" divider heading and return how
 * many interlude banners follow. OCR on the divider plate is preferred when
 * available, but this keeps the sequential TOC cursor aligned when tessdata is
 * missing or the divider is text-only.
 */
function scanPendingInterludesFromBlocks(blocks, fromIndex, toIndex) {
  let pending = 0

  for (let index = fromIndex; index < toIndex; index += 1) {
    const block = blocks[index]
    if (block?.type === "image" || block?.type === "image_candidate") {
      continue
    }

    const text = (block?.text ?? "").trim()
    if (/^Interludes$/i.test(text)) {
      pending = countInterludeNamesFromTextBlocks(blocks, index)
    }
  }

  return pending
}

function buildTocMetadataForChapterHeading(
  blocks,
  blockIndex,
  printedToc,
  {
    tocOrderCursor = null,
    forceInterludeBoundary = false,
    buildSequentialEntry = null,
    buildSequentialInterludeEntry = null,
    ocrNumberLabel = null,
  } = {}
) {
  if (!printedToc?.ordered?.length) {
    return null
  }

  if (forceInterludeBoundary) {
    return buildSequentialInterludeEntry?.() ?? null
  }

  if (hasBackMatterHeadingText(blocks, blockIndex)) {
    return null
  }

  if (tocOrderCursor) {
    const anchor = extractTocAnchorFromOcrLabel(ocrNumberLabel)
    if (anchor) {
      const expected = peekExpectedTocAnchor(printedToc, tocOrderCursor)
      const located = findTocEntryByAnchorFromCursor(printedToc, tocOrderCursor, anchor)
      if (located && shouldAcceptTocReanchor(expected, anchor, located, tocOrderCursor)) {
        tocOrderCursor.index = located.index + 1
        return printedTocEntryToOcrMetadata(located.entry)
      }
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

/** Skip prelude/prologue and any chapter entries until the next interlude slot. */
function takeNextSequentialInterludeTocEntry(printedToc, tocOrderCursor) {
  if (!printedToc?.ordered?.length || !tocOrderCursor) {
    return null
  }

  while (true) {
    const entry = peekNextNonPartTocEntry(printedToc, tocOrderCursor)
    if (!entry) {
      return null
    }

    advanceTocCursorAfterEntry(printedToc, tocOrderCursor, entry)

    if (entry.kind === "prelude" || entry.kind === "prologue") {
      continue
    }

    if (entry.kind === "interlude") {
      return printedTocEntryToOcrMetadata(entry)
    }
  }
}

/** Prelude/prologue are text-detected; skip them when assigning printed TOC slots to banners. */
function takeNextSequentialTocEntryForImageBanner(printedToc, tocOrderCursor) {
  if (!printedToc?.ordered?.length || !tocOrderCursor) {
    return null
  }

  while (true) {
    const entry = peekNextNonPartTocEntry(printedToc, tocOrderCursor)
    if (!entry) {
      return null
    }

    advanceTocCursorAfterEntry(printedToc, tocOrderCursor, entry)

    if (entry.kind === "prelude" || entry.kind === "prologue") {
      continue
    }

    return printedTocEntryToOcrMetadata(entry)
  }
}

function supplementBannerlessPrintedChapters(blocks, _printedToc) {
  return blocks
}

export {
  buildTocMetadataForChapterHeading,
  collectFollowingTextBlocks,
  countInterludesAfterUpcomingBannerlessChapters,
  extractChapterKeyFromOcrNumber,
  extractTocAnchorFromOcrLabel,
  hasBackMatterHeadingText,
  scanPendingInterludesFromBlocks,
  supplementBannerlessPrintedChapters,
  takeNextSequentialTocEntry,
  takeNextSequentialInterludeTocEntry,
  takeNextSequentialTocEntryForImageBanner,
}
