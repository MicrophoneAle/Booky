import { findChapter, normalizeTitleKey } from "../helpers.mjs"

// Printed CONTENTS (source PDF page 4): nine numbered stories. Confirmed by
// raw pdfjs extraction of that page.
const JUNGLE_BOOK_STORIES = [
  "Mowgli's Brothers",
  "Kaa's Hunting",
  "How Fear Came",
  "The Outcast",
  "Tiger! Tiger!",
  "Letting In The Jungle",
  "The King's Ankus",
  "Red Dog",
  "The Spring Running",
]

export default {
  id: "jungle-book",
  name: "The Jungle Book",
  file: "The Jungle Book.pdf",
  assertions: [
    [
      "nine CONTENTS stories present (printed TOC)",
      (ctx) => ctx.chapters.length === JUNGLE_BOOK_STORIES.length,
    ],
    [
      "CONTENTS story titles match printed order",
      (ctx) => {
        if (ctx.chapters.length !== JUNGLE_BOOK_STORIES.length) {
          return false
        }
        return JUNGLE_BOOK_STORIES.every((expected, index) => {
          const actual = normalizeTitleKey(ctx.chapters[index]?.title)
          const want = normalizeTitleKey(expected)
          return actual === want || actual.includes(want) || want.includes(actual)
        })
      },
    ],
    [
      "first story Mowgli's Brothers",
      (ctx) => Boolean(findChapter(ctx.chapters, /Mowgli.?s Brothers/i)),
    ],
    [
      "middle story Tiger! Tiger!",
      (ctx) => Boolean(findChapter(ctx.chapters, /Tiger!\s*Tiger!/i)),
    ],
    [
      "last story The Spring Running",
      (ctx) => Boolean(findChapter(ctx.chapters, /Spring Running/i)),
    ],
  ],
}
