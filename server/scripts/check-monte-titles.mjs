import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const pdfPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/src/assets/797The-Count-of-Monte-Cristo.pdf"
)

const { parsePdfBuffer } = await import("../index.js")
const { chapters, contentWithChapters } = await parsePdfBuffer(
  readFileSync(pdfPath),
  "monte.pdf"
)

const blocks = contentWithChapters.flatMap((page) => page.blocks ?? [])

function findChapter(n) {
  return chapters.find((entry) =>
    new RegExp(`Chapter\\s+${n}(\\s|-|$)`, "i").test(entry.title ?? "")
  )
}

function findHeadingBlock(n) {
  return blocks.find(
    (block) =>
      block.isChapterStart &&
      block.isHeading &&
      new RegExp(`^Chapter\\s+${n}(\\s|-|$)`, "i").test((block.text ?? "").trim())
  )
}

for (const n of [8, 20, 29, 53, 55, 58]) {
  const ch = findChapter(n)
  const heading = findHeadingBlock(n)
  console.log(
    `CH${n} chapter="${ch?.title ?? "NOT FOUND"}" heading="${heading?.text ?? "NOT FOUND"}"`
  )
}

console.log("Total chapters:", chapters.length)
