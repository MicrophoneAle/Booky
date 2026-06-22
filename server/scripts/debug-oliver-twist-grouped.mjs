import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const pdfPath = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../client/src/assets/Oliver Twist.pdf"
)

const { extractLinesByPosition } = await import("../index.js")

const buffer = readFileSync(pdfPath)
const pages = await extractLinesByPosition(buffer)

for (const pageIndex of [6, 27]) {
  const page = pages[pageIndex]
  console.log(`\n=== Grouped lines page index ${pageIndex} (pdf page ${pageIndex + 1}) ===`)
  for (const line of (page?.lines ?? []).slice(0, 15)) {
    console.log({
      fs: line.fontSize?.toFixed?.(1),
      centered: line.centered,
      text: (line.text ?? "").slice(0, 100),
    })
  }
}
