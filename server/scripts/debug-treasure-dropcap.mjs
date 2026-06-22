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

for (const page of pages) {
  for (const line of page.lines ?? []) {
    if (/long after this came|ot long after/i.test(line.text ?? "")) {
      console.log("found:", line.text?.slice(0, 80))
    }
  }
}
