import { readFileSync } from "node:fs"
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
  if (line.includes("[chapterAssign]") || line.includes("[boundarySummary]")) {
    logs.push(line)
  }
  originalLog(...args)
}

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")
const { chapters, contentWithChapters } = await parsePdfBuffer(
  readFileSync(pdfPath),
  "The Way of Kings.pdf"
)

console.log = originalLog

console.log("PARSER_VERSION", PARSER_VERSION)

function matchesSlot(payload) {
  const num = payload.finalNumber ?? ""
  const title = payload.title ?? ""
  if (/^Chapter (6[89]|7[0-2])$/i.test(num)) {
    return true
  }
  if (/^Part (Four|Five)$/i.test(num)) {
    return true
  }
  if (/part/i.test(payload.finalKind ?? "") && /five|four/i.test(num)) {
    return true
  }
  return false
}

for (const line of logs) {
  if (!line.includes("[chapterAssign]")) {
    continue
  }
  const payload = JSON.parse(line.replace(/^\[chapterAssign\]\s*/, ""))
  const num = payload.finalNumber ?? ""
  const page = payload.pageNumber ?? 0
  if (
    /^Chapter (6[89]|7[0-2])$/i.test(num) ||
    (payload.finalKind === "part" && page >= 1020 && page <= 1060) ||
    (payload.imageRole === "full_page_illustration" && page >= 1020 && page <= 1060) ||
    (payload.imageRole === "illustration" && page >= 1048 && page <= 1055)
  ) {
    console.log("[slot]", JSON.stringify(payload))
  }
}

const summaryLine = logs.find((line) => line.includes("[boundarySummary]"))
if (summaryLine) {
  const payload = JSON.parse(summaryLine.replace(/^\[boundarySummary\]\s*/, ""))
  const slice = payload.orderedBoundaries.filter((entry) => {
    const num = entry.number ?? ""
    return (
      /^Chapter (6[89]|7[0-2])$/i.test(num) ||
      /^Part (Four|Five)$/i.test(num)
    )
  })
  console.log("[boundarySlice]", JSON.stringify(slice, null, 2))
}

for (const label of [68, 69, 70, 71, 72, 75, "Epilogue"]) {
  const pattern =
    label === "Epilogue"
      ? /Epilogue/i
      : new RegExp(`Chapter\\s+${label}\\b`, "i")
  const ch = chapters.find((entry) => pattern.test(entry.title ?? ""))
  console.log(`TOC ${label}:`, ch?.title ?? "MISSING")
}

const blocks = contentWithChapters.flatMap((page) => page.blocks ?? [])
let capture = false
const ch70Prose = []
for (const block of blocks) {
  const text = (block.text ?? "").trim()
  if (/^Chapter\s+70\b/i.test(text) || /Sea Of Glass/i.test(text)) {
    capture = true
  }
  if (capture) {
    ch70Prose.push(text.slice(0, 120))
    if (ch70Prose.length >= 6) {
      break
    }
  }
}
console.log("Ch70 opening blocks:", JSON.stringify(ch70Prose, null, 2))
console.log("Total chapters:", chapters.length)
