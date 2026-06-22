import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const { loadPdfDocument } = await import("../index.js")

const buffer = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "../../client/src/assets/Treasure Island.pdf")
)

const pdf = await loadPdfDocument(buffer)
const page = await pdf.getPage(17)
const operatorList = await page.getOperatorList({ intent: "display" })
console.log("ops", operatorList.fnArray.length)

const paintOps = operatorList.fnArray.filter((op) => op === 85 || op === 86)
console.log("paint ops", paintOps.length)

page.cleanup()
await pdf.destroy()
