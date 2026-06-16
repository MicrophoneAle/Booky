/**
 * One-time transport script: extract line ranges from index.js.bak into module bodies.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(__dirname, "..")
const srcPath = path.join(serverDir, "index.js.bak")
const lines = fs.readFileSync(srcPath, "utf8").split("\n")

function slice(start, end) {
  return lines.slice(start - 1, end).join("\n")
}

function writeBody(relPath, start, end) {
  const full = path.join(serverDir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, slice(start, end) + "\n", "utf8")
  return end - start + 1
}

const slices = [
  ["parse/_parseGate.body.js", 76, 138],
  ["parse/_parseProgress.body.js", 140, 436],
  ["app/_setup.body.js", 443, 516],
  ["app/_html.body.js", 779, 903],
  ["routes/_documentHelpers.body.js", 599, 655],
  ["routes/_documentRoutes1.body.js", 527, 597],
  ["routes/_documentRoutes2.body.js", 657, 777],
  ["routes/_documentRoutes3.body.js", 905, 1149],
  ["parser/_constantsTop.body.js", 33, 73],
  ["parser/_constantsChapter.body.js", 1151, 1186],
  ["parser/_puaAndFrontMatter.body.js", 1188, 2395],
  ["parser/_textNormalization.body.js", 2396, 3891],
  ["parser/_pdfImages.body.js", 3892, 5166],
  ["parser/_pdfExtract.body.js", 5167, 5532],
  ["parser/_chapterDetection.body.js", 5533, 6358],
  ["parser/_buildBlocks.body.js", 6359, 6835],
  ["documents/_documentService.body.js", 75, 75],
  ["documents/_documentService2.body.js", 6836, 7151],
  ["parser/_parsePdfBuffer.body.js", 7153, 7439],
  ["documents/_reparse.body.js", 7441, 7627],
  ["routes/_uploadRoutes.body.js", 7629, 7735],
]

const counts = {}
for (const [rel, start, end] of slices) {
  counts[rel] = writeBody(rel, start, end)
}

console.log("Extracted bodies:", counts)
