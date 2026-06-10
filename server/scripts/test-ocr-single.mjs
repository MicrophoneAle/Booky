import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs")
const { classifyPdfImageRole, resolvePdfImageBuffer } = await import("../index.js")
const { ocrIllustrationMetadata } = await import("../imageOcrService.js")

const pdfPath = path.resolve(__dirname, "../../client/src/assets/The Way of Kings.pdf")
if (!existsSync(pdfPath)) {
  process.exit(1)
}

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

const PDF_IMAGE_PAINT_OPS = new Set(
  [OPS.paintImageXObject, OPS.paintInlineImageXObject].filter((op) => op != null)
)

const buffer = readFileSync(pdfPath)
const pdf = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise

const targetPages = [27, 273, 595, 609, 610]

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

    if (!role) {
      continue
    }

    let imageObject = args?.[0]
    if (op !== OPS.paintInlineImageXObject) {
      imageObject = await page.objs.get(args?.[0])
    }

    const imageBuffer = resolvePdfImageBuffer(imageObject)
    if (!imageBuffer?.length) {
      continue
    }

    const metadata = await ocrIllustrationMetadata(imageBuffer, role)
    console.log(`page ${pageNumber} role=${role}`, metadata)
    break
  }

  page.cleanup?.()
}
