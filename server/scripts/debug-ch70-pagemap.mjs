// TEMP diagnostic for the ch70 "Sea Of Glass" TOC page bug (shows 804, expected 821).
// Reparses WoK from scratch and reports the structural facts that determine what
// buildChapterPageMap / buildImageChapterPageMap can produce client-side:
//   a. which mechanism supplies ch70's TOC pageNum (image-id join)
//   b. where ch70's boundary block actually sits in the content stream
//   c/d. estimated reader pages for the p1051 plate vs ch70's arch (char-calibrated
//        against the known-good ch68=789 / ch71=827 anchors)
//   e. chapterId leakage onto non-opener blocks
// Plus: duplicate image-block id scan and [partCursor] events (p1051 invariant).
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { analyzeChapterGraphicFromContext } from "../chapterGraphicService.js"
import { isLikelyChapterArchBannerBlock, isFullPageHeightIllustrationBlock } from "../pdfImageRoleUtils.js"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"
process.env.BOOKY_FRONTMATTER_DEBUG = "1"
process.env.BOOKY_CHAPTER_GRAPHIC_DEBUG = "1"

const pdfPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/src/assets/The Way of Kings.pdf"
)

const partCursorLines = []
const chapterAssignLines = []
const cursorTraceLines = []
const bannerlessReconcileLines = []
const tocReanchorLines = []
const graphicDecisionLines = []
const portraitBandLines = []
const originalLog = console.log
console.log = (...args) => {
  const line = args.map(String).join(" ")
  if (line.includes("[partCursor]")) {
    partCursorLines.push(line)
  }
  if (line.includes("[chapterAssign]")) {
    chapterAssignLines.push(line)
  }
  if (line.includes("[cursorTrace]")) {
    cursorTraceLines.push(line)
  }
  if (line.includes("[bannerlessReconcile]")) {
    bannerlessReconcileLines.push(line)
  }
  if (line.includes("[tocReanchor]")) {
    tocReanchorLines.push(line)
  }
  if (line.includes("[chapterGraphicService]")) {
    graphicDecisionLines.push(line)
  }
  if (line.includes("[portraitBandScan]")) {
    portraitBandLines.push(line)
  }
}

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")
const { chapters, contentWithChapters } = await parsePdfBuffer(
  readFileSync(pdfPath),
  "The Way of Kings.pdf"
)

console.log = originalLog

console.log("PARSER_VERSION", PARSER_VERSION)
console.log("total chapters:", chapters.length)

// --- chapters[] rows around the affected slots -------------------------------
const interesting = /(chapter (6[89]|7[0-2])\b|part (four|five)|justice|sea of glass)/i
console.log("\n=== chapters[] entries (ch68-72 / parts) ===")
for (const ch of chapters) {
  if (interesting.test(ch.title ?? "")) {
    console.log(JSON.stringify(ch))
  }
}

// --- flat block stream with content positions --------------------------------
const flat = []
for (const page of contentWithChapters) {
  const blocks = page?.blocks ?? []
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    flat.push({ page, pageIndex: page.pageIndex, blockIndex, block: blocks[blockIndex] })
  }
}

const describe = ({ pageIndex, blockIndex, block }) => ({
  pos: `${pageIndex}/${blockIndex}`,
  type: block.type,
  pdfPage: block.pageNumber ?? null,
  id: block.id ?? null,
  imageRole: block.imageRole ?? null,
  isChapterBoundary: Boolean(block.isChapterBoundary),
  forcesOwnPage: Boolean(block.forcesOwnPage),
  bannerlessChapterAfter: block.bannerlessChapterAfter ?? null,
  boundaryKind: block.chapterMetadata?.boundaryKind ?? null,
  metaNumber: block.chapterMetadata?.number ?? null,
  metaTitle: block.chapterMetadata?.title ?? null,
  isHeading: Boolean(block.isHeading),
  chapterId: block.chapterId ?? null,
  text: (block.text ?? "").slice(0, 70),
})

// --- locate the key blocks ----------------------------------------------------
const findArch = (num) =>
  flat.find(
    (entry) =>
      entry.block.type === "image" &&
      entry.block.isChapterBoundary &&
      new RegExp(`\\b${num}\\b`).test(entry.block.chapterMetadata?.number ?? "")
  )

