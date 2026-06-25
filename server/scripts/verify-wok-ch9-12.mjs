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
const { chapters } = await parsePdfBuffer(readFileSync(pdfPath), "The Way of Kings.pdf")

console.log = originalLog

console.log("PARSER_VERSION", PARSER_VERSION)

for (const line of logs) {
  if (!line.includes("[chapterAssign]")) {
    continue
  }
  const payload = JSON.parse(line.replace(/^\[chapterAssign\]\s*/, ""))
  const num = payload.finalNumber ?? ""
  if (
    /^Chapter (9|1[0-2])$/i.test(num) ||
    /^Interlude I-[123]$/i.test(num)
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
      /^Chapter (9|1[0-2])$/i.test(num) ||
      /^Interlude I-[123]$/i.test(num)
    )
  })
  console.log("[boundarySlice]", JSON.stringify(slice, null, 2))
}

for (const n of [9, 10, 11, "I-1", 12, 28]) {
  const pattern =
    typeof n === "string"
      ? new RegExp(`Interlude\\s+${n.replace("-", "\\-")}`, "i")
      : new RegExp(`Chapter\\s+${n}\\b`, "i")
  const ch = chapters.find((entry) => pattern.test(entry.title ?? ""))
  console.log(`TOC ${n}:`, ch?.title ?? "MISSING")
}

console.log("Total chapters:", chapters.length)
