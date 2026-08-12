import {
  arabicChapterNumbers,
  findChapter,
  hasContiguousNumbers,
} from "../helpers.mjs"

// Printed TABLE of CONTENTS (source PDF pages 6-9): Introduction, Parts I-VI
// with chapters spelled ONE..THIRTY-FOUR (34 chapters), then Biography.
// Confirmed by raw pdfjs extraction of those pages - not from parsePdfBuffer.
const TREASURE_ISLAND_CHAPTER_COUNT = 34

export default {
  id: "treasure-island",
  name: "Treasure Island",
  file: "Treasure Island.pdf",
  skipGeneralChecks: ["indentationConsistency"],
  assertions: [
    [
      "title resolves to Treasure Island (not series brand)",
      (ctx) => {
        const title = ctx.parseResult?.bookTitle ?? ctx.parseResult?.title ?? ""
        return (
          /^Treasure Island$/i.test(title.trim()) &&
          !/Core Classics/i.test(title)
        )
      },
    ],
    [
      "Introduction present",
      (ctx) => Boolean(findChapter(ctx.chapters, /^Introduction$/i)),
    ],
    [
      "six Part dividers present",
      (ctx) => {
        const parts = ctx.chapters.filter(
          (chapter) =>
            /^Part\s+[IVXLC]+\b/i.test(chapter.title ?? "") &&
            !/Chapter/i.test(chapter.title ?? "")
        )
        return parts.length === 6
      },
    ],
    [
      "Chapters 1-34 present with no gaps (printed TOC)",
      (ctx) =>
        hasContiguousNumbers(
          arabicChapterNumbers(ctx.chapters),
          TREASURE_ISLAND_CHAPTER_COUNT
        ),
    ],
    [
      "first chapter title (printed TOC)",
      (ctx) =>
        Boolean(
          findChapter(
            ctx.chapters,
            /Chapter\s+1\b.*Old Sea Dog.*Admiral Benbow/i
          )
        ),
    ],
    [
      "middle chapter title ch17 (printed TOC)",
      (ctx) =>
        Boolean(
          findChapter(
            ctx.chapters,
            /Chapter\s+17\b.*Jolly Boat/i
          )
        ),
    ],
    [
      "last chapter title ch34 And Last (printed TOC)",
      (ctx) =>
        Boolean(findChapter(ctx.chapters, /Chapter\s+34\b.*And Last/i)),
    ],
  ],
}
