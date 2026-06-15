import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pdfPath = path.resolve(__dirname, "../../client/src/assets/The Way of Kings.pdf")

if (!existsSync(pdfPath)) {
  console.error("WoK PDF not found")
  process.exit(1)
}

const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs")
const { classifyPdfImageRole, PDF_IMAGE_ROLE } = await import("../pdfImageRoleUtils.js")

function imageMetricsFromTransform(transform, pageWidth, pageHeight) {
  const width = Math.hypot(transform[0], transform[1])
  const height = Math.hypot(transform[2], transform[3])
  return { width, height, pageWidth, pageHeight, x: transform[4], y: transform[5] }
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

const allImages = []

for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const pageWidth = viewport.width
  const pageHeight = viewport.height
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

    const metrics = imageMetricsFromTransform(transform, pageWidth, pageHeight)
    if (metrics.width < 8 || metrics.height < 8) {
      continue
    }

    const role = classifyPdfImageRole(metrics)
    allImages.push({
      pageNumber,
      ...metrics,
      widthRatio: metrics.width / pageWidth,
      heightRatio: metrics.height / pageHeight,
      aspectRatio: metrics.width / metrics.height,
      role,
    })
  }

  page.cleanup?.()
}

const byRole = {
  null: allImages.filter((img) => !img.role),
  [PDF_IMAGE_ROLE.FULL_PAGE_ILLUSTRATION]: allImages.filter(
    (img) => img.role === PDF_IMAGE_ROLE.FULL_PAGE_ILLUSTRATION
  ),
  [PDF_IMAGE_ROLE.CHAPTER_HEADING]: allImages.filter(
    (img) => img.role === PDF_IMAGE_ROLE.CHAPTER_HEADING
  ),
}

console.log("Total images >= 8px:", allImages.length)
console.log("By role:", {
  dropped: byRole.null.length,
  full_page: byRole[PDF_IMAGE_ROLE.FULL_PAGE_ILLUSTRATION].length,
  chapter_heading: byRole[PDF_IMAGE_ROLE.CHAPTER_HEADING].length,
})

console.log("\n--- Wide images (widthRatio >= 0.3) NOT classified ---")
for (const img of byRole.null
  .filter((item) => item.widthRatio >= 0.3)
  .slice(0, 40)) {
  console.log(
    `p${img.pageNumber} w=${img.width.toFixed(0)} h=${img.height.toFixed(0)} wr=${img.widthRatio.toFixed(2)} hr=${img.heightRatio.toFixed(2)} ar=${img.aspectRatio.toFixed(2)}`
  )
}

console.log("\n--- chapter_heading candidates ---")
for (const img of byRole[PDF_IMAGE_ROLE.CHAPTER_HEADING].slice(0, 20)) {
  console.log(
    `p${img.pageNumber} w=${img.width.toFixed(0)} h=${img.height.toFixed(0)} wr=${img.widthRatio.toFixed(2)} hr=${img.heightRatio.toFixed(2)}`
  )
}

console.log("\n--- pages 276-295 and 820-885 ---")
for (const img of allImages.filter((item) => 
  (item.pageNumber >= 276 && item.pageNumber <= 295) ||
  (item.pageNumber >= 820 && item.pageNumber <= 885)
)) {
  console.log(
    `p${img.pageNumber} role=${img.role ?? "null"} wr=${img.widthRatio.toFixed(2)} hr=${img.heightRatio.toFixed(2)} ar=${img.aspectRatio.toFixed(2)}`
  )
}
