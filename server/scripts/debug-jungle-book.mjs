import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs"

const require = createRequire(import.meta.url)
const PDFJS_DIST_DIR = require.resolve("pdfjs-dist/package.json").replace(/[/\\]package\.json$/, "")

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const pdfPath = join(__dirname, "../../client/src/assets/The Jungle Book.pdf")

const { parsePdfBuffer, PARSER_VERSION, classifyPdfImageRole } = await import("../index.js")

const result = await parsePdfBuffer(readFileSync(pdfPath), "The Jungle Book.pdf")
const blocks = result.contentWithChapters.flatMap((page) => page.blocks ?? [])

console.log("PARSER_VERSION", PARSER_VERSION)
console.log("chapters", result.chapters.length)
console.log(
  "chapter titles",
  result.chapters.map((chapter) => chapter.title)
)

const jungleHeaders = blocks.filter((block) => /JUNGLE BOOK|•\s*\d/.test(block.text ?? ""))
console.log("\nmargin-like blocks", jungleHeaders.length)
for (const block of jungleHeaders.slice(0, 12)) {
  console.log(JSON.stringify((block.text ?? "").slice(0, 100)))
}

const headings = blocks.filter((block) => block.isHeading)
console.log("\nheading blocks", headings.length)
for (const block of headings.slice(0, 20)) {
  console.log(
    JSON.stringify({
      text: (block.text ?? "").slice(0, 60),
      isChapterStart: block.isChapterStart,
      fontSize: block.fontSize,
      page: block.sourcePdfPage,
    })
  )
}

const images = blocks.filter((block) => block.type === "image")
console.log("\nimage blocks", images.length)
for (const image of images.slice(0, 15)) {
  console.log(
    JSON.stringify({
      role: image.imageRole,
      page: image.pageNumber ?? image.sourcePdfPage,
      hasData: Boolean(image.dataUrl || image.buffer || image.src),
      w: image.coordinates?.width,
      h: image.coordinates?.height,
    })
  )
}

// Raw image scan with wasm
const data = new Uint8Array(readFileSync(pdfPath))
const doc = await getDocument({
  data,
  disableFontFace: true,
  useSystemFonts: false,
  useWorkerFetch: false,
  wasmUrl: `${PDFJS_DIST_DIR}/wasm/`,
  standardFontDataUrl: `${PDFJS_DIST_DIR}/standard_fonts/`,
}).promise

let imageCount = 0
for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
  const page = await doc.getPage(pageNumber)
  const ops = await page.getOperatorList({ intent: "display" })
  const viewport = page.getViewport({ scale: 1 })
  const pageWidth = viewport.width
  const pageHeight = viewport.height
  let transform = [1, 0, 0, 1, 0, 0]
  const stack = []

  for (let index = 0; index < ops.fnArray.length; index += 1) {
    const op = ops.fnArray[index]
    const args = ops.argsArray[index]
    if (op === OPS.save) stack.push([...transform])
    else if (op === OPS.restore) transform = stack.pop() ?? [1, 0, 0, 1, 0, 0]
    else if (op === OPS.transform) {
      const [a, b, c, d, e, f] = args
      const [ta, tb, tc, td, te, tf] = transform
      transform = [
        a * ta + b * tc,
        a * tb + b * td,
        c * ta + d * tc,
        c * tb + d * td,
        e * ta + f * tc + te,
        e * tb + f * td + tf,
      ]
    } else if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject) {
      const width = Math.hypot(transform[0], transform[1])
      const height = Math.hypot(transform[2], transform[3])
      const role = classifyPdfImageRole({
        width,
        height,
        pageWidth,
        pageHeight,
      })
      if (role) {
        imageCount += 1
        if (imageCount <= 20) {
          console.log(
            "raw page",
            pageNumber,
            role,
            "w",
            width.toFixed(0),
            "h",
            height.toFixed(0)
          )
        }
      }
    }
  }
}

console.log("\nraw classified images with wasm", imageCount)
await doc.destroy()
