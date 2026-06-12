import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pdfPath = path.resolve(__dirname, "../../client/src/assets/The Way of Kings.pdf")

process.env.BOOKY_OCR_DEBUG = "1"

const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs")
const { classifyPdfImageRole } = await import("../index.js")
const { ocrIllustrationMetadata } = await import("../imageOcrService.js")

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

function bufferFromByteSource(source) {
  if (!source) return null
  if (Buffer.isBuffer(source)) return source.length > 0 ? source : null
  if (source instanceof Uint8Array) {
    return Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  }
  if (typeof source === "object" && source.buffer instanceof ArrayBuffer) {
    return Buffer.from(source.buffer, source.byteOffset ?? 0, source.byteLength ?? source.length ?? 0)
  }
  return null
}

function resolvePdfImageBuffer(imageObject) {
  if (!imageObject) return null
  for (const candidate of [imageObject.srcData, imageObject.currentSrc, imageObject.bytes, imageObject.stream, imageObject.data]) {
    const buffer = bufferFromByteSource(candidate)
    if (buffer?.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      return buffer
    }
  }
  if (typeof imageObject.src === "string" && imageObject.src.startsWith("data:image/jpeg")) {
    const comma = imageObject.src.indexOf(",")
    if (comma !== -1) {
      return Buffer.from(imageObject.src.slice(comma + 1), "base64")
    }
  }
  return null
}

const PDF_IMAGE_PAINT_OPS = new Set(
  [OPS.paintImageXObject, OPS.paintInlineImageXObject].filter((op) => op != null)
)

const buffer = readFileSync(pdfPath)
const pdf = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise

const samplePages = [57, 71, 180, 251, 273, 487, 782, 847]

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
    console.log(`\n=== pdf page ${pageNumber} ===`)
    console.log("buffer bytes", imageBuffer?.length)
    console.log("metadata", meta)
    break
  }

  page.cleanup?.()
}

const { terminateOcrWorker } = await import("../imageOcrService.js")
await terminateOcrWorker()
