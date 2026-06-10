import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pdfPath = path.resolve(__dirname, "../../client/src/assets/The Way of Kings.pdf")

const { extractPrintedTocLookup } = await import("../printedTocService.js")
const { analyzeChapterGraphicFromContext } = await import("../chapterGraphicService.js")
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")

const buffer = readFileSync(pdfPath)
const pdf = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise

const blocks = []
for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
  const page = await pdf.getPage(pageNumber)
  const textContent = await page.getTextContent()
  for (const item of textContent.items) {
    const text = (item.str ?? "").trim()
    if (text) {
      blocks.push({ text })
    }
  }
  page.cleanup?.()
}

const printedToc = extractPrintedTocLookup(blocks)
const imageBlock = {
  type: "image_candidate",
  imageRole: "chapter_heading",
  pageNumber: 300,
}

const analysis = analyzeChapterGraphicFromContext({
  imageBlock,
  blocks: [imageBlock, { type: "text", text: "Collected on the first day of the week." }],
  blockIndex: 0,
  chapterSequence: 11,
  ocrMetadata: {
    boundaryKind: "chapter",
    number: null,
    title: "Pe I 7 pr a garbage OCR text here",
    rawText: "garbage",
  },
  printedToc,
})

console.log(JSON.stringify(analysis, null, 2))
