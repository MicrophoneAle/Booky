/**
 * Extract chapter / interlude / section titles from the printed table of contents
 * in the PDF text layer (e.g. Stormlight "1: STORMBLESSED" listings).
 * Used as fallback when illustration OCR cannot read a title.
 */

const CHAPTER_TOC_LINE_REGEX = /^(\d{1,3}):\s+([A-Z][A-Z0-9\s'’.,\-]+)(?:[.?!])?$/
const INTERLUDE_TOC_LINE_REGEX = /^(?:I-(\d{1,2})|(\d)-(\d{1,2})):\s+(.+)$/i
const PART_TOC_LINE_REGEX =
  /^Part\s+((?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)|[IVXLCDM]+|\d+):\s*(.+)$/i
const CHAPTER_LISTING_TOC_REGEX =
  /^Chapter\s+(\d{1,3}|[IVXLCDM]+):\s+(.+)$/i
const ROMAN_CHAPTER_TOC_LINE_REGEX =
  /^(?:([IVXLCDM]{1,10})|(\d{1,3}))\.\s+(.+?)\s+(\d{1,4})\s*$/i
const NUMBERED_DOT_LEADER_TOC_REGEX =
  /^(\d{1,3})\s+(.+?)\s*\.{2,}\s*(\d{1,4})\s*$/
const PROLOGUE_TOC_REGEX = /^Prologue:\s+(.+)$/i
const EPILOGUE_TOC_REGEX = /^Epilogue:\s+(.+)$/i
const PRELUDE_TOC_REGEX = /^Prelude to the Stormlight Archive$/i

// Spelled-out chapter numbers used by some editions (e.g. Treasure Island)
// whose printed TOC renders "CHAPTER TWENTY-TWO" as a letter-spaced marker line
// separate from the title line.
const SPELLED_NUMBER_ONES = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
}
const SPELLED_NUMBER_TENS = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
}

function spelledNumberWordsToValue(word) {
  const cleaned = (word ?? "").toLowerCase().replace(/[^a-z-]/g, "")
  if (!cleaned) {
    return null
  }
  let total = 0
  for (const part of cleaned.split("-").filter(Boolean)) {
    if (SPELLED_NUMBER_ONES[part] != null) {
      total += SPELLED_NUMBER_ONES[part]
    } else if (SPELLED_NUMBER_TENS[part] != null) {
      total += SPELLED_NUMBER_TENS[part]
    } else {
      return null
    }
  }
  return total > 0 && total <= 199 ? total : null
}

// Recognize a letter-spaced "CHAPTER <SPELLED NUMBER>" marker line. The title
// for the chapter is rendered on the following TOC line, so this only yields the
// numeric key; the title is paired in ingestPrintedTocLine.
function parseSpelledChapterMarker(text) {
  const collapsed = (text ?? "").replace(/\s+/g, "").toLowerCase()
  const match = collapsed.match(/^chapter([a-z][a-z-]*)$/)
  if (!match) {
    return null
  }
  const value = spelledNumberWordsToValue(match[1])
  return value == null ? null : String(value)
}

function normalizeLine(text) {
  return (text ?? "").replace(/\s+/g, " ").trim()
}

