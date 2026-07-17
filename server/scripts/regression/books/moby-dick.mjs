const PUA_REGEX = /[\uE000-\uF8FF]/

export default {
  id: "moby-dick",
  name: "Moby Dick",
  file: "herman-melville-moby-dick.pdf",
  skipGeneralChecks: [
    "indentationConsistency",
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
      (ctx) => {
        const firstChapterIndex = ctx.blocks.findIndex((block) =>
          /^Chapter\s+I\s*-/i.test((block.text ?? "").trim())
        )
        const frontMatter =
          firstChapterIndex > 0 ? ctx.blocks.slice(1, firstChapterIndex) : []
        return (
          !ctx.blocks.some((block) => /^CONTENTS$/i.test((block.text ?? "").trim())) &&
          frontMatter.every((block) => {
            const text = (block.text ?? "").trim()
            return (
              !/^(?:[IVXLCDM]{1,10}|\d{1,3})\.\s+.+\s+\d{1,4}\s*$/i.test(text) &&
              !/^I\.\s+Loomings\b/i.test(text) &&
              !/^XXIII\.\s+Postscript\b/i.test(text)
            )
          })
        )
      },
    ],
    [
      "no false scene breaks flooding chapter I",
      (ctx) => {
        const chapterStart = ctx.blocks.findIndex((block) =>
          /^Chapter\s+I\s*-/i.test((block.text ?? "").trim())
        )
        if (chapterStart < 0) {
          return false
        }
        const chapterSlice = ctx.blocks.slice(chapterStart, chapterStart + 20)
        const sceneBreaks = chapterSlice.filter(
          (block) => (block.text ?? "").trim() === "* * *"
        )
        return sceneBreaks.length <= 1
      },
    ],
    [
      "loomings key-to-it-all sentence intact",
      (ctx) =>
        ctx.blocks.some((block) =>
          /\bthis is the key to it all\b/i.test(block.text ?? "")
        ),
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
      "chapter XLI includes Hark subtitle",
      (ctx) => {
        const chapter = ctx.blocks.find((block) =>
          /^Chapter\s+XLI\s*-\s*Hark!?\b/i.test((block.text ?? "").trim())
        )
        return Boolean(chapter) && chapter.isHeading === true
      },
    ],
    [
      "no stray page number after chapter I",
      (ctx) => {
        const chapterStart = ctx.blocks.findIndex((block) =>
          /^Chapter\s+I\s*-/i.test((block.text ?? "").trim())
        )
        const chapterTwo = ctx.blocks.findIndex((block) =>
          /^Chapter\s+II\s*-/i.test((block.text ?? "").trim())
        )
        if (chapterStart < 0 || chapterTwo < 0) {
          return false
        }
        return !ctx.blocks
          .slice(chapterStart, chapterTwo)
          .some((block) => /^\d{1,3}$/.test((block.text ?? "").trim()))
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
      "no standalone scene break dividers in body",
      (ctx) =>
        !ctx.blocks.some(
          (block) => (block.text ?? "").trim() === "* * *"
        ),
    ],
  ],
}
