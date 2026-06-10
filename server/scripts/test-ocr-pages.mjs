import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createCanvas } from "@napi-rs/canvas/node-canvas.js"
import { getDocument, OPS, ImageKind } from "pdfjs-dist/legacy/build/pdf.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { classifyPdfImageRole } = await import("../index.js")
const { ocrIllustrationMetadata } = await import("../imageOcrService.js")

const pdfPath = path.resolve(__dirname, "../../client/src/assets/The Way of Kings.pdf")
const targetPages = [273, 595, 609, 610]

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

function rawPdfPixelsToJpegBuffer(imageObject) {
  const { width, height, data, kind = ImageKind.RGBA_32BPP } = imageObject
  if (!width || !height || !data?.length) return null
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext("2d")
  const imageData = ctx.createImageData(width, height)
  if (kind === ImageKind.RGBA_32BPP) {
    imageData.data.set(data.subarray(0, width * height * 4))
  } else if (kind === ImageKind.RGB_24BPP) {
    let si = 0
    for (let di = 0; di < imageData.data.length; di += 4) {
      imageData.data[di] = data[si]
      imageData.data[di + 1] = data[si + 1]
      imageData.data[di + 2] = data[si + 2]
      imageData.data[di + 3] = 255
      si += 3
    }
  } else {
    return null
  }
  ctx.putImageData(imageData, 0, 0)
  return canvas.toBuffer("image/jpeg", { quality: 0.92 })
}

async function imageObjectToBuffer(imageObject) {
  if (!imageObject) return null
  for (const key of ["srcData", "currentSrc", "bytes"]) {
    const val = imageObject[key]
    if (Buffer.isBuffer(val) && val.length > 3 && val[0] === 0xff) return val
  }
  return rawPdfPixelsToJpegBuffer(imageObject)
}

const PDF_IMAGE_PAINT_OPS = new Set(
  [OPS.paintImageXObject, OPS.paintInlineImageXObject].filter((op) => op != null)
)

const buffer = readFileSync(pdfPath)
const pdf = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise

for (const pageNumber of targetPages) {
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
    if (!PDF_IMAGE_PAINT_OPS.has(op)) continue

    const width = Math.hypot(transform[0], transform[1])
    const height = Math.hypot(transform[2], transform[3])
    const role = classifyPdfImageRole({
      width,
      height,
      pageWidth: viewport.width,
      pageHeight: viewport.height,
    })
    if (!role) continue

    let imageObject = args?.[0]
    if (op !== OPS.paintInlineImageXObject) {
      imageObject = await page.objs.get(args?.[0])
    }

    const imageBuffer = await imageObjectToBuffer(imageObject)
    const metadata = imageBuffer
      ? await ocrIllustrationMetadata(imageBuffer, role)
      : null

    console.log(`page ${pageNumber}`, { role, size: imageBuffer?.length, metadata })
    break
  }

  page.cleanup?.()
}
