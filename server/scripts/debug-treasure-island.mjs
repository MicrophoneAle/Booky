import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")
const buffer = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "../../client/src/assets/Treasure Island.pdf")
)

const result = await parsePdfBuffer(buffer, "Treasure Island.pdf")
const flat = (result.contentWithChapters ?? []).flatMap((p) => p.blocks ?? [])

console.log("parser", PARSER_VERSION)
console.log("chapters:", result.chapters.length)
for (const ch of result.chapters.slice(0, 12)) {
  console.log(" ", ch.title)
}

const leaks = flat.filter((b) =>
  /THEOLDSEADOG|ADMIRALBENBOW|CHAPTERHEADINGGOESHERE|THE OLD SEA DOG AT THE/i.test(b.text ?? "")
)
console.log("\nrunning header leaks:", leaks.length)
for (const b of leaks.slice(0, 3)) {
  console.log(" ", (b.text ?? "").slice(0, 150))
}

const ch2Start = flat.find((b) => /Black Dog Appears and Disappears/i.test(b.text ?? ""))
console.log("\nch2 heading:", ch2Start?.text ?? "MISSING")

const notLong = flat.find((b) => /Not long after this came/i.test(b.text ?? ""))
console.log("drop cap fix:", notLong ? "OK" : "MISSING", notLong?.text?.slice(0, 60) ?? "")

const images = flat.filter((b) => b.type === "image")
const imageCandidates = flat.filter((b) => b.type === "image_candidate")
console.log("image blocks:", images.length, "candidates in content:", imageCandidates.length)
const withBuffer = (result.pageImageCandidates ?? []).flat().filter((c) => c?.buffer)
console.log("candidates with buffer:", withBuffer.length)
