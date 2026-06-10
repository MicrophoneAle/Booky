/**
 * Extract chapter / interlude / part titles from the printed table of contents
 * in the PDF text layer (e.g. Stormlight "1: STORMBLESSED" listings).
 */

const CHAPTER_TOC_LINE_REGEX = /^(\d{1,3}):\s+([A-Z][A-Z0-9\s'’\-]+)$/
const INTERLUDE_TOC_LINE_REGEX = /^(\d-\d{1,2}):\s+(.+)$/
const PART_TOC_LINE_REGEX =
  /^Part\s+((?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)|[IVXLCDM]+|\d+):\s*(.+)$/i
const CHAPTER_LISTING_TOC_REGEX =
  /^Chapter\s+(\d{1,3}|[IVXLCDM]+):\s+(.+)$/i

function normalizeLine(text) {
  return (text ?? "").replace(/\s+/g, " ").trim()
}

function titleCaseTocTitle(text) {
  const trimmed = normalizeLine(text)
  if (!trimmed) {
    return null
  }

  return trimmed
    .toLowerCase()
    .split(/\s+/)
    .map((word) => {
      if (/^i{1,3}$/i.test(word) || /^[ivxlcdm]+$/i.test(word)) {
        return word.toUpperCase()
      }
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(" ")
}

function isPrintedTocSectionLine(text) {
  const trimmed = normalizeLine(text)
  if (!trimmed) {
    return false
  }

  return (
    /^contents$/i.test(trimmed) ||
    CHAPTER_TOC_LINE_REGEX.test(trimmed) ||
    INTERLUDE_TOC_LINE_REGEX.test(trimmed) ||
    PART_TOC_LINE_REGEX.test(trimmed) ||
    CHAPTER_LISTING_TOC_REGEX.test(trimmed) ||
    /^interludes$/i.test(trimmed) ||
    /^prologue:\s+/i.test(trimmed) ||
    /^prelude\b/i.test(trimmed) ||
    /^book\s+(?:one|two|three)\b/i.test(trimmed)
  )
}

/**
 * @param {Array<{ text?: string }>} blocks
 * @returns {{
 *   chapters: Map<string, string>,
 *   interludes: Map<string, string>,
 *   parts: Map<string, string>,
 *   ordered: Array<{ kind: string, key: string, title: string, label: string }>
 * } | null}
 */
function extractPrintedTocLookup(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return null
  }

  const chapters = new Map()
  const interludes = new Map()
  const parts = new Map()
  const ordered = []

  let inTocSection = false
  let tocEntryCount = 0

  for (const block of blocks) {
    const text = normalizeLine(block?.text)
    if (!text) {
      continue
    }

    if (/^contents$/i.test(text)) {
      inTocSection = true
      continue
    }

    if (!inTocSection && !isPrintedTocSectionLine(text)) {
      continue
    }

    if (!inTocSection && isPrintedTocSectionLine(text)) {
      inTocSection = true
    }

    const chapterMatch = text.match(CHAPTER_TOC_LINE_REGEX)
    if (chapterMatch) {
      const key = chapterMatch[1]
      const title = titleCaseTocTitle(chapterMatch[2])
      const label = `Chapter ${key}`
      chapters.set(key, title)
      ordered.push({ kind: "chapter", key, title, label })
      tocEntryCount += 1
      continue
    }

    const interludeMatch = text.match(INTERLUDE_TOC_LINE_REGEX)
    if (interludeMatch) {
      const key = interludeMatch[1]
      const title = titleCaseTocTitle(interludeMatch[2])
      const label = `Interlude I-${key.split("-")[1]}`
      interludes.set(key, title)
      ordered.push({ kind: "interlude", key, title, label })
      tocEntryCount += 1
      continue
    }

    const partMatch = text.match(PART_TOC_LINE_REGEX)
    if (partMatch) {
      const key = partMatch[1]
      const title = titleCaseTocTitle(partMatch[2])
      const label = `Part ${key.charAt(0).toUpperCase()}${key.slice(1).toLowerCase()}`
      parts.set(key.toLowerCase(), title)
      ordered.push({ kind: "part", key: key.toLowerCase(), title, label })
      tocEntryCount += 1
      continue
    }

    const listingMatch = text.match(CHAPTER_LISTING_TOC_REGEX)
    if (listingMatch) {
      const key = listingMatch[1]
      const title = titleCaseTocTitle(listingMatch[2])
      const label = `Chapter ${key}`
      chapters.set(key, title)
      ordered.push({ kind: "chapter", key, title, label })
      tocEntryCount += 1
    }
  }

  if (tocEntryCount < 5) {
    return null
  }

  return { chapters, interludes, parts, ordered }
}

function parseChapterNumberKey(numberLabel) {
  const trimmed = normalizeLine(numberLabel)
  if (!trimmed) {
    return null
  }

  const digitMatch = trimmed.match(/\b(\d{1,3})\b/)
  return digitMatch?.[1] ?? null
}

function parseInterludeKey(numberLabel) {
  const trimmed = normalizeLine(numberLabel)
  if (!trimmed) {
    return null
  }

  const match =
    trimmed.match(/I-(\d{1,2})/i) ??
    trimmed.match(/(\d-\d{1,2})/)

  if (!match) {
    return null
  }

  if (match[0].includes("-") && !match[0].startsWith("I")) {
    return match[0]
  }

  const interludeNum = match[1]
  return `1-${interludeNum}`
}

/**
 * Resolve a chapter or interlude title from the printed TOC.
 *
 * @param {ReturnType<typeof extractPrintedTocLookup>} printedToc
 * @param {object} params
 * @param {string|null} params.number OCR/heuristic number label
 * @param {string|null} params.boundaryKind
 * @param {number} params.chapterSequence 1-based main-chapter counter
 */
function lookupPrintedTocTitle(printedToc, { number = null, boundaryKind = "chapter", chapterSequence = 1 } = {}) {
  if (!printedToc) {
    return null
  }

  if (boundaryKind === "interlude") {
    const key = parseInterludeKey(number)
    if (key && printedToc.interludes.has(key)) {
      return printedToc.interludes.get(key)
    }

    const interludeEntries = printedToc.ordered.filter((entry) => entry.kind === "interlude")
    return interludeEntries[chapterSequence - 1]?.title ?? null
  }

  if (boundaryKind === "chapter") {
    const key = parseChapterNumberKey(number) ?? String(chapterSequence)
    if (printedToc.chapters.has(key)) {
      return printedToc.chapters.get(key)
    }
  }

  return null
}

function lookupPrintedTocNumberLabel(printedToc, { boundaryKind = "chapter", chapterSequence = 1, number = null } = {}) {
  if (!printedToc) {
    return null
  }

  if (boundaryKind === "interlude") {
    const key = parseInterludeKey(number)
    if (key) {
      const interludeNum = key.split("-")[1]
      return `Interlude I-${interludeNum}`
    }

    const interludeEntries = printedToc.ordered.filter((entry) => entry.kind === "interlude")
    return interludeEntries[chapterSequence - 1]?.label ?? null
  }

  if (boundaryKind === "chapter") {
    const key = parseChapterNumberKey(number) ?? String(chapterSequence)
    if (printedToc.chapters.has(key)) {
      return `Chapter ${key}`
    }
  }

  return null
}

export {
  extractPrintedTocLookup,
  lookupPrintedTocTitle,
  lookupPrintedTocNumberLabel,
  titleCaseTocTitle,
}
