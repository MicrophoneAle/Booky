import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const pdfPath = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../client/src/assets/Aesop's Fables.pdf"
)

const buffer = readFileSync(pdfPath)

const { loadPdfDocument } = await import("../index.js")

// Access internal via dynamic import - use same pattern as index
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
const { getDocument } = pdfjs

async function loadPdf() {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
  })
  return loadingTask.promise
}

const pdf = await loadPdf()
const totalPages = pdf.numPages
console.log("pages", totalPages)

async function timePage(pageNumber) {
  const start = Date.now()
  const page = await pdf.getPage(pageNumber)
  try {
    await page.getTextContent()
  } finally {
    page.cleanup?.()
  }
  return Date.now() - start
}

async function timeBatch(startPage, concurrency) {
  const pages = []
  for (let n = startPage; n < startPage + concurrency && n <= totalPages; n += 1) {
    pages.push(n)
  }
  const batchStart = Date.now()
  const results = await Promise.all(
    pages.map(async (pageNumber) => {
      const ms = await timePage(pageNumber)
      return { pageNumber, ms }
    })
  )
  return { batchMs: Date.now() - batchStart, results }
}

for (let batchStart = 1; batchStart <= 50; batchStart += 4) {
  const { batchMs, results } = await timeBatch(batchStart, 4)
  const slow = results.filter((entry) => entry.ms > 2000)
  console.log(
    `batch ${batchStart}-${batchStart + 3}:`,
    `${batchMs}ms total`,
    slow.length ? `SLOW ${JSON.stringify(slow)}` : ""
  )
}

await pdf.destroy?.()
