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

for (let i = 0; i < pages.length; i += 1) {
  const lines = pages[i]?.lines ?? []
  if (lines.some((l) => /^Chapter [349]\b/.test(l.text ?? ""))) {
    console.log(`\n=== pdf page ${i + 1} ===`)
    for (const line of lines.slice(0, 6)) {
      console.log((line.text ?? "").slice(0, 100))
    }
  }
}
