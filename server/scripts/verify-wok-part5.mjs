import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")
const pdfPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/src/assets/The Way of Kings.pdf"
)

const { chapters, contentWithChapters } = await parsePdfBuffer(
  readFileSync(pdfPath),
  "wok.pdf"
)

const blocks = contentWithChapters.flatMap((page) => page.blocks ?? [])

console.log("PARSER_VERSION", PARSER_VERSION)
console.log("Total chapters:", chapters.length)

const checks = [
  [12, /Chapter\s+12\b/i, /Unity/i],
  [29, /Chapter\s+29\b/i, /Errorgance/i],
  [52, /Chapter\s+52\b/i, null],
  [70, /Chapter\s+70\b/i, /Sea Of Glass/i],
  [71, /Chapter\s+71\b/i, /Recorded In Blood/i],
  [75, /Chapter\s+75\b/i, /In The Top Room/i],
  ["Epilogue", /Epilogue/i, /Of Most Worth/i],
]

for (const [label, titlePattern, subtitlePattern] of checks) {
  const ch = chapters.find((entry) => titlePattern.test(entry.title ?? ""))
  const ok =
    Boolean(ch) && (!subtitlePattern || subtitlePattern.test(ch.title ?? ""))
  console.log(`${ok ? "OK" : "FAIL"} ${label}:`, ch?.title ?? "MISSING")
}

let ch70Start = -1
for (let index = 0; index < blocks.length; index += 1) {
  const meta = blocks[index].chapterMetadata ?? {}
  if (
    blocks[index].isChapterBoundary &&
    meta.boundaryKind === "chapter" &&
    /^Chapter\s+70$/i.test(meta.number ?? "")
  ) {
    ch70Start = index
    break
  }
}

const ch70Slice = []
if (ch70Start >= 0) {
  for (let index = ch70Start; index < Math.min(blocks.length, ch70Start + 8); index += 1) {
    ch70Slice.push((blocks[index].text ?? "").slice(0, 100))
  }
}

console.log(
  "Ch70 boundary slice:",
  JSON.stringify(ch70Slice, null, 2)
)

const hasNavani = blocks.some((block) =>
  /Navani pushed her way past the guards/i.test(block.text ?? "")
)
const hasTanatanev = blocks.some((block) =>
  /Tanatanev 1173, 18 seconds pre-death/i.test(block.text ?? "")
)
console.log("Navani opener:", hasNavani)
console.log("Tanatanev epigraph:", hasTanatanev)