function cleanStoryChapterTitle(text) {
  return (text ?? "")
    .replace(/^[\s\u201c\u201d"'`]+|[\s\u201c\u201d"'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
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
    /^(?:table of contents|contents)$/i.test(trimmed) ||
    parseSpelledChapterMarker(trimmed) != null ||
    CHAPTER_TOC_LINE_REGEX.test(trimmed) ||
    INTERLUDE_TOC_LINE_REGEX.test(trimmed) ||
    PART_TOC_LINE_REGEX.test(trimmed) ||
    CHAPTER_LISTING_TOC_REGEX.test(trimmed) ||
    ROMAN_CHAPTER_TOC_LINE_REGEX.test(trimmed) ||
    NUMBERED_DOT_LEADER_TOC_REGEX.test(trimmed) ||
    PROLOGUE_TOC_REGEX.test(trimmed) ||
    EPILOGUE_TOC_REGEX.test(trimmed) ||
    PRELUDE_TOC_REGEX.test(trimmed) ||
    /^interludes$/i.test(trimmed) ||
    /^book\s+(?:one|two|three)\b/i.test(trimmed)
  )
}

function ingestPrintedTocLine(text, state) {
  const trimmed = normalizeLine(text)
  if (!trimmed) {
    return false
  }

  if (/^(?:table of contents|contents)$/i.test(trimmed)) {
    state.inTocSection = true
    return true
  }

  if (!state.inTocSection && !isPrintedTocSectionLine(trimmed)) {
    return false
  }

  if (!state.inTocSection && isPrintedTocSectionLine(trimmed)) {
    state.inTocSection = true
  }

  // Letter-spaced "CHAPTER <SPELLED NUMBER>" marker: remember the chapter key so
  // the next line (the title plus its page number) can be paired with it.
  const spelledMarkerKey = parseSpelledChapterMarker(trimmed)
  if (spelledMarkerKey) {
    state.pendingChapterMarkerKey = spelledMarkerKey
    return true
  }

  // Title line that follows a spelled marker: "The Last of the Blind Man 30".
  // Some title lines are dropped during extraction, leaving consecutive markers;
  // pairing against the most recent pending marker keeps the rest correct.
  if (state.pendingChapterMarkerKey) {
    const titleMatch = trimmed.match(/^(.+?)\s+(\d{1,4})$/)
    if (
      titleMatch &&
      /[A-Za-z]/.test(titleMatch[1]) &&
      titleMatch[1].trim().length >= 2 &&
      !isPrintedTocSectionLine(titleMatch[1])
    ) {
      const key = state.pendingChapterMarkerKey
      const title = cleanStoryChapterTitle(titleMatch[1])
      state.pendingChapterMarkerKey = null
      if (title && !state.chapters.has(key)) {
        state.chapters.set(key, title)
        state.ordered.push({ kind: "chapter", key, title, label: `Chapter ${key}` })
        state.tocEntryCount += 1
      }
      return true
    }
    // Not a title line - drop the pending marker so later body text is not paired.
    state.pendingChapterMarkerKey = null
  }

  if (PRELUDE_TOC_REGEX.test(trimmed)) {
    const title = "Prelude to the Stormlight Archive"
    state.sections.set("prelude", title)
    state.ordered.push({ kind: "prelude", key: "prelude", title, label: "Prelude" })
    state.tocEntryCount += 1
    return true
  }

  const prologueMatch = trimmed.match(PROLOGUE_TOC_REGEX)
  if (prologueMatch) {
    const title = titleCaseTocTitle(prologueMatch[1])
    state.sections.set("prologue", title)
    state.ordered.push({ kind: "prologue", key: "prologue", title, label: "Prologue" })
    state.tocEntryCount += 1
    return true
  }

  const epilogueMatch = trimmed.match(EPILOGUE_TOC_REGEX)
  if (epilogueMatch) {
    const title = titleCaseTocTitle(epilogueMatch[1])
    state.sections.set("epilogue", title)
    state.ordered.push({ kind: "epilogue", key: "epilogue", title, label: "Epilogue" })
    state.tocEntryCount += 1
    return true
  }

  const partMatch = trimmed.match(PART_TOC_LINE_REGEX)
  if (partMatch) {
    const key = partMatch[1].toLowerCase()
    const subtitle = titleCaseTocTitle(partMatch[2])
    const label = `Part ${partMatch[1]}`
    state.parts.set(key, subtitle)
    state.ordered.push({ kind: "part", key, title: subtitle, label })
    state.tocEntryCount += 1
    return true
  }

  const chapterMatch = trimmed.match(CHAPTER_TOC_LINE_REGEX)
  if (chapterMatch) {
    const key = chapterMatch[1]
    const title = titleCaseTocTitle(chapterMatch[2])
    const label = `Chapter ${key}`
    state.chapters.set(key, title)
    state.ordered.push({ kind: "chapter", key, title, label })
    state.tocEntryCount += 1
    return true
  }

  const interludeMatch = trimmed.match(INTERLUDE_TOC_LINE_REGEX)
  if (interludeMatch) {
    const interludeNum = interludeMatch[1] ?? interludeMatch[3]
    const key = `1-${interludeNum}`
    const title = titleCaseTocTitle(interludeMatch[4])
    const label = `Interlude I-${interludeNum}`
    state.interludes.set(key, title)
    state.ordered.push({ kind: "interlude", key, title, label })
    state.tocEntryCount += 1
    return true
  }

  const listingMatch = trimmed.match(CHAPTER_LISTING_TOC_REGEX)
  if (listingMatch) {
    const key = listingMatch[1]
    const title = titleCaseTocTitle(listingMatch[2])
    const label = `Chapter ${key}`
    state.chapters.set(key, title)
    state.ordered.push({ kind: "chapter", key, title, label })
    state.tocEntryCount += 1
    return true
  }

  const romanRowMatch = trimmed.match(ROMAN_CHAPTER_TOC_LINE_REGEX)
  if (romanRowMatch) {
    const key = (romanRowMatch[1] ?? romanRowMatch[2]).toUpperCase()
    const title = titleCaseTocTitle(romanRowMatch[3])
    const label = `Chapter ${key}`
    state.chapters.set(key, title)
    state.ordered.push({ kind: "chapter", key, title, label })
    state.tocEntryCount += 1
    return true
  }

  const dotLeaderMatch = trimmed.match(NUMBERED_DOT_LEADER_TOC_REGEX)
  if (dotLeaderMatch) {
    const key = dotLeaderMatch[1]
    const title = titleCaseTocTitle(cleanStoryChapterTitle(dotLeaderMatch[2]))
    const label = `Chapter ${key}`
    state.chapters.set(key, title)
    state.ordered.push({ kind: "chapter", key, title, label })
    state.tocEntryCount += 1
    state.dotLeaderEntryCount += 1
    return true
  }

  return state.inTocSection
}

function createPrintedTocState() {
  return {
    chapters: new Map(),
    interludes: new Map(),
    sections: new Map(),
    parts: new Map(),
    ordered: [],
    inTocSection: false,
    tocEntryCount: 0,
    dotLeaderEntryCount: 0,
    pendingChapterMarkerKey: null,
  }
}

function finalizePrintedTocState(state) {
  if (state.tocEntryCount < 5) {
    return null
  }

  return {
    chapters: state.chapters,
    interludes: state.interludes,
    sections: state.sections,
    parts: state.parts,
    ordered: state.ordered,
    isSaddlebackDotLeader: state.dotLeaderEntryCount >= 3,
  }
}

/**
 * Scan raw PDF page lines before block building (TOC lines may never become blocks).
 * @param {Array<{ lines?: Array<{ text?: string }> }>} pageData
 */
function extractPrintedTocFromPageData(pageData) {
  if (!Array.isArray(pageData) || pageData.length === 0) {
    return null
  }

  const state = createPrintedTocState()

  for (const page of pageData) {
    for (const line of page?.lines ?? []) {
      ingestPrintedTocLine(line?.text, state)
    }
  }

  return finalizePrintedTocState(state)
}

/**
 * @param {Array<{ text?: string }>} blocks
 */
function extractPrintedTocLookup(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return null
  }

  const state = createPrintedTocState()

  for (const block of blocks) {
    ingestPrintedTocLine(block?.text, state)
  }

  return finalizePrintedTocState(state)
}

