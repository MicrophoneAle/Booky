import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const pdfPath = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../client/src/assets/Aesop's Fables.pdf"
)

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
const { getDocument } = pdfjs
const pdf = await (
  await getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    disableFontFace: true,
    useSystemFonts: false,
  })
).promise

async function timeImages(pageNumber) {
  const start = Date.now()
  const page = await pdf.getPage(pageNumber)
  try {
    const op = await page.getOperatorList({ intent: "display" })
    return { pageNumber, ms: Date.now() - start, ops: op.fnArray?.length ?? 0 }
  } finally {
    page.cleanup?.()
  }
}

for (let pageNumber = 35; pageNumber <= 50; pageNumber += 1) {
  const result = await timeImages(pageNumber)
  console.log(result)
}

await pdf.destroy?.()
