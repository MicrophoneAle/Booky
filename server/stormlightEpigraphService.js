/**
 * Match Stormlight Archive chapter banners to printed TOC entries using
 * death-rattle epigraph text that follows each banner in the PDF text layer.
 */

const DEATH_RATTLE_ATTRIBUTION_REGEX =
  /^ΓÇö(?:Collected|Dated|Noted|Purports|Though|Kakashah|Tanatanev|Tanatesach|Kaktach)/i

/** @type {Array<{ chapterKey: string, prefix: string }>} */
const WAY_OF_KINGS_DEATH_RATTLE_PREFIXES = [
  { chapterKey: "52", prefix: "i'm standing over the body of a brother" },
  { chapterKey: "53", prefix: "he must pick it up, the fallen title" },
  { chapterKey: "54", prefix: "the burdens of nine become mine" },
  { chapterKey: "55", prefix: "a woman sits and scratches out her own eyes" },
  { chapterKey: "56", prefix: "light grows so distant" },
  { chapterKey: "57", prefix: "i hold the suckling child in my hands" },
  { chapterKey: "58", prefix: "re-shephir, the midnight mother" },
  { chapterKey: "59", prefix: "above the final void i hang" },
  { chapterKey: "60", prefix: "the death is my life, the strength becomes my weakness" },
  { chapterKey: "61", prefix: "in the storm i awaken, falling, spinning, grieving" },
  { chapterKey: "62", prefix: "the darkness becomes a palace" },
  { chapterKey: "63", prefix: "i wish to sleep" },
  { chapterKey: "64", prefix: "they come from the pit, two dead men" },
  { chapterKey: "65", prefix: "i see them. they are the rocks" },
  { chapterKey: "66", prefix: "that chanting, that singing, those rasping voices" },
  { chapterKey: "67", prefix: "let me no longer hurt" },
  { chapterKey: "68", prefix: "they named it the final desolation, but they lied" },
  { chapterKey: "69", prefix: "all is withdrawn for me. i stand against the one who saved my life" },
]

const BACK_MATTER_HEADING_PATTERNS = [
  /^ARS\s+ARCANUM$/i,
  /^ENDNOTE$/i,
  /^THE\s+END\s+OF$/i,
  /^BOOK\s+ONE\s+OF$/i,
  /^ILLUSTRATIONS$/i,
  /^THE TEN ESSENCES AND THEIR HISTORICAL ASSOCIATIONS$/i,
  /^ON THE CREATION OF FABRIALS$/i,
]

