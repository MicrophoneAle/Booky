const sloganLines = [
  "WAR IS PEACE",
  "FREEDOM IS SLAVERY",
  "IGNORANCE IS STRENGTH",
]

function centeredTexts(ctx) {
  return ctx.blocks
    .filter((block) => block.textAlign === "center")
    .map((block) => (block.text ?? "").trim())
}

function partChapterGroups(chapters) {
  const partChapters = chapters.filter((chapter) =>
    /—\s*Chapter/i.test(chapter.title ?? "")
  )
  const partGroups = new Map()

  for (const chapter of partChapters) {
    const title = chapter.title ?? ""
    const partLabel = title.split("—")[0].trim()
    const chapterMatch = title.match(/Chapter\s+(\d+)/i)
    const chapterNum = chapterMatch ? Number(chapterMatch[1]) : null

    if (!partGroups.has(partLabel)) {
      partGroups.set(partLabel, [])
    }
    if (chapterNum !== null) {
      partGroups.get(partLabel).push(chapterNum)
    }
  }

  return partGroups
}

export default {
  id: "orwell1984",
  name: "1984",
  file: "orwell1984.pdf",
  assertions: [
    [
      "Part chapter numbering complete",
      (ctx) => {
        const partGroups = partChapterGroups(ctx.chapters)

        for (const numbers of partGroups.values()) {
          const sorted = [...new Set(numbers)].sort((a, b) => a - b)
          if (sorted.length === 0) {
            continue
          }

          const min = sorted[0]
          const max = sorted[sorted.length - 1]
          const expected = []
          for (let number = min; number <= max; number += 1) {
            expected.push(number)
          }

          const missing = expected.filter((number) => !sorted.includes(number))
          const hasLowChapters =
            sorted.includes(1) && sorted.includes(2) && sorted.includes(3)

          if (missing.length > 0 || !hasLowChapters) {
            return false
          }
        }

        return partGroups.size > 0
      },
    ],
    [
      "Party slogans (3 centered lines)",
      (ctx) => {
        const centered = centeredTexts(ctx)
        return sloganLines.every((slogan) =>
          centered.some((text) => text.toUpperCase() === slogan)
        )
      },
    ],
    [
      "DOWN WITH BIG BROTHER (>= 5 centered lines)",
      (ctx) => {
        const centered = centeredTexts(ctx)
        const count = centered.filter((text) =>
          /^DOWN WITH BIG BROTHER$/i.test(text)
        ).length
        return count >= 5
      },
    ],
    [
      "Short dialogue (Yes.) not centered",
      (ctx) => {
        const yesCentered = ctx.blocks.filter(
          (block) =>
            /^['\u2018]?Yes\.?['\u2019]?$/i.test((block.text ?? "").trim()) &&
            block.textAlign === "center"
        )
        return yesCentered.length === 0
      },
    ],
    [
      "Paddington dialogue continuity",
      (ctx) =>
        ctx.blocks.some((block) => {
          const text = (block.text ?? "").trim()
          return (
            /remember this/i.test(text) &&
            /Go to Paddington Station/i.test(text) &&
            !/Go to With a sort of military precision/i.test(text)
          )
        }),
    ],
    [
      "Stray roman-numeral TOC chapters",
      (ctx) => {
        const romanOnlyStray = ctx.chapters.filter(
          (chapter) =>
            /^Chapter\s+[IVXLCDM]+$/i.test((chapter.title ?? "").trim()) &&
            !/—/.test(chapter.title ?? "")
        )
        return romanOnlyStray.length === 0
      },
    ],
    [
      "Word count above 85000",
      (ctx) => ctx.wordCount > 85000,
    ],
    [
      "At least 3 Parts detected",
      (ctx) => {
        const partLabels = new Set()
        for (const chapter of ctx.chapters) {
          const title = chapter.title ?? ""
          if (/—\s*Chapter/i.test(title)) {
            partLabels.add(title.split("—")[0].trim())
          }
        }
        return partLabels.size >= 3
      },
    ],
  ],
}
