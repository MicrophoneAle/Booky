import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")
const buffer = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "../../client/src/assets/Treasure Island.pdf")
)
const pdf = await getDocument({ data: new Uint8Array(buffer), disableFontFace: true }).promise
const page = await pdf.getPage(24)
const tc = await page.getTextContent()
page.cleanup()
await pdf.destroy()

const items = tc.items.filter((i) => i.str?.trim())
for (const item of items.slice(0, 35)) {
  const fs = Math.hypot(item.transform[0], item.transform[1])
  console.log(`fs=${fs.toFixed(1).padStart(6)} y=${item.transform[5].toFixed(0).padStart(4)} x=${item.transform[4].toFixed(0).padStart(4)} | ${JSON.stringify(item.str)}`)
}
