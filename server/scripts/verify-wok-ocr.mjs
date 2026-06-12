import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createCanvas, loadImage } from "@napi-rs/canvas/node-canvas.js"
import { createWorker } from "tesseract.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pdfPath = path.resolve(__dirname, "../../client/src/assets/The Way of Kings.pdf")

const { parsePdfBuffer } = await import("../index.js")
const { ocrIllustrationMetadata } = await import("../imageOcrService.js")

function extractPayload(block) {
  if (Buffer.isBuffer(block?.buffer) && block.buffer.length > 0) {
    return block.buffer
  }
  if (typeof block?.imgData === "object" && block.imgData?.buffer != null) {
    return Buffer.from(block.imgData.buffer)
  }
  if (typeof block?.imgData === "string" && block.imgData.length > 0) {
    return Buffer.from(block.imgData.replace(/^data:image\/\w+;base64,/, ""), "base64")
  }
  return null
}

const result = await parsePdfBuffer(readFileSync(pdfPath), "wok.pdf", {
  documentId: "verify-wok-ocr",
})

const blocks = result.contentWithChapters.flatMap((page) => page.blocks)
const headings = blocks.filter(
  (block) =>
    block.type === "image" &&
    block.imageRole === "chapter_heading" &&
    block.isChapterBoundary
)

let withMeta = 0
let withoutMeta = 0
const failures = []

for (const block of headings) {
  const metadata = block.chapterMetadata ?? {}
  const hasMeta = Boolean(metadata.number || metadata.title)
  if (hasMeta) {
    withMeta += 1
  } else {
    withoutMeta += 1
    failures.push(block.pageNumber)
  }
}

console.log("chapter heading boundaries", headings.length)
console.log("with OCR metadata", withMeta)
console.log("without OCR metadata", withoutMeta)
console.log("failed pdf pages (first 20)", failures.slice(0, 20).join(", "))

// Re-OCR a sample of failed headings using stored src won't work (binary stripped).
// Re-parse candidates by scanning PDF pages for chapter headings.
const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs")

function multiplyPdfTransform(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

const { classifyPdfImageRole, resolvePdfImageBuffer } = await import("../index.js")
const PDF_IMAGE_PAINT_OPS = new Set(
  [OPS.paintImageXObject, OPS.paintInlineImageXObject].filter((op) => op != null)
)

const samplePages = [57, 180, 251, 273, 487, 782, 847, 854]
const buffer = readFileSync(pdfPath)
const pdf = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise

console.log("\n--- direct PDF OCR sample ---")
for (const pageNumber of samplePages) {
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const operatorList = await page.getOperatorList({ intent: "display" })
  let transform = [1, 0, 0, 1, 0, 0]
  const transformStack = []

  for (let opIndex = 0; opIndex < operatorList.fnArray.length; opIndex += 1) {
    const op = operatorList.fnArray[opIndex]
    const args = operatorList.argsArray[opIndex]
    if (op === OPS.save) {
      transformStack.push([...transform])
      continue
    }
    if (op === OPS.restore) {
      transform = transformStack.pop() ?? [1, 0, 0, 1, 0, 0]
      continue
    }
    if (op === OPS.transform) {
      transform = multiplyPdfTransform(transform, args)
      continue
    }
    if (!PDF_IMAGE_PAINT_OPS.has(op)) {
      continue
    }

    const width = Math.hypot(transform[0], transform[1])
    const height = Math.hypot(transform[2], transform[3])
    const role = classifyPdfImageRole({
      width,
      height,
      pageWidth: viewport.width,
      pageHeight: viewport.height,
    })

    if (role !== "chapter_heading") {
      continue
    }

    let imageObject = args?.[0]
    if (op !== OPS.paintInlineImageXObject) {
      imageObject = await page.objs.get(args?.[0])
    }

    const imageBuffer = resolvePdfImageBuffer(imageObject)
    const meta = await ocrIllustrationMetadata(imageBuffer, "chapter_heading")
    console.log(
      `pdf p${pageNumber}`,
      "buf",
      imageBuffer?.length,
      meta ? `${meta.number} | ${meta.title}` : "null"
    )
    break
  }

  page.cleanup?.()
}

await import("../imageOcrService.js").then((m) => m.terminateOcrWorker?.())
