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
