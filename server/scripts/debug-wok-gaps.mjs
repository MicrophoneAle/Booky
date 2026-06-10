import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pdfPath = path.resolve(__dirname, "../../client/src/assets/The Way of Kings.pdf")

const {
  parsePdfBuffer,
  mapTextBlocksToPagePositions,
  interleaveImageCandidateBlocks,
} = await import("../index.js")

// Need internal helpers - re-import via full parse path
const result = await parsePdfBuffer(readFileSync(pdfPath), "wok.pdf")

const blocks = result.contentWithChapters.flatMap((page) => page.blocks)

let anchorIdx = -1
for (let i = 0; i < blocks.length; i += 1) {
  const text = blocks[i].text ?? ""
  if (text.includes("EIGHT MONTHS LATER")) {
    anchorIdx = i
    break
  }
}
if (anchorIdx < 0) {
  for (let i = 0; i < blocks.length; i += 1) {
    if ((blocks[i].text ?? "").includes("stomach growled")) {
      anchorIdx = i
      break
    }
  }
}

console.log("anchor idx", anchorIdx)
for (let i = Math.max(0, anchorIdx - 5); i < Math.min(blocks.length, anchorIdx + 20); i += 1) {
  const block = blocks[i]
  if (block.type === "image") {
    console.log(i, "IMAGE", {
      page: block.pageNumber,
      src: Boolean(block.src),
      w: block.coordinates?.width,
      h: block.coordinates?.height,
    })
  } else {
    console.log(i, "TEXT", (block.text ?? "").slice(0, 80))
  }
}

const images = blocks.filter((block) => block.type === "image")
console.log("\nimages total", images.length, "no src", images.filter((b) => !b.src).length)
console.log(
  "images pdf pages 74-77",
  images
    .filter((b) => b.pageNumber >= 74 && b.pageNumber <= 77)
    .map((b) => ({
      page: b.pageNumber,
      src: Boolean(b.src),
      w: Math.round(b.coordinates?.width ?? 0),
      h: Math.round(b.coordinates?.height ?? 0),
    }))
)

// Images interleaved before anchor text but from far-away PDF pages
const misplaced = []
for (let i = Math.max(0, anchorIdx - 30); i < anchorIdx; i += 1) {
  const block = blocks[i]
  if (block.type === "image" && block.pageNumber && block.pageNumber < 70) {
    misplaced.push({ streamIdx: i, pdfPage: block.pageNumber, src: Boolean(block.src) })
  }
}
console.log("\nmisplaced images before anchor (pdf page < 70):", misplaced.slice(0, 10))
