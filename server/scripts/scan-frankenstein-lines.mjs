import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")
const { extractLinesByPosition } = await import("../index.js")

const pdfPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/src/assets/frankenstein.pdf"
)
const buffer = readFileSync(pdfPath)
const pageData = await extractLinesByPosition(buffer)

const hits = []
for (let pi = 0; pi < pageData.length; pi += 1) {
  for (const line of pageData[pi].lines ?? []) {
    const t = (line.text ?? "").trim()
    if (/^(chapter|letter|preface)\s+/i.test(t) && (line.fontSize ?? 0) >= 14) {
      hits.push({ page: pi, fs: line.fontSize, text: t.slice(0, 90) })
    }
  }
}

console.log("Parser", PARSER_VERSION, "heading-like lines:", hits.length)
for (const h of hits.slice(0, 80)) {
  console.log(JSON.stringify(h))
}

const { chapters } = await parsePdfBuffer(buffer, "frankenstein.pdf")
console.log("chapters:", chapters.length)
for (const c of chapters) {
  console.log(`p.${c.pageIndex} ${c.title}`)
}
