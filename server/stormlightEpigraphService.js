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
      // Allow a wider forward window so a confident plaque OCR can recover from
      // sequential cursor drift (e.g. bannerless chapters 10–11, failed arches).
      return anchorNum >= expectedNum && anchorNum <= expectedNum + 12
    }
  }

  if (expected.kind === "interlude") {
    const expectedNum = Number.parseInt(expected.key, 10)
    const anchorNum = Number.parseInt(anchor.key, 10)
    if (Number.isFinite(expectedNum) && Number.isFinite(anchorNum)) {
      return anchorNum >= expectedNum && anchorNum <= expectedNum + 2
    }
  }

  return true
}

function countUpcomingInterludesAtCursor(printedToc, tocOrderCursor) {
  if (!printedToc?.ordered?.length || !tocOrderCursor) {
    return 0
  }

  let index = tocOrderCursor.index
  let count = 0

  while (index < printedToc.ordered.length) {
    const entry = printedToc.ordered[index]
    if (entry.kind === "part") {
      index += 1
      continue
    }
    if (entry.kind === "interlude") {
      count += 1
      index += 1
      continue
    }
    break
  }

  return count
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

  if (forceInterludeBoundary) {
    return buildSequentialInterludeEntry?.() ?? null
  }

  if (hasBackMatterHeadingText(blocks, blockIndex)) {
    return null
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

function isTextContentBlock(block) {
  return (
    block?.type !== "image" &&
    block?.type !== "image_candidate" &&
    typeof block?.text === "string"
  )
}

function boundaryAssignmentKey(metadata) {
  const kind = metadata?.boundaryKind
  const number = (metadata?.number ?? "").trim()

  if (kind === "chapter") {
    const key = extractChapterKeyFromOcrNumber(number)
    return key ? `chapter:${key}` : null
  }

  if (kind === "interlude") {
    const match = number.match(/I-(\d{1,2})/i)
    return match ? `interlude:${match[1]}` : null
  }

  if (kind === "epilogue") {
    return "epilogue:epilogue"
  }

  return null
}

function collectAssignedBoundaryKeys(blocks) {
  const assigned = new Set()
  const boundaries = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block?.type !== "image" || !block.isChapterBoundary) {
      continue
    }

    const assignmentKey = boundaryAssignmentKey(block.chapterMetadata ?? {})
    if (!assignmentKey) {
      continue
    }

    assigned.add(assignmentKey)
    boundaries.push({
      index,
      assignmentKey,
      pageNumber: block.pageNumber ?? null,
      sourcePdfPageIndex: block.sourcePdfPageIndex ?? null,
    })
  }

  return { assigned, boundaries }
}

function interludeTocAssignmentKey(entryKey) {
  const key = String(entryKey ?? "")
  const romanMatch = key.match(/^1-(\d{1,2})$/)
  if (romanMatch) {
    return `interlude:${romanMatch[1]}`
  }

  const plaqueMatch = key.match(/^I-(\d{1,2})$/i)
  if (plaqueMatch) {
    return `interlude:${plaqueMatch[1]}`
  }

  return `interlude:${key}`
}

function tocEntryAssignmentKey(entry) {
  if (entry.kind === "chapter") {
    return `chapter:${entry.key}`
  }

  if (entry.kind === "interlude") {
    return interludeTocAssignmentKey(entry.key)
  }

  if (entry.kind === "epilogue") {
    return "epilogue:epilogue"
  }

  return null
}

function findBoundaryIndexForTocEntry(boundaries, entry) {
  const key = tocEntryAssignmentKey(entry)

  if (!key) {
    return -1
  }

  const match = boundaries.find((boundary) => boundary.assignmentKey === key)
  return match?.index ?? -1
}

function formatBannerlessChapterHeadingText(entry) {
  const title = (entry.title ?? "").trim()
  if (title) {
    return `Chapter ${entry.key} - ${title}`
  }

  return entry.label ?? `Chapter ${entry.key}`
}

function resolveBannerlessInsertionIndex(
  blocks,
  prevBoundaryIndex,
  nextBoundaryIndex,
  positionInGap
) {
  if (prevBoundaryIndex < 0) {
    return 0
  }

  const gapStart = prevBoundaryIndex + 1
  const gapEnd = nextBoundaryIndex >= 0 ? nextBoundaryIndex : blocks.length

  if (positionInGap === "end" && nextBoundaryIndex >= 0) {
    return nextBoundaryIndex
  }

  for (let index = gapStart; index < gapEnd; index += 1) {
    if (isTextContentBlock(blocks[index]) && (blocks[index].text ?? "").trim()) {
      return index
    }
  }

  return gapStart
}