function normalizeEpigraphQuote(text) {
  return (text ?? "")
    .replace(/[\u2018\u2019\u201a\u02bc`']/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

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

function extractDeathRattleQuoteFromFollowingText(followingTextBlocks) {
  const lines = followingTextBlocks.flatMap((text) =>
    text.split(/\n+/).map((line) => line.trim()).filter(Boolean)
  )

  for (let index = 0; index < lines.length; index += 1) {
    if (!DEATH_RATTLE_ATTRIBUTION_REGEX.test(lines[index])) {
      continue
    }

    const quoteParts = []
    for (let quoteIndex = index - 1; quoteIndex >= 0 && quoteIndex >= index - 8; quoteIndex -= 1) {
      const line = lines[quoteIndex]
      if (/^[\u201c"\u2018']/.test(line)) {
        quoteParts.unshift(line)
        break
      }

      quoteParts.unshift(line)

      if (quoteParts.join(" ").length >= 120) {
        break
      }
    }

    const quote = normalizeEpigraphQuote(
      quoteParts.join(" ").replace(/^[\u201c"\u2018']/, "").replace(/[\u201d"\u2019']$/, "")
    )

    if (quote.length >= 12) {
      return quote
    }
  }

  return null
}

function matchDeathRattleChapterKey(quote) {
  if (!quote) {
    return null
  }

  for (const { chapterKey, prefix } of WAY_OF_KINGS_DEATH_RATTLE_PREFIXES) {
    if (quote.startsWith(prefix)) {
      return chapterKey
    }
  }

  return null
}

function findPrintedTocEntryByChapterKey(printedToc, chapterKey, { kind = "chapter" } = {}) {
  if (!printedToc?.ordered?.length || !chapterKey) {
    return null
  }

  return (
    printedToc.ordered.find(
      (entry) => entry.kind === kind && String(entry.key) === String(chapterKey)
    ) ?? null
  )
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

function lookupDeathRattleChapterEntry(blocks, blockIndex, printedToc) {
  const followingText = collectFollowingTextBlocks(blocks, blockIndex)
  const quote = extractDeathRattleQuoteFromFollowingText(followingText)
  const chapterKey = matchDeathRattleChapterKey(quote)

  if (!chapterKey) {
    return null
  }

  return findPrintedTocEntryByChapterKey(printedToc, chapterKey)
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

function peekNextPrintedTocChapterKey(printedToc, tocOrderCursor) {
  const entry = peekNextNonPartTocEntry(printedToc, tocOrderCursor)
  if (!entry || entry.kind !== "chapter") {
    return null
  }

  const parsed = Number.parseInt(String(entry.key), 10)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Prefer death-rattle epigraph matching for Stormlight chapter banners; fall back
 * to sequential printed TOC cursor assignment.
 */
function buildTocMetadataForChapterHeading(
  blocks,
  blockIndex,
  printedToc,
  { tocOrderCursor = null, forceInterludeBoundary = false, buildSequentialEntry = null } = {}
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

  const nextSequentialEntry = peekNextNonPartTocEntry(printedToc, tocOrderCursor)
  const nextSequentialChapterKey = peekNextPrintedTocChapterKey(printedToc, tocOrderCursor)

  const deathRattleEntry = lookupDeathRattleChapterEntry(blocks, blockIndex, printedToc)
  const deathRattleKey = deathRattleEntry ? Number.parseInt(String(deathRattleEntry.key), 10) : null

  const shouldUseDeathRattleMatch =
    deathRattleEntry &&
    Number.isFinite(deathRattleKey) &&
    deathRattleKey >= 52 &&
    nextSequentialEntry?.kind === "chapter" &&
    nextSequentialChapterKey != null &&
    deathRattleKey !== nextSequentialChapterKey

  if (shouldUseDeathRattleMatch) {
    advanceTocCursorAfterEntry(printedToc, tocOrderCursor, deathRattleEntry)
    return printedTocEntryToOcrMetadata(deathRattleEntry)
  }

  return buildSequentialEntry?.() ?? null
}

function supplementBannerlessPrintedChapters(blocks, printedToc) {
  if (!printedToc?.ordered?.length || !Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  const chapterEntries = printedToc.ordered.filter((entry) => entry.kind === "chapter")
  if (chapterEntries.length === 0) {
    return blocks
  }

  const assignedKeys = new Set()
  const boundaryIndices = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block?.type !== "image" || block.isChapterBoundary !== true) {
      continue
    }

    const metadata = block.chapterMetadata ?? {}
    if (metadata.includeInToc === false || metadata.boundaryKind !== "chapter") {
      continue
    }

    const key = String(metadata.number ?? "").match(/\b(\d{1,3})\b/)?.[1]
    if (!key) {
      continue
    }

    assignedKeys.add(key)
    boundaryIndices.push({ index, pageNumber: block.pageNumber ?? 0, key: Number(key) })
  }

  if (boundaryIndices.length < 2) {
    return blocks
  }

  boundaryIndices.sort((left, right) => left.pageNumber - right.pageNumber)
  const supplements = []

  function appendMissingChapterSupplements(current, nextIndex, missingKeys) {
    if (missingKeys.length === 0) {
      return
    }

    const gapBlocks = []
    for (let index = current.index + 1; index < nextIndex; index += 1) {
      const block = blocks[index]
      if (block?.type === "image" || block?.type === "image_candidate") {
        const pageNumber = block.pageNumber ?? block.sourcePdfPageIndex ?? 0
        if (pageNumber > 0) {
          gapBlocks.push({ index, pageNumber, preferImage: true })
        }
        continue
      }

      const text = (block?.text ?? "").trim()
      if (!text) {
        continue
      }

      gapBlocks.push({
        index,
        pageNumber: block.pageNumber ?? block.sourcePdfPageIndex ?? 0,
        preferImage: false,
      })
    }

    if (gapBlocks.length === 0) {
      return
    }

    const imageAnchors = gapBlocks.filter((entry) => entry.preferImage)
    const anchors = imageAnchors.length > 0 ? imageAnchors : gapBlocks

    for (let missingIndex = 0; missingIndex < missingKeys.length; missingIndex += 1) {
      const key = missingKeys[missingIndex]
      const entry = chapterEntries.find((chapter) => String(chapter.key) === key)
      if (!entry) {
        continue
      }

      const anchorIndex = Math.min(
        anchors.length - 1,
        Math.floor(((missingIndex + 0.5) * anchors.length) / missingKeys.length)
      )
      const anchor = anchors[anchorIndex]

      supplements.push({
        insertBeforeIndex: anchor.index,
        block: {
          type: "image",
          id: `synthetic-ch-${key}-p${anchor.pageNumber}`,
          imageRole: "chapter_heading",
          isChapterBoundary: true,
          isSyntheticChapterBoundary: true,
          pageNumber: anchor.pageNumber,
          sourcePdfPageIndex: anchor.pageNumber > 0 ? anchor.pageNumber - 1 : null,
          chapterMetadata: {
            boundaryKind: "chapter",
            number: entry.label,
            title: entry.title,
            rawText: entry.title ? `${entry.label}: ${entry.title}` : entry.label,
            includeInToc: true,
          },
        },
      })
      assignedKeys.add(key)
    }
  }

  for (let boundaryIndex = 0; boundaryIndex < boundaryIndices.length - 1; boundaryIndex += 1) {
    const current = boundaryIndices[boundaryIndex]
    const next = boundaryIndices[boundaryIndex + 1]
    const missingKeys = []

    for (let chapterNumber = current.key + 1; chapterNumber < next.key; chapterNumber += 1) {
      const key = String(chapterNumber)
      if (!assignedKeys.has(key)) {
        missingKeys.push(key)
      }
    }

    appendMissingChapterSupplements(current, next.index, missingKeys)
  }

  const lastBoundary = boundaryIndices[boundaryIndices.length - 1]
  const maxChapterKey = chapterEntries.reduce((max, entry) => {
    const parsed = Number.parseInt(String(entry.key), 10)
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max
  }, 0)
  const tailMissingKeys = []

  for (let chapterNumber = lastBoundary.key + 1; chapterNumber <= maxChapterKey; chapterNumber += 1) {
    const key = String(chapterNumber)
    if (!assignedKeys.has(key)) {
      tailMissingKeys.push(key)
    }
  }

  if (tailMissingKeys.length > 0) {
    const tailImages = []
    const seenPages = new Set()

    for (let index = lastBoundary.index + 1; index < blocks.length; index += 1) {
      const block = blocks[index]
      if (block?.type !== "image" && block?.type !== "image_candidate") {
        continue
      }

      const pageNumber = block.pageNumber ?? 0
      if (pageNumber <= lastBoundary.pageNumber || seenPages.has(pageNumber)) {
        continue
      }

      seenPages.add(pageNumber)
      tailImages.push({ index, pageNumber })
    }

    for (let missingIndex = 0; missingIndex < tailMissingKeys.length; missingIndex += 1) {
      const key = tailMissingKeys[missingIndex]
      const entry = chapterEntries.find((chapter) => String(chapter.key) === key)
      if (!entry) {
        continue
      }

      const anchor =
        tailImages[Math.min(missingIndex, Math.max(0, tailImages.length - 1))] ??
        tailImages[tailImages.length - 1]

      if (!anchor) {
        continue
      }

      supplements.push({
        insertBeforeIndex: anchor.index,
        block: {
          type: "image",
          id: `synthetic-ch-${key}-p${anchor.pageNumber}`,
          imageRole: "chapter_heading",
          isChapterBoundary: true,
          isSyntheticChapterBoundary: true,
          pageNumber: anchor.pageNumber,
          sourcePdfPageIndex: anchor.pageNumber > 0 ? anchor.pageNumber - 1 : null,
          chapterMetadata: {
            boundaryKind: "chapter",
            number: entry.label,
            title: entry.title,
            rawText: entry.title ? `${entry.label}: ${entry.title}` : entry.label,
            includeInToc: true,
          },
        },
      })
      assignedKeys.add(key)
    }
  }

  if (supplements.length === 0) {
    return blocks
  }

  supplements.sort((left, right) => right.insertBeforeIndex - left.insertBeforeIndex)
  let updated = [...blocks]

  for (const supplement of supplements) {
    updated = [
      ...updated.slice(0, supplement.insertBeforeIndex),
      supplement.block,
      ...updated.slice(supplement.insertBeforeIndex),
    ]
  }

  return updated
}

export {
  WAY_OF_KINGS_DEATH_RATTLE_PREFIXES,
  buildTocMetadataForChapterHeading,
  collectFollowingTextBlocks,
  extractDeathRattleQuoteFromFollowingText,
  hasBackMatterHeadingText,
  lookupDeathRattleChapterEntry,
  matchDeathRattleChapterKey,
  supplementBannerlessPrintedChapters,
}
