/**
 * Narrative-body window for wordCountVsRaw.
 *
 * The truncation check compares parsed vs pdftotext inside this window, not
 * across the whole PDF. Bounds come from unique strings in the edition's raw
 * text (first-chapter opening, last-chapter opening or last sentence), never
 * from parser chapter boundaries. A denominator built from parsePdfBuffer
 * cannot see over-stripping.
 *
 * stopAfter is a raw-text apparatus marker searched only after the end
 * needle. It cuts the window; it does not subtract a pattern catalog from a
 * full-document count.
 */

export const WORD_COUNT_BODY_FLOOR = 0.9

/**
 * Per-book needles, confirmed unique (or last-occurrence-safe) in pdftotext
 * of the committed sample PDF. start/end are first/last chapter body, not
 * printed-TOC rows.
 */
export const NARRATIVE_BODY_ANCHORS = {
  oldman: {
    start: "He was an old man who fished alone",
    end: "the old man was dreaming about",
    stopAfter: "THE END",
  },
  orwell1984: {
    start: "It was a bright cold day in April",
    end: "He loved Big Brother",
    stopAfter: "APPENDIX",
  },
  "monte-cristo": {
    start: "On the 24th of February, 1815",
    end: "an opal-colored light",
  },
  "pride-prejudice": {
    start: "It is a truth universally acknowledged",
    end: "Happy for all her maternal feelings",
  },
  "moby-dick": {
    start: "Call me Ishmael",
    end: "CHAPTER CXXV",
  },
  "treasure-island": {
    start: "other gentlemen having asked me",
    end: "the transportation of this great mass of gold",
  },
  frankenstein: {
    start: "will rejoice to hear that no disaster",
    end: "He sprung from the cabin-window",
  },
  "oliver-twist": {
    start: "Treats of the Place Where Oliver Twist Was Born",
    end: "The fortunes of those who have figured",
  },
  "jungle-book": {
    start: "very warm evening when Father Wolf",
    end: "It was the second year after the great fight with",
    stopAfter: "JungleBookCvr.qxd",
  },
  aesop: {
    start: "ONE day a Wolf and a Lamb happened to come at the same time",
    end: "AN EAGLE and a Fox had lived together as good neighbors",
    stopAfter: "Swiss Family Robinson",
  },
  metamorphosis: {
    start: "Gregor Samsa was waking up from",
    end: "serious wound, from which he suffered",
  },
  narnia: {
    start: "LUCY LOOKS INTO A WARDROBE",
    end: "FAREWELL TO SHADOWLANDS",
  },
  "maya-angelou": {
    start: "They went home and told their wives",
    end: "A Rock, A River, A Tree",
    stopAfter: "was cut by Francisco",
  },
  "way-of-kings": {
    start: "Kalak rounded a rocky stone ridge",
    end: "Let us have a conversation to pass the time",
    stopAfter: "This is a work of fiction",
  },
}

export function countWordsInText(text) {
  return String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

export function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function needlePattern(needle) {
  const parts = String(needle ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegExp)
  if (parts.length === 0) {
    return null
  }
  return new RegExp(parts.join("\\s+"), "i")
}

export function findNeedle(text, needle, fromIndex = 0) {
  const pattern = needlePattern(needle)
  if (!pattern || text == null) {
    return null
  }
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
  const globalPattern = new RegExp(pattern.source, flags)
  globalPattern.lastIndex = fromIndex
  const match = globalPattern.exec(text)
  if (!match) {
    return null
  }
  return { index: match.index, length: match[0].length, text: match[0] }
}

export function sliceNarrativeBody(text, anchors) {
  if (!anchors?.start || !anchors?.end) {
    return {
      slice: text ?? "",
      error: "missing narrative-body start/end anchors",
      usedFullDocument: false,
    }
  }

  const source = text ?? ""
  const startHit = findNeedle(source, anchors.start, 0)
  if (!startHit) {
    return {
      slice: "",
      error: `body start anchor not found: ${anchors.start}`,
      usedFullDocument: false,
    }
  }

  const endHit = findNeedle(source, anchors.end, startHit.index)
  if (!endHit) {
    return {
      slice: "",
      error: `body end anchor not found after start: ${anchors.end}`,
      usedFullDocument: false,
    }
  }

  let endIndex = source.length
  if (anchors.stopAfter) {
    const stopHit = findNeedle(
      source,
      anchors.stopAfter,
      endHit.index + endHit.length
    )
    if (stopHit) {
      endIndex = stopHit.index
    }
  }

  if (endIndex < startHit.index) {
    return {
      slice: "",
      error: "body window inverted (stopAfter before start)",
      usedFullDocument: false,
    }
  }

  return {
    slice: source.slice(startHit.index, endIndex),
    error: null,
    usedFullDocument: false,
    startIndex: startHit.index,
    endIndex,
  }
}