const ch68Arch = findArch(68)
const ch70Arch = findArch(70)
const ch71Arch = findArch(71)
const plate = flat.find(
  (entry) =>
    entry.block.type === "image" &&
    (entry.block.pageNumber === 1051 || entry.block.bannerlessChapterAfter)
)

console.log("\n=== key blocks ===")
console.log("ch68 arch:", ch68Arch ? JSON.stringify(describe(ch68Arch)) : "NOT FOUND")
console.log("plate    :", plate ? JSON.stringify(describe(plate)) : "NOT FOUND")
console.log("ch70 arch:", ch70Arch ? JSON.stringify(describe(ch70Arch)) : "NOT FOUND")
console.log("ch71 arch:", ch71Arch ? JSON.stringify(describe(ch71Arch)) : "NOT FOUND")

// --- every image block near PDF pages 1045-1070 ------------------------------
console.log("\n=== image blocks, PDF pages 1045-1070 ===")
for (const entry of flat) {
  const pdfPage = entry.block.pageNumber ?? 0
  if (entry.block.type === "image" && pdfPage >= 1045 && pdfPage <= 1070) {
    console.log(JSON.stringify(describe(entry)))
  }
}

// --- non-prose blocks between plate and ch71 arch ----------------------------
if (plate && ch71Arch) {
  const from = flat.indexOf(plate)
  const to = flat.indexOf(ch71Arch)
  console.log(`\n=== headings/images between plate (flat ${from}) and ch71 arch (flat ${to}) ===`)
  for (let i = from; i <= to; i += 1) {
    const entry = flat[i]
    if (entry.block.type === "image" || entry.block.isHeading || entry.block.chapterId) {
      console.log(`flat ${i}:`, JSON.stringify(describe(entry)))
    }
  }
}

// --- char distances + page estimates anchored on ch68=789, ch71=827 ----------
const charsBetween = (a, b) => {
  if (!a || !b) return null
  const from = flat.indexOf(a)
  const to = flat.indexOf(b)
  let chars = 0
  for (let i = Math.min(from, to); i < Math.max(from, to); i += 1) {
    chars += (flat[i].block.text ?? "").length
  }
  return chars
}

const span68to71 = charsBetween(ch68Arch, ch71Arch)
if (span68to71 != null) {
  const cpp = span68to71 / (827 - 789)
  const est = (target) => {
    const chars = charsBetween(ch68Arch, target)
    return chars == null ? null : Math.round(789 + chars / cpp)
  }
  console.log("\n=== reader-page estimates (calibrated ch68=789, ch71=827) ===")
  console.log("chars ch68->ch71:", span68to71, "chars/page:", Math.round(cpp))
  console.log("plate estimated reader page:", est(plate))
  console.log("ch70 arch estimated reader page:", est(ch70Arch))
  console.log("chars plate->ch70 arch:", charsBetween(plate, ch70Arch))
}

// --- duplicate image-block id scan (buildImageChapterPageMap hazard) ---------
console.log("\n=== duplicate image block ids ===")
const idMap = new Map()
for (const entry of flat) {
  if (entry.block.type === "image" && entry.block.id) {
    const list = idMap.get(entry.block.id) ?? []
    list.push(entry)
    idMap.set(entry.block.id, list)
  }
}
let dupCount = 0
for (const [id, entries] of idMap) {
  if (entries.length > 1) {
    dupCount += 1
    console.log(
      `DUP id ${id}:`,
      JSON.stringify(entries.map((e) => ({ pos: `${e.pageIndex}/${e.blockIndex}`, pdfPage: e.block.pageNumber, boundary: Boolean(e.block.isChapterBoundary) })))
    )
  }
}
console.log("duplicate ids:", dupCount)
if (ch70Arch?.block.id) {
  console.log("ch70 arch id occurrences:", (idMap.get(ch70Arch.block.id) ?? []).length)
}
if (plate?.block.id && ch70Arch?.block.id) {
  console.log("plate id === arch id:", plate.block.id === ch70Arch.block.id)
}

// --- chapterId leakage (question e) -------------------------------------------
const ch70Entry = chapters.find((ch) => /chapter 70\b/i.test(ch.title ?? ""))
if (ch70Entry) {
  console.log("\n=== blocks carrying ch70's chapterId ===", ch70Entry.id)
  for (const entry of flat) {
    if (entry.block.chapterId === ch70Entry.id) {
      console.log(JSON.stringify(describe(entry)))
    }
  }
}

