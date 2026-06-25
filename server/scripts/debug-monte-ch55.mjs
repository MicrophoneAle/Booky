import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"
process.env.BOOKY_SUBTITLE_DEBUG = "1"

const pdfPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/src/assets/797The-Count-of-Monte-Cristo.pdf"
)

const { parsePdfBuffer } = await import("../index.js")
const { chapters, contentWithChapters } = await parsePdfBuffer(
  readFileSync(pdfPath),
  "monte.pdf"
)

console.log("Parser version from import done")
console.log("Chapter count:", chapters.length)

for (const n of [8, 20, 29, 55, 78, 79]) {
  const ch = chapters.find((entry) =>
    new RegExp(`^Chapter\\s+${n}(\\s|-|$)`, "i").test((entry.title ?? "").trim())
  )
  console.log(`CH ${n}:`, ch?.title ?? "NOT FOUND")
}

const blocks = contentWithChapters.flatMap((page) => page.blocks ?? [])
let capture = false
const ch55 = []
for (const block of blocks) {
  const text = (block.text ?? "").trim()
  if (/^Chapter\s+55(\s|-|$)/i.test(text) && block.isChapterStart) {
    capture = true
  }
  if (capture) {
    ch55.push({
      text: text.slice(0, 140),
      isHeading: block.isHeading,
      isChapterStart: block.isChapterStart,
    })
    if (ch55.length >= 8) {
      break
    }
  }
}
console.log("CH55 first blocks:", JSON.stringify(ch55, null, 2))
