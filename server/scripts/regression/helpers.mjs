/** Shared helpers for book-specific regression assertions. */

export function arabicChapterNumbers(chapters) {
  return chapters
    .map((chapter) => {
      const match = (chapter?.title ?? "").match(/Chapter\s+(\d+)\b/i)
      return match ? Number(match[1]) : null
    })
    .filter((number) => number !== null)
}

export function romanToInt(roman) {
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }
  const upper = roman.toUpperCase()
  let total = 0
  for (let index = 0; index < upper.length; index += 1) {
    const value = values[upper[index]]
    const next = values[upper[index + 1]]
    total += next && value < next ? -value : value
  }
  return total
}

export function romanChapterNumbers(chapters) {
  return chapters
    .map((chapter) => {
      const match = (chapter?.title ?? "").match(/Chapter\s+([IVXLCDM]+)\b/i)
      return match ? romanToInt(match[1]) : null
    })
    .filter((number) => number !== null)
}

export function hasContiguousNumbers(numbers, expectedMax) {
  const present = new Set(numbers)
  for (let number = 1; number <= expectedMax; number += 1) {
    if (!present.has(number)) {
      return false
    }
  }
  return numbers.every((number) => number <= expectedMax)
}

export function chapterTitle(chapters, index) {
  return (chapters[index]?.title ?? "").trim()
}

export function findChapter(chapters, pattern) {
  return chapters.find((chapter) => pattern.test(chapter?.title ?? ""))
}

export function normalizeTitleKey(text) {
  return (text ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

export function compactTitleKey(text) {
  return normalizeTitleKey(text).replace(/\s+/g, "")
}

export function levenshteinDistance(a, b) {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  const rows = b.length + 1
  const cols = a.length + 1
  const matrix = Array.from({ length: rows }, () => new Array(cols).fill(0))

  for (let col = 0; col < cols; col += 1) {
    matrix[0][col] = col
  }
  for (let row = 0; row < rows; row += 1) {
    matrix[row][0] = row
  }

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = b[row - 1] === a[col - 1] ? 0 : 1
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost
      )
    }
  }

  return matrix[rows - 1][cols - 1]
}

/**
 * Tight OCR-style title match for Contents-vs-body spelling drift (not substring
 * containment). Requires similar length and a high compact-string similarity.
 */
export function titleKeysMatchOcrFuzzy(expectedKey, candidateKey) {
  if (expectedKey === candidateKey) {
    return true
  }

  const compactExpected = expectedKey.replace(/\s+/g, "")
  const compactCandidate = candidateKey.replace(/\s+/g, "")
  if (compactExpected === compactCandidate) {
    return true
  }

  const maxLen = Math.max(compactExpected.length, compactCandidate.length)
  const minLen = Math.min(compactExpected.length, compactCandidate.length)
  if (maxLen === 0) {
    return true
  }
  if (maxLen - minLen > 4) {
    return false
  }

  const distance = levenshteinDistance(compactExpected, compactCandidate)
  if (distance > 4) {
    return false
  }

  const ratio = 1 - distance / maxLen
  return ratio >= 0.88
}

export function filterStoryChapters(chapters) {
  return chapters.filter(
    (chapter) =>
      !/^(?:Introduction|Preface|Contents|Part\b)/i.test(
        (chapter.title ?? "").trim()
      )
  )
}

/** Exact normalized match only - consumes one pool entry per expected title. */
export function consumeExactTitlesFromPool(pool, expectedTitles) {
  for (const title of expectedTitles) {
    const key = normalizeTitleKey(title)
    const index = pool.indexOf(key)
    if (index === -1) {
      return false
    }
    pool.splice(index, 1)
  }
  return true
}

/** Exact normalized match against a set of present keys (no substring fallback). */
export function hasExactNormalizedTitle(title, presentKeys) {
  return presentKeys.has(normalizeTitleKey(title))
}

/**
 * Match a printed Contents title to one detected chapter key using exact match
 * first, then tight OCR fuzzy match. Mutates pool by removing the matched entry.
 */
export function consumeContentsTitleFromPool(
  pool,
  contentsTitle,
  aliasKeys = null
) {
  const expectedKey = normalizeTitleKey(contentsTitle)
  let index = pool.indexOf(expectedKey)
  if (index === -1 && aliasKeys?.has(expectedKey)) {
    index = pool.indexOf(aliasKeys.get(expectedKey))
  }
  if (index === -1) {
    index = pool.findIndex((candidate) =>
      titleKeysMatchOcrFuzzy(expectedKey, candidate)
    )
  }
  if (index === -1) {
    return false
  }
  pool.splice(index, 1)
  return true
}
