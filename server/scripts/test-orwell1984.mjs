import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pdfPath = path.resolve(
  __dirname,
  "../../client/src/assets/orwell1984.pdf"
)

const buffer = readFileSync(pdfPath)
const { chapters, contentWithChapters } = await parsePdfBuffer(
  buffer,
  "orwell1984.pdf"
)

const allBlocks = contentWithChapters.flatMap((page) => page.blocks ?? [])
const centeredTexts = allBlocks
  .filter((block) => block.textAlign === "center")
  .map((block) => block.text.trim())

const partChapters = chapters.filter((chapter) =>
  /—\s*Chapter/i.test(chapter.title)
)

const partGroups = new Map()
for (const chapter of partChapters) {
  const partLabel = chapter.title.split("—")[0].trim()
  const chapterMatch = chapter.title.match(/Chapter\s+(\d+)/i)
  const chapterNum = chapterMatch ? Number(chapterMatch[1]) : null
  if (!partGroups.has(partLabel)) {
    partGroups.set(partLabel, [])
  }
  if (chapterNum !== null) {
    partGroups.get(partLabel).push(chapterNum)
  }
}

const downWithBigBrotherCount = centeredTexts.filter((text) =>
  /^DOWN WITH BIG BROTHER$/i.test(text)
).length

const sloganLines = ["WAR IS PEACE", "FREEDOM IS SLAVERY", "IGNORANCE IS STRENGTH"]
const slogansFound = sloganLines.every((slogan) =>
  centeredTexts.some((text) => text.toUpperCase() === slogan)
)

const romanOnlyStray = chapters.filter((chapter) =>
  /^Chapter\s+[IVXLCDM]+$/i.test(chapter.title.trim()) &&
  !/—/.test(chapter.title)
)

let pass = true
const lines = []

lines.push(`Parser version: ${PARSER_VERSION}`)
lines.push(`Total chapters detected: ${chapters.length}`)
lines.push("")

lines.push("Chapters per Part:")
for (const [partLabel, numbers] of partGroups) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b)
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  const expected = []
  for (let n = min; n <= max; n += 1) {
    expected.push(n)
  }
  const missing = expected.filter((n) => !sorted.includes(n))
  const hasLowChapters = sorted.includes(1) && sorted.includes(2) && sorted.includes(3)

  lines.push(`  ${partLabel}: [${sorted.join(", ")}]`)
  if (missing.length > 0) {
    pass = false
    lines.push(`    FAIL — missing: ${missing.join(", ")}`)
  } else if (!hasLowChapters && sorted.length > 0) {
    pass = false
    lines.push("    FAIL — chapters 1–3 not present")
  } else {
    lines.push("    OK")
  }
}

lines.push("")
lines.push(`Centered blocks: ${centeredTexts.length}`)
lines.push(
  slogansFound
    ? "  Party slogans (3 centered lines): OK"
    : "  Party slogans: FAIL — " +
        sloganLines
          .filter(
            (s) => !centeredTexts.some((t) => t.toUpperCase() === s)
          )
          .join(", ")
)
if (!slogansFound) {
  pass = false
}

lines.push(
  downWithBigBrotherCount >= 5
    ? `  DOWN WITH BIG BROTHER (${downWithBigBrotherCount} centered lines): OK`
    : `  DOWN WITH BIG BROTHER: FAIL — found ${downWithBigBrotherCount}, expected >= 5`
)
if (downWithBigBrotherCount < 5) {
  pass = false
}

const yesCentered = allBlocks.filter(
  (block) =>
    /^['\u2018]?Yes\.?['\u2019]?$/i.test((block.text ?? "").trim()) &&
    block.textAlign === "center"
)

const paddingtonPass = allBlocks.some((block) => {
  const text = (block.text ?? "").trim()
  return (
    /remember this/i.test(text) &&
    /Go to Paddington Station/i.test(text) &&
    !/Go to With a sort of military precision/i.test(text)
  )
})

lines.push("")
lines.push(
  yesCentered.length === 0
    ? "  Short dialogue (Yes.) not centered: OK"
    : `  Short dialogue (Yes.) not centered: FAIL — ${yesCentered.length} centered`
)
if (yesCentered.length > 0) {
  pass = false
}

lines.push("")
lines.push(
  paddingtonPass
    ? "  Paddington dialogue continuity: OK"
    : "  Paddington dialogue continuity: FAIL — missing or scrambled Go to / Paddington lines"
)
if (!paddingtonPass) {
  pass = false
}

lines.push("")
if (romanOnlyStray.length > 0) {
  pass = false
  lines.push(`Stray roman-numeral chapters: ${romanOnlyStray.map((c) => c.title).join("; ")}`)
} else {
  lines.push("Stray roman-numeral TOC chapters: OK")
}

lines.push("")
lines.push(pass ? "OVERALL: PASS" : "OVERALL: FAIL")

console.log(lines.join("\n"))
process.exit(pass ? 0 : 1)
