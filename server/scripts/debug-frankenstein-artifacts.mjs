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

const { contentWithChapters } = await parsePdfBuffer(
  readFileSync(pdfPath),
  "frankenstein.pdf"
)

console.log("Parser", PARSER_VERSION)

for (const page of contentWithChapters.slice(0, 3)) {
  console.log("\n=== page", page.pageIndex, "===")
  for (const b of page.blocks ?? []) {
    console.log((b.text ?? "").slice(0, 100))
  }
}

const artifactRe = /\d{1,3}\s+Letter\s+[IV]+/i
let hits = 0
for (const page of contentWithChapters) {
  for (const b of page.blocks ?? []) {
    if (artifactRe.test(b.text ?? "")) {
      hits += 1
      if (hits <= 8) {
        console.log("\nARTIFACT p", page.pageIndex, ":", (b.text ?? "").slice(0, 150))
      }
    }
  }
}
console.log("\nInline letter artifacts:", hits)
