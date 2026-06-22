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
  const text = (pages[i]?.lines ?? []).map((l) => l.text).join(" ")
  if (/Grimwig/i.test(text) || /Chapter 14/i.test(text)) {
    console.log(`\n=== pdf page ${i + 1} ===`)
    for (const line of (pages[i]?.lines ?? []).slice(0, 10)) {
      console.log({ fs: line.fontSize?.toFixed?.(1), text: (line.text ?? "").slice(0, 100) })
    }
  }
}
