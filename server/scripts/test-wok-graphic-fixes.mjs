import { analyzeChapterGraphicFromContext } from "../chapterGraphicService.js"

const tallArch = {
  type: "image_candidate",
  imageRole: "chapter_heading",
  pageNumber: 34,
  coordinates: { width: 300, height: 400, pageWidth: 400, pageHeight: 600 },
}

const blocks = [
  tallArch,
  {
    type: "text",
    text: "—Collected on the second day of Kakash, year 1171.",
    pageNumber: 34,
    sourcePdfPageIndex: 33,
  },
  {
    type: "text",
    text: "Kaladin's stomach growled as he reached through the bars.",
    pageNumber: 34,
    sourcePdfPageIndex: 33,
  },
]

for (let index = 0; index < 40; index += 1) {
  blocks.push({
    type: "text",
    text: "Trailing prose from the previous chapter on the same page.",
    pageNumber: 34,
    sourcePdfPageIndex: 33,
  })
}

const chapterOnBusyPage = analyzeChapterGraphicFromContext({
  imageBlock: tallArch,
  blocks,
  blockIndex: 0,
  chapterSequence: 2,
  ocrMetadata: {
    boundaryKind: "chapter",
    number: "2",
    title: "HONOR IS DEAD",
    rawText: "2: HONOR IS DEAD",
  },
})

const prologueArch = {
  ...tallArch,
  pageNumber: 12,
  coordinates: { width: 300, height: 400, pageWidth: 400, pageHeight: 600 },
}

const prologueBlocks = [
  prologueArch,
  {
    type: "text",
    text: "—Collected on the first day of the week Palah of the month Shash.",
    pageNumber: 12,
    sourcePdfPageIndex: 11,
  },
  {
    type: "text",
    text: "Szeth-son-son-Vallano, Truthless of Shinovar, wore white on the day.",
    pageNumber: 12,
    sourcePdfPageIndex: 11,
  },
]

const prologue = analyzeChapterGraphicFromContext({
  imageBlock: prologueArch,
  blocks: prologueBlocks,
  blockIndex: 0,
  ocrMetadata: {
    boundaryKind: "prologue",
    number: "Prologue",
    title: "To Kill",
    rawText: "Prologue: To Kill",
  },
})

const mapIllustration = {
  type: "image_candidate",
  imageRole: "chapter_heading",
  pageNumber: 11,
  coordinates: { width: 360, height: 420, pageWidth: 400, pageHeight: 600 },
}

const mapBlocks = [
  mapIllustration,
  {
    type: "text",
    text: "Charcoal rubbing of a map of Sadeas's warcamp on the Shattered Plains.",
    pageNumber: 12,
    sourcePdfPageIndex: 11,
  },
]

const map = analyzeChapterGraphicFromContext({
  imageBlock: mapIllustration,
  blocks: mapBlocks,
  blockIndex: 0,
  chapterSequence: 1,
  ocrMetadata: null,
})

console.log(
  "chapter on busy page",
  chapterOnBusyPage.isChapterBoundary,
  chapterOnBusyPage.number
)
console.log("prologue p12", prologue.isChapterBoundary, prologue.boundaryKind, prologue.title)
console.log("map illustration", map.isChapterBoundary)

if (!chapterOnBusyPage.isChapterBoundary || !prologue.isChapterBoundary || map.isChapterBoundary) {
  process.exitCode = 1
}
