/**
 * Local OCR for chapter headers and section divider illustrations (no paid AI).
 * Uses tesseract.js + canvas preprocessing tuned for Stormlight-style graphics.
 */

import { createCanvas, loadImage } from "@napi-rs/canvas/node-canvas.js"
import { createWorker } from "tesseract.js"

const OCR_DEBUG = process.env.BOOKY_OCR_DEBUG === "1"

let sharedWorkerPromise = null

const ROMAN_WORDS = new Set([
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
])

const PART_WORD_TO_NUMBER = {
  one: "One",
  two: "Two",
  three: "Three",
  four: "Four",
  five: "Five",
  six: "Six",
}

function logOcr(message, context = {}) {
  if (OCR_DEBUG) {
    console.log("[imageOcrService]", JSON.stringify({ message, ...context }))
  }
}

async function getOcrWorker() {
  if (!sharedWorkerPromise) {
    sharedWorkerPromise = (async () => {
      const worker = OCR_DEBUG
        ? await createWorker("eng", 1, {
            logger: (message) => console.log("[tesseract]", message),
          })
        : await createWorker("eng")
      return worker
    })()
  }

  return sharedWorkerPromise
}

function normalizeOcrLine(text) {
  return (text ?? "")
    .replace(/[|]/g, "I")
    .replace(/\s+/g, " ")
    .trim()
}

function binarizeImageData(imageData, threshold = 168) {
  const { data, width, height } = imageData
  const output = createCanvas(width, height).getContext("2d").createImageData(width, height)

  for (let index = 0; index < data.length; index += 4) {
    const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114
    const value = gray < threshold ? 0 : 255
    output.data[index] = value
    output.data[index + 1] = value
    output.data[index + 2] = value
    output.data[index + 3] = 255
  }

  return output
}

async function prepareScaledCanvas(imageBuffer, minWidth = 960) {
  const source = await loadImage(imageBuffer)
  const scale = Math.max(2, minWidth / Math.max(1, source.width))
  const width = Math.max(3, Math.round(source.width * scale))
  const height = Math.max(3, Math.round(source.height * scale))
  const canvas = createCanvas(width, height)
  const context = canvas.getContext("2d")

  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, width, height)
  context.drawImage(source, 0, 0, width, height)

  return canvas
}

function cropCanvasRegion(canvas, region, { binarize = true } = {}) {
  const sourceWidth = canvas.width
  const sourceHeight = canvas.height
  const x = Math.max(0, Math.round(sourceWidth * region.left))
  const y = Math.max(0, Math.round(sourceHeight * region.top))
  const width = Math.max(3, Math.round(sourceWidth * region.width))
  const height = Math.max(3, Math.round(sourceHeight * region.height))
  const cropCanvas = createCanvas(width, height)
  const context = cropCanvas.getContext("2d")

  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, width, height)
  context.drawImage(canvas, x, y, width, height, 0, 0, width, height)

  if (binarize) {
    const imageData = context.getImageData(0, 0, width, height)
    context.putImageData(binarizeImageData(imageData), 0, 0)
  }

  return cropCanvas.toBuffer("image/png")
}

async function recognizeBuffer(buffer, { psm = "7", whitelist = null } = {}) {
  const worker = await getOcrWorker()
  const parameters = {
    tessedit_pageseg_mode: psm,
  }

  if (whitelist) {
    parameters.tessedit_char_whitelist = whitelist
  }

  await worker.setParameters(parameters)
  const { data } = await worker.recognize(buffer)
  return normalizeOcrLine(data.text)
}

async function recognizeRegion(scaledCanvas, region, options = {}) {
  return recognizeBuffer(cropCanvasRegion(scaledCanvas, region, { binarize: true }), options)
}

function parseChapterNumberToken(token) {
  const trimmed = normalizeOcrLine(token).replace(/\.$/, "")
  if (!trimmed) {
    return null
  }

  const interludeMatch = trimmed.match(/^I[\s\-–—]*(\d{1,2})$/i)
  if (interludeMatch) {
    return { kind: "interlude", label: `Interlude I-${interludeMatch[1]}` }
  }

  if (/^\d{1,3}$/.test(trimmed)) {
    return { kind: "chapter", label: `Chapter ${trimmed}` }
  }

  if (/^[IVXLCDM]+$/i.test(trimmed)) {
    return { kind: "chapter", label: `Chapter ${trimmed.toUpperCase()}` }
  }

  const lower = trimmed.toLowerCase()
  if (ROMAN_WORDS.has(lower)) {
    const word = lower.charAt(0).toUpperCase() + lower.slice(1)
    return { kind: "chapter", label: `Chapter ${word}` }
  }

  return null
}

