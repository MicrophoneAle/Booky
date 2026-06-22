import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const pdfPath = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../client/src/assets/Oliver Twist.pdf"
)

const mod = await import("../index.js")

// Use internal helpers via a focused page extract
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")

const buffer = readFileSync(pdfPath)
const pdf = await getDocument({
  data: new Uint8Array(buffer),
  disableFontFace: true,
  useSystemFonts: false,
}).promise

const pagesToInspect = [5, 6, 23, 24, 25]

for (const pageNum of pagesToInspect) {
  const page = await pdf.getPage(pageNum)
  const textContent = await page.getTextContent()
  page.cleanup()

  console.log(`\n=== PDF page ${pageNum} ===`)
  for (const item of textContent.items.slice(0, 40)) {
    const str = item.str?.trim()
    if (!str) continue
    const fs = item.transform ? Math.hypot(item.transform[0], item.transform[1]) : 0
    console.log(`  fs=${fs.toFixed(1).padStart(5)} | ${JSON.stringify(str.slice(0, 100))}`)
  }
}

await pdf.destroy()

// Full parse chapters
const result = await mod.parsePdfBuffer(buffer, "Oliver Twist.pdf")
console.log("\n=== Detected chapters ===")
for (const ch of result.chapters) {
  console.log(`  ${ch.title}`)
}
