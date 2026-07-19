const falseHeadingPatterns = [
  /Dantès smiled.*meal left/i,
  /Canebière, took the Rue de Noailles/i,
  /occupied by Dantès/i,
  /old man uttered a cry.*he fell/i,
]

// Confirmed via a raw pdftotext extraction of the source PDF (independent of
// the parser): "Chapter 1." through "Chapter 117." all appear as heading
// lines, no gaps, no duplicates. Chapter numbering runs continuously across
// all five VOLUME divisions (unlike 1984's per-part restart) - so this is a
// single 1..117 range, not a group of per-volume ranges.
const MONTE_CRISTO_EXPECTED_CHAPTER_COUNT = 117

function arabicChapterNumbers(chapters) {
  return chapters
    .map((chapter) => {
      const match = (chapter?.title ?? "").match(/Chapter\s+(\d+)\b/i)
      return match ? Number(match[1]) : null
    })
    .filter((number) => number !== null)
}

export default {
  id: "monte-cristo",
  name: "The Count of Monte Cristo",
  file: "797The-Count-of-Monte-Cristo.pdf",
  skipGeneralChecks: ["indentationConsistency"],
  assertions: [
    [
      "no false prose headings",
      (ctx) =>
        !ctx.blocks.some(
          (block) =>
            block.isHeading &&
            falseHeadingPatterns.some((pattern) =>
              pattern.test(block.text ?? "")
            )
        ),
    ],
    [
      "Known mid-sentence lines are not headings",
      (ctx) =>
        !ctx.blocks.some(
          (block) =>
            block.isHeading &&
            falseHeadingPatterns.some((pattern) =>
              pattern.test(block.text ?? "")
            )
        ),
    ],
    [
      "chapter 2 heading with subtitle",
      (ctx) => {
        const chapter = ctx.blocks.find((block) =>
          /^Chapter\s+2\s*-\s*Father and Son$/i.test((block.text ?? "").trim())
        )
        return chapter?.isHeading === true && chapter?.isChapterStart === true
      },
    ],
    [
      "chapter 1 heading with subtitle",
      (ctx) => {
        const chapter = ctx.blocks.find((block) =>
          /^Chapter\s+1\s*-\s*Marseilles/i.test((block.text ?? "").trim())
        )
        return chapter?.isHeading === true
      },
    ],
    [
      "chapter 3 with subtitle",
      (ctx) => {
        const chapter = ctx.blocks.find((block) =>
          /^Chapter\s+3\s*-\s*The Catalans$/i.test((block.text ?? "").trim())
        )
        return chapter?.isHeading === true && chapter?.isChapterStart === true
      },
    ],
    [
      "chapter 7 with subtitle from PDF",
      (ctx) => {
        const chapter = ctx.blocks.find((block) =>
          /^Chapter\s+7\s*-\s*The Examination$/i.test((block.text ?? "").trim())
        )
        return chapter?.isHeading === true && chapter?.isChapterStart === true
      },
    ],
    [
      "chapter 6 with French subtitle",
      (ctx) => {
        const chapter = ctx.chapters.find((entry) =>
          /Chapter\s+6\s*-\s*The Deputy Procureur du Roi/i.test(entry.title ?? "")
        )
        return Boolean(chapter)
      },
    ],
    [
      "chapter 53 Robert le Diable",
      (ctx) => {
        const chapter = ctx.chapters.find((entry) =>
          /Chapter\s+53\s*-\s*Robert le Diable/i.test(entry.title ?? "")
        )
        return Boolean(chapter)
      },
    ],
    [
      "chapter 55 Major Cavalcanti",
      (ctx) => {
        const chapter = ctx.chapters.find((entry) =>
          /Chapter\s+55\s*-\s*Major Cavalcanti/i.test(entry.title ?? "")
        )
        const heading = ctx.blocks.find((block) =>
          /^Chapter\s+55\s*-\s*Major Cavalcanti$/i.test((block.text ?? "").trim())
        )
        return Boolean(chapter) && heading?.isHeading === true
      },
    ],
    [
      "chapter 8 Château d'If",
      (ctx) => {
        const chapter = ctx.chapters.find((entry) =>
          /Chapter\s+8\s*-\s*The Château d/i.test(entry.title ?? "")
        )
        return Boolean(chapter)
      },
    ],
    [
      "chapter 58 Noirtier de Villefort",
      (ctx) => {
        const chapter = ctx.chapters.find((entry) =>
          /Chapter\s+58\s*-\s*M\.?\s*Noirtier de Villefort/i.test(entry.title ?? "")
        )
        return Boolean(chapter)
      },
    ],
    [
      "Word count above 400000",
      (ctx) => ctx.wordCount > 400000,
    ],
    [
      "Chapters 1-117 present with no gaps (raw PDF chapter headings)",
      (ctx) => {
        const numbers = arabicChapterNumbers(ctx.chapters)
        const present = new Set(numbers)

        const missing = []
        for (let number = 1; number <= MONTE_CRISTO_EXPECTED_CHAPTER_COUNT; number += 1) {
          if (!present.has(number)) {
            missing.push(number)
          }
        }
        const extra = numbers.filter(
          (number) => number > MONTE_CRISTO_EXPECTED_CHAPTER_COUNT
        )

        return missing.length === 0 && extra.length === 0
      },
    ],
    [
      '"three." wrap fragment is not a heading',
      (ctx) =>
        !ctx.blocks.some(
          (block) =>
            block.isHeading && /^three\.?$/i.test((block.text ?? "").trim())
        ),
    ],
    [
      "No heading ends with a preposition",
      (ctx) =>
        !ctx.blocks
          .filter((block) => block.isHeading)
          .some((block) =>
            /\b(of|the|a|left|fell|was|be|in|to|with|from|at|by|on|as)$/i.test(
              (block.text ?? "").trim()
            )
          ),
    ],
  ],
}
