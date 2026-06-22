import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
const buffer = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "../../client/src/assets/Treasure Island.pdf")
)
const pdf = await getDocument({ data: new Uint8Array(buffer), disableFontFace: true }).promise
for (const n of [17, 18]) {
  const page = await pdf.getPage(n)
  const tc = await page.getTextContent()
  page.cleanup()
  console.log(`\n=== page ${n} ===`)
  for (const item of tc.items.filter((i) => i.str?.trim()).slice(0, 20)) {
    const fs = Math.hypot(item.transform[0], item.transform[1])
    console.log(`fs=${fs.toFixed(1)} | ${JSON.stringify(item.str)}`)
  }
}
await pdf.destroy()
