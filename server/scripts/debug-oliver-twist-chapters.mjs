import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const pdfPath = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../client/src/assets/Oliver Twist.pdf"
)

const { parsePdfBuffer } = await import("../index.js")

const result = await parsePdfBuffer(readFileSync(pdfPath), "Oliver Twist.pdf")

console.log("chapters:", result.chapters.length)
for (const ch of result.chapters.slice(0, 15)) {
  console.log(`  ${ch.number ?? "?"} | ${ch.title}`)
}

const flat = result.content.flatMap((p) => p.blocks ?? [])
const chapterBlocks = flat.filter((b) => b.isChapterStart || /^Chapter/i.test(b.text ?? ""))

console.log("\nChapter heading blocks (first 20):")
for (const b of chapterBlocks.slice(0, 20)) {
  console.log(JSON.stringify({
    text: (b.text ?? "").slice(0, 120),
    isHeading: b.isHeading,
    isChapterStart: b.isChapterStart,
    fontSize: b.fontSize,
  }))
}
