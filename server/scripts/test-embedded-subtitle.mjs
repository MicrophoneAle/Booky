import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const pdfPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/src/assets/797The-Count-of-Monte-Cristo.pdf"
)

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")

console.log("PARSER_VERSION", PARSER_VERSION)

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

function findHeading(n) {
  return blocks.find(
    (block) =>
      block.isChapterStart &&
      block.isHeading &&
      new RegExp(`^Chapter\\s+${n}(\\s|-|$)`, "i").test((block.text ?? "").trim())
  )
}

const multiWordChecks = [
  [53, /Robert le Diable/i],
  [55, /Major Cavalcanti/i],
  [58, /Noirtier de Villefort/i],
  [6, /Deputy Procureur/i],
]

let pass = true
for (const [n, pattern] of multiWordChecks) {
  const ch = findChapter(n)
  const heading = findHeading(n)
  const ok = pattern.test(ch?.title ?? "") && pattern.test(heading?.text ?? "")
  console.log(`${ok ? "OK" : "FAIL"} CH${n}:`, ch?.title ?? "?", "|", heading?.text ?? "?")
  if (!ok) {
    pass = false
  }
}

console.log("Chapter count:", chapters.length)
process.exit(pass ? 0 : 1)
