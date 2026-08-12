import {
  arabicChapterNumbers,
  findChapter,
  hasContiguousNumbers,
} from "../helpers.mjs"

// Printed Contents (source PDF pages 2-3): Chapter 1 .. Chapter 53 with no
// gaps. Confirmed by raw pdfjs extraction of the Contents pages.
const OLIVER_TWIST_CHAPTER_COUNT = 53

export default {
  id: "oliver-twist",
  name: "Oliver Twist",
  file: "Oliver Twist.pdf",
  skipGeneralChecks: ["indentationConsistency"],
  assertions: [
    [
      "Chapters 1-53 present with no gaps (printed Contents)",
      (ctx) =>
        hasContiguousNumbers(
          arabicChapterNumbers(ctx.chapters),
          OLIVER_TWIST_CHAPTER_COUNT
        ),
    ],
    [
      "first chapter present",
      (ctx) => Boolean(findChapter(ctx.chapters, /Chapter\s+1\b/i)),
    ],
    [
      "middle chapter 27 present",
      (ctx) => Boolean(findChapter(ctx.chapters, /Chapter\s+27\b/i)),
    ],
    [
      "last chapter 53 present",
      (ctx) => Boolean(findChapter(ctx.chapters, /Chapter\s+53\b/i)),
    ],
  ],
}
