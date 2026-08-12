import { findChapter } from "../helpers.mjs"

// Planet eBook edition (Ian Johnston translation): three untitled parts marked
// only by roman numerals I / II / III on pages 3, 27, and 53. Confirmed by raw
// pdfjs extraction - there are no "Chapter N" headings in this PDF.
export default {
  id: "metamorphosis",
  name: "The Metamorphosis",
  file: "the-metamorphosis.pdf",
  assertions: [
    [
      "three roman parts I-III present",
      (ctx) => {
        const parts = ["I", "II", "III"].filter((label) =>
          ctx.chapters.some(
            (chapter) =>
              new RegExp(`^(?:Part\\s+)?${label}$`, "i").test(
                (chapter.title ?? "").trim()
              )
          )
        )
        return parts.length === 3
      },
    ],
    [
      "part I is first chapter entry",
      (ctx) => /^I$/i.test((ctx.chapters[0]?.title ?? "").trim()),
    ],
    [
      "part II present",
      (ctx) => Boolean(findChapter(ctx.chapters, /^(?:Part\s+)?II$/i)),
    ],
    [
      "part III is last chapter entry",
      (ctx) =>
        /^(?:Part\s+)?III$/i.test(
          (ctx.chapters[ctx.chapters.length - 1]?.title ?? "").trim()
        ),
    ],
    [
      "opening Gregor Samsa sentence present",
      (ctx) => /Gregor Samsa/i.test(ctx.joined),
    ],
  ],
}
