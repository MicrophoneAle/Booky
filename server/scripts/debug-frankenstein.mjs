import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")
const pdfPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/src/assets/frankenstein.pdf"
)

const { chapters } = await parsePdfBuffer(readFileSync(pdfPath), "frankenstein.pdf")

console.log("Parser", PARSER_VERSION, "chapters:", chapters.length)
for (const c of chapters.slice(0, 40)) {
  console.log(JSON.stringify({ title: c.title.slice(0, 90), page: c.pageIndex }))
}
console.log("...")
for (const c of chapters.slice(-10)) {
  console.log(JSON.stringify({ title: c.title.slice(0, 90), page: c.pageIndex }))
}
