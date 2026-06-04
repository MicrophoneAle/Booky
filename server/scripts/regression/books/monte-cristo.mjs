const falseHeadingPatterns = [
  /Dantès smiled.*meal left/i,
  /Canebière, took the Rue de Noailles/i,
  /occupied by Dantès/i,
  /old man uttered a cry.*he fell/i,
]

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
      "chapter 2 heading",
      (ctx) => {
        const chapter = ctx.blocks.find((block) =>
          /Chapter\s+2/i.test(block.text ?? "")
        )
        return chapter?.isHeading === true
      },
    ],
    [
      "Chapter 2 is correctly a heading",
      (ctx) => {
        const chapter = ctx.blocks.find((block) =>
          /Chapter\s+2/i.test(block.text ?? "")
        )
        return chapter?.isHeading === true
      },
    ],
    [
      "Word count above 400000",
      (ctx) => ctx.wordCount > 400000,
    ],
    [
      "At least 100 chapters detected",
      (ctx) => ctx.chapters.length >= 100,
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
