/**
 * Assemble split module files from extracted bodies + import/export wrappers.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serverDir = path.resolve(__dirname, "..")

function readBody(...parts) {
  return parts
    .map((p) => fs.readFileSync(path.join(serverDir, p), "utf8"))
    .join("\n")
}

function writeModule(relPath, header, body, footer = "") {
  const full = path.join(serverDir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  const content = [header.trim(), body.trim(), footer.trim()].filter(Boolean).join("\n\n") + "\n"
  fs.writeFileSync(full, content, "utf8")
  return content.split("\n").length
}

const counts = {}

counts["supabaseClient.js"] = writeModule(
  "supabaseClient.js",
  `import { createClient } from "@supabase/supabase-js"

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)`,
  ""
)

counts["parser/constants.js"] = writeModule(
  "parser/constants.js",
  `import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"`,
  readBody("parser/_constantsTop.body.js", "parser/_constantsChapter.body.js"),
  `export {
  PARSER_VERSION,
  PDF_IMAGE_JPEG_CONTENT_TYPE,
  PDF_IMAGE_PAINT_OPS,
  PDF_IMAGE_RESOLVE_TIMEOUT_MS,
  ILLUSTRATION_VISION_CONCURRENCY,
  BOOK_ASSET_UPLOAD_CONCURRENCY,
  BOOK_ASSET_UPLOAD_MAX_RETRIES,
  BOOK_ASSET_UPLOAD_RETRY_BASE_MS,
  BOOK_ASSETS_BUCKET,
  BOOK_ASSETS_FALLBACK_BUCKET,
  BOOK_ASSET_SIGNED_URL_TTL_SECONDS,
  PDF_IMAGE_MIN_DIMENSION_PX,
  PUA_FALLBACK_MAP,
  MAX_PROSE_BLOCK_WORDS,
  MAX_PROSE_BLOCK_CHARS,
  SHORT_PROSE_CONTINUATION_MAX_WORDS,
  PARSE_STATUS,
  CHAPTER_PATTERN,
  STRUCTURAL_HEADING_PREFIX_REGEX,
  PART_HEADING_PATTERN,
  VOLUME_HEADING_PATTERN,
  STRUCTURAL_HEADING_MAX_CHARS,
  STRUCTURAL_HEADING_MAX_WORDS,
  TOC_CHAPTER_LISTING_REGEX,
  EARLY_TOC_SCAN_LINE_LIMIT,
  CHAPTER_NUMBER_REGEX,
  CHAPTER_HEADING_MIN_FONT_SIZE,
  CHAPTER_DISPLAY_FONT_SIZE,
  PUA_PRIVATE_USE_START,
  PUA_PRIVATE_USE_END,
  PUA_DIGIT_BLOCK_START,
  PUA_LETTER_BLOCK_START,
  PUA_LETTER_BLOCK_END,
  PRINTED_TOC_SCAN_LINE_LIMIT,
  SCENE_BREAK_DIVIDER_TEXT,
  CHAPTER_TITLE_TAIL_WORD_REGEX,
  PRINTED_TOC_RUN_MIN_LENGTH,
  MULTILINE_CHAPTER_WRAP_MIN_FONT_SIZE,
}`
)

counts["parse/parseGate.js"] = writeModule(
  "parse/parseGate.js",
  "",
  readBody("parse/_parseGate.body.js"),
  `export {
  runWithFullParseGate,
  PARSE_GATE_UPLOAD_PRIORITY,
  PARSE_GATE_REPARSE_PRIORITY,
}`
)

counts["parse/parseProgress.js"] = writeModule(
  "parse/parseProgress.js",
  `import { supabase } from "../supabaseClient.js"`,
  readBody("parse/_parseProgress.body.js"),
  `export {
  resolvePdfExtractionConcurrency,
  structurePhasePercent,
  mergeParseProgressSnapshot,
  setDocumentParseProgress,
  getDocumentParseProgress,
  clearDocumentParseProgress,
  PARSE_PROGRESS_EXTRACT_MAX_PERCENT,
  PARSE_PROGRESS_STRUCTURE_PERCENT,
  PARSE_PROGRESS_ILLUSTRATION_START_PERCENT,
  PARSE_PROGRESS_ILLUSTRATION_END_PERCENT,
  PARSE_PROGRESS_UPLOAD_MAX_PERCENT,
  PARSE_PROGRESS_FINALIZE_PERCENT,
  PARSE_PROGRESS_SAVE_PERCENT,
  EXTRACT_PROGRESS_TEXT_SHARE,
  EXTRACT_PROGRESS_IMAGE_SHARE,
}`
)

counts["app/setup.js"] = writeModule(
  "app/setup.js",
  `import express from "express"
import { clerkMiddleware, getAuth } from "@clerk/express"`,
  readBody("app/_setup.body.js", "app/_html.body.js"),
  `export { app, applyCorsHeaders, requireAuth, buildReformattedHtml }`
)

counts["parser/puaAndFrontMatter.js"] = writeModule(
  "parser/puaAndFrontMatter.js",
  `import zlib from "node:zlib"
import {
  CHAPTER_PATTERN,
  CHAPTER_TITLE_TAIL_WORD_REGEX,
  MULTILINE_CHAPTER_WRAP_MIN_FONT_SIZE,
  PART_HEADING_PATTERN,
  PRINTED_TOC_RUN_MIN_LENGTH,
  PRINTED_TOC_SCAN_LINE_LIMIT,
  PUA_DIGIT_BLOCK_START,
  PUA_FALLBACK_MAP,
  PUA_LETTER_BLOCK_END,
  PUA_LETTER_BLOCK_START,
  PUA_PRIVATE_USE_END,
  PUA_PRIVATE_USE_START,
  SCENE_BREAK_DIVIDER_TEXT,
  STRUCTURAL_HEADING_PREFIX_REGEX,
  VOLUME_HEADING_PATTERN,
} from "./constants.js"`,
  readBody("parser/_puaAndFrontMatter.body.js"),
  `export {
  buildDefaultPuaReplacementMap,
  translatePuaCharacters,
  isSceneBreakOrnamentLine,
  isSceneBreakDividerText,
  pushSceneBreakBlock,
  promoteStructuralSectionHeadings,
  mergeEndOfPartBlocks,
  mergeTrailingChapterTitleFragments,
  mergeInlineChapterLabelTitles,
  mergeMultilineChapterTitleBlocks,
  normalizeFrontAndBackMatterBlocks,
  excludePrintedTocBlocks,
  findFirstChapterBlockIndex,
  isPrintedTocHeading,
  isPrintedTocEntryLine,
  isStormlightPrintedTocLine,
  isIllustrationsListLine,
  isLargeFontAllCapsChapterWrapLine,
  isShortChapterHeadingSubtitleLine,
  injectStormlightPreludeHeading,
}`
)

counts["parser/textNormalization.js"] = writeModule(
  "parser/textNormalization.js",
  `import {
  CHAPTER_PATTERN,
  MAX_PROSE_BLOCK_CHARS,
  MAX_PROSE_BLOCK_WORDS,
  PART_HEADING_PATTERN,
  SHORT_PROSE_CONTINUATION_MAX_WORDS,
  STRUCTURAL_HEADING_PREFIX_REGEX,
  VOLUME_HEADING_PATTERN,
} from "./constants.js"
import { translatePuaCharacters } from "./puaAndFrontMatter.js"`,
  readBody("parser/_textNormalization.body.js"),
  `export {
  normalizeExtractedText,
  shouldDropExtractedLine,
  groupTextItemsIntoLines,
  getItemFontSize,
  getItemY,
  getItemX,
  getItemFontTraits,
  buildRunsFromLineItems,
  isScannerWatermarkLine,
  sanitizePdfTitle,
  sanitizePdfAuthor,
  humanizeBookTitleFromFileName,
  resolveBookTitle,
  applyProseFormattingToBlock,
  isProseLineContinuation,
  isShortProseContinuation,
  medianValue,
  computePageLineMetrics,
  annotatePageLineGaps,
  isHeadingTerminalOrStructural,
  isCleanStructuralHeadingText,
  isShortDialogueLine,
  isDialogueAttributionFragment,
  isAllCapsCalloutLine,
  dropMarginCalloutLines,
  joinWrappedText,
  looksLikeFilenameSlug,
  contentStartsWithBookTitle,
  isStandalonePageNumberText,
  HEADING_STRING_MIN_FONT_SIZE,
  INDENT_THRESHOLD_PX,
  BOOK_TITLE_MINOR_WORDS,
  normalizeHeadingCandidate,
  PROSE_BLOCKLIST_WORD_REGEX,
  isHeadingIncompleteEnding,
  isTocDenseListingLine,
  isTocPageReferenceLine,
  isRunningHeaderMergedLine,
  isNarrativeBoundaryLine,
}`
)

counts["parser/pdfImages.js"] = writeModule(
  "parser/pdfImages.js",
  `import crypto from "node:crypto"
import { createCanvas } from "@napi-rs/canvas/node-canvas.js"
import { ImageKind } from "pdfjs-dist/legacy/build/pdf.mjs"
import {
  analyzeChapterGraphicFromContext,
  analyzeChapterHeadingBanner,
  shouldSkipChapterGraphicAnalysis,
  SAFE_FALLBACK,
} from "../chapterGraphicService.js"
import {
  countInterludeNamesInDivider,
  ocrIllustrationMetadata,
  terminateOcrWorker,
} from "../imageOcrService.js"
import {
  extractChapterKeyFromOcrNumber,
  supplementBannerlessPrintedChapters,
  takeNextSequentialTocEntryForImageBanner,
} from "../stormlightEpigraphService.js"
import { supabase } from "../supabaseClient.js"
import {
  BOOK_ASSET_SIGNED_URL_TTL_SECONDS,
  BOOK_ASSET_UPLOAD_CONCURRENCY,
  BOOK_ASSET_UPLOAD_MAX_RETRIES,
  BOOK_ASSET_UPLOAD_RETRY_BASE_MS,
  BOOK_ASSETS_BUCKET,
  BOOK_ASSETS_FALLBACK_BUCKET,
  ILLUSTRATION_VISION_CONCURRENCY,
  PDF_IMAGE_JPEG_CONTENT_TYPE,
  PDF_IMAGE_MIN_DIMENSION_PX,
  PDF_IMAGE_PAINT_OPS,
  PDF_IMAGE_RESOLVE_TIMEOUT_MS,
} from "./constants.js"
import {
  PARSE_PROGRESS_ILLUSTRATION_END_PERCENT,
  PARSE_PROGRESS_ILLUSTRATION_START_PERCENT,
  PARSE_PROGRESS_UPLOAD_MAX_PERCENT,
} from "../parse/parseProgress.js"
import {
  isDialogueAttributionFragment,
  isAllCapsCalloutLine,
  isShortDialogueLine,
} from "./textNormalization.js"`,
  readBody("parser/_pdfImages.body.js"),
  `export {
  classifyPdfImageRole,
  isChapterHeaderCandidate,
  PDF_IMAGE_ROLE,
  interleaveImageCandidateBlocks,
  finalizeIllustrationBlocks,
  uploadBookAssets,
  resolvePdfImageBuffer,
  extractPdfPageImageCandidatesFromOperatorList,
  annotateLinesCentered,
  multiplyPdfTransform,
  imageMetricsFromTransform,
  withSourcePdfPage,
  mapTextBlocksToPagePositions,
}`
)

counts["parser/wordCount.js"] = writeModule(
  "parser/wordCount.js",
  "",
  readBody("parser/_wordCount.body.js"),
  `export { countWordsFromBlocks, countWordsFromContent, countWordsInPlainText }`
)

counts["parser/pdfExtract.js"] = writeModule(
  "parser/pdfExtract.js",
  `import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import {
  resolvePdfExtractionConcurrency,
  EXTRACT_PROGRESS_TEXT_SHARE,
  PARSE_PROGRESS_EXTRACT_MAX_PERCENT,
  EXTRACT_PROGRESS_IMAGE_SHARE,
} from "../parse/parseProgress.js"
import { SCENE_BREAK_DIVIDER_TEXT } from "./constants.js"
import {
  buildDefaultPuaReplacementMap,
  isSceneBreakOrnamentLine,
  translatePuaCharacters,
} from "./puaAndFrontMatter.js"
import {
  getItemFontSize,
  getItemX,
  getItemY,
  isScannerWatermarkLine,
  isCleanStructuralHeadingText,
  medianValue,
  dropMarginCalloutLines,
  normalizeExtractedText,
  sanitizePdfTitle,
  sanitizePdfAuthor,
  groupTextItemsIntoLines,
  shouldDropExtractedLine,
  isStandalonePageNumberText,
  HEADING_STRING_MIN_FONT_SIZE,
  INDENT_THRESHOLD_PX,
} from "./textNormalization.js"
import {
  annotateLinesCentered,
  extractPdfPageImageCandidatesFromOperatorList,
} from "./pdfImages.js"`,
  readBody("parser/_pdfExtract.body.js"),
  `export {
  extractLinesByPosition,
  extractPdfStructure,
  loadPdfDocument,
  extractPhasePercent,
  buildPdfPageLinesFromTextContent,
  readPdfInfo,
}`
)

counts["parser/chapterDetection.js"] = writeModule(
  "parser/chapterDetection.js",
  `import {
  extractPrintedTocLookup,
  extractPrintedTocFromPageData,
} from "../printedTocService.js"
import {
  CHAPTER_HEADING_MIN_FONT_SIZE,
  CHAPTER_PATTERN,
  CHAPTER_NUMBER_REGEX,
  PART_HEADING_PATTERN,
  STRUCTURAL_HEADING_PREFIX_REGEX,
  VOLUME_HEADING_PATTERN,
  TOC_CHAPTER_LISTING_REGEX,
  STRUCTURAL_HEADING_MAX_CHARS,
} from "./constants.js"
import {
  isCleanStructuralHeadingText,
  HEADING_STRING_MIN_FONT_SIZE,
  BOOK_TITLE_MINOR_WORDS,
  normalizeHeadingCandidate,
  PROSE_BLOCKLIST_WORD_REGEX,
} from "./textNormalization.js"
import { withSourcePdfPage } from "./pdfImages.js"`,
  readBody("parser/_chapterDetection.body.js"),
  `export {
  detectChapters,
  isChapterHeading,
  isStandaloneChapterNumber,
  qualifiesAsEmittedHeading,
  mergeChapterSubtitleBlocks,
  splitDialogueHeavyBlocks,
  applyProseBlockDefaults,
  dedupeFrontMatterTitleBlocks,
  pushHeadingBlock,
  isTocChapterListingLine,
  isDedicationStructuralBlock,
  isStructuralLine,
  isLikelyChapterNumberLine,
  consumeRepeatedSectionLabel,
  collectConsecutiveTocHeadingRun,
  isTocHeadingCandidate,
}`
)

counts["parser/buildBlocks.js"] = writeModule(
  "parser/buildBlocks.js",
  `import {
  CHAPTER_PATTERN,
  MAX_PROSE_BLOCK_CHARS,
  MAX_PROSE_BLOCK_WORDS,
  PART_HEADING_PATTERN,
  SCENE_BREAK_DIVIDER_TEXT,
  SHORT_PROSE_CONTINUATION_MAX_WORDS,
  STRUCTURAL_HEADING_PREFIX_REGEX,
  VOLUME_HEADING_PATTERN,
  MULTILINE_CHAPTER_WRAP_MIN_FONT_SIZE,
  CHAPTER_TITLE_TAIL_WORD_REGEX,
  CHAPTER_DISPLAY_FONT_SIZE,
  PRINTED_TOC_SCAN_LINE_LIMIT,
  EARLY_TOC_SCAN_LINE_LIMIT,
} from "./constants.js"
import {
  isSceneBreakDividerText,
  isPrintedTocHeading,
  isPrintedTocEntryLine,
  isStormlightPrintedTocLine,
  pushSceneBreakBlock,
  findFirstChapterBlockIndex,
  isIllustrationsListLine,
  isLargeFontAllCapsChapterWrapLine,
  isShortChapterHeadingSubtitleLine,
} from "./puaAndFrontMatter.js"
import {
  applyProseFormattingToBlock,
  buildRunsFromLineItems,
  computePageLineMetrics,
  annotatePageLineGaps,
  isScannerWatermarkLine,
  isProseLineContinuation,
  isShortProseContinuation,
  isHeadingTerminalOrStructural,
  isCleanStructuralHeadingText,
  isShortDialogueLine,
  isDialogueAttributionFragment,
  joinWrappedText,
  normalizeExtractedText,
  shouldDropExtractedLine,
  isStandalonePageNumberText,
  HEADING_STRING_MIN_FONT_SIZE,
  PROSE_BLOCKLIST_WORD_REGEX,
  isHeadingIncompleteEnding,
  isTocDenseListingLine,
  isTocPageReferenceLine,
  isRunningHeaderMergedLine,
  isNarrativeBoundaryLine,
} from "./textNormalization.js"
import { withSourcePdfPage } from "./pdfImages.js"
import {
  applyProseBlockDefaults,
  pushHeadingBlock,
  isTocChapterListingLine,
  isDedicationStructuralBlock,
  isStructuralLine,
  isLikelyChapterNumberLine,
  consumeRepeatedSectionLabel,
  collectConsecutiveTocHeadingRun,
  isTocHeadingCandidate,
} from "./chapterDetection.js"`,
  readBody("parser/_buildBlocks.body.js"),
  `export { buildBlocksFromLines }`
)

counts["parser/blockTransforms.js"] = writeModule(
  "parser/blockTransforms.js",
  `import {
  promoteStructuralSectionHeadings,
  mergeEndOfPartBlocks,
  mergeTrailingChapterTitleFragments,
  mergeInlineChapterLabelTitles,
  mergeMultilineChapterTitleBlocks,
} from "./puaAndFrontMatter.js"
import {
  mergeChapterSubtitleBlocks,
  splitDialogueHeavyBlocks,
} from "./chapterDetection.js"`,
  readBody("parser/_blockTransforms.body.js"),
  `export { applyBlockTransformPipeline, blocksToContent }`
)

counts["documents/documentService.js"] = writeModule(
  "documents/documentService.js",
  `import { supabase } from "../supabaseClient.js"
import { PARSER_VERSION, PARSE_STATUS } from "../parser/constants.js"
import {
  PARSE_GATE_UPLOAD_PRIORITY,
  runWithFullParseGate,
} from "../parse/parseGate.js"
import {
  clearDocumentParseProgress,
  getDocumentParseProgress,
  setDocumentParseProgress,
  PARSE_PROGRESS_SAVE_PERCENT,
} from "../parse/parseProgress.js"
import { countWordsFromContent } from "../parser/wordCount.js"
import { parsePdfBuffer } from "../parser/parsePdfBuffer.js"`,
  readBody("documents/_documentService.body.js", "documents/_documentService2.body.js"),
  `export {
  backgroundParseInFlight,
  parseDocumentInBackground,
  downloadStoredPdfBuffer,
  resolveWordCountForDocument,
  toPublicDocument,
  hasValidParsedCache,
  readStoredDocumentContent,
  buildParsedCacheFields,
}`
)

counts["parser/parsePdfBuffer.js"] = writeModule(
  "parser/parsePdfBuffer.js",
  `import {
  extractPrintedTocLookup,
  extractPrintedTocFromPageData,
} from "../printedTocService.js"
import { supplementBannerlessPrintedChapters } from "../stormlightEpigraphService.js"
import { terminateOcrWorker } from "../imageOcrService.js"
import {
  mergeParseProgressSnapshot,
  structurePhasePercent,
  PARSE_PROGRESS_FINALIZE_PERCENT,
  PARSE_PROGRESS_ILLUSTRATION_END_PERCENT,
  PARSE_PROGRESS_ILLUSTRATION_START_PERCENT,
  PARSE_PROGRESS_UPLOAD_MAX_PERCENT,
} from "../parse/parseProgress.js"
import {
  buildDefaultPuaReplacementMap,
  normalizeFrontAndBackMatterBlocks,
  excludePrintedTocBlocks,
  injectStormlightPreludeHeading,
} from "./puaAndFrontMatter.js"
import {
  resolveBookTitle,
  contentStartsWithBookTitle,
  sanitizePdfAuthor,
  looksLikeFilenameSlug,
  isScannerWatermarkLine,
} from "./textNormalization.js"
import {
  interleaveImageCandidateBlocks,
  finalizeIllustrationBlocks,
  uploadBookAssets,
} from "./pdfImages.js"
import {
  extractPdfStructure,
  loadPdfDocument,
  extractPhasePercent,
} from "./pdfExtract.js"
import { detectChapters, dedupeFrontMatterTitleBlocks } from "./chapterDetection.js"
import { buildBlocksFromLines } from "./buildBlocks.js"
import { applyBlockTransformPipeline, blocksToContent } from "./blockTransforms.js"
import { countWordsFromBlocks } from "./wordCount.js"`,
  readBody("parser/_parsePdfBuffer.body.js"),
  `export { parsePdfBuffer }`
)

counts["documents/reparse.js"] = writeModule(
  "documents/reparse.js",
  `import { supabase } from "../supabaseClient.js"
import { PARSER_VERSION, PARSE_STATUS } from "../parser/constants.js"
import {
  PARSE_GATE_REPARSE_PRIORITY,
  runWithFullParseGate,
} from "../parse/parseGate.js"
import { parsePdfBuffer } from "../parser/parsePdfBuffer.js"
import { isScannerWatermarkLine, isShortDialogueLine } from "../parser/textNormalization.js"
import {
  backgroundParseInFlight,
  downloadStoredPdfBuffer,
} from "./documentService.js"`,
  readBody("documents/_reparse.body.js"),
  `export {
  reparseOutdatedDocuments,
  reparseDocumentInBackgroundFromRow,
  documentNeedsReparse,
  isValidAdminSecret,
}`
)

counts["routes/documentRoutes.js"] = writeModule(
  "routes/documentRoutes.js",
  `import { supabase } from "../supabaseClient.js"
import { app, requireAuth, buildReformattedHtml } from "../app/setup.js"
import { PARSE_STATUS, PARSER_VERSION, BOOK_ASSETS_BUCKET, BOOK_ASSETS_FALLBACK_BUCKET } from "../parser/constants.js"
import {
  getDocumentParseProgress,
  mergeParseProgressSnapshot,
  clearDocumentParseProgress,
} from "../parse/parseProgress.js"
import {
  backgroundParseInFlight,
  parseDocumentInBackground,
  resolveWordCountForDocument,
  toPublicDocument,
  hasValidParsedCache,
  readStoredDocumentContent,
} from "../documents/documentService.js"`,
  readBody(
    "routes/_documentRoutes1.body.js",
    "routes/_documentHelpers.body.js",
    "routes/_documentRoutes2.body.js",
    "routes/_documentRoutes3.body.js"
  ),
  ""
)

counts["routes/uploadRoutes.js"] = writeModule(
  "routes/uploadRoutes.js",
  `import multer from "multer"
import { supabase } from "../supabaseClient.js"
import { app, requireAuth } from "../app/setup.js"
import { PARSER_VERSION, PARSE_STATUS } from "../parser/constants.js"
import { humanizeBookTitleFromFileName } from "../parser/textNormalization.js"
import { parseDocumentInBackground } from "../documents/documentService.js"
import { reparseOutdatedDocuments, isValidAdminSecret } from "../documents/reparse.js"`,
  readBody("routes/_uploadRoutes.body.js"),
  ""
)

counts["index.js"] = writeModule(
  "index.js",
  `import "dotenv/config"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { app, applyCorsHeaders } from "./app/setup.js"
import "./routes/documentRoutes.js"
import "./routes/uploadRoutes.js"

export { parsePdfBuffer } from "./parser/parsePdfBuffer.js"
export { extractLinesByPosition } from "./parser/pdfExtract.js"
export { normalizeExtractedText } from "./parser/textNormalization.js"
export {
  classifyPdfImageRole,
  isChapterHeaderCandidate,
  PDF_IMAGE_ROLE,
  interleaveImageCandidateBlocks,
  finalizeIllustrationBlocks,
  uploadBookAssets,
} from "./parser/pdfImages.js"
export { PARSER_VERSION } from "./parser/constants.js"`,
  `const isServerEntryPoint =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])

app.use((error, req, res, _next) => {
  applyCorsHeaders(req, res)
  console.error(
    \`[server] \${req.method} \${req.path}:\`,
    error instanceof Error ? error.message : String(error)
  )

  if (!res.headersSent) {
    res.status(500).json({ success: false, error: "Internal server error" })
  }
})

if (isServerEntryPoint) {
  const PORT = process.env.PORT || 3000
  app.listen(PORT, () => {
    console.log(\`Server on port \${PORT}\`)

    if (process.env.BOOKY_REPARSE_ON_BOOT === "1") {
      import("./documents/reparse.js").then(({ reparseOutdatedDocuments }) => {
        setTimeout(async () => {
          try {
            const summary = await reparseOutdatedDocuments({ limit: 3 })
            if (summary.reparsed > 0 || summary.failed.length > 0) {
              console.log(
                \`Background re-parse: \${summary.reparsed} updated, \${summary.failed.length} failed, \${summary.skipped} skipped\`
              )
            }
          } catch (error) {
            console.error(
              "Background re-parse failed:",
              error instanceof Error ? error.message : "Unknown error"
            )
          }
        }, 5_000)
      })
    }
  })
}`,
  ""
)

console.log("Assembled modules:", counts)
