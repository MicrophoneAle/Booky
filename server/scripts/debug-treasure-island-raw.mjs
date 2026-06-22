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

for (let i = 0; i < pages.length; i += 1) {
  const lines = pages[i]?.lines ?? []
  if (lines.some((l) => /Chapter 2|Black Dog/i.test(l.text ?? ""))) {
    console.log(`\n=== pdf page ${i + 1} ===`)
    for (const line of lines.slice(0, 12)) {
      console.log({ fs: line.fontSize?.toFixed?.(1), text: (line.text ?? "").slice(0, 100) })
    }
  }
  if (lines.some((l) => /THEOLDSEADOG|THE OLD SEA/i.test(l.text ?? ""))) {
    console.log(`\n=== running head page ${i + 1} ===`)
    for (const line of lines) {
      if (/THEOLD|ADMIRAL|^\d+$|^-\s*\d/i.test(line.text ?? "")) {
        console.log({ fs: line.fontSize?.toFixed?.(1), y: line.y?.toFixed?.(0), x: line.x?.toFixed?.(0), text: line.text })
      }
    }
  }
}
