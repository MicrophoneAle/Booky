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

// Orwell's 1984 has a fixed, well-known structure: Part One has 8 chapters,
// Part Two has 9, Part Three has 6. Hardcoding these (rather than deriving
// the expected range from whatever numbers happen to be present in the
// parsed output) is what lets the assertion below catch truncation - a part
// silently missing its last N chapters still has a self-consistent
// min..max range in the observed data, so a range derived from that data
// can never detect the loss. Only a range checked against an independent
// ground truth can.
const EXPECTED_PART_CHAPTER_COUNTS = {
  "PART ONE": 8,
  "PART TWO": 9,
  "PART THREE": 6,
}

export default {
  id: "orwell1984",
  name: "1984",
  file: "orwell1984.pdf",
  assertions: [
    [
      "title is not a filename slug",
      (ctx) =>
        !ctx.blocks.some(
          (block) =>
            block.isHeading && /^orwell\s*1984$/i.test((block.text ?? "").trim())
        ),
    ],
    [
      "Part chapter numbering complete",
      (ctx) => {
        const partGroups = partChapterGroups(ctx.chapters)

        if (partGroups.size === 0) {
          return false
        }

        for (const [partLabel, expectedCount] of Object.entries(
          EXPECTED_PART_CHAPTER_COUNTS
        )) {
          const sorted = [...new Set(partGroups.get(partLabel) ?? [])].sort(
            (a, b) => a - b
          )

          const expected = []
          for (let number = 1; number <= expectedCount; number += 1) {
            expected.push(number)
          }

          const missing = expected.filter((number) => !sorted.includes(number))
          const extra = sorted.filter((number) => number > expectedCount)

          if (missing.length > 0 || extra.length > 0) {
            return false
          }
        }

        return true
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
