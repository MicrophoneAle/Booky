import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"
process.env.BOOKY_FRONTMATTER_DEBUG = "1"

const pdfPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/src/assets/The Way of Kings.pdf"
)

const logs = []
const originalLog = console.log
console.log = (...args) => {
  const line = args.map(String).join(" ")
  if (line.includes("[chapterAssign]")) {
    logs.push(JSON.parse(line.replace(/^\[chapterAssign\]\s*/, "")))
  }
  originalLog(...args)
}

const { parsePdfBuffer } = await import("../index.js")
const { contentWithChapters } = await parsePdfBuffer(
  readFileSync(pdfPath),
  "The Way of Kings.pdf"
)

console.log = originalLog

const blocks = contentWithChapters.flatMap((page) => page.blocks ?? [])

const assignSlice = logs.filter(
  (entry) => entry.pageNumber >= 1020 && entry.pageNumber <= 1095
)

const blockSlice = []
for (let index = 15020; index < 15120; index += 1) {
  const block = blocks[index]
  if (!block) {
    continue
  }
  blockSlice.push({
    index,
    type: block.type,
    pageNumber: block.pageNumber,
    imageRole: block.imageRole ?? null,
    isChapterBoundary: Boolean(block.isChapterBoundary),
    boundaryKind: block.chapterMetadata?.boundaryKind ?? null,
    number: block.chapterMetadata?.number ?? null,
    title: block.chapterMetadata?.title ?? null,
    text: (block.text ?? "").slice(0, 80),
  })
}

writeFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "wok-ch68-72-debug.json"),
  JSON.stringify({ assignSlice, blockSlice }, null, 2)
)
