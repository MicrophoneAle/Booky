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

for (const pageIndex of [17, 18, 22, 23]) {
  console.log(`\n=== pdf page ${pageIndex + 1} ===`)
  for (const line of (pages[pageIndex]?.lines ?? []).slice(0, 15)) {
    console.log({ fs: line.fontSize?.toFixed?.(1), text: (line.text ?? "").slice(0, 100) })
  }
}
