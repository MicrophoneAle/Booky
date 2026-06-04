import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")

const pdfPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/src/assets/PrideAndPrejudice.pdf"
)

const { contentWithChapters, bookTitle } = await parsePdfBuffer(
  readFileSync(pdfPath),
  "PrideAndPrejudice.pdf"
)

const blocks = contentWithChapters.flatMap((page) => page.blocks ?? [])
const joined = blocks.map((block) => block.text ?? "").join(" ")

let pass = true
const checks = [
  ["book title resolved", () => /pride and prejudice/i.test(bookTitle ?? "")],
  [
    "title heading present",
    () =>
      blocks.some(
        (block) =>
          block.isHeading && /Pride and Prejudice/i.test(block.text ?? "")
      ),
  ],
  [
    "opening chapter intact",
    () => {
      const chapter = blocks.find((block) =>
        /^Chapter\s+1\.?$/i.test(block.text ?? "")
      )
      return chapter?.isHeading === true
    },
  ],
  [
    "famous opening sentence present",
    () =>
      joined.includes(
        "It is a truth universally acknowledged, that a single man in possession of a good fortune"
      ),
  ],
]

console.log(`Parser version: ${PARSER_VERSION}`)
for (const [label, fn] of checks) {
  const ok = fn()
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`)
  if (!ok) {
    pass = false
  }
}

process.exit(pass ? 0 : 1)
