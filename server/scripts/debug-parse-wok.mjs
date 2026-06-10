import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const candidates = [
  path.resolve(__dirname, "../../client/src/assets/The Way of Kings.pdf"),
  path.resolve(__dirname, "../../client/src/assets/the way of kings.pdf"),
  path.resolve(__dirname, "../../client/src/assets/Way of Kings.pdf"),
]

const pdfPath = candidates.find((candidate) => existsSync(candidate))
if (!pdfPath) {
  console.error("WoK PDF not found. Checked:")
  for (const candidate of candidates) {
    console.error("  -", candidate)
  }
  process.exit(1)
}

console.log("Using PDF:", pdfPath)
console.log("Size MB:", (readFileSync(pdfPath).length / (1024 * 1024)).toFixed(2))

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")

const phases = []

try {
  const startedAt = Date.now()
  const result = await parsePdfBuffer(readFileSync(pdfPath), "The Way of Kings.pdf", {
    documentId: "debug-wok-test",
    onPageProcessed(pageNumber, totalPages) {
      if (pageNumber % 100 === 0 || pageNumber === totalPages) {
        console.log(`  pages: ${pageNumber}/${totalPages}`)
      }
    },
    onProgress(progress) {
      phases.push(progress)
      if (
        progress.phase === "classifying_illustrations" ||
        progress.phase === "uploading_assets" ||
        progress.phase === "finalizing" ||
        progress.phase === "structuring"
      ) {
        console.log(
          `[${progress.phase}] ${progress.label ?? ""} ${progress.current ?? 0}/${progress.total ?? 0} (${progress.percent ?? 0}%)`
        )
      }
    },
  })

  const imageBlocks = result.contentWithChapters
    .flatMap((page) => page.blocks)
    .filter((block) => block.type === "image")

  console.log("\nSUCCESS")
  console.log("PARSER_VERSION", PARSER_VERSION)
  console.log("elapsed s", ((Date.now() - startedAt) / 1000).toFixed(1))
  console.log("pages", result.parsedText.numpages)
  console.log("chapters", result.chapters.length)
  console.log("image blocks", imageBlocks.length)
  console.log("images with src", imageBlocks.filter((b) => b.src).length)
  console.log("image candidates total", result.imageCandidateCount)
  console.log(
    "chapter boundary images",
    imageBlocks.filter((block) => block.isChapterBoundary).length
  )
  console.log("last phases:", phases.slice(-5))
} catch (error) {
  console.error("\nFAILED at:", phases.at(-1)?.phase ?? "unknown")
  console.error("last progress:", phases.at(-1))
  console.error("error:", error instanceof Error ? error.stack ?? error.message : error)
  process.exit(1)
}
