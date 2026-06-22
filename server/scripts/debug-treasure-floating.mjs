import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const { extractLinesByPosition } = await import("../index.js")
const buffer = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "../../client/src/assets/Treasure Island.pdf")
)
const pages = await extractLinesByPosition(buffer)

const needles = [
  /partii|part iv|part iii|Sea Cook|Stockade|OUT THE MAP|apples for anyone|whistling gently/i,
  /DOCTOR OPENED THE PAPER|MAP OF AN ISLAND/i,
]

for (let i = 0; i < pages.length; i += 1) {
  const lines = pages[i]?.lines ?? []
  const hit = lines.some((l) => needles.some((n) => n.test(l.text ?? "")))
  if (!hit) continue
  console.log(`\n=== pdf page ${i + 1} ===`)
  for (const line of lines) {
    if (needles.some((n) => n.test(line.text ?? "")) || line.centered) {
      console.log({
        centered: line.centered,
        fs: line.fontSize?.toFixed?.(1),
        text: (line.text ?? "").slice(0, 100),
      })
    }
  }
}