// --- partCursor events ---------------------------------------------------------
console.log("\n=== [partCursor] events ===")
for (const line of partCursorLines) {
  console.log(line)
}

// --- chapterAssign around the plate --------------------------------------------
console.log("\n=== [chapterAssign] PDF pages 1045-1070 ===")
for (const line of chapterAssignLines) {
  try {
    const payload = JSON.parse(line.replace(/^.*\[chapterAssign\]\s*/, ""))
    if ((payload.pageNumber ?? 0) >= 1045 && (payload.pageNumber ?? 0) <= 1070) {
      console.log(JSON.stringify(payload))
    }
  } catch {
    /* skip non-JSON lines */
  }
}

// ================================================================================
// QUESTION 1: p1073 Part Five anchor - image and/or text?
// ================================================================================
console.log("\n\n=== Q1: all blocks, PDF pages 1071-1076 ===")
function isLikelyStructuralPartDividerPlateLocal(block) {
  if (!block || (block.type !== "image" && block.type !== "image_candidate")) {
    return { result: false, reason: "not-image" }
  }
  const coords = block.coordinates ?? {}
  const pageWidth = coords.pageWidth ?? 0
  const pageHeight = coords.pageHeight ?? 0
  const width = coords.width ?? 0
  const height = coords.height ?? 0
  if (!pageWidth || !pageHeight) {
    return { result: false, reason: "no-page-dims" }
  }
  const widthRatio = width / pageWidth
  const heightRatio = height / pageHeight
  const aspectRatio = height > 0 ? width / height : 0
  if (widthRatio < 0.4 || heightRatio < 0.45) {
    return { result: false, reason: "below-width-or-height-floor", widthRatio, heightRatio, aspectRatio }
  }
  if (widthRatio >= 0.34 && widthRatio <= 0.4 && heightRatio >= 0.14 && heightRatio <= 0.2) {
    return { result: false, reason: "arch-band-exclusion", widthRatio, heightRatio, aspectRatio }
  }
  if (
    aspectRatio > 0 &&
    aspectRatio < 1.0 &&
    heightRatio >= 0.45 &&
    heightRatio < 0.58 &&
    widthRatio >= 0.4 &&
    widthRatio < 0.5
  ) {
    return { result: false, reason: "portrait-opener-band-exclusion", widthRatio, heightRatio, aspectRatio }
  }
  return { result: true, reason: "passes-all-gates", widthRatio, heightRatio, aspectRatio }
}

for (const entry of flat) {
  const pdfPage = entry.block.pageNumber ?? 0
  if (pdfPage >= 1071 && pdfPage <= 1076) {
    const base = describe(entry)
    if (entry.block.type === "image" || entry.block.type === "image_candidate") {
      const coords = entry.block.coordinates ?? {}
      const widthRatio = coords.pageWidth ? Number((coords.width / coords.pageWidth).toFixed(3)) : null
      const heightRatio = coords.pageHeight ? Number((coords.height / coords.pageHeight).toFixed(3)) : null
      const aspect = coords.height ? Number((coords.width / coords.height).toFixed(3)) : null
      const dividerCheck = isLikelyStructuralPartDividerPlateLocal(entry.block)
      console.log(
        JSON.stringify({
          ...base,
          widthRatio,
          heightRatio,
          aspect,
          isLikelyStructuralPartDividerPlate: dividerCheck.result,
          dividerCheckReason: dividerCheck.reason,
        })
      )
    } else {
      console.log(JSON.stringify(base))
    }
  }
}

console.log("\n=== Q1: text blocks matching /Part\\s+(Four|Five)/i anywhere in book ===")
for (const entry of flat) {
  const text = (entry.block.text ?? "").trim()
  if (/Part\s+(Four|Five)\b/i.test(text)) {
    console.log(JSON.stringify({ pdfPage: entry.block.pageNumber, pos: `${entry.pageIndex}/${entry.blockIndex}`, text: text.slice(0, 80) }))
  }
}

