/**
 * Wrap-tail classifier for extract-drop traces from parsePdfBuffer({ onExtractDrop }).
 *
 * A wrap-tail is the last wrapped line of a finished paragraph that the extract
 * filter deleted before buildBlocksFromLines. The joined phrase is absent from
 * parsed blocks. This is the same classifier used to measure the 1,918-count
 * known-bad scoreboard; keep it in the harness, not under .tmp/.
 */

const NEVER_WRAP_REASONS = new Set([
  "standalone-page-number",
  "standalone-page-number-normalized",
  "standalone-roman-page-marker",
  "roman-page-marker-cluster",
  "standalone-running-head",
  "header-page-marker",
  "toc-listing",
  "toc-header",
  "running-header-merged",
  "story-section-running-head",
  "scanner-watermark",
  "production-slug",
  "chapter-placeholder",
  "letter-spaced-artifact",
  "spaced-running-header",
  "roman-section-running-head",
  "collapsed-running-header",
  "glossary-sidebar",
  "url",
  "www",
  "repeated-section-label-same-page",
  "repeated-section-label-other-page",
  "scene-break-not-centered",
  "empty",
])

const SHORT_CHARS = 52
const SHORT_WORDS = 9

export const WRAP_TAIL_MECHANISM_ORDER = [
  "dropMarginCalloutLines::margin-callout-displaced-left",
  "shouldDropExtractedLine::recurring-line-running-header",
  "dropMarginCalloutLines::substring-of-longer-line",
  "dropMarginCalloutLines::margin-callout-displaced-right",
]

export const WRAP_TAIL_MECHANISM_LABELS = {
  "dropMarginCalloutLines::margin-callout-displaced-left": "displaced-left",
  "shouldDropExtractedLine::recurring-line-running-header": "recurring-header",
  "dropMarginCalloutLines::substring-of-longer-line": "substring-of-longer-line",
  "dropMarginCalloutLines::margin-callout-displaced-right": "displaced-right",
}

export function foldWrapTailText(text) {
  return (text ?? "")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
}

function endsSentence(text) {
  return /[.!?]["'\u201d\u2019)]*\s*$/.test(foldWrapTailText(text))
}

function wordCount(text) {
  return foldWrapTailText(text).split(/\s+/).filter(Boolean).length
}

function isShort(text) {
  const folded = foldWrapTailText(text)
  return folded.length <= SHORT_CHARS && wordCount(folded) <= SHORT_WORDS
}

export function looksLikeWrapTail(drop) {
  const prev = foldWrapTailText(drop.prev)
  const text = foldWrapTailText(drop.text)
  if (!text) {
    return false
  }
  if (NEVER_WRAP_REASONS.has(drop.reason)) {
    return false
  }
  if (!isShort(text)) {
    return false
  }
  if (/^https?:\/\//i.test(text) || /^www\./i.test(text)) {
    return false
  }
  if (/ebook no/i.test(text) || /gutenberg/i.test(text)) {
    return false
  }

  if (!prev) {
    return /^[a-z(]/.test(text) && endsSentence(text) && wordCount(text) >= 2
  }

  if (endsSentence(prev)) {
    return false
  }
  if (!/[a-z]/.test(prev) || prev.length < 20) {
    return false
  }
  const leftover = /^[a-z(]/.test(text) || endsSentence(text)
  if (!leftover) {
    return false
  }
  return true
}

function searchHay(blocks) {
  return foldWrapTailText(blocks.map((block) => block.text ?? "").join("\n"))
}

function presentInParse(needle, hay) {
  const folded = foldWrapTailText(needle)
  if (!folded || folded.length < 2) {
    return false
  }
  return hay.includes(folded)
}

export function classifyExtractDrop(drop, hay) {
  const text = foldWrapTailText(drop.text)
  const prev = foldWrapTailText(drop.prev)
  const phrase = prev && text ? `${prev} ${text}` : text
  const exactInParse = presentInParse(text, hay)
  const phraseInParse = presentInParse(phrase, hay)
  const wrap = looksLikeWrapTail(drop)

  let fate = "other"
  if (phraseInParse) {
    fate = "relocated-or-merged"
  } else if (!exactInParse) {
    fate = wrap ? "wrap-tail-deleted" : "absent-not-wrap"
  } else if (wrap) {
    fate = "wrap-tail-token-elsewhere"
  } else {
    fate = "echo-or-duplicate-token"
  }

  return { wrap, exactInParse, phraseInParse, fate }
}

export function isWrapTailClass(classified) {
  return (
    classified.wrap &&
    (classified.fate === "wrap-tail-deleted" ||
      classified.fate === "wrap-tail-token-elsewhere")
  )
}

export function mechanismKey(drop) {
  return `${drop.stage}::${drop.reason}`
}

export function scoreWrapTails(drops, blocks) {
  const hay = searchHay(blocks ?? [])
  const wraps = []
  const byMechanism = {}

  for (const drop of drops ?? []) {
    const classified = { ...drop, ...classifyExtractDrop(drop, hay) }
    if (!isWrapTailClass(classified)) {
      continue
    }
    wraps.push(classified)
    const key = mechanismKey(classified)
    byMechanism[key] = (byMechanism[key] || 0) + 1
  }

  return {
    count: wraps.length,
    wraps,
    byMechanism,
  }
}

export function formatMechanismBreakdown(byMechanism = {}) {
  const keys = [
    ...WRAP_TAIL_MECHANISM_ORDER.filter((key) => byMechanism[key]),
    ...Object.keys(byMechanism)
      .filter((key) => !WRAP_TAIL_MECHANISM_ORDER.includes(key))
      .sort(),
  ]

  if (keys.length === 0) {
    return "none"
  }

  return keys
    .map((key) => {
      const label = WRAP_TAIL_MECHANISM_LABELS[key] ?? key
      return `${label} ${byMechanism[key]}`
    })
    .join(", ")
}
