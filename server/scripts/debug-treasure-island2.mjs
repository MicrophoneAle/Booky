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
const flat = (result.parsedContent ?? result.content ?? []).flatMap((p) => p.blocks ?? [])

for (const b of flat) {
  const t = b.text ?? ""
  if (/THEOLDSEADOG|ADMIRALBENBOW|CHAPTERHEADING|THE OLD SEA DOG AT/i.test(t)) {
    console.log("LEAK:", t.slice(0, 200))
  }
  if (/^ot long after|^and Disappears/i.test(t)) {
    console.log("CH2:", t.slice(0, 120))
  }
}

const ch2 = result.chapters.find((c) => /Chapter 2/i.test(c.title ?? ""))
console.log("\nch2 title:", ch2?.title)

// Count prose vs heading
console.log("blocks:", flat.length, "images:", flat.filter((b) => b.type === "image").length)