console.log("\n=== Q1b: ALL text blocks matching /^PART\\b/i anywhere in book (any part) ===")
for (const entry of flat) {
  const text = (entry.block.text ?? "").trim()
  if (/^PART\b/i.test(text)) {
    console.log(JSON.stringify({ pdfPage: entry.block.pageNumber, pos: `${entry.pageIndex}/${entry.blockIndex}`, text: text.slice(0, 80) }))
  }
}

console.log("\n=== Q1c: ALL image/chapters with boundaryKind 'part' (how Parts One-Three got anchored) ===")
for (const entry of flat) {
  if (entry.block.type === "image" && entry.block.chapterMetadata?.boundaryKind === "part") {
    console.log(JSON.stringify(describe(entry)))
  }
}


// ================================================================================
// QUESTION 2: p1074 ch70 arch suppression - exact gate trace
// ================================================================================
console.log("\n\n=== Q2: [chapterGraphicService] decisions, PDF pages 1050-1080 ===")
for (const line of graphicDecisionLines) {
  try {
    const payload = JSON.parse(line.replace(/^.*\[chapterGraphicService\]\s*/, ""))
    if ((payload.pageNumber ?? 0) >= 1050 && (payload.pageNumber ?? 0) <= 1080) {
      console.log(JSON.stringify(payload))
    }
  } catch {
    /* skip */
  }
}

console.log("\n=== Q2: [cursorTrace] events, PDF pages 1000-1095 ===")
for (const line of cursorTraceLines) {
  console.log(line.replace(/^.*(?=\[cursorTrace\])/, ""))
}

console.log("\n=== Q2: [tocReanchor] events (all) ===")
for (const line of tocReanchorLines) {
  console.log(line.replace(/^.*(?=\[tocReanchor\])/, ""))
}

console.log("\n=== Q2: [bannerlessReconcile] events (all) ===")
for (const line of bannerlessReconcileLines) {
  console.log(line.replace(/^.*(?=\[bannerlessReconcile\])/, ""))
}

console.log("\n=== Q2: [portraitBandScan] events (all) ===")
for (const line of portraitBandLines) {
  console.log(line.replace(/^.*(?=\[portraitBandScan\])/, ""))
}

// ================================================================================
// QUESTION 3: whole-book scan for suppressed chapter_heading arches
// ================================================================================
console.log("\n\n=== Q3: chapter_heading images with isChapterBoundary=false (whole book) ===")
let suppressedCount = 0
for (const entry of flat) {
  const block = entry.block
  if (block.type === "image" && block.imageRole === "chapter_heading" && !block.isChapterBoundary) {
    suppressedCount += 1
    console.log(JSON.stringify(describe(entry)))
  }
}
console.log("total suppressed chapter_heading images:", suppressedCount)

// ================================================================================
// QUESTION 4: bannerlessReconcile blast radius - full chapterAssign context 68-71
// ================================================================================
console.log("\n\n=== Q4: full [chapterAssign] trace, PDF pages 1000-1095 ===")
for (const line of chapterAssignLines) {
  try {
    const payload = JSON.parse(line.replace(/^.*\[chapterAssign\]\s*/, ""))
    if ((payload.pageNumber ?? 0) >= 1000 && (payload.pageNumber ?? 0) <= 1095) {
      console.log(JSON.stringify(payload))
    }
  } catch {
    /* skip */
  }
}

