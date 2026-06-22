import PDFDocument from "pdfkit"
import { createCanvas, loadImage } from "@napi-rs/canvas/node-canvas.js"

const PDF_IMAGE_MAX_DIMENSION = 1200
const PDF_IMAGE_FETCH_CONCURRENCY = 6

function escapeHtmlText(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function escapeHtmlAttr(text) {
  return escapeHtmlText(text).replace(/"/g, "&quot;")
}

function renderBlockInlineHtml(block) {
  if (Array.isArray(block.runs) && block.runs.length > 1) {
    return block.runs
      .map((run) => {
        let html = escapeHtmlText(run.text ?? "")
        if (run.bold) html = `<strong>${html}</strong>`
        if (run.italic) html = `<em>${html}</em>`
        return html
      })
      .join("")
  }

  let html = escapeHtmlText(block.text ?? "")
  if (block.bold) html = `<strong>${html}</strong>`
  if (block.italic) html = `<em>${html}</em>`
  return html
}

function* iterateContentBlocks(content) {
  const pages = Array.isArray(content) ? content : []
  for (const page of pages) {
    for (const block of page.blocks ?? []) {
      yield block
    }
  }
}

function renderImageFigureHtml(block) {
  const src = typeof block.src === "string" ? block.src.trim() : ""
  if (!src) {
    return ""
  }

  const caption = block.chapterMetadata?.title?.trim()
  const captionHtml = caption
    ? `<figcaption>${escapeHtmlText(caption)}</figcaption>`
    : ""

  return `<figure class="illustration">
<img src="${escapeHtmlAttr(src)}" alt="" loading="lazy" />
${captionHtml}
</figure>`
}

export function buildReformattedHtml(name, content) {
  const safeTitle = escapeHtmlText(name || "Document")
  const parts = []
  let previousWasHeading = false
  let lastProseIndex = -1

  for (const block of iterateContentBlocks(content)) {
    if (block.type === "image") {
      const figureHtml = renderImageFigureHtml(block)
      if (figureHtml) {
        parts.push(figureHtml)
        previousWasHeading = false
        lastProseIndex = -1
      }
      continue
    }

    const text = (block.text ?? "").trim()
    if (!text) {
      continue
    }

    const isCentered = block.textAlign === "center" || block.centered === true

    if (block.isHeading) {
      const tag = (block.fontSize ?? 0) >= 18 ? "h1" : "h2"
      parts.push(`<${tag}>${renderBlockInlineHtml(block)}</${tag}>`)
      previousWasHeading = true
      lastProseIndex = -1
      continue
    }

    if (isCentered) {
      parts.push(`<p class="center">${renderBlockInlineHtml(block)}</p>`)
      previousWasHeading = false
      lastProseIndex = -1
      continue
    }

    if (block.isContinuation && lastProseIndex >= 0) {
      parts[lastProseIndex] = parts[lastProseIndex].replace(
        /<\/p>$/,
        ` ${renderBlockInlineHtml(block)}</p>`
      )
      continue
    }

    const classes = [previousWasHeading ? "first" : "body"]
    if (block.isIndented) {
      classes.push("indent")
    }
    parts.push(`<p class="${classes.join(" ")}">${renderBlockInlineHtml(block)}</p>`)
    lastProseIndex = parts.length - 1
    previousWasHeading = false
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    background: #f4efe6;
    color: #1c1917;
    font-family: "Georgia", "Times New Roman", serif;
    line-height: 1.6;
  }
  main {
    max-width: 40rem;
    margin: 0 auto;
    padding: 3rem 1.5rem 5rem;
  }
  h1 {
    font-size: 1.9rem;
    margin: 2.5rem 0 1rem;
    line-height: 1.2;
  }
  h2 {
    font-size: 1.35rem;
    margin: 2rem 0 0.75rem;
    line-height: 1.25;
  }
  p {
    margin: 0;
    text-align: justify;
    hyphens: auto;
  }
  p.body { text-indent: 1.5em; }
  p.first { text-indent: 0; }
  p.indent {
    text-indent: 0;
    margin-left: 2em;
  }
  p.center {
    text-align: center;
    text-indent: 0;
    margin: 0.6rem 0;
    letter-spacing: 0.04em;
  }
  figure.illustration {
    margin: 1.75rem 0;
    text-align: center;
  }
  figure.illustration img {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
  }
  figure.illustration figcaption {
    margin-top: 0.5rem;
    font-size: 0.9rem;
    font-style: italic;
    color: #57534e;
  }
</style>
</head>
<body>
<main>
${parts.join("\n")}
</main>
</body>
</html>`
}

async function fetchRawImageBuffer(src) {
  if (!src) {
    return null
  }

  if (src.startsWith("data:")) {
    const match = src.match(/^data:image\/[^;]+;base64,(.+)$/i)
    if (!match) {
      return null
    }
    try {
      return Buffer.from(match[1], "base64")
    } catch {
      return null
    }
  }

  try {
    const response = await fetch(src)
    if (!response.ok) {
      return null
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length) {
      return null
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
    if (contentType.includes("text/html") || contentType.includes("application/json")) {
      return null
    }

    return buffer
  } catch {
    return null
  }
}

async function normalizeImageForPdf(buffer) {
  if (!buffer?.length) {
    return null
  }

  try {
    const image = await loadImage(buffer)
    let { width, height } = image
    const maxDim = PDF_IMAGE_MAX_DIMENSION

    if (width > maxDim || height > maxDim) {
      const scale = maxDim / Math.max(width, height)
      width = Math.max(1, Math.round(width * scale))
      height = Math.max(1, Math.round(height * scale))
    }

    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext("2d")
    ctx.drawImage(image, 0, 0, width, height)
    return canvas.toBuffer("image/jpeg", { quality: 0.88 })
  } catch {
    return null
  }
}

async function fetchImageBuffer(src, cache) {
  if (!src || cache.has(src)) {
    return cache.get(src) ?? null
  }

  const raw = await fetchRawImageBuffer(src)
  const normalized = raw ? await normalizeImageForPdf(raw) : null
  cache.set(src, normalized)
  return normalized
}

async function prefetchExportImages(content) {
  const cache = new Map()
  const imageSrcs = new Set()

  for (const block of iterateContentBlocks(content)) {
    if (block.type === "image" && typeof block.src === "string" && block.src.trim()) {
      imageSrcs.add(block.src.trim())
    }
  }

  const uniqueSrcs = [...imageSrcs]
  if (uniqueSrcs.length === 0) {
    return cache
  }

  let nextIndex = 0
  const workerCount = Math.min(PDF_IMAGE_FETCH_CONCURRENCY, uniqueSrcs.length)

  async function worker() {
    while (nextIndex < uniqueSrcs.length) {
      const src = uniqueSrcs[nextIndex]
      nextIndex += 1
      await fetchImageBuffer(src, cache)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return cache
}

function sanitizePdfText(text) {
  return String(text ?? "")
    .replace(/\0/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, "")
}

function assertValidPdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 128) {
    throw new Error("Generated PDF is empty or too small")
  }

  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("Generated PDF has an invalid header")
  }

  const trailer = buffer.subarray(Math.max(0, buffer.length - 1024)).toString("ascii")
  if (!trailer.includes("%%EOF")) {
    throw new Error("Generated PDF is missing an EOF marker")
  }
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right
}

function ensureVerticalSpace(doc, heightNeeded) {
  const bottom = doc.page.height - doc.page.margins.bottom
  if (doc.y + heightNeeded > bottom) {
    doc.addPage()
  }
}

function renderPdfImage(doc, buffer) {
  try {
    const maxWidth = contentWidth(doc)
    const maxHeight = doc.page.height * 0.55
    const imageInfo = doc.openImage(buffer)
    let width = imageInfo.width
    let height = imageInfo.height
    const scale = Math.min(maxWidth / width, maxHeight / height, 1)
    width = Math.max(1, Math.round(width * scale))
    height = Math.max(1, Math.round(height * scale))

    ensureVerticalSpace(doc, height + 24)
    doc.moveDown(0.5)
    const x = doc.page.margins.left + (maxWidth - width) / 2
    const y = doc.y
    doc.image(buffer, x, y, { width, height })
    doc.y = y + height + 12
  } catch (error) {
    console.warn(
      "[reformattedExport] Skipping illustration:",
      error instanceof Error ? error.message : String(error)
    )
  }
}

function renderPdfTextBlock(doc, block, { previousWasHeading }) {
  const text = sanitizePdfText(block.text).trim()
  if (!text) {
    return { previousWasHeading: false }
  }

  const isCentered = block.textAlign === "center" || block.centered === true

  try {
    if (block.isHeading) {
      ensureVerticalSpace(doc, 48)
      doc.moveDown(1)
      doc
        .font("Helvetica-Bold")
        .fontSize((block.fontSize ?? 0) >= 18 ? 20 : 16)
        .text(text, { align: "center" })
      doc.moveDown(0.5)
      doc.font("Helvetica").fontSize(12)
      return { previousWasHeading: true }
    }

    if (isCentered) {
      ensureVerticalSpace(doc, 24)
      doc.moveDown(0.35)
      doc.font("Helvetica").fontSize(12).text(text, { align: "center" })
      doc.moveDown(0.35)
      return { previousWasHeading: false }
    }

    const indent = block.isIndented ? 36 : previousWasHeading ? 0 : 18
    doc.font("Helvetica").fontSize(12).text(text, {
      align: "justify",
      indent,
      paragraphGap: 6,
      lineGap: 2,
    })
  } catch (error) {
    console.warn(
      "[reformattedExport] Skipping text block:",
      error instanceof Error ? error.message : String(error)
    )
  }

  return { previousWasHeading: false }
}

function flattenExportBlocks(content) {
  const flattened = []

  for (const block of iterateContentBlocks(content)) {
    if (block.type === "image") {
      flattened.push({ kind: "image", block })
      continue
    }

    const text = (block.text ?? "").trim()
    if (!text) {
      continue
    }

    if (block.isContinuation && flattened.length > 0) {
      const last = flattened[flattened.length - 1]
      if (last.kind === "text") {
        last.block = {
          ...last.block,
          text: `${(last.block.text ?? "").trim()} ${text}`,
        }
        continue
      }
    }

    flattened.push({ kind: "text", block: { ...block, text } })
  }

  return flattened
}

export async function buildReformattedPdfBuffer(name, content) {
  const imageCache = await prefetchExportImages(content)
  const flattened = flattenExportBlocks(content)

  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (handler, value) => {
      if (settled) {
        return
      }
      settled = true
      handler(value)
    }

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      autoFirstPage: true,
      info: {
        Title: sanitizePdfText(name || "Document"),
      },
    })

    const chunks = []
    doc.on("data", (chunk) => chunks.push(chunk))
    doc.on("error", (error) => settle(reject, error))
    doc.on("end", () => {
      try {
        const buffer = Buffer.concat(chunks)
        assertValidPdfBuffer(buffer)
        settle(resolve, buffer)
      } catch (error) {
        settle(reject, error)
      }
    })

    try {
      doc.font("Helvetica").fontSize(12)

      let previousWasHeading = false

      for (const item of flattened) {
        if (item.kind === "image") {
          const src =
            typeof item.block.src === "string" ? item.block.src.trim() : ""
          const buffer = src ? imageCache.get(src) : null
          if (buffer) {
            renderPdfImage(doc, buffer)
          }
          previousWasHeading = false
          continue
        }

        const state = renderPdfTextBlock(doc, item.block, { previousWasHeading })
        previousWasHeading = state.previousWasHeading
      }

      doc.end()
    } catch (error) {
      settle(reject, error)
    }
  })
}
