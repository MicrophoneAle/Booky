import PDFDocument from "pdfkit"

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

async function fetchImageBuffer(src, cache) {
  if (!src || cache.has(src)) {
    return cache.get(src) ?? null
  }

  try {
    const response = await fetch(src)
    if (!response.ok) {
      cache.set(src, null)
      return null
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    cache.set(src, buffer)
    return buffer
  } catch {
    cache.set(src, null)
    return null
  }
}

async function prefetchExportImages(content) {
  const cache = new Map()
  const imageSrcs = new Set()

  for (const block of iterateContentBlocks(content)) {
    if (block.type === "image" && typeof block.src === "string" && block.src.trim()) {
      imageSrcs.add(block.src.trim())
    }
  }

  await Promise.all(
    [...imageSrcs].map((src) => fetchImageBuffer(src, cache))
  )

  return cache
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
  const maxWidth = contentWidth(doc)
  const maxHeight = doc.page.height * 0.55
  ensureVerticalSpace(doc, maxHeight + 24)
  doc.moveDown(0.5)
  doc.image(buffer, {
    fit: [maxWidth, maxHeight],
    align: "center",
  })
  doc.moveDown(0.75)
}

function renderPdfTextBlock(doc, block, { previousWasHeading }) {
  const text = (block.text ?? "").trim()
  if (!text) {
    return { previousWasHeading: false }
  }

  const isCentered = block.textAlign === "center" || block.centered === true

  if (block.isHeading) {
    ensureVerticalSpace(doc, 48)
    doc.moveDown(1)
    doc
      .font("Times-Bold")
      .fontSize((block.fontSize ?? 0) >= 18 ? 20 : 16)
      .text(text, { align: "center" })
    doc.moveDown(0.5)
    doc.font("Times-Roman").fontSize(12)
    return { previousWasHeading: true }
  }

  if (isCentered) {
    ensureVerticalSpace(doc, 24)
    doc.moveDown(0.35)
    doc.font("Times-Roman").fontSize(12).text(text, { align: "center" })
    doc.moveDown(0.35)
    return { previousWasHeading: false }
  }

  const indent = block.isIndented ? 36 : previousWasHeading ? 0 : 18
  doc.font("Times-Roman").fontSize(12).text(text, {
    align: "justify",
    indent,
    paragraphGap: 6,
    lineGap: 2,
  })

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
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      info: {
        Title: name || "Document",
      },
    })

    const chunks = []
    doc.on("data", (chunk) => chunks.push(chunk))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    doc.font("Times-Roman").fontSize(12)

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
  })
}