// ================================================================================
// DIRECT REPRODUCTION: call the real analyzeChapterGraphicFromContext on the real
// p1074 block + real surrounding blocks (type flipped back to image_candidate for
// the target only, since findPreviousImageBlock/findNextImageBlock/etc. accept
// either "image" or "image_candidate"). Isolates whether isChapterBanner resolves
// true or false for this exact geometry+context, without touching product code.
// ================================================================================
console.log("\n\n=== DIRECT REPRO: analyzeChapterGraphicFromContext(p1074) ===")
const p1074Entry = flat.find((e) => e.block.type === "image" && e.block.pageNumber === 1074)
if (p1074Entry) {
  const rawBlocks = flat.map((e) => e.block)
  const targetIndex = flat.indexOf(p1074Entry)
  const candidateBlock = { ...p1074Entry.block, type: "image_candidate" }
  rawBlocks[targetIndex] = candidateBlock

  const MAP_OR_DIVIDER_TEXT_PATTERNS = [
    /^ROSHAR$/i,
    /^THE STORMLIGHT ARCHIVE$/i,
    /^BOOK$/i,
    /^ONE$/i,
    /^TWO$/i,
    /^THREE$/i,
    /^THE WAY OF KINGS$/i,
    /4,500 years later/i,
    /codes of war/i,
    /alethi codes/i,
    /sketchbook/i,
  ]
  function collectNearbyTextLinesLocal(blocksArr, imgBlock, maxPageDelta = 1) {
    const pageNumber = imgBlock?.pageNumber ?? 0
    const lines = []
    for (const block of blocksArr) {
      if (block?.type === "image" || block?.type === "image_candidate") continue
      const blockPage =
        block?.pageNumber ??
        (Number.isFinite(block?.sourcePdfPageIndex) ? block.sourcePdfPageIndex + 1 : 0)
      if (Math.abs(blockPage - pageNumber) > maxPageDelta) continue
      const text = (block?.text ?? "").trim()
      if (text) lines.push(text)
    }
    return lines
  }
  function findPreviousImageBlockLocal(blocksArr, idx) {
    const originPage = blocksArr[idx]?.pageNumber ?? 0
    let closest = null
    let closestDelta = Infinity
    for (let i = 0; i < blocksArr.length; i += 1) {
      if (i === idx) continue
      const b = blocksArr[i]
      if (b?.type !== "image" && b?.type !== "image_candidate") continue
      const pageDelta = originPage - (b.pageNumber ?? 0)
      if (pageDelta <= 0 || pageDelta > 2) continue
      if (pageDelta < closestDelta) {
        closest = b
        closestDelta = pageDelta
      }
    }
    return closest
  }
  function findNextImageBlockLocal(blocksArr, idx, maxPageDelta = 2) {
    const originPage = blocksArr[idx]?.pageNumber ?? 0
    let closest = null
    let closestDelta = Infinity
    for (let i = 0; i < blocksArr.length; i += 1) {
      if (i === idx) continue
      const b = blocksArr[i]
      if (b?.type !== "image" && b?.type !== "image_candidate") continue
      const pageDelta = (b.pageNumber ?? 0) - originPage
      if (pageDelta <= 0 || pageDelta > maxPageDelta) continue
      if (pageDelta < closestDelta) {
        closest = b
        closestDelta = pageDelta
      }
    }
    return closest
  }

  const nearbyLines = collectNearbyTextLinesLocal(rawBlocks, candidateBlock, 1)
  const matchedPattern = nearbyLines.find((text) =>
    MAP_OR_DIVIDER_TEXT_PATTERNS.some((pattern) => pattern.test(text))
  )
  const prevImg = findPreviousImageBlockLocal(rawBlocks, targetIndex)
  const nextImg = findNextImageBlockLocal(rawBlocks, targetIndex, 2)

  console.log(
    "isMapOrGalleryIllustration inputs:",
    JSON.stringify({
      nearbyLineCount: nearbyLines.length,
      matchedMapPattern: matchedPattern ?? null,
      previousImage: prevImg
        ? { pageNumber: prevImg.pageNumber, imageRole: prevImg.imageRole, isFullPageHeight: isFullPageHeightIllustrationBlock(prevImg) }
        : null,
      nextImage: nextImg
        ? { pageNumber: nextImg.pageNumber, imageRole: nextImg.imageRole, isFullPageHeight: isFullPageHeightIllustrationBlock(nextImg) }
        : null,
    })
  )

  console.log(
    "pre-checks:",
    JSON.stringify({
      isLikelyChapterArchBannerBlock: isLikelyChapterArchBannerBlock(candidateBlock),
      isFullPageHeightIllustrationBlock: isFullPageHeightIllustrationBlock(candidateBlock),
    })
  )

  const directResult = analyzeChapterGraphicFromContext({
    imageBlock: candidateBlock,
    blocks: rawBlocks,
    blockIndex: targetIndex,
    chapterSequence: 70,
    interludeSequence: 1,
    ocrMetadata: null,
    printedToc: null,
    forceInterludeBoundary: false,
    precomputedPageCharCounts: null,
    tocOrderCursor: null,
    buildSequentialTocEntry: null,
    buildSequentialInterludeTocEntry: null,
  })
  console.log("direct result (printedToc=null):", JSON.stringify(directResult))
} else {
  console.log("p1074 block not found in flat")
}
