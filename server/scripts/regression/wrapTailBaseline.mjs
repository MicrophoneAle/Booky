/**
 * Known-bad wrap-tail counts. These are defects to drive DOWN, not targets
 * to maintain. Do not raise a number to make the check pass. A higher count
 * means more leftover wrap lines were deleted at extract and never reached
 * the reader.
 *
 * Recorded from parsePdfBuffer({ onExtractDrop }) + looksLikeWrapTail at
 * PARSER_VERSION 138 (commit 1319e15 tracer; matches the load-hook dump at
 * 1,918, delta 0).
 *
 * To record a real improvement, re-run with --update-wrap-tail-baseline
 * after the per-book counts have dropped. That flag refuses to write if any
 * selected book went up, so a silent increase cannot land in this file.
 */

export const WRAP_TAIL_BASELINE_NOTE =
  "known-bad extract wrap-tails; drive down, never treat as a target"

export const WRAP_TAIL_BOOK_BASELINE = {
  "monte-cristo": 959,
  "way-of-kings": 640,
  "treasure-island": 114,
  narnia: 42,
  "moby-dick": 40,
  oldman: 37,
  "oliver-twist": 32,
  aesop: 30,
  "pride-prejudice": 12,
  "jungle-book": 6,
  orwell1984: 4,
  frankenstein: 2,
  metamorphosis: 0,
  "maya-angelou": 0,
}

export const WRAP_TAIL_MECHANISM_BASELINE = {
  "dropMarginCalloutLines::margin-callout-displaced-left": 1460,
  "shouldDropExtractedLine::recurring-line-running-header": 268,
  "dropMarginCalloutLines::substring-of-longer-line": 139,
  "dropMarginCalloutLines::margin-callout-displaced-right": 51,
}

export const WRAP_TAIL_CORPUS_BASELINE = 1918
