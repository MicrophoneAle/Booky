import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const {
  buildBlocksFromLines,
  blocksToContent,
  detectChapters,
  extractHeadingLines,
  extractLinesByPosition,
  isChapterHeading,
  isCleanStructuralHeadingText,
  PARSER_VERSION,
} = await import("../index.js")

const pdfPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/src/assets/frankenstein.pdf"
)
const buffer = readFileSync(pdfPath)

const [headingStrings, pageData] = await Promise.all([
  extractHeadingLines(buffer),
  extractLinesByPosition(buffer),
])

const blocks = buildBlocksFromLines(pageData, headingStrings)
const content = blocksToContent(blocks)
const { chapters } = detectChapters(content, "Frankenstein")

console.log("Parser", PARSER_VERSION, "chapters:", chapters.length)

for (const block of blocks) {
  const text = (block.text ?? "").trim()
  if (!/^(chapter|letter|preface|volume|part)/i.test(text)) {
    continue
  }
  console.log(
    JSON.stringify({
      text: text.slice(0, 80),
      isHeading: block.isHeading,
      isChapterStart: block.isChapterStart,
      fontSize: block.fontSize,
      clean: isCleanStructuralHeadingText(text, { fontSize: block.fontSize ?? 0 }),
      chapterHeading: isChapterHeading(block),
    })
  )
}
