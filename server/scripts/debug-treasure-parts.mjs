import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const { parsePdfBuffer } = await import("../index.js")
const buffer = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "../../client/src/assets/Treasure Island.pdf")
)
const result = await parsePdfBuffer(buffer, "Treasure Island.pdf")
const flat = (result.contentWithChapters ?? []).flatMap((p) => p.blocks ?? [])

for (const b of flat) {
  const t = b.text ?? ""
  if (/partii|Sea Cook|OUT THE MAP|apples for anyone|whistling gently|partiii|partiv|Stockade/i.test(t)) {
    console.log({
      heading: b.isHeading,
      center: b.textAlign ?? b.centered,
      text: t.slice(0, 120),
    })
  }
}

console.log("\nPart chapters:")
for (const ch of result.chapters) {
  if (/part|Part|PART|Sea Cook|Shore Adventure|Stockade|Cruise/i.test(ch.title ?? "")) {
    console.log(ch.title)
  }
}
