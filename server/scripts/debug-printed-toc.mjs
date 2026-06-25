import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  extractPrintedTocFromPageData,
  lookupPrintedTocTitle,
} from "../printedTocService.js"
import { extractLinesByPosition } from "../index.js"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const pdfPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/src/assets/797The-Count-of-Monte-Cristo.pdf"
)

const pageData = await extractLinesByPosition(readFileSync(pdfPath))
const printedToc = extractPrintedTocFromPageData(pageData)

console.log("printedToc chapters size:", printedToc?.chapters?.size ?? 0)

for (const n of [8, 20, 29, 55]) {
  const title = lookupPrintedTocTitle(printedToc, {
    number: String(n),
    boundaryKind: "chapter",
  })
  console.log(`TOC ch ${n}:`, title ?? "(missing)")
}

if (printedToc?.chapters?.has("55")) {
  console.log("Raw TOC 55:", printedToc.chapters.get("55"))
}
