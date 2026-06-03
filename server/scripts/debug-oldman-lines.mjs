import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")
const pdfPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/src/assets/The Old Man and the Sea.pdf"
)

const { contentWithChapters } = await parsePdfBuffer(
  readFileSync(pdfPath),
  "oldman.pdf"
)

console.log("Parser", PARSER_VERSION)

for (const page of contentWithChapters) {
  if (page.pageIndex < 37 || page.pageIndex > 41) continue
  console.log("\n=== page", page.pageIndex, "===")
  for (const b of page.blocks ?? []) {
    const t = (b.text ?? "").slice(0, 120)
    const flags = [
      b.bold ? "bold" : "",
      b.runs?.length > 1 ? `runs:${b.runs.length}` : "",
      b.isHeading ? "hd" : "",
    ]
      .filter(Boolean)
      .join(",")
    console.log(`[${flags}] ${t}`)
  }
}
