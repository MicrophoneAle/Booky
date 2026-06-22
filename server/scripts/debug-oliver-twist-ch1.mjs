import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const { extractLinesByPosition } = await import("../index.js")
const buffer = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "../../client/src/assets/Oliver Twist.pdf")
)
const pages = await extractLinesByPosition(buffer)

for (const pageIndex of [3, 4, 45, 46]) {
  console.log(`\n=== page ${pageIndex + 1} ===`)
  for (const line of (pages[pageIndex]?.lines ?? []).slice(0, 8)) {
    console.log({ fs: line.fontSize?.toFixed?.(1), text: (line.text ?? "").slice(0, 90) })
  }
}
