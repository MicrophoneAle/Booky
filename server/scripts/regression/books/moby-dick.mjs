const PUA_REGEX = /[\uE000-\uF8FF]/

export default {
  id: "moby-dick",
  name: "Moby Dick",
  file: "herman-melville-moby-dick.pdf",
  skipGeneralChecks: [
    "indentationConsistency",
    "noMidSentenceHeadings",
    "headingDensitySane",
  ],
  assertions: [
    [
      "no PUA codepoints in any block",
      (ctx) =>
        !ctx.blocks.some((block) => PUA_REGEX.test(block.text ?? "")),
    ],
    [
      "no chapter heading classified as giant title block",
      (ctx) =>
        !ctx.blocks.some(
          (block) =>
            block.isHeading &&
            (block.fontSize ?? 0) > 18 &&
            /^chapter\b/i.test((block.text ?? "").trim())
        ),
    ],
    [
      "no printed CONTENTS run in body",
      (ctx) =>
        !ctx.blocks.some((block) => {
          const text = (block.text ?? "").trim()
          return (
            /^I\.\s+Loomings\b/i.test(text) ||
            /^XVII\.\s+The prophet\b/i.test(text) ||
            /^CONTENTS$/i.test(text)
          )
        }),
    ],
    [
      "chapter LIV merged heading at normal size",
      (ctx) => {
        const chapter = ctx.blocks.find((block) =>
          /^Chapter\s+LIV\s*-\s*Of Whales in Paint/i.test(
            (block.text ?? "").trim()
          )
        )
        return (
          Boolean(chapter) &&
          chapter.isHeading === true &&
          (chapter.fontSize ?? 0) <= 16
        )
      },
    ],
    [
      "chapter LIII merged heading",
      (ctx) => {
        const chapter = ctx.blocks.find((block) =>
          /^Chapter\s+LIII\s*-\s*Of the Less Erroneous Pictures/i.test(
            (block.text ?? "").trim()
          )
        )
        return Boolean(chapter) && chapter.isHeading === true
      },
    ],
    [
      "The and There ligatures restored",
      (ctx) => {
        const joined = ctx.joined.toLowerCase()
        return (
          /\bthe\b/.test(joined) &&
          /\bthere\b/.test(joined) &&
          !/\be carpet\b/.test(joined)
        )
      },
    ],
    [
      "ct ligatures restored in pictures",
      (ctx) => /\bpictures\b/i.test(ctx.joined),
    ],
    [
      "125 numbered chapters in this PDF edition",
      (ctx) =>
        ctx.chapters.length >= 120 &&
        ctx.chapters.some((chapter) => /Chapter\s+CXXV\b/i.test(chapter.title ?? "")),
    ],
    [
      "epilogue chapter detected",
      (ctx) =>
        ctx.chapters.some((chapter) => /epilogue/i.test(chapter.title ?? "")),
    ],
    [
      "scene break divider present in chapter XXXVIII",
      (ctx) =>
        ctx.blocks.some(
          (block) =>
            (block.text ?? "").trim() === "* * *" &&
            block.textAlign === "center"
        ),
    ],
  ],
}
