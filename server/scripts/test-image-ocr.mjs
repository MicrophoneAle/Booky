import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pdfPath = path.resolve(__dirname, "../../client/src/assets/The Way of Kings.pdf")

if (!existsSync(pdfPath)) {
  console.error("WoK PDF not found")
  process.exit(1)
}

const { parsePdfBuffer } = await import("../index.js")
const { ocrIllustrationMetadata } = await import("../imageOcrService.js")

const result = await parsePdfBuffer(readFileSync(pdfPath), "test.pdf")

const samples = result.contentWithChapters
  .flatMap((page) => page.blocks)
  .filter((block) => block.type === "image" && block.isChapterBoundary)
  .slice(0, 8)

console.log("Sample boundary images:", samples.length)

for (const block of samples) {
  console.log("\n---", block.imageRole, block.pageNumber, "---")
  console.log("metadata:", block.chapterMetadata)
}
