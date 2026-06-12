import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pdfPath = path.resolve(__dirname, "../../client/src/assets/The Way of Kings.pdf")

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")
const { parseChapterHeadingFromOcrTexts } = await import("../imageOcrService.js")
const { terminateOcrWorker } = await import("../imageOcrService.js")

const noisySamples = [
  {
    bannerText: "Ee —- 7 i [ENA a 'oa: CITY OF BELLS - aR : AR",
    expectedTitle: "City Of Bells",
    expectedNumber: null,
  },
  {
    bannerText: "B J > 13] — OER I TEN HEARTBEATS BWI AEP ARS!",
    expectedNumber: "Chapter 13",
    expectedTitle: "Ten Heartbeats",
  },
  {
    bannerText: "Ph ry fo 5% 2h yer To h Se ne ; CL Lo PAYDAY - BEEN",
    expectedTitle: "Payday",
    expectedNumber: null,
  },
  {
    numberText: "21",
    titleText: "WHY MEN LIE",
    expectedNumber: "Chapter 21",
    expectedTitle: "Why Men Lie",
  },
]

let unitFailures = 0
for (const sample of noisySamples) {
  const metadata = parseChapterHeadingFromOcrTexts(sample)
  const numberOk =
    sample.expectedNumber === undefined ||
    sample.expectedNumber === null
      ? !metadata?.number || sample.expectedNumber === metadata?.number
      : metadata?.number === sample.expectedNumber
  const titleOk =
    !sample.expectedTitle ||
    (metadata?.title ?? "").toLowerCase() === sample.expectedTitle.toLowerCase()

  if (!numberOk || !titleOk) {
    unitFailures += 1
    console.error("unit fail", sample, metadata)
  }
}

console.log("OCR parser unit samples:", unitFailures === 0 ? "pass" : `${unitFailures} failed`)

const result = await parsePdfBuffer(readFileSync(pdfPath), "wok.pdf", {
  documentId: "verify-wok-toc",
})

const blocks = result.contentWithChapters.flatMap((page) => page.blocks)
const boundaries = blocks.filter(
  (block) =>
    block.type === "image" &&
    block.isChapterBoundary &&
    block.chapterMetadata?.includeInToc !== false
)

const withMeta = boundaries.filter((block) => {
  const metadata = block.chapterMetadata ?? {}
  return Boolean(metadata.number || metadata.title)
})

const chapterBoundaries = boundaries.filter(
  (block) => (block.chapterMetadata?.boundaryKind ?? "chapter") === "chapter"
)

const chapterNumbers = chapterBoundaries
  .map((block) => {
    const match = String(block.chapterMetadata?.number ?? "").match(/\b(\d{1,3})\b/)
    return match ? Number.parseInt(match[1], 10) : null
  })
  .filter((value) => Number.isFinite(value))
  .sort((left, right) => left - right)

const uniqueChapterNumbers = [...new Set(chapterNumbers)]
const missingChapterNumbers = []
for (let chapter = 1; chapter <= 75; chapter += 1) {
  if (!uniqueChapterNumbers.includes(chapter)) {
    missingChapterNumbers.push(chapter)
  }
}

const prelude = boundaries.find((block) => block.chapterMetadata?.boundaryKind === "prelude")
const prologue = boundaries.find((block) => block.chapterMetadata?.boundaryKind === "prologue")
const epilogue = boundaries.find((block) => block.chapterMetadata?.boundaryKind === "epilogue")

console.log("PARSER_VERSION", PARSER_VERSION)
console.log("TOC boundaries", boundaries.length)
console.log("with number or title", withMeta.length)
console.log("unique chapter numbers", uniqueChapterNumbers.length)
console.log("missing chapters 1-75", missingChapterNumbers.join(", ") || "none")
console.log("prelude", prelude ? "yes" : "no", "prologue", prologue ? "yes" : "no", "epilogue", epilogue ? "yes" : "no")
console.log("synthetic boundaries", boundaries.filter((block) => block.isSyntheticChapterBoundary).length)

console.log("\n--- sample boundaries ---")
for (const block of boundaries.slice(0, 12)) {
  const metadata = block.chapterMetadata ?? {}
  console.log(
    `p.${block.pageNumber}\t${metadata.number ?? ""}\t${metadata.title ?? ""}\t${metadata.boundaryKind}`
  )
}

console.log("\n--- late chapters ---")
for (const block of boundaries.filter((entry) => {
  const match = String(entry.chapterMetadata?.number ?? "").match(/\b(\d{1,3})\b/)
  return match && Number.parseInt(match[1], 10) >= 60
})) {
  const metadata = block.chapterMetadata ?? {}
  console.log(`p.${block.pageNumber}\t${metadata.number}\t${metadata.title}`)
}

await terminateOcrWorker()

const success =
  unitFailures === 0 &&
  withMeta.length >= 60 &&
  missingChapterNumbers.length <= 10 &&
  Boolean(epilogue)

process.exit(success ? 0 : 1)