function buildBannerlessChapterBlock(entry, anchorBlock) {
  const headingText = formatBannerlessChapterHeadingText(entry)

  return {
    text: headingText,
    isHeading: true,
    fontSize: 14,
    isChapterStart: true,
    chapterTitle: headingText,
    pageNumber: Number.isFinite(anchorBlock?.pageNumber) ? anchorBlock.pageNumber : null,
    sourcePdfPageIndex:
      anchorBlock?.sourcePdfPageIndex ??
      (Number.isFinite(anchorBlock?.pageNumber) ? anchorBlock.pageNumber - 1 : null),
    bannerlessChapterBoundary: true,
  }
}

function supplementBannerlessPrintedChapters(blocks, printedToc) {
  if (!printedToc?.ordered?.length || !Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  const { assigned, boundaries } = collectAssignedBoundaryKeys(blocks)
  const missingEntries = []

  for (const entry of printedToc.ordered) {
    if (entry.kind !== "chapter") {
      continue
    }

    const key = `chapter:${entry.key}`
    if (!assigned.has(key)) {
      missingEntries.push(entry)
    }
  }

  if (missingEntries.length === 0) {
    return blocks
  }

  let result = [...blocks]
  let boundaryList = [...boundaries]

  for (let missingIndex = 0; missingIndex < missingEntries.length; missingIndex += 1) {
    const entry = missingEntries[missingIndex]
    const entryIndex = printedToc.ordered.indexOf(entry)

    let prevBoundaryIndex = -1
    let nextBoundaryIndex = -1

    for (let scan = entryIndex - 1; scan >= 0; scan -= 1) {
      const scanEntry = printedToc.ordered[scan]
      if (scanEntry.kind === "part") {
        continue
      }

      const index = findBoundaryIndexForTocEntry(boundaryList, scanEntry)
      if (index >= 0) {
        prevBoundaryIndex = index
        break
      }
    }

    for (let scan = entryIndex + 1; scan < printedToc.ordered.length; scan += 1) {
      const scanEntry = printedToc.ordered[scan]
      if (scanEntry.kind === "part") {
        continue
      }

      const index = findBoundaryIndexForTocEntry(boundaryList, scanEntry)
      if (index >= 0) {
        nextBoundaryIndex = index
        break
      }
    }

    const nextMissingEntry = missingEntries[missingIndex + 1]
    const nextMissingIsAdjacent =
      nextMissingEntry &&
      printedToc.ordered.indexOf(nextMissingEntry) === entryIndex + 1
    const positionInGap =
      nextMissingIsAdjacent
        ? "start"
        : missingEntries.length > 1 && missingIndex === missingEntries.length - 1
          ? "end"
          : "start"

    const insertAt = resolveBannerlessInsertionIndex(
      result,
      prevBoundaryIndex,
      nextBoundaryIndex,
      positionInGap
    )

    const anchorBlock =
      positionInGap === "end" && nextBoundaryIndex >= 0
        ? result[nextBoundaryIndex]
        : result[prevBoundaryIndex] ?? result[insertAt] ?? null
    const bannerlessBlock = buildBannerlessChapterBlock(entry, anchorBlock)

    result = [
      ...result.slice(0, insertAt),
      bannerlessBlock,
      ...result.slice(insertAt),
    ]

    boundaryList = boundaryList.map((boundary) => ({
      ...boundary,
      index: boundary.index >= insertAt ? boundary.index + 1 : boundary.index,
    }))
    assigned.add(`chapter:${entry.key}`)
  }

  return result
}

export {
  buildTocMetadataForChapterHeading,
  collectFollowingTextBlocks,
  countInterludesAfterUpcomingBannerlessChapters,
  countUpcomingInterludesAtCursor,
  extractChapterKeyFromOcrNumber,
  extractTocAnchorFromOcrLabel,
  hasBackMatterHeadingText,
  scanPendingInterludesFromBlocks,
  supplementBannerlessPrintedChapters,
  takeNextSequentialTocEntry,
  takeNextSequentialInterludeTocEntry,
  takeNextSequentialTocEntryForImageBanner,
}
