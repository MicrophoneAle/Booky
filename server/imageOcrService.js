/**
 * Local OCR for chapter headers and section divider illustrations (no paid AI).
 * Uses tesseract.js + canvas preprocessing tuned for Stormlight-style graphics.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createCanvas, loadImage } from "@napi-rs/canvas/node-canvas.js"
import { createWorker } from "tesseract.js"

const OCR_DEBUG = process.env.BOOKY_OCR_DEBUG === "1"
const OCR_RECOGNIZE_TIMEOUT_MS = 45_000
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_TESSDATA_PATH = path.join(__dirname, "tessdata")
const BUNDLED_ENG_TRAINEDDATA = path.join(__dirname, "eng.traineddata")

let sharedWorkerPromise = null

function trainedDataArchiveExists(langDir) {
  return fs.existsSync(path.join(langDir, "eng.traineddata.gz"))
}

function resolveTesseractLangPath() {
  if (fs.existsSync(LOCAL_TESSDATA_PATH) && trainedDataArchiveExists(LOCAL_TESSDATA_PATH)) {
    return LOCAL_TESSDATA_PATH
  }

  if (trainedDataArchiveExists(__dirname)) {
    return __dirname
  }

  return null
}

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
      const langPath = resolveTesseractLangPath()
      if (!langPath) {
        logOcr("tessdata_missing")
        return null
      }

      try {
        const workerOptions = {
          langPath,
          ...(OCR_DEBUG ? { logger: (message) => console.log("[tesseract]", message) } : {}),
        }
        return await createWorker("eng", 1, workerOptions)
      } catch (error) {
        logOcr("worker_init_failed", {
          message: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    })()
  }

  return sharedWorkerPromise
}

async function terminateOcrWorker() {
  if (!sharedWorkerPromise) {
    return
  }

  try {
    const worker = await sharedWorkerPromise
    await worker.terminate()
  } catch {
    // Worker may already be terminated.
  } finally {
    sharedWorkerPromise = null
  }
}

function normalizeOcrLine(text) {
  return (text ?? "")
    .replace(/[|]/g, "I")
    .replace(/\s+/g, " ")
    .trim()
}

function otsuThreshold(grayValues) {
  const histogram = new Array(256).fill(0)
  for (const value of grayValues) {
    histogram[value] += 1
  }

  const total = grayValues.length
  if (total === 0) {
    return null
  }

  let sum = 0
  for (let index = 0; index < 256; index += 1) {
    sum += index * histogram[index]
  }

  let sumBackground = 0
  let weightBackground = 0
  let maxVariance = 0
  let threshold = 128

  for (let index = 0; index < 256; index += 1) {
    weightBackground += histogram[index]
    if (weightBackground === 0) {
      continue
    }

    const weightForeground = total - weightBackground
    if (weightForeground === 0) {
      break
    }

    sumBackground += index * histogram[index]
    const meanBackground = sumBackground / weightBackground
    const meanForeground = (sum - sumBackground) / weightForeground
    const variance =
      weightBackground *
      weightForeground *
      (meanBackground - meanForeground) *
      (meanBackground - meanForeground)

    if (variance > maxVariance) {
      maxVariance = variance
      threshold = index
    }
  }

  return threshold
}

function preprocessImageData(imageData) {
  const { data, width, height } = imageData
  const pixelCount = width * height
  const grayValues = new Uint8Array(pixelCount)
  let sum = 0

  for (let pixelIndex = 0, dataIndex = 0; pixelIndex < pixelCount; pixelIndex += 1, dataIndex += 4) {
    const gray =
      data[dataIndex] * 0.299 + data[dataIndex + 1] * 0.587 + data[dataIndex + 2] * 0.114
    grayValues[pixelIndex] = gray
    sum += gray
  }

  const mean = sum / pixelCount
  const invert = mean < 132
  if (invert) {
    for (let index = 0; index < pixelCount; index += 1) {
      grayValues[index] = 255 - grayValues[index]
    }
  }

  const threshold = otsuThreshold(grayValues) ?? 168
  const output = createCanvas(width, height).getContext("2d").createImageData(width, height)

  for (let pixelIndex = 0, dataIndex = 0; pixelIndex < pixelCount; pixelIndex += 1, dataIndex += 4) {
    const value = grayValues[pixelIndex] < threshold ? 0 : 255
    output.data[dataIndex] = value
    output.data[dataIndex + 1] = value
    output.data[dataIndex + 2] = value
    output.data[dataIndex + 3] = 255
  }

  return output
}

async function prepareScaledCanvas(imageBuffer, minWidth = 800) {
  const source = await loadImage(imageBuffer)
  const scale = Math.min(
    3.0,
    Math.max(1.5, minWidth / Math.max(1, source.width))
  )
  const width = Math.max(3, Math.round(source.width * scale))
  const height = Math.max(3, Math.round(source.height * scale))
  const canvas = createCanvas(width, height)
  const context = canvas.getContext("2d")

  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, width, height)
  context.drawImage(source, 0, 0, width, height)

  return canvas
}

function cropCanvasRegion(canvas, region, { preprocess = true } = {}) {
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

  if (preprocess) {
    const imageData = context.getImageData(0, 0, width, height)
    context.putImageData(preprocessImageData(imageData), 0, 0)
  }

  return cropCanvas.toBuffer("image/png")
}

async function recognizeBuffer(buffer, { psm = "7", whitelist = null } = {}) {
  const worker = await getOcrWorker()
  if (!worker) {
    return ""
  }
  const parameters = {
    tessedit_pageseg_mode: psm,
  }

  if (whitelist) {
    parameters.tessedit_char_whitelist = whitelist
  }

  await worker.setParameters(parameters)

  let timeoutId
  const recognizePromise = worker.recognize(buffer)
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("OCR recognize timed out"))
    }, OCR_RECOGNIZE_TIMEOUT_MS)
  })

  try {
    const { data } = await Promise.race([recognizePromise, timeoutPromise])
    return normalizeOcrLine(data.text)
  } finally {
    clearTimeout(timeoutId)
  }
}

async function recognizeRegion(scaledCanvas, region, options = {}) {
  return recognizeBuffer(cropCanvasRegion(scaledCanvas, region, { preprocess: true }), options)
}

function parseSectionLabelToken(token) {
  const trimmed = normalizeOcrLine(token).replace(/\.$/, "")
  if (!trimmed) {
    return null
  }

  if (/^PRELUDE$/i.test(trimmed)) {
    return { kind: "prelude", label: "Prelude" }
  }

  if (/^PROLOGUE$/i.test(trimmed)) {
    return { kind: "prologue", label: "Prologue" }
  }

  if (/^EPILOGUE$/i.test(trimmed)) {
    return { kind: "epilogue", label: "Epilogue" }
  }

  return null
}

function chapterNumberUsesDigits(number) {
  return /\d/.test(number?.label ?? "")
}

function parseChapterNumberToken(token, { hasDigitNumber = false } = {}) {
  const trimmed = normalizeOcrLine(token).replace(/\.$/, "")
  if (!trimmed) {
    return null
  }

  const sectionLabel = parseSectionLabelToken(trimmed)
  if (sectionLabel) {
    return sectionLabel
  }

  const interludeMatch = trimmed.match(/^I[\s\-–—]*(\d{1,2})$/i)
  if (interludeMatch) {
    return { kind: "interlude", label: `Interlude I-${interludeMatch[1]}` }
  }

  const dashInterludeMatch = trimmed.match(/^(\d)-(\d{1,2})$/)
  if (dashInterludeMatch) {
    return { kind: "interlude", label: `Interlude I-${dashInterludeMatch[2]}` }
  }

  if (/^\d{1,3}$/.test(trimmed)) {
    if (trimmed === "0" || trimmed === "00") {
      return null
    }
    const value = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(value) || value < 1 || value > 75) {
      return null
    }
    return { kind: "chapter", label: `Chapter ${trimmed}` }
  }

  if (!hasDigitNumber && /^[IVXLCDM]+$/i.test(trimmed)) {
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

  if (cleaned.length < 4 || cleaned.length > 60) {
    return false
  }

  const words = cleaned.split(" ").filter((word) => word.length > 0)
  if (words.length === 0 || words.length > 8) {
    return false
  }

  const longWords = words.filter((word) => word.replace(/[^A-Za-z]/g, "").length >= 4)
  if (longWords.length === 0) {
    return false
  }

  const shortWords = words.filter((word) => word.length <= 2)
  if (shortWords.length / words.length > 0.35) {
    return false
  }

  const alpha = cleaned.replace(/[^A-Za-z]/g, "")
  const longAlpha = longWords.join("").replace(/[^A-Za-z]/g, "")
  if (longAlpha.length < alpha.length * 0.65) {
    return false
  }

  for (const word of words) {
    const letters = word.replace(/[^A-Za-z]/g, "")
    if (letters.length >= 4 && !/[AEIOUaeiou]/.test(letters)) {
      return false
    }
  }

  const uppercaseLetters = alpha.replace(/[^A-Z]/g, "").length
  if (alpha.length >= 6 && uppercaseLetters < alpha.length * 0.45) {
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

function resolveBoundaryKind(number) {
  if (!number?.kind) {
    return "chapter"
  }

  if (
    number.kind === "interlude" ||
    number.kind === "prelude" ||
    number.kind === "prologue" ||
    number.kind === "epilogue"
  ) {
    return number.kind
  }

  return "chapter"
}

function buildChapterHeadingMetadata({ number, title }) {
  if (!number && !title) {
    return null
  }

  const boundaryKind = resolveBoundaryKind(number)

  return {
    boundaryKind,
    number: number?.label ?? null,
    title,
    rawText: [number?.label, title].filter(Boolean).join(": "),
  }
}

function parseChapterHeadingBannerText(bannerText) {
  const lines = bannerText
    .split(/\n/)
    .map((line) => normalizeOcrLine(line))
    .filter((line) => line.length > 0)

  let number = null
  let title = null

  for (const line of lines) {
    const parsedNumber = parseChapterNumberToken(line, {
      hasDigitNumber: chapterNumberUsesDigits(number),
    })
    if (parsedNumber) {
      if (chapterNumberUsesDigits(parsedNumber) || !number) {
        number = parsedNumber
      }
      continue
    }

    const parsedTitle = parseTitleLine(line)
    if (!title && parsedTitle) {
      title = parsedTitle
      continue
    }

    const inlineNumber = line.match(/^(\d{1,3})\s+(.+)$/)
    if (inlineNumber) {
      const parsedInline = parseChapterNumberToken(inlineNumber[1], {
        hasDigitNumber: chapterNumberUsesDigits(number),
      })
      if (parsedInline && (chapterNumberUsesDigits(parsedInline) || !number)) {
        number = parsedInline
      }
      if (!title) {
        title = parseTitleLine(inlineNumber[2])
      }
    }
  }

  return buildChapterHeadingMetadata({ number, title })
}

function resolveBestChapterNumberToken(...regionTexts) {
  const tokens = regionTexts
    .map((text) => normalizeOcrLine(text).replace(/\s+/g, ""))
    .filter((trimmed) => /^\d{1,3}$/.test(trimmed))
    .map((trimmed) => ({ trimmed, value: Number.parseInt(trimmed, 10) }))
    .filter(({ value }) => value >= 1 && value <= 75)

  if (tokens.length === 0) {
    return null
  }

  tokens.sort(
    (left, right) =>
      right.trimmed.length - left.trimmed.length || left.value - right.value
  )

  return tokens[0].trimmed
}

async function ocrChapterHeading(imageBuffer) {
  const scaledCanvas = await prepareScaledCanvas(imageBuffer, 900)
  const bannerRegion = { left: 0.04, top: 0, width: 0.92, height: 0.58 }
  const numberRegionWide = { left: 0.3, top: 0.01, width: 0.4, height: 0.14 }
  const numberRegionNarrow = { left: 0.38, top: 0.02, width: 0.24, height: 0.12 }

  const [bannerText, numberTextWide, numberTextNarrow] = await Promise.all([
    recognizeRegion(scaledCanvas, bannerRegion, { psm: "6" }),
    recognizeRegion(scaledCanvas, numberRegionWide, {
      psm: "7",
      whitelist: "0123456789IVXLCDM-I",
    }),
    recognizeRegion(scaledCanvas, numberRegionNarrow, {
      psm: "7",
      whitelist: "0123456789IVXLCDM-I",
    }),
  ])

  logOcr("chapter_heading_banner", { bannerText, numberTextWide, numberTextNarrow })

  const metadata = parseChapterHeadingBannerText(bannerText)
  const bestNumberToken = resolveBestChapterNumberToken(numberTextWide, numberTextNarrow)

  if (bestNumberToken) {
    const parsedNumber = parseChapterNumberToken(bestNumberToken)
    if (parsedNumber) {
      if (metadata) {
        metadata.number = parsedNumber.label
        metadata.rawText = [parsedNumber.label, metadata.title].filter(Boolean).join(": ")
        return metadata
      }

      return buildChapterHeadingMetadata({ number: parsedNumber, title: null })
    }
  }

  return metadata
}

async function ocrFullPageSection(imageBuffer) {
  const scaledCanvas = await prepareScaledCanvas(imageBuffer, 1100)
  const bodyRegion = { left: 0.06, top: 0.08, width: 0.88, height: 0.84 }

  const combined = await recognizeRegion(scaledCanvas, bodyRegion, {
    psm: "6",
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

function countInterludeNamesInDivider(ocrMetadata) {
  const title = (ocrMetadata?.title ?? "").trim()
  if (!title) {
    return 0
  }

  const names = title
    .split(/\s*[•·]\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)

  return names.length
}

export {
  ocrIllustrationMetadata,
  parseChapterNumberToken,
  parseSectionLabelToken,
  parsePartLabel,
  isPlausibleTitle,
  countInterludeNamesInDivider,
  terminateOcrWorker,
}
