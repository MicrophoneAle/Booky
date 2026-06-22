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
const buffer = readFileSync(pdfPath)

// Extract raw page lines via loadPdfDocument path
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
const pdf = await mod.loadPdfDocument?.(buffer) ?? await getDocument({
  data: new Uint8Array(buffer),
  disableFontFace: true,
  useSystemFonts: false,
}).promise

const headingStrings = new Set()
const totalPages = pdf.numPages

// Find pages containing Chapter 2, 5, etc.
for (let pageNumber = 1; pageNumber <= Math.min(totalPages, 80); pageNumber += 1) {
  const page = await pdf.getPage(pageNumber)
  const textContent = await page.getTextContent()
  page.cleanup()
  const fullText = textContent.items.map((i) => i.str).join(" ")
  if (/Chapter\s+[25]\b/i.test(fullText) || /TREATS OF OLIVER/i.test(fullText) || /MASTER.?S BUSINESS/i.test(fullText)) {
    console.log(`\n=== PDF page ${pageNumber} (book content match) ===`)
    // Group by approximate y position for line-like output
    const items = textContent.items.filter((i) => i.str?.trim())
    for (const item of items.slice(0, 25)) {
      const fs = item.transform ? Math.hypot(item.transform[0], item.transform[1]) : 0
      console.log(`  fs=${fs.toFixed(1).padStart(5)} y=${item.transform?.[5]?.toFixed(0)} | ${JSON.stringify(item.str.slice(0, 120))}`)
    }
    console.log("  ...")
    console.log(`  FULL (first 500): ${fullText.slice(0, 500)}`)
  }
}

await pdf.destroy()
