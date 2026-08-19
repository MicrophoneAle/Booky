/**
 * Wrap-tail scoreboard. Blocking on increase, informative on decrease.
 *
 * The numbers in wrapTailBaseline.mjs are KNOWN-BAD. They measure lines the
 * extract filter already deleted (first-wins predicate) that look like the
 * leftover tail of a wrapped paragraph. They are not a quality target, a
 * quota, or a snapshot of healthy output. A year from now: if a book is
 * still at 959, that is 959 remaining defects, not a passing grade.
 *
 * Increase vs the recorded count fails. Decrease reports the improvement
 * and still passes (stale baseline is allowed so a fix is not blocked on
 * editing this file). Record the new floor with --update-wrap-tail-baseline
 * once you have confirmed the drop is real. That write path refuses any
 * book whose live count went up, so an increase cannot be saved as the
 * new normal.
 */

import {
  formatMechanismBreakdown,
  scoreWrapTails,
} from "./wrapTail.mjs"
import {
  WRAP_TAIL_BASELINE_NOTE,
  WRAP_TAIL_BOOK_BASELINE,
} from "./wrapTailBaseline.mjs"

export function wrapTailExtractCheck(blocks, config = {}) {
  if (!Array.isArray(config.extractDrops)) {
    return {
      pass: true,
      skipped: true,
      failures: [],
      summary: "no extract-drop trace (parse did not pass onExtractDrop)",
    }
  }

  const bookId = config.bookId
  if (typeof bookId !== "string" || !bookId) {
    return {
      pass: false,
      failures: ["wrap-tail check needs config.bookId"],
    }
  }

  if (!Object.prototype.hasOwnProperty.call(WRAP_TAIL_BOOK_BASELINE, bookId)) {
    return {
      pass: false,
      failures: [
        `no known-bad wrap-tail baseline for ${bookId}; add the book only after measuring with onExtractDrop`,
      ],
    }
  }

  const scored = scoreWrapTails(config.extractDrops, blocks)
  const baseline = WRAP_TAIL_BOOK_BASELINE[bookId]
  const mechanisms = formatMechanismBreakdown(scored.byMechanism)
  const scoredPayload = {
    bookId,
    count: scored.count,
    baseline,
    byMechanism: scored.byMechanism,
  }

  if (scored.count > baseline) {
    return {
      pass: false,
      failures: [
        `${bookId} wrap-tail count ${scored.count} > known-bad baseline ${baseline} (${WRAP_TAIL_BASELINE_NOTE})`,
        `mechanisms: ${mechanisms}`,
        "do not raise the baseline; the extract filter dropped more wrap leftovers",
      ],
      summary: `${scored.count} > ${baseline} known-bad; mechanisms: ${mechanisms}`,
      wrapTail: scoredPayload,
    }
  }

  if (scored.count < baseline) {
    const delta = baseline - scored.count
    return {
      pass: true,
      failures: [],
      summary:
        `improved ${baseline} -> ${scored.count} (-${delta}); still known-bad, not a target. ` +
        `Record with --update-wrap-tail-baseline. mechanisms: ${mechanisms}`,
      wrapTail: scoredPayload,
    }
  }

  return {
    pass: true,
    failures: [],
    summary: `${scored.count} known-bad (not a target; drive down). mechanisms: ${mechanisms}`,
    wrapTail: scoredPayload,
  }
}
