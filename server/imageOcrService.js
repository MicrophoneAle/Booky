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
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_TESSDATA_PATH = path.join(__dirname, "tessdata")
const BUNDLED_ENG_TRAINEDDATA = path.join(__dirname, "eng.traineddata")

let sharedWorkerPromise = null

function resolveTesseractLangPath() {
  if (fs.existsSync(LOCAL_TESSDATA_PATH)) {
    return LOCAL_TESSDATA_PATH
  }

  if (fs.existsSync(BUNDLED_ENG_TRAINEDDATA)) {
    return __dirname
  }

  return undefined
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
      const workerOptions = {
        ...(langPath ? { langPath } : {}),
        ...(OCR_DEBUG ? { logger: (message) => console.log("[tesseract]", message) } : {}),
      }
      const worker = await createWorker("eng", 1, workerOptions)
      return worker
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

function parseChapterNumberToken(token) {
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

  if (/^\d{1,2}$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10)
    if (parsed >= 1 && parsed <= 75) {
      return { kind: "chapter", label: `Chapter ${parsed}` }
    }
  }

  const lower = trimmed.toLowerCase()
  if (ROMAN_WORDS.has(lower)) {
    const word = lower.charAt(0).toUpperCase() + lower.slice(1)
    return { kind: "chapter", label: `Chapter ${word}` }
  }

  return null
}

const OCR_TITLE_STOP_WORDS = new Set([
  "THE",
  "AND",
  "FOR",
  "OF",
  "TO",
  "IN",
  "A",
  "AN",
  "OR",
  "AT",
  "BY",
  "ON",
  "AS",
  "IS",
  "IT",
  "BE",
  "HE",
  "SHE",
  "WE",
  "ME",
  "MY",
  "LE",
  "EL",
  "EE",
  "TY",
  "SA",
  "OM",
  "FR",
  "NP",
  "BCA",
  "MA",
  "FAE",
  "OS",
  "AW",
  "AE",
  "AR",
  "ENA",
  "NAN",
  "BAC",
  "VU",
  "BN",
  "JA",
  "ZZ",
  "NS",
  "GI",
  "PAN",
  "RE",
  "ARS",
  "BWI",
  "AEP",
  "LIA",
  "FA",
  "OE",
  "BA",
  "ND",
  "PR",
  "NL",
  "SY",
  "CL",
  "LO",
  "BEEN",
  "HEXEN",
  "OER",
  "BRIDGEFOUR",
  "STORMLIGHT",
  "ARCHIVE",
  "SANDERSON",
  "PART",
  "CHAPTER",
  "INTERLUDE",
  "INTERLUDES",
  "PRELUDE",
  "PROLOGUE",
  "EPILOGUE",
])

function trimTitleNoiseWords(title) {
  const words = (title ?? "").split(/\s+/).filter(Boolean)
  if (words.length <= 1) {
    return title
  }

  const kept = []
  for (const word of words) {
    const previous = kept[kept.length - 1] ?? ""
    if (
      kept.length >= 2 &&
      word.length <= 4 &&
      previous.length >= 5 &&
      !TITLE_CONNECTOR_WORDS.has(word.toUpperCase())
    ) {
      break
    }

    kept.push(word)
  }

  return kept.join(" ")
}

