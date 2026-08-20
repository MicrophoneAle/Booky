/**
 * Known-bad wrap-tail counts. These are defects to drive DOWN, not targets
 * to maintain. Do not raise a number to make the check pass. A higher count
 * means more leftover wrap lines were deleted at extract and never reached
 * the reader.
 *
 * Recorded from parsePdfBuffer({ onExtractDrop }) + looksLikeWrapTail.
 * Refresh with --update-wrap-tail-baseline after a real reduction. That
 * flag refuses to write if any selected book went up.
 */

export const WRAP_TAIL_BASELINE_NOTE =
  "known-bad extract wrap-tails; drive down, never treat as a target"

export const WRAP_TAIL_BOOK_BASELINE = {
  "way-of-kings": 189,
  "monte-cristo": 142,
  "narnia": 42,
  "treasure-island": 41,
  "oliver-twist": 32,
  "moby-dick": 15,
  "pride-prejudice": 12,
  "oldman": 5,
  "orwell1984": 4,
  "aesop": 3,
  "frankenstein": 2,
  "jungle-book": 0,
  "maya-angelou": 0,
  "metamorphosis": 0,
}

export const WRAP_TAIL_MECHANISM_BASELINE = {
  "dropMarginCalloutLines::margin-callout-displaced-left": 8,
  "shouldDropExtractedLine::recurring-line-running-header": 289,
  "dropMarginCalloutLines::substring-of-longer-line": 139,
  "dropMarginCalloutLines::margin-callout-displaced-right": 51,
}

export const WRAP_TAIL_CORPUS_BASELINE = 487