function isPlausibleTitle(text) {
  const cleaned = normalizeOcrLine(text)
    .replace(/[^A-Za-z0-9'\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (cleaned.length < 4) {
    return false
  }

  const letters = cleaned.replace(/[^A-Za-z]/g, "")
  if (letters.length < cleaned.length * 0.55) {
    return false
  }

  const words = cleaned.split(" ").filter((word) => word.length >= 2)
  if (words.length === 0) {
    return false
  }

  if (words.every((word) => word.length <= 2)) {
    return false
  }

  return true
}

function parseTitleLine(text) {
  const cleaned = normalizeOcrLine(text)
    .replace(/[^A-Za-z0-9'\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (!isPlausibleTitle(cleaned)) {
    return null
  }

  if (/^(chapter|part|interlude|interludes)$/i.test(cleaned)) {
    return null
  }

  if (/^I[\s\-–—]*\d+$/i.test(cleaned)) {
    return null
  }

  if (/^\d{1,3}$/.test(cleaned)) {
    return null
  }

  return cleaned
}

function parsePartLabel(text) {
  const match = normalizeOcrLine(text).match(
    /^PART\s+(ONE|TWO|THREE|FOUR|FIVE|SIX|\d+|[IVXLCDM]+)\b/i
  )
  if (!match) {
    return null
  }

  const token = match[1]
  const word = token.toLowerCase()
  const label = PART_WORD_TO_NUMBER[word] ?? token.toUpperCase()
  return `Part ${label}`
}

function parseInterludesDivider(text) {
  return /\bINTERLUDES?\b/i.test(text) ? "Interludes" : null
}

function parseCharacterList(text) {
  const cleaned = normalizeOcrLine(text)
  if (!cleaned.includes("•") && !cleaned.includes("·")) {
    return null
  }

  const names = cleaned
    .split(/\s*[•·]\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3 && /^[A-Z]/.test(part))

  return names.length > 0 ? names.join(" · ") : null
}

function parseChapterHeadingBannerText(bannerText) {
  const lines = bannerText
    .split(/\n/)
    .map((line) => normalizeOcrLine(line))
    .filter((line) => line.length > 0)

  let number = null
  let title = null

  for (const line of lines) {
    const parsedNumber = parseChapterNumberToken(line)
    if (!number && parsedNumber) {
      number = parsedNumber
      continue
    }

    const parsedTitle = parseTitleLine(line)
    if (!title && parsedTitle) {
      title = parsedTitle
      continue
    }

    const inlineNumber = line.match(/^(\d{1,3})\s+(.+)$/)
    if (!number && inlineNumber) {
      number = parseChapterNumberToken(inlineNumber[1])
      if (!title) {
        title = parseTitleLine(inlineNumber[2])
      }
    }
  }

  if (!number && !title) {
    return null
  }

  const boundaryKind = number?.kind === "interlude" ? "interlude" : "chapter"

  return {
    boundaryKind,
    number: number?.label ?? null,
    title,
    rawText: [number?.label, title].filter(Boolean).join(": "),
  }
}

async function ocrChapterHeading(imageBuffer) {
  const scaledCanvas = await prepareScaledCanvas(imageBuffer, 1100)
  const bannerRegion = { left: 0.04, top: 0, width: 0.92, height: 0.58 }

  const bannerText = await recognizeRegion(scaledCanvas, bannerRegion, {
    psm: "6",
    minLength: 2,
  })

  logOcr("chapter_heading_banner", { bannerText })

  return parseChapterHeadingBannerText(bannerText)
}

async function ocrFullPageSection(imageBuffer) {
  const scaledCanvas = await prepareScaledCanvas(imageBuffer, 1400)
  const bodyRegion = { left: 0.06, top: 0.08, width: 0.88, height: 0.84 }

  const combined = await recognizeRegion(scaledCanvas, bodyRegion, {
    psm: "6",
    minLength: 4,
  })

  logOcr("full_page_body", { combined })

  const interludes = parseInterludesDivider(combined)
  if (interludes) {
    return {
      boundaryKind: "interlude_divider",
      number: interludes,
      title: parseCharacterList(combined),
      rawText: combined,
    }
  }

  const partLabel = parsePartLabel(combined)
  if (partLabel) {
    const subtitle =
      parseTitleLine(
        combined
          .replace(/^PART\s+\w+/i, "")
          .replace(/\bINTERLUDES?\b/i, "")
          .trim()
      ) ?? null
    return {
      boundaryKind: "part",
      number: partLabel,
      title: subtitle,
      rawText: combined,
    }
  }

  return null
}

/**
 * @param {Buffer} imageBuffer
 * @param {"chapter_heading"|"full_page_illustration"|null} imageRole
 * @returns {Promise<{ boundaryKind: string, number: string|null, title: string|null, rawText: string|null }|null>}
 */
async function ocrIllustrationMetadata(imageBuffer, imageRole) {
  if (!imageBuffer?.length || !imageRole) {
    return null
  }

  try {
    if (imageRole === "chapter_heading") {
      return await ocrChapterHeading(imageBuffer)
    }

    if (imageRole === "full_page_illustration") {
      return await ocrFullPageSection(imageBuffer)
    }
  } catch (error) {
    logOcr("ocr_failed", {
      imageRole,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  return null
}

export { ocrIllustrationMetadata, parseChapterNumberToken, parsePartLabel }