function titleCaseBannerTitle(text) {
  const trimmed = (text ?? "").replace(/\s+/g, " ").trim()
  if (!trimmed) {
    return null
  }

  return trimmed
    .toLowerCase()
    .split(/\s+/)
    .map((word) => {
      if (/^i{1,3}$/i.test(word)) {
        return word.toUpperCase()
      }
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(" ")
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

  const meaningfulWords = words.filter((word) => !OCR_TITLE_STOP_WORDS.has(word.toUpperCase()))
  if (meaningfulWords.length === 0) {
    return false
  }

  const longWords = meaningfulWords.filter(
    (word) => word.replace(/[^A-Za-z]/g, "").length >= 4
  )
  const meaningfulAlpha = meaningfulWords.join("").replace(/[^A-Za-z]/g, "")
  if (longWords.length === 0 && meaningfulAlpha.length < 7) {
    return false
  }

  const shortWords = words.filter((word) => word.length <= 2)
  if (shortWords.length / words.length > 0.45) {
    return false
  }

  const alpha = cleaned.replace(/[^A-Za-z]/g, "")
  if (longWords.length > 0) {
    const longAlpha = longWords.join("").replace(/[^A-Za-z]/g, "")
    if (longAlpha.length < alpha.length * 0.45) {
      return false
    }
  }

  for (const word of longWords) {
    const letters = word.replace(/[^A-Za-z]/g, "")
    if (letters.length >= 5 && !/[AEIOUaeiou]/i.test(letters)) {
      return false
    }
  }

  const uppercaseLetters = alpha.replace(/[^A-Z]/g, "").length
  if (alpha.length >= 6 && uppercaseLetters < alpha.length * 0.35) {
    return false
  }

  return true
}

const TITLE_CONNECTOR_WORDS = new Set(["OF", "THE", "A", "AN", "AND", "IN", "ON", "TO"])

function extractUppercaseTitleRuns(text) {
  const normalized = normalizeOcrLine(text).replace(/[^A-Za-z0-9'\-\s]/g, " ")
  const regexRuns =
    normalized.match(/\b(?:[A-Z][A-Z'\-]{2,})(?:\s+(?:[A-Z][A-Z'\-]{2,}))*\b/g) ?? []

  const tokenRuns = []
  const tokens = normalized.split(/\s+/).filter(Boolean)
  let current = []

  for (const token of tokens) {
    const upper = token.toUpperCase()
    const isCapsToken = /^[A-Z][A-Z'\-]*$/.test(upper) && upper.length >= 2

    if (isCapsToken && (upper.length >= 3 || TITLE_CONNECTOR_WORDS.has(upper))) {
      if (TITLE_CONNECTOR_WORDS.has(upper) && current.length === 0) {
        continue
      }
      current.push(upper)
      continue
    }

    if (current.length > 0) {
      tokenRuns.push(current.join(" "))
      current = []
    }
  }

  if (current.length > 0) {
    tokenRuns.push(current.join(" "))
  }

  return [...regexRuns, ...tokenRuns]
    .map((run) => run.replace(/\s+/g, " ").trim())
    .filter((run) => run.length >= 4)
}

function scoreTitleCandidate(candidate) {
  const words = candidate.split(/\s+/).filter(Boolean)
  const contentWords = words.filter(
    (word) => !TITLE_CONNECTOR_WORDS.has(word.toUpperCase())
  )
  if (contentWords.length === 0) {
    return 0
  }

  const alpha = candidate.replace(/[^A-Za-z]/g, "")
  const uppercaseRatio = alpha.length > 0 ? alpha.replace(/[^A-Z]/g, "").length / alpha.length : 0
  let score = candidate.length

  if (contentWords.length >= 2) {
    score += 14
  }

  if (contentWords.some((word) => word.length >= 6)) {
    score += 10
  }

  if (uppercaseRatio >= 0.7) {
    score += 8
  }

  if (candidate.length >= 8 && candidate.length <= 40) {
    score += 6
  }

  return score
}

function pickBestTitleCandidate(candidates) {
  const ranked = [...new Set(candidates)]
    .map((candidate) => ({
      candidate,
      score: scoreTitleCandidate(candidate),
    }))
    .filter((entry) => entry.score > 0 && isPlausibleTitle(entry.candidate))
    .sort((left, right) => right.score - left.score)

  return ranked[0]?.candidate ?? null
}

function extractTitleFromNoisyOcr(...texts) {
  const candidates = []

  for (const text of texts) {
    if (!text) {
      continue
    }

    for (const line of text.split(/\n+/)) {
      const parsed = parseTitleLine(line)
      if (parsed) {
        candidates.push(parsed)
      }
    }

    candidates.push(...extractUppercaseTitleRuns(text))
  }

  const best = pickBestTitleCandidate(candidates)
  return best ? trimTitleNoiseWords(titleCaseBannerTitle(best)) : null
}

function extractPlaqueChapterNumber(numberText) {
  const compact = normalizeOcrLine(numberText).replace(/\s+/g, "")
  if (!compact) {
    return null
  }

  const digitMatch = compact.match(/^(\d{1,2})$/)
  if (digitMatch) {
    const parsed = Number.parseInt(digitMatch[1], 10)
    if (parsed >= 1 && parsed <= 75) {
      return { kind: "chapter", label: `Chapter ${parsed}` }
    }
  }

  return null
}

function extractSectionLabelFromText(text) {
  const combined = normalizeOcrLine(text)
  if (!combined) {
    return null
  }

  if (/\bPRELUDE\b/i.test(combined)) {
    return { kind: "prelude", label: "Prelude" }
  }

  if (/\bPROLOGUE\b/i.test(combined)) {
    return { kind: "prologue", label: "Prologue" }
  }

  if (/\bEPILOGUE\b/i.test(combined)) {
    return { kind: "epilogue", label: "Epilogue" }
  }

  const interludeMatch = combined.match(/\bI[\s\-–—]*(\d{1,2})\b/i)
  if (interludeMatch) {
    return { kind: "interlude", label: `Interlude I-${interludeMatch[1]}` }
  }

  for (const token of combined.split(/\s+/)) {
    const sectionLabel = parseSectionLabelToken(token)
    if (sectionLabel) {
      return sectionLabel
    }
  }

  return null
}

function extractLooseChapterNumber(numberText, ...fallbackTexts) {
  const plaqueNumber = extractPlaqueChapterNumber(numberText)
  if (plaqueNumber) {
    return plaqueNumber
  }

  for (const text of fallbackTexts) {
    const sectionLabel = extractSectionLabelFromText(text)
    if (sectionLabel) {
      return sectionLabel
    }
  }

  return null
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

function parseChapterHeadingFromOcrTexts({
  numberText = "",
  titleText = "",
  sectionText = "",
  bannerText = "",
} = {}) {
  let number = extractLooseChapterNumber(numberText, sectionText, bannerText)
  let title = extractTitleFromNoisyOcr(titleText, sectionText, bannerText)

  if (!title) {
    title = extractTitleFromNoisyOcr(bannerText)
  }

  return buildChapterHeadingMetadata({ number, title })
}

function parseChapterHeadingBannerText(bannerText) {
  return parseChapterHeadingFromOcrTexts({ bannerText })
}

async function ocrChapterHeading(imageBuffer) {
  const scaledCanvas = await prepareScaledCanvas(imageBuffer, 1400)
  const numberRegion = { left: 0.38, top: 0.03, width: 0.24, height: 0.14 }
  const numberRegionWide = { left: 0.3, top: 0.02, width: 0.4, height: 0.18 }
  const titleRegion = { left: 0.05, top: 0.2, width: 0.9, height: 0.36 }
  const sectionRegion = { left: 0.08, top: 0.18, width: 0.84, height: 0.42 }
  const bannerRegion = { left: 0.04, top: 0, width: 0.92, height: 0.58 }

  const [numberText, numberTextWide, titleText, sectionText, bannerText] =
    await Promise.all([
      recognizeRegion(scaledCanvas, numberRegion, {
        psm: "8",
        whitelist: "0123456789",
      }),
      recognizeRegion(scaledCanvas, numberRegionWide, {
        psm: "7",
        whitelist: "0123456789",
      }),
      recognizeRegion(scaledCanvas, titleRegion, {
        psm: "7",
      }),
      recognizeRegion(scaledCanvas, sectionRegion, {
        psm: "6",
      }),
      recognizeRegion(scaledCanvas, bannerRegion, {
        psm: "6",
      }),
    ])

  const resolvedNumberText = [numberText, numberTextWide].find((text) =>
    /^\d{1,2}$/.test(normalizeOcrLine(text).replace(/\s+/g, ""))
  )

  logOcr("chapter_heading_banner", {
    numberText: resolvedNumberText ?? numberText,
    titleText,
    sectionText,
    bannerText,
  })

  return parseChapterHeadingFromOcrTexts({
    numberText: resolvedNumberText ?? numberTextWide ?? numberText,
    titleText,
    sectionText,
    bannerText,
  })
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
      const sectionMetadata = await ocrFullPageSection(imageBuffer)
      if (sectionMetadata) {
        return sectionMetadata
      }

      return await ocrChapterHeading(imageBuffer)
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
  parseChapterHeadingFromOcrTexts,
  parseChapterNumberToken,
  parseSectionLabelToken,
  parsePartLabel,
  isPlausibleTitle,
  extractTitleFromNoisyOcr,
  extractLooseChapterNumber,
  countInterludeNamesInDivider,
  terminateOcrWorker,
}
