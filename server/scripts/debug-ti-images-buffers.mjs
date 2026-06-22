import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getDocument, OPS, ImageKind } from "pdfjs-dist/legacy/build/pdf.mjs"
import { createCanvas } from "@napi-rs/canvas/node-canvas.js"
import { classifyPdfImageRole } from "../pdfImageRoleUtils.js"

const require = createRequire(import.meta.url)
const PDFJS_DIST_DIR = path.dirname(require.resolve("pdfjs-dist/package.json"))

const buffer = readFileSync(
  path.join(fileURLToPath(new URL(".", import.meta.url)), "../../client/src/assets/Treasure Island.pdf")
)

function isJpeg(buf) {
  return buf?.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8
}

function isPng(buf) {
  return buf?.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50
}

function multiplyTransform(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

function metricsFromTransform(transform, pageWidth, pageHeight) {
  return {
    x: transform[4],
    y: transform[5],
    width: Math.hypot(transform[0], transform[1]),
    height: Math.hypot(transform[2], transform[3]),
    pageWidth,
    pageHeight,
  }
}

async function resolveImageObject(page, pdf, refId) {
  const pools = [page.objs, page.commonObjs, pdf?.commonObjs].filter(Boolean)
  let lastError = null

  for (const pool of pools) {
    try {
      if (typeof pool.has === "function" && pool.has(refId)) {
        return pool.get(refId)
      }
    } catch {
      // Fall through to callback-based wait.
    }

    try {
      const data = await new Promise((resolve, reject) => {
        let settled = false
        const timeoutId = setTimeout(() => {
          if (settled) return
          settled = true
          reject(new Error(`Image resolve timed out for ${refId}`))
        }, PDF_IMAGE_RESOLVE_TIMEOUT_MS)

        pool.get(refId, (value) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutId)
          if (value != null) {
            resolve(value)
          } else {
            reject(new Error(`Image object ${refId} returned empty data`))
          }
        })
      })
      if (data) {
        return data
      }
    } catch (error) {
      lastError = error
    }
  }

  if (lastError) {
    throw lastError
  }

  return null
}

function tryExtractBuffer(imageObject) {
  const sources = [
    imageObject?.srcData,
    imageObject?.currentSrc,
    imageObject?.bytes,
    imageObject?.data,
  ]
  for (const source of sources) {
    if (!source) continue
    const buf = Buffer.isBuffer(source)
      ? source
      : source instanceof Uint8Array
        ? Buffer.from(source)
        : null
    if (buf?.length) {
      return { buf, kind: isJpeg(buf) ? "jpeg" : isPng(buf) ? "png" : "other" }
    }
  }
  return { buf: null, kind: imageObject?.kind ?? "unknown" }
}

const pdf = await getDocument({
  data: new Uint8Array(buffer),
  disableFontFace: true,
  useWorkerFetch: false,
  wasmUrl: `${path.join(PDFJS_DIST_DIR, "wasm").replace(/\\/g, "/")}/`,
  standardFontDataUrl: `${path.join(PDFJS_DIST_DIR, "standard_fonts").replace(/\\/g, "/")}/`,
}).promise

let loggedFailure = 0
const stats = {
  paintOps: 0,
  withRole: 0,
  resolved: 0,
  withBuffer: 0,
  jpeg: 0,
  png: 0,
  rawPixel: 0,
  failed: 0,
  kinds: {},
}

for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const operatorList = await page.getOperatorList({ intent: "display" })
  let transform = [1, 0, 0, 1, 0, 0]
  const stack = []

  for (let i = 0; i < operatorList.fnArray.length; i += 1) {
    const op = operatorList.fnArray[i]
    const args = operatorList.argsArray[i]
    if (op === OPS.save) {
      stack.push([...transform])
      continue
    }
    if (op === OPS.restore) {
      transform = stack.pop() ?? [1, 0, 0, 1, 0, 0]
      continue
    }
    if (op === OPS.transform) {
      transform = multiplyTransform(transform, args)
      continue
    }
    if (op !== OPS.paintImageXObject && op !== OPS.paintInlineImageXObject) {
      continue
    }

    stats.paintOps += 1
    const metrics = metricsFromTransform(transform, viewport.width, viewport.height)
    const role = classifyPdfImageRole(metrics)
    if (!role) continue
    stats.withRole += 1

    try {
      const imageObject =
        op === OPS.paintInlineImageXObject ? args?.[0] : await resolveImageObject(page, pdf, args?.[0])
      if (!imageObject) {
        stats.failed += 1
        if (loggedFailure < 5) {
          loggedFailure += 1
          console.log("null object page", pageNumber, args?.[0])
        }
        continue
      }
      stats.resolved += 1
      const { buf, kind } = tryExtractBuffer(imageObject)
      stats.kinds[kind] = (stats.kinds[kind] ?? 0) + 1
      if (buf?.length) {
        stats.withBuffer += 1
        if (kind === "jpeg") stats.jpeg += 1
        if (kind === "png") stats.png += 1
      } else if (imageObject?.data?.length) {
        stats.rawPixel += 1
      } else {
        stats.failed += 1
        if (pageNumber <= 30 && stats.failed <= 5) {
          console.log("fail sample page", pageNumber, {
            role,
            imgKind: imageObject?.kind,
            width: imageObject?.width,
            height: imageObject?.height,
            dataLen: imageObject?.data?.length,
            filter: imageObject?.filter,
            keys: imageObject ? Object.keys(imageObject) : [],
          })
        }
      }
    } catch (error) {
      stats.failed += 1
      if (loggedFailure < 5) {
        loggedFailure += 1
        console.log("resolve error page", pageNumber, args?.[0], error.message)
      }
    }
  }

  page.cleanup()
}

console.log(stats)
await pdf.destroy()
