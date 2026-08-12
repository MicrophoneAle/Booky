import { findChapter, hasContiguousNumbers } from "../helpers.mjs"

// Printed CONTENTS (source PDF pages 10-15): Prelude, Prologue: To Kill,
// Parts One-Five, chapters 1-75 (including 69 JUSTICE and 70 SEA OF GLASS),
// interludes, Epilogue. Confirmed by raw pdfjs scan of those pages.
//
// Reader TOC deliberately omits Parts Four/Five (no text headings; filtered
// from image boundaries) - see CLAUDE.md. Expected reader entries:
//   Prelude + Prologue + Parts One-Three + 75 chapters + 9 interludes + Epilogue
//   = 90.
const WOK_EXPECTED_READER_CHAPTERS = 90
const WOK_NUMBERED_CHAPTERS = 75
const WOK_EXPECTED_INTERLUDES = 9

function wokChapterNumbers(chapters) {
  return chapters
    .map((chapter) => {
      const match = (chapter?.title ?? "").match(
        /(?:^|\b)(?:Chapter\s+)?(\d{1,2})\b/
      )
      if (!match) return null
      const number = Number(match[1])
      return number >= 1 && number <= WOK_NUMBERED_CHAPTERS ? number : null
    })
    .filter((number) => number !== null)
}

export default {
  id: "way-of-kings",
  name: "The Way of Kings",
  file: "The Way of Kings.pdf",
  skipGeneralChecks: [
    "indentationConsistency",
    "headingDensitySane",
    "dialogueSplitCheck",
  ],
  assertions: [
    [
      `reader TOC has ${WOK_EXPECTED_READER_CHAPTERS} entries`,
      (ctx) => ctx.chapters.length === WOK_EXPECTED_READER_CHAPTERS,
    ],
    [
      "Chapters 1-75 present with no gaps (printed CONTENTS)",
      (ctx) =>
        hasContiguousNumbers(wokChapterNumbers(ctx.chapters), WOK_NUMBERED_CHAPTERS),
    ],
    [
      "Prelude present",
      (ctx) =>
        Boolean(
          findChapter(ctx.chapters, /Prelude to the Stormlight Archive/i)
        ),
    ],
    [
      "Prologue present",
      (ctx) => Boolean(findChapter(ctx.chapters, /Prologue/i)),
    ],
    [
      "Parts One-Three present; Four/Five absent from reader TOC",
      (ctx) => {
        const titles = ctx.chapters.map((chapter) => chapter.title ?? "")
        const hasOne = titles.some((title) => /Part\s+One\b/i.test(title))
        const hasTwo = titles.some((title) => /Part\s+Two\b/i.test(title))
        const hasThree = titles.some((title) => /Part\s+Three\b/i.test(title))
        const hasFour = titles.some((title) => /Part\s+Four\b/i.test(title))
        const hasFive = titles.some((title) => /Part\s+Five\b/i.test(title))
        return hasOne && hasTwo && hasThree && !hasFour && !hasFive
      },
    ],
    [
      "chapter 69 Justice distinct from chapter 70",
      (ctx) => {
        const ch69 = findChapter(
          ctx.chapters,
          /(?:Chapter\s+)?69\b.*Justice|Justice/i
        )
        const ch70 = findChapter(
          ctx.chapters,
          /(?:Chapter\s+)?70\b.*Sea Of Glass|Sea Of Glass/i
        )
        if (!ch69 || !ch70) {
          return false
        }
        // Must be distinct entries - the historical bug made both navigate to Justice.
        return ch69 !== ch70 && /69/.test(ch69.title ?? "") && /70/.test(ch70.title ?? "")
      },
    ],
    [
      "chapter 1 Stormblessed present",
      (ctx) =>
        Boolean(
          findChapter(ctx.chapters, /(?:Chapter\s+)?1\b.*Stormblessed|Stormblessed/i)
        ),
    ],
    [
      "chapter 75 In the Top Room present",
      (ctx) =>
        Boolean(
          findChapter(
            ctx.chapters,
            /(?:Chapter\s+)?75\b.*Top Room|In the Top Room/i
          )
        ),
    ],
    [
      `${WOK_EXPECTED_INTERLUDES} interludes present`,
      (ctx) => {
        const interludes = ctx.chapters.filter((chapter) =>
          /Interlude/i.test(chapter.title ?? "")
        )
        return interludes.length === WOK_EXPECTED_INTERLUDES
      },
    ],
    [
      "Epilogue present",
      (ctx) => Boolean(findChapter(ctx.chapters, /Epilogue/i)),
    ],
  ],
}
