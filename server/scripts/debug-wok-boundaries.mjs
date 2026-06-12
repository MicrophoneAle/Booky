import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pdfPath = path.resolve(__dirname, "../../client/src/assets/The Way of Kings.pdf")

const { parsePdfBuffer } = await import("../index.js")
const { extractPrintedTocFromPageData } = await import("../printedTocService.js")

const result = await parsePdfBuffer(readFileSync(pdfPath), "wok.pdf", {
  documentId: "debug-wok-boundaries",
})

const blocks = result.contentWithChapters.flatMap((page) => page.blocks)
const printedToc =
  extractPrintedTocFromPageData(result.parsedText?.pageData ?? []) ??
  null
const boundaries = blocks.filter((block) => block.type === "image" && block.isChapterBoundary)
const headings = blocks.filter((block) => block.type === "image" && block.imageRole === "chapter_heading")

console.log("printed TOC entries", printedToc?.ordered?.length ?? result.printedToc?.ordered?.length ?? "n/a")
console.log("boundaries", boundaries.length)
console.log("chapter headings", headings.length)
console.log("--- boundaries ---")
for (const block of boundaries) {
  const metadata = block.chapterMetadata ?? {}
  const label = metadata.title
    ? `${metadata.number ?? ""}: ${metadata.title}`.replace(/^: /, "")
    : metadata.number ?? metadata.boundaryKind
  console.log(`p.${block.pageNumber}\t${metadata.boundaryKind}\t${label}`)
}
