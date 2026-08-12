import { findChapter, normalizeTitleKey } from "../helpers.mjs"
import { AESOP_PRINTED_TOC_TITLES } from "./_aesop-titles.mjs"

// Printed CONTENTS (source PDF pages 8-14): Part I fables followed by the
// Krylov/Wiltse Part II set, ending at "The Wolf and the Cat" before a Note
// and a trailing reprinted mini-index. Confirmed by raw pdfjs extraction;
// expected set is the unique primary TOC titles before that Note.
const AESOP_EXPECTED_COUNT = AESOP_PRINTED_TOC_TITLES.length

export default {
  id: "aesop",
  name: "Aesop's Fables",
  file: "Aesop's Fables.pdf",
  skipGeneralChecks: ["headingDensitySane", "indentationConsistency"],
  assertions: [
    [
      `primary printed-TOC fable count (${AESOP_EXPECTED_COUNT})`,
      (ctx) => {
        const storyChapters = ctx.chapters.filter(
          (chapter) =>
            !/^(?:Introduction|Preface|Contents|Part\b)/i.test(
              (chapter.title ?? "").trim()
            )
        )
        return storyChapters.length === AESOP_EXPECTED_COUNT
      },
    ],
    [
      "every primary printed-TOC fable title present",
      (ctx) => {
        const present = new Set(
          ctx.chapters.map((chapter) => normalizeTitleKey(chapter.title))
        )
        return AESOP_PRINTED_TOC_TITLES.every((title) => {
          const key = normalizeTitleKey(title)
          if (present.has(key)) {
            return true
          }
          for (const candidate of present) {
            if (candidate.includes(key) || key.includes(candidate)) {
              return true
            }
          }
          return false
        })
      },
    ],
    [
      "first fable The Wolf and the Lamb",
      (ctx) => Boolean(findChapter(ctx.chapters, /Wolf and the Lamb/i)),
    ],
    [
      "middle fable The Hare and the Tortoise",
      (ctx) => Boolean(findChapter(ctx.chapters, /Hare and the Tortoise/i)),
    ],
    [
      "last primary TOC fable The Wolf and the Cat",
      (ctx) => Boolean(findChapter(ctx.chapters, /Wolf and the Cat/i)),
    ],
  ],
}
