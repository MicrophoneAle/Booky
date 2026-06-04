import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")

const pdfPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/src/assets/797The-Count-of-Monte-Cristo.pdf"
)

const { contentWithChapters } = await parsePdfBuffer(
  readFileSync(pdfPath),
  "monte.pdf"
)

const blocks = contentWithChapters.flatMap((page) => page.blocks ?? [])

const falseHeadingPatterns = [
  /Dantès smiled.*meal left/i,
  /Canebière, took the Rue de Noailles/i,
  /occupied by Dantès/i,
  /old man uttered a cry.*he fell/i,
]

let pass = true
console.log(`Parser version: ${PARSER_VERSION}`)

for (const [label, pattern] of [
  ["no false prose headings", null],
  ["chapter 2 heading", /Chapter\s+2/i],
]) {
  if (label === "no false prose headings") {
    const falseHeadings = blocks.filter(
      (block) =>
        block.isHeading &&
        falseHeadingPatterns.some((rx) => rx.test(block.text ?? ""))
    )
    const ok = falseHeadings.length === 0
    console.log(`${ok ? "OK  " : "FAIL"} ${label}`)
    if (!ok) {
      pass = false
      for (const block of falseHeadings.slice(0, 4)) {
        console.log(`  - ${(block.text ?? "").slice(0, 90)}`)
      }
    }
    continue
  }

  const chapter = blocks.find((block) => pattern.test(block.text ?? ""))
  const ok = chapter?.isHeading === true
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`)
  if (!ok) {
    pass = false
  }
}

process.exit(pass ? 0 : 1)