function parseChapterNumberKey(numberLabel) {
  const trimmed = normalizeLine(numberLabel)
  if (!trimmed) {
    return null
  }

  if (/^\d{1,3}$/.test(trimmed)) {
    return trimmed
  }

  const romanOnly = trimmed.match(/^([IVXLCDM]{1,10})$/i)
  if (romanOnly) {
    return romanOnly[1].toUpperCase()
  }

  const digitMatch = trimmed.match(/\b(\d{1,3})\b/)
  if (digitMatch) {
    return digitMatch[1]
  }

  const romanMatch = trimmed.match(/\b([IVXLCDM]{1,10})\b/i)
  return romanMatch ? romanMatch[1].toUpperCase() : null
}

function parseInterludeKey(numberLabel) {
  const trimmed = normalizeLine(numberLabel)
  if (!trimmed) {
    return null
  }

  const match =
    trimmed.match(/I-(\d{1,2})/i) ??
    trimmed.match(/(\d)-(\d{1,2})/)

  if (!match) {
    return null
  }

  if (match[2] != null) {
    return `${match[1]}-${match[2]}`
  }

  return `1-${match[1]}`
}

function lookupPrintedTocTitle(
  printedToc,
  { number = null, boundaryKind = "chapter", chapterSequence = 1 } = {}
) {
  if (!printedToc) {
    return null
  }

  if (boundaryKind === "prelude" || boundaryKind === "prologue" || boundaryKind === "epilogue") {
    return printedToc.sections?.get(boundaryKind) ?? null
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

function lookupPrintedTocNumberLabel(
  printedToc,
  { boundaryKind = "chapter", chapterSequence = 1, number = null } = {}
) {
  if (!printedToc) {
    return null
  }

  if (boundaryKind === "prelude") {
    return "Prelude"
  }

  if (boundaryKind === "prologue") {
    return "Prologue"
  }

  if (boundaryKind === "epilogue") {
    return "Epilogue"
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
  extractPrintedTocFromPageData,
  lookupPrintedTocTitle,
  lookupPrintedTocNumberLabel,
  titleCaseTocTitle,
  parseSpelledChapterMarker,
}
