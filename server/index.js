import "dotenv/config"
import path from "node:path"
import zlib from "node:zlib"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import express from "express"
import multer from "multer"
import { clerkMiddleware, getAuth } from "@clerk/express"
import { createClient } from "@supabase/supabase-js"
import crypto from "node:crypto"
import { getDocument, OPS, ImageKind } from "pdfjs-dist/legacy/build/pdf.mjs"
import { createCanvas, loadImage } from "@napi-rs/canvas/node-canvas.js"
import {
  analyzeChapterGraphicFromContext,
  shouldSkipChapterGraphicAnalysis,
  SAFE_FALLBACK,
} from "./chapterGraphicService.js"
import {
  countInterludeNamesInDivider,
  ocrIllustrationMetadata,
  terminateOcrWorker,
} from "./imageOcrService.js"
import {
  classifyPdfImageRole,
  isChapterLikeOcrMetadata,
  isFullPageHeightIllustrationBlock,
  isFullPageSpreadHalf,
  isLikelyChapterArchBannerBlock,
  isTallChapterArchBannerBlock,
  PDF_IMAGE_ROLE,
} from "./pdfImageRoleUtils.js"
import {
  extractPrintedTocLookup,
  extractPrintedTocFromPageData,
  lookupPrintedTocTitle,
  parseSpelledChapterMarker,
} from "./printedTocService.js"
import {
  buildReformattedHtml,
  buildReformattedPdfBuffer,
} from "./reformattedExportService.js"
import {
  advanceTocCursorPastNextPartDivider,
  extractChapterKeyFromOcrNumber,
  isLastChapterSlotBeforePart,
  scanPendingInterludesFromBlocks,
  scanStructuralPartDividerPlate,
  seekTocCursorToFirstChapterAfterNthPart,
  takeNextSequentialInterludeTocEntry,
  takeNextSequentialTocEntryForImageBanner,
} from "./stormlightEpigraphService.js"

const PARSER_VERSION = 136
const BOOKY_BB_DEBUG = process.env.BOOKY_BB_DEBUG === "1"
const BOOKY_TOC_MISS_DEBUG = process.env.BOOKY_TOC_MISS_DEBUG === "1"
const BOOKY_TOC_ORDER_DEBUG = process.env.BOOKY_TOC_ORDER_DEBUG === "1"

function bbNormalizeLetters(text) {
  return (text ?? "").replace(/\s+/g, "").toLowerCase()
}

function bbMatchesPhrase(text) {
  return bbNormalizeLetters(text).includes("downwithbigbrother")
}

function bbLog(stage, payload) {
  if (!BOOKY_BB_DEBUG) {
    return
  }
  console.log("[bb]", stage, JSON.stringify(payload))
}
const PDF_IMAGE_JPEG_CONTENT_TYPE = "image/jpeg"

const PDF_IMAGE_PAINT_OPS = new Set(
  [OPS.paintImageXObject, OPS.paintInlineImageXObject].filter((op) => op != null)
)
const PDF_IMAGE_RESOLVE_TIMEOUT_MS = 8000
const PDF_PAGE_OPERATION_TIMEOUT_MS = 45_000
const PDF_LARGE_BOOK_PAGE_THRESHOLD = 120
const PDF_LARGE_FILE_BYTES = 12 * 1024 * 1024
const BOOK_ASSET_UPLOAD_CONCURRENCY = 2
const BOOK_ASSET_UPLOAD_MAX_RETRIES = 6
const BOOK_ASSET_UPLOAD_RETRY_BASE_MS = 1200
const BOOK_ASSETS_BUCKET = "book-assets"
const BOOK_ASSETS_FALLBACK_BUCKET = process.env.BOOK_ASSETS_FALLBACK_BUCKET ?? "pdfs"
const BOOK_ASSET_SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365
const PDF_IMAGE_MIN_DIMENSION_PX = 8

const PUA_FALLBACK_MAP = {
  "\uE002": "Th",
  "\uE053": "Th",
  "\uE076": "ct",
  "\uF643": "0",
  "\uF644": "1",
  "\uF645": "2",
  "\uF646": "3",
  "\uF647": "4",
  "\uF648": "5",
  "\uF649": "6",
  "\uF64A": "7",
  "\uF64B": "8",
  "\uF64C": "9",
}

const MAX_PROSE_BLOCK_WORDS = 80
const MAX_PROSE_BLOCK_CHARS = 500
const SHORT_PROSE_CONTINUATION_MAX_WORDS = 20

const PARSE_STATUS = {
  PENDING: "pending",
  READY: "ready",
  ERROR: "error",
}

const backgroundParseInFlight = new Set()
const cancelledBackgroundParses = new Set()
const MAX_CONCURRENT_FULL_PARSES = 1
let fullParseActiveCount = 0
/** @type {Array<{ resolve: () => void, reject: (error: Error) => void, priority: number, documentId: string|null }>} */
const fullParseWaitQueue = []
const PARSE_GATE_UPLOAD_PRIORITY = 10
const PARSE_GATE_REPARSE_PRIORITY = 0

function isFullParseGateFree() {
  return fullParseActiveCount < MAX_CONCURRENT_FULL_PARSES
}

function releaseFullParseSlot() {
  fullParseActiveCount = Math.max(0, fullParseActiveCount - 1)
  const next = fullParseWaitQueue.shift()
  if (next) {
    next.resolve()
  }
}

function tryAcquireFullParseSlot() {
  if (fullParseActiveCount >= MAX_CONCURRENT_FULL_PARSES) {
    return null
  }
  fullParseActiveCount += 1
  return releaseFullParseSlot
}

function enqueueFullParseWaiter(entry) {
  const insertBefore = fullParseWaitQueue.findIndex(
    (item) => item.priority < entry.priority
  )
  if (insertBefore === -1) {
    fullParseWaitQueue.push(entry)
  } else {
    fullParseWaitQueue.splice(insertBefore, 0, entry)
  }
}

function assertParseNotCancelled(documentId) {
  if (documentId && cancelledBackgroundParses.has(documentId)) {
    throw new Error("PARSE_CANCELLED")
  }
}

function cancelBackgroundParse(documentId) {
  if (!documentId) {
    return
  }

  cancelledBackgroundParses.add(documentId)
  clearDocumentParseProgress(documentId)

  for (let index = fullParseWaitQueue.length - 1; index >= 0; index -= 1) {
    const entry = fullParseWaitQueue[index]
    if (entry.documentId === documentId) {
      fullParseWaitQueue.splice(index, 1)
      entry.reject(new Error("PARSE_CANCELLED"))
    }
  }
}

function clearCancelledBackgroundParse(documentId) {
  if (documentId) {
    cancelledBackgroundParses.delete(documentId)
  }
}

async function acquireFullParseSlot(priority = 0, documentId = null) {
  while (fullParseActiveCount >= MAX_CONCURRENT_FULL_PARSES) {
    assertParseNotCancelled(documentId)
    await new Promise((resolve, reject) => {
      if (documentId && cancelledBackgroundParses.has(documentId)) {
        reject(new Error("PARSE_CANCELLED"))
        return
      }
      enqueueFullParseWaiter({ resolve, reject, priority, documentId })
    })
  }
  fullParseActiveCount += 1
  return releaseFullParseSlot
}

async function runWithFullParseGate(task, { wait = true, priority = 0, onWaiting, documentId = null } = {}) {
  let release = wait ? null : tryAcquireFullParseSlot()
  if (!release && wait) {
    onWaiting?.()
    release = await acquireFullParseSlot(priority, documentId)
  }
  if (!release) {
    return { skipped: true }
  }

  try {
    return await task()
  } finally {
    release()
  }
}

const documentParseProgress = new Map()
const parseProgressDbWriteAt = new Map()
const PARSE_PROGRESS_DB_WRITE_MS = 750
const PDF_PAGE_EXTRACTION_CONCURRENCY = 6
const PDF_TEXT_EXTRACTION_CONCURRENCY = 8
const EXTRACT_PROGRESS_TEXT_SHARE = 0.62
const EXTRACT_PROGRESS_IMAGE_SHARE = 0.38

function resolvePdfExtractionConcurrency(totalPages, byteLength = 0) {
  const configuredText = Number(process.env.BOOKY_TEXT_EXTRACTION_CONCURRENCY)
  const configuredImage = Number(process.env.BOOKY_IMAGE_EXTRACTION_CONCURRENCY)

  let text = PDF_TEXT_EXTRACTION_CONCURRENCY
  let image = PDF_PAGE_EXTRACTION_CONCURRENCY

  // Large illustrated PDFs on Render free tier (512MB): parallel page reads OOM or hang.
  if (totalPages > 900 || byteLength >= PDF_LARGE_FILE_BYTES * 4) {
    text = 1
    image = 1
  } else if (totalPages > 400 || byteLength >= PDF_LARGE_FILE_BYTES) {
    text = 2
    image = 1
  } else if (totalPages >= PDF_LARGE_BOOK_PAGE_THRESHOLD) {
    text = 3
    image = 2
  }

  if (Number.isFinite(configuredText) && configuredText > 0) {
    text = Math.min(configuredText, text)
  }
  if (Number.isFinite(configuredImage) && configuredImage > 0) {
    image = Math.min(configuredImage, image)
  }

  return { text, image }
}

const PARSE_PROGRESS_EXTRACT_MAX_PERCENT = 58
const PARSE_PROGRESS_STRUCTURE_PERCENT = 62
const PARSE_PROGRESS_ILLUSTRATION_START_PERCENT = 63
const PARSE_PROGRESS_ILLUSTRATION_END_PERCENT = 80
const PARSE_PROGRESS_UPLOAD_MAX_PERCENT = 93
const PARSE_PROGRESS_FINALIZE_PERCENT = 96
const PARSE_PROGRESS_SAVE_PERCENT = 98

function structurePhasePercent(structureStep, current = 0, total = 0) {
  const base = PARSE_PROGRESS_EXTRACT_MAX_PERCENT
  const span = PARSE_PROGRESS_STRUCTURE_PERCENT - base

  if (structureStep === "lines" && total > 0) {
    return Math.round(base + (current / total) * span * 0.45)
  }
  if (structureStep === "transform") {
    return Math.round(base + span * 0.55)
  }
  if (structureStep === "outline") {
    return Math.round(base + span * 0.75)
  }
  if (structureStep === "interleave" && total > 0) {
    return Math.round(base + span * (0.8 + (current / total) * 0.2))
  }
  return Math.round(base + span * 0.5)
}

function parseProgressPhaseRank(phase) {
  const ranks = {
    starting: 0,
    extracting: 1,
    structuring: 2,
    classifying_illustrations: 3,
    ocr_illustrations: 4,
    uploading_assets: 5,
    finalizing: 6,
    saving: 7,
    ready: 8,
    error: 9,
  }
  return ranks[phase] ?? -1
}

function emptyParseCounters() {
  return {
    pages: { current: 0, total: 0 },
    illustrations: { current: 0, total: 0 },
    ocr: { current: 0, total: 0 },
    uploads: { current: 0, total: 0 },
  }
}

function bumpParseCounter(counter, current, total) {
  const next = { ...counter }
  if (typeof current === "number") {
    next.current = Math.max(next.current ?? 0, current)
  }
  if (typeof total === "number" && total > 0) {
    next.total = total
  }
  return next
}

function shouldResetExtractImagePageCounter(previousSubphase) {
  return (
    previousSubphase == null ||
    previousSubphase === "text" ||
    previousSubphase === "text_complete"
  )
}

function activeCountersForPhase(phase, counters) {
  if (phase === "extracting") {
    return counters.pages
  }
  if (phase === "structuring") {
    return counters.pages
  }
  if (phase === "classifying_illustrations") {
    return counters.illustrations
  }
  if (phase === "ocr_illustrations") {
    return counters.ocr
  }
  if (phase === "uploading_assets") {
    return counters.uploads
  }
  return { current: 0, total: 0 }
}

function mergeParseProgressSnapshot(previous, patch) {
  if (!patch) {
    return previous ?? null
  }

  if (patch.phase === "ready" || patch.phase === "error") {
    return patch
  }

  const prev = previous ?? {}
  const prevRank = parseProgressPhaseRank(prev.phase)
  const patchRank = parseProgressPhaseRank(patch.phase ?? prev.phase)

  if (patch.phase && patchRank < prevRank) {
    // finalizeIllustrationBlocks interleaves classification-only and OCR
    // candidates in one loop, so classification updates keep arriving after
    // the snapshot phase has advanced to ocr_illustrations. Dropping them
    // froze the illustrations counter short of its total for the rest of the
    // phase; fold their counter progress in while keeping the later phase.
    if (
      patch.phase === "classifying_illustrations" &&
      prev.phase === "ocr_illustrations"
    ) {
      const illustrations = bumpParseCounter(
        {
          ...emptyParseCounters().illustrations,
          ...(prev.counters?.illustrations ?? {}),
        },
        patch.illustrationCurrent ?? patch.current,
        patch.illustrationTotal ?? patch.total
      )
      return {
        ...prev,
        counters: { ...(prev.counters ?? emptyParseCounters()), illustrations },
        illustrationCurrent: illustrations.current,
        illustrationTotal: illustrations.total,
        percent: Math.max(prev.percent ?? 0, patch.percent ?? 0),
        updatedAt: Date.now(),
      }
    }
    return {
      ...prev,
      percent: Math.max(prev.percent ?? 0, patch.percent ?? 0),
    }
  }

  const phase =
    patch.phase && patchRank >= prevRank ? patch.phase : prev.phase ?? patch.phase

  const counters = {
    pages: { ...emptyParseCounters().pages, ...(prev.counters?.pages ?? {}) },
    illustrations: {
      ...emptyParseCounters().illustrations,
      ...(prev.counters?.illustrations ?? {}),
    },
    ocr: { ...emptyParseCounters().ocr, ...(prev.counters?.ocr ?? {}) },
    uploads: { ...emptyParseCounters().uploads, ...(prev.counters?.uploads ?? {}) },
  }

  const effectivePhase = patch.phase ?? prev.phase

  if (effectivePhase === "extracting" || effectivePhase === "structuring") {
    const subphase = patch?.extractSubphase ?? prev?.extractSubphase
    if (subphase === "images") {
      const imageBase = shouldResetExtractImagePageCounter(prev?.extractSubphase)
        ? { current: 0, total: patch?.total ?? counters.pages.total }
        : counters.pages
      counters.pages = bumpParseCounter(imageBase, patch.current, patch.total)
    } else if (subphase === "filtering") {
      const filterBase =
        prev?.extractSubphase === "filtering"
          ? counters.pages
          : { current: 0, total: patch?.total ?? counters.pages.total }
      counters.pages = bumpParseCounter(filterBase, patch.current, patch.total)
    } else {
      counters.pages = bumpParseCounter(counters.pages, patch.current, patch.total)
    }
  }

  if (effectivePhase === "classifying_illustrations") {
    counters.illustrations = bumpParseCounter(
      counters.illustrations,
      patch.illustrationCurrent ?? patch.current,
      patch.illustrationTotal ?? patch.total
    )
  }

  if (effectivePhase === "ocr_illustrations") {
    counters.ocr = bumpParseCounter(
      counters.ocr,
      patch.ocrCurrent ?? patch.current,
      patch.ocrTotal ?? patch.total
    )
    if (patch.illustrationTotal > 0 || typeof patch.illustrationCurrent === "number") {
      counters.illustrations = bumpParseCounter(
        counters.illustrations,
        patch.illustrationCurrent,
        patch.illustrationTotal
      )
    }
  }

  if (effectivePhase === "uploading_assets") {
    counters.uploads = bumpParseCounter(counters.uploads, patch.current, patch.total)
  }

  const active = activeCountersForPhase(phase, counters)
  const imageBufferCurrent =
    typeof patch.imageBufferCurrent === "number"
      ? Math.max(prev.imageBufferCurrent ?? 0, patch.imageBufferCurrent)
      : prev.imageBufferCurrent
  const imageBufferTotal =
    typeof patch.imageBufferTotal === "number" && patch.imageBufferTotal > 0
      ? patch.imageBufferTotal
      : prev.imageBufferTotal

  return {
    ...prev,
    ...patch,
    phase,
    counters,
    current: active.current,
    total: active.total,
    percent: Math.max(prev.percent ?? 0, patch.percent ?? prev.percent ?? 0),
    extractSubphase:
      phase === "extracting"
        ? patch.extractSubphase ?? prev.extractSubphase
        : undefined,
    structureStep:
      phase === "structuring" || phase === "classifying_illustrations"
        ? patch.structureStep ?? prev.structureStep
        : undefined,
    usingPrintedToc:
      patch.usingPrintedToc == null ? prev.usingPrintedToc : patch.usingPrintedToc,
    illustrationCurrent: counters.illustrations.current,
    illustrationTotal: counters.illustrations.total,
    ocrCurrent: counters.ocr.current,
    ocrTotal: counters.ocr.total,
    pageCurrent: counters.pages.current,
    pageTotal: counters.pages.total,
    uploadCurrent: counters.uploads.current,
    uploadTotal: counters.uploads.total,
    imageBufferCurrent,
    imageBufferTotal,
    updatedAt: Date.now(),
  }
}

function setDocumentParseProgress(documentId, progress) {
  const previous = documentParseProgress.get(documentId)
  const merged = mergeParseProgressSnapshot(previous, progress)
  documentParseProgress.set(documentId, merged)

  const now = Date.now()
  const lastWrite = parseProgressDbWriteAt.get(documentId) ?? 0
  const phaseChanged = previous?.phase !== merged?.phase
  const structureStepChanged = previous?.structureStep !== merged?.structureStep
  const extractSubphaseChanged = previous?.extractSubphase !== merged?.extractSubphase
  const pageChanged =
    (merged?.phase === "extracting" || merged?.phase === "structuring") &&
    typeof merged.pageCurrent === "number" &&
    merged.pageCurrent !== previous?.pageCurrent
  const ocrChanged =
    merged?.phase === "ocr_illustrations" &&
    typeof merged.ocrCurrent === "number" &&
    merged.ocrCurrent !== previous?.ocrCurrent
  const illustrationChanged =
    (merged?.phase === "classifying_illustrations" ||
      merged?.phase === "ocr_illustrations") &&
    typeof merged.illustrationCurrent === "number" &&
    merged.illustrationCurrent !== previous?.illustrationCurrent

  const imageBufferChanged =
    typeof merged?.imageBufferCurrent === "number" &&
    merged.imageBufferCurrent !== previous?.imageBufferCurrent

  if (
    phaseChanged ||
    structureStepChanged ||
    extractSubphaseChanged ||
    pageChanged ||
    illustrationChanged ||
    ocrChanged ||
    imageBufferChanged ||
    merged?.phase === "starting" ||
    merged?.phase === "extracting" ||
    merged?.phase === "error" ||
    merged?.phase === "saving" ||
    now - lastWrite >= PARSE_PROGRESS_DB_WRITE_MS
  ) {
    parseProgressDbWriteAt.set(documentId, now)
    void supabase
      .from("documents")
      .update({ parse_progress: merged })
      .eq("id", documentId)
      .then(({ error }) => {
        if (error) {
          console.warn(
            `[parse-progress] Failed to persist progress for ${documentId}:`,
            error.message
          )
        }
      })
  }
}

function getDocumentParseProgress(documentId) {
  return documentParseProgress.get(documentId) ?? null
}

function clearDocumentParseProgress(documentId) {
  documentParseProgress.delete(documentId)
  parseProgressDbWriteAt.delete(documentId)
  void supabase
    .from("documents")
    .update({ parse_progress: null })
    .eq("id", documentId)
    .then(({ error }) => {
      if (error) {
        console.warn(
          `[parse-progress] Failed to clear progress for ${documentId}:`,
          error.message
        )
      }
    })
}

// Single write path for parse_status so a failed Supabase update is always
// logged - a silently dropped ERROR write leaves a document stuck "pending"
// with no trace of why.
async function setDocumentParseStatus(documentId, parseStatus, userId = null) {
  let query = supabase
    .from("documents")
    .update({ parse_status: parseStatus })
    .eq("id", documentId)
  if (userId) {
    query = query.eq("user_id", userId)
  }
  const { error } = await query
  if (error) {
    console.error(
      `[parse-status] Failed to set parse_status=${parseStatus} for ${documentId}:`,
      error.message
    )
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const app = express()

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:4173",
  "https://booky-lemon.vercel.app",
]

function normalizeOrigin(origin) {
  if (!origin || typeof origin !== "string") {
    return null
  }
  return origin.replace(/\/$/, "")
}

function isAllowedOrigin(origin) {
  const normalized = normalizeOrigin(origin)
  if (!normalized) {
    return false
  }

  if (ALLOWED_ORIGINS.includes(normalized)) {
    return true
  }

  const clientUrl = normalizeOrigin(process.env.CLIENT_URL)
  if (clientUrl && normalized === clientUrl) {
    return true
  }

  for (const entry of (process.env.ALLOWED_ORIGINS ?? "").split(",")) {
    if (normalizeOrigin(entry.trim()) === normalized) {
      return true
    }
  }

  return /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(normalized)
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Access-Control-Allow-Credentials", "true")
    res.setHeader("Vary", "Origin")
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  )
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  res.setHeader("Access-Control-Max-Age", "86400")
}

// 1. CORS first — answer preflight before Clerk or auth middleware
app.use((req, res, next) => {
  applyCorsHeaders(req, res)

  if (req.method === "OPTIONS") {
    res.sendStatus(204)
    return
  }

  next()
})

// 2. Clerk middleware after CORS
app.use(clerkMiddleware())

// 3. JSON body parser after Clerk
app.use(express.json())

app.get("/", (req, res) => res.json({ message: "Booky API running" }))

function requireAuth(req, res, next) {
  const { userId } = getAuth(req)
  if (!userId) {
    return res.status(401).json({ success: false, error: "Unauthorized" })
  }
  req.userId = userId
  next()
}

app.get("/documents/:id/status", requireAuth, async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from("documents")
      .select("id, parse_status, parse_progress")
      .eq("id", id)
      .eq("user_id", req.userId)
      .single()

    if (error || !data) {
      res.status(404).json({ success: false, error: "Document not found" })
      return
    }

    const parseStatus = data.parse_status ?? PARSE_STATUS.READY
    const liveProgress = getDocumentParseProgress(data.id)
    const persistedProgress = data.parse_progress ?? null
    const parseProgress =
      liveProgress && persistedProgress
        ? mergeParseProgressSnapshot(persistedProgress, liveProgress)
        : liveProgress ?? persistedProgress

    res.json({
      success: true,
      id: data.id,
      parse_status: parseStatus,
      parse_progress: parseProgress,
      parse_percent:
        parseStatus === PARSE_STATUS.READY
          ? 100
          : (parseProgress?.percent ?? 0),
    })
  } catch {
    res.status(500).json({ success: false, error: "Failed to fetch document status" })
  }
})

app.get("/documents", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("documents")
      .select("id, name, total_pages, word_count, created_at, parse_status")
      .eq("user_id", req.userId)
      .order("created_at", { ascending: false })

    if (error) {
      res.status(500).json({ success: false, error: "Failed to fetch documents" })
      return
    }

    const documents = await Promise.all(
      (data ?? []).map(async (documentRow) => {
        const parseStatus = documentRow.parse_status ?? PARSE_STATUS.READY
        const wordCount =
          parseStatus === PARSE_STATUS.PENDING
            ? 0
            : await resolveWordCountForDocument(documentRow, req.userId)
        return toPublicDocument(documentRow, wordCount)
      })
    )

    res.json({
      success: true,
      documents,
    })
  } catch {
    res.status(500).json({ success: false, error: "Failed to fetch documents" })
  }
})

async function listStorageObjectPaths(bucket, folderPath) {
  const paths = []
  const queue = [folderPath.replace(/\/$/, "")]

  while (queue.length > 0) {
    const currentPath = queue.shift()
    const { data, error } = await supabase.storage.from(bucket).list(currentPath, {
      limit: 1000,
    })

    if (error || !Array.isArray(data)) {
      continue
    }

    for (const entry of data) {
      const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
      if (entry.metadata == null) {
        queue.push(entryPath)
      } else {
        paths.push(entryPath)
      }
    }
  }

  return paths
}

async function removeStoragePaths(bucket, paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return
  }

  const chunkSize = 100
  for (let index = 0; index < paths.length; index += chunkSize) {
    const chunk = paths.slice(index, index + chunkSize)
    const { error } = await supabase.storage.from(bucket).remove(chunk)
    if (error) {
      console.warn(`[deleteDocument] Failed to remove ${chunk.length} objects from ${bucket}:`, error.message)
    }
  }
}

async function deleteBookIllustrationAssets(documentId) {
  const assetPrefix = `books/${documentId}`
  const buckets = new Set([BOOK_ASSETS_BUCKET, BOOK_ASSETS_FALLBACK_BUCKET])

  for (const bucket of buckets) {
    const paths = await listStorageObjectPaths(bucket, assetPrefix)
    await removeStoragePaths(bucket, paths)

    const nestedPrefix = `${BOOK_ASSETS_BUCKET}/${assetPrefix}`
    if (bucket === BOOK_ASSETS_FALLBACK_BUCKET) {
      const nestedPaths = await listStorageObjectPaths(bucket, nestedPrefix)
      await removeStoragePaths(bucket, nestedPaths)
    }
  }
}

app.delete("/documents/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params

    cancelBackgroundParse(id)

    const { data: document, error: fetchError } = await supabase
      .from("documents")
      .select("storage_path")
      .eq("id", id)
      .eq("user_id", req.userId)
      .single()

    if (fetchError || !document) {
      res.status(404).json({ success: false, error: "Document not found" })
      return
    }

    if (document.storage_path) {
      const { error: storageError } = await supabase.storage
        .from("pdfs")
        .remove([document.storage_path])

      if (storageError) {
        console.warn(`[deleteDocument] PDF remove failed for ${id}:`, storageError.message)
      }
    }

    try {
      await deleteBookIllustrationAssets(id)
    } catch (error) {
      console.warn(
        `[deleteDocument] Illustration cleanup failed for ${id}:`,
        error instanceof Error ? error.message : String(error)
      )
    }

    const { error: deleteError } = await supabase
      .from("documents")
      .delete()
      .eq("id", id)
      .eq("user_id", req.userId)

    if (deleteError) {
      res.status(500).json({ success: false, error: "Delete failed" })
      return
    }

    res.json({ success: true })
  } catch (error) {
    console.error(
      `[deleteDocument] ${req.params.id}:`,
      error instanceof Error ? error.message : String(error)
    )
    res.status(500).json({ success: false, error: "Delete failed" })
  }
})

app.patch("/documents/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : ""

    if (!name) {
      res.status(400).json({ success: false, error: "Name is required" })
      return
    }

    const { data, error } = await supabase
      .from("documents")
      .update({ name })
      .eq("id", id)
      .eq("user_id", req.userId)
      .select("id, name, total_pages, word_count, created_at")
      .single()

    if (error || !data) {
      res.status(500).json({ success: false, error: "Update failed" })
      return
    }

    res.json({
      success: true,
      document: data,
    })
  } catch {
    res.status(500).json({ success: false, error: "Update failed" })
  }
})

app.get("/documents/:id/download", requireAuth, async (req, res) => {
  try {
    const { id } = req.params

    const { data: document, error: documentError } = await supabase
      .from("documents")
      .select("storage_path")
      .eq("id", id)
      .eq("user_id", req.userId)
      .single()

    if (documentError || !document?.storage_path) {
      res.status(404).json({ success: false, error: "Document not found" })
      return
    }

    const { data, error } = await supabase.storage
      .from("pdfs")
      .createSignedUrl(document.storage_path, 60)

    if (error || !data?.signedUrl) {
      res.status(500).json({ success: false, error: "Failed to create download URL" })
      return
    }

    res.json({ url: data.signedUrl })
  } catch {
    res.status(500).json({ success: false, error: "Failed to prepare download" })
  }
})

app.get("/documents/:id/download/reformatted", requireAuth, async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from("documents")
      .select("name, content, parse_status")
      .eq("id", id)
      .eq("user_id", req.userId)
      .single()

    if (error || !data) {
      res.status(404).json({ success: false, error: "Document not found" })
      return
    }

    const parseStatus = data.parse_status ?? PARSE_STATUS.READY
    if (parseStatus !== PARSE_STATUS.READY) {
      res.status(409).json({
        success: false,
        error: "Document is still processing. Try again shortly.",
      })
      return
    }

    if (!Array.isArray(data.content) || data.content.length === 0) {
      res.status(422).json({
        success: false,
        error: "No reformatted content available for this document.",
      })
      return
    }

    const safeFileName = (data.name || "document").replace(/[^\w.\- ]+/g, "_")
    const format = String(req.query.format ?? "html").toLowerCase()

    if (format === "pdf") {
      const pdfBuffer = await buildReformattedPdfBuffer(data.name, data.content)
      res.setHeader("Content-Type", "application/pdf")
      res.setHeader("Content-Length", String(pdfBuffer.length))
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeFileName} (reformatted).pdf"`
      )
      res.end(pdfBuffer)
      return
    }

    if (format !== "html") {
      res.status(400).json({
        success: false,
        error: 'Unsupported format. Use "html" or "pdf".',
      })
      return
    }

    const html = buildReformattedHtml(data.name, data.content)
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFileName} (reformatted).html"`
    )
    res.send(html)
  } catch (error) {
    console.error("[download/reformatted]", error)
    res.status(500).json({ success: false, error: "Failed to build reformatted document" })
  }
})

app.get("/documents/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from("documents")
      .select(
        "id, name, total_pages, chapters, content, parser_version, parse_status, parsed_cache, parsed_cache_version, storage_path"
      )
      .eq("id", id)
      .eq("user_id", req.userId)
      .single()

    if (error || !data) {
      res.status(404).json({ success: false, error: "Document not found" })
      return
    }

    const parseStatus = data.parse_status ?? PARSE_STATUS.READY
    if (parseStatus === PARSE_STATUS.PENDING) {
      res.json({
        success: true,
        document: {
          id: data.id,
          name: data.name,
          parse_status: parseStatus,
          total_pages: data.total_pages ?? 0,
        },
      })
      return
    }

    if (parseStatus === PARSE_STATUS.ERROR) {
      res.status(422).json({
        success: false,
        error: "Document processing failed. Try uploading again.",
        parse_status: parseStatus,
      })
      return
    }

    const cached = readStoredDocumentContent(data)
    if (cached) {
      res.json({
        success: true,
        document: buildOpenDocumentPayload(data, cached),
      })
      return
    }

    if (documentNeedsReparse(data)) {
      const storedContent = readStoredDocumentContent(data)

      // Never block open on a full PDF re-parse (large books can take minutes).
      if (storedContent) {
        void reparseDocumentInBackgroundFromRow(data, { skipIfParseBusy: true })
        res.json({
          success: true,
          document: buildOpenDocumentPayload(data, storedContent),
        })
        return
      }

      void reparseDocumentInBackgroundFromRow(data, { skipIfParseBusy: false })
      res.json({
        success: true,
        document: {
          id: data.id,
          name: data.name,
          parse_status: PARSE_STATUS.PENDING,
          total_pages: data.total_pages ?? 0,
        },
      })
      return
    }

    res.json({
      success: true,
      document: {
        id: data.id,
        name: data.name,
        total_pages: data.total_pages,
        chapters: data.chapters,
        content: data.content,
        parser_version: data.parser_version ?? PARSER_VERSION,
      },
    })
  } catch (error) {
    console.error(`[documents] Failed to load document ${req.params.id}:`, error)
    res.status(500).json({ success: false, error: "Failed to load document." })
  }
})

app.post("/documents/:id/reparse", requireAuth, async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from("documents")
      .select("id, name, storage_path, parser_version, content")
      .eq("id", id)
      .eq("user_id", req.userId)
      .single()

    if (error || !data) {
      res.status(404).json({ success: false, error: "Document not found" })
      return
    }

    const result = await reparseDocumentIfOutdated(data, { force: true })

    const refreshed = await supabase
      .from("documents")
      .select("id, name, total_pages, chapters, content, parser_version")
      .eq("id", id)
      .eq("user_id", req.userId)
      .single()

    if (refreshed.error || !refreshed.data) {
      res.status(500).json({ success: false, error: "Failed to load updated document" })
      return
    }

    res.json({
      success: true,
      reparsed: result.updated,
      document: {
        id: refreshed.data.id,
        name: refreshed.data.name,
        total_pages: refreshed.data.total_pages,
        chapters: refreshed.data.chapters,
        content: refreshed.data.content,
        parser_version: refreshed.data.parser_version ?? PARSER_VERSION,
      },
    })
  } catch (error) {
    console.error(`[documents] Re-parse failed for ${req.params.id}:`, error)
    res.status(500).json({ success: false, error: "Failed to re-parse document." })
  }
})

app.post("/documents/:id/retry-parse", requireAuth, async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from("documents")
      .select("id, name, storage_path, parse_status")
      .eq("id", id)
      .eq("user_id", req.userId)
      .single()

    if (error || !data) {
      res.status(404).json({ success: false, error: "Document not found" })
      return
    }

    if (!data.storage_path) {
      res.status(422).json({ success: false, error: "No source PDF available to retry." })
      return
    }

    const parseStatus = data.parse_status ?? PARSE_STATUS.READY
    if (parseStatus === PARSE_STATUS.READY) {
      res.json({ success: true, alreadyReady: true })
      return
    }

    if (backgroundParseInFlight.has(id)) {
      res.json({ success: true, alreadyRunning: true })
      return
    }

    await supabase
      .from("documents")
      .update({
        parse_status: PARSE_STATUS.PENDING,
        parse_progress: null,
      })
      .eq("id", id)
      .eq("user_id", req.userId)

    scheduleBackgroundParse(id, req.userId, data.storage_path, data.name ?? "")

    res.json({ success: true, retrying: true })
  } catch (error) {
    console.error(`[documents] Retry-parse failed for ${req.params.id}:`, error)
    res.status(500).json({ success: false, error: "Failed to retry processing." })
  }
})

const CHAPTER_WORD_NUMBERS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty"

const CHAPTER_PATTERN = new RegExp(
  `^(?:(?:chapter|letter|part|section|book|volume|preface|introduction|prologue|epilogue|conclusion|appendix|stave)\\s+(?:\\d+|[ivxlcdm]+|${CHAPTER_WORD_NUMBERS})|(?:preface|introduction|prologue|epilogue|conclusion|dedication|contents))\\.?$`,
  "i"
)

const STRUCTURAL_HEADING_PREFIX_REGEX =
  /^(chapter|letter|part|section|book|volume|preface|introduction|prologue|epilogue|conclusion|appendix|stave)\s+/i

const PART_HEADING_PATTERN =
  /^part\s+(\d+|[ivxlcdm]+|one|two|three|four|five|six)\.?$/i

const COMPACT_PART_HEADING_REGEX =
  /^part\s*(i{1,3}|iv|v|vi{0,3}|ix|x|xi{0,3}|xii{0,3})\s*:?\s*$/i

const EMBEDDED_PART_WITH_SUBTITLE_REGEX =
  /\bpart(i{1,3}|iv|v|vi{0,3}|ix|x)\s*:\s*(.+)$/i

const PART_WORD_TO_ROMAN = {
  one: "I",
  two: "II",
  three: "III",
  four: "IV",
  five: "V",
  six: "VI",
}

function formatPartHeadingLabel(romanOrWord) {
  const key = (romanOrWord ?? "").toLowerCase()
  const roman = PART_WORD_TO_ROMAN[key] ?? String(romanOrWord ?? "").toUpperCase()
  return `Part ${roman}`
}

const PART_ORDINAL_TOKEN_VALUES = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
}

// Normalizes a part ordinal token ("One", "iii", "4") to its numeric value so
// printed-TOC part keys and text part-heading tokens compare across numbering
// styles. Returns null for anything outside parts 1-10.
function resolvePartOrdinalValue(token) {
  const key = (token ?? "").toString().trim().toLowerCase()
  if (!key) {
    return null
  }
  if (/^\d{1,2}$/.test(key)) {
    const value = Number.parseInt(key, 10)
    return value >= 1 && value <= 10 ? value : null
  }
  return PART_ORDINAL_TOKEN_VALUES[key] ?? null
}

function parseCompactPartHeading(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return null
  }
  const match = trimmed.match(COMPACT_PART_HEADING_REGEX)
  if (!match) {
    return null
  }
  return formatPartHeadingLabel(match[1])
}

function resolvePartHeadingLabel(text) {
  const compact = parseCompactPartHeading(text)
  if (compact) {
    return compact
  }
  const normalized = normalizeHeadingCandidate(text)
  if (PART_HEADING_PATTERN.test(normalized)) {
    const match = normalized.match(/^part\s+(.+?)\.?$/i)
    if (match) {
      const token = match[1]
      const prefix = /^PART\s/i.test(normalized) ? "PART" : "Part"
      if (/^(one|two|three|four|five|six)$/i.test(token)) {
        const label = /^[A-Z]+$/.test(token)
          ? token
          : `${token.charAt(0).toUpperCase()}${token.slice(1).toLowerCase()}`
        return `${prefix} ${label}`
      }
      return formatPartHeadingLabel(token)
    }
  }
  return null
}

const VOLUME_HEADING_PATTERN =
  /^volume\s+(\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\.?$/i

const STRUCTURAL_HEADING_MAX_CHARS = 80
const STRUCTURAL_HEADING_MAX_WORDS = 12

const TOC_CHAPTER_LISTING_REGEX = new RegExp(
  `^Chapter\\s+(\\d+|[IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty)\\s*:\\s+\\S`,
  "i"
)

const EARLY_TOC_SCAN_LINE_LIMIT = 80

const CHAPTER_NUMBER_REGEX = new RegExp(
  `^(\\d{1,2}|[ivxlcdm]+|${CHAPTER_WORD_NUMBERS})\\.?$`,
  "i"
)

const CHAPTER_HEADING_MIN_FONT_SIZE = 12.5
const CHAPTER_DISPLAY_FONT_SIZE = 15

const PUA_PRIVATE_USE_START = 0xe000
const PUA_PRIVATE_USE_END = 0xf8ff
const PUA_DIGIT_BLOCK_START = 0xf643
const PUA_LETTER_BLOCK_START = 0xf761
const PUA_LETTER_BLOCK_END = 0xf77a
const PRINTED_TOC_SCAN_LINE_LIMIT = 250
const SCENE_BREAK_DIVIDER_TEXT = " * * * "
const CHAPTER_TITLE_TAIL_WORD_REGEX = /^[A-Z][A-Z\-']{1,18}\.?$/
const PRINTED_TOC_RUN_MIN_LENGTH = 5
const MULTILINE_CHAPTER_WRAP_MIN_FONT_SIZE = 14
const DISPLAY_CHAPTER_TITLE_MIN_FONT_SIZE = 20

const requireFromModule = createRequire(import.meta.url)
const PDFJS_DIST_DIR = path.dirname(requireFromModule.resolve("pdfjs-dist/package.json"))
const PDFJS_WASM_URL = `${path.join(PDFJS_DIST_DIR, "wasm").replace(/\\/g, "/")}/`
const PDFJS_STANDARD_FONT_URL = `${path.join(PDFJS_DIST_DIR, "standard_fonts").replace(/\\/g, "/")}/`

function isPuaCodePoint(codePoint) {
  return codePoint >= PUA_PRIVATE_USE_START && codePoint <= PUA_PRIVATE_USE_END
}

function parseHexCodePoint(token) {
  const value = Number.parseInt(String(token ?? "").replace(/[<>]/g, ""), 16)
  return Number.isFinite(value) ? value : null
}

function parseToUnicodeCMapText(cmapText) {
  const sourceToDestination = new Map()

  const bfcharBlocks = cmapText.matchAll(
    /(\d+)\s+beginbfchar([\s\S]*?)endbfchar/g
  )
  for (const block of bfcharBlocks) {
    for (const line of block[2].split(/\r?\n/)) {
      const match = line.trim().match(/^<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>$/)
      if (!match) {
        continue
      }
      const source = parseHexCodePoint(match[1])
      const destination = parseHexCodePoint(match[2])
      if (source != null && destination != null) {
        sourceToDestination.set(source, destination)
      }
    }
  }

  const bfrangeBlocks = cmapText.matchAll(
    /(\d+)\s+beginbfrange([\s\S]*?)endbfrange/g
  )
  for (const block of bfrangeBlocks) {
    for (const line of block[2].split(/\r?\n/)) {
      const match = line
        .trim()
        .match(/^<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>$/)
      if (!match) {
        continue
      }
      const sourceStart = parseHexCodePoint(match[1])
      const sourceEnd = parseHexCodePoint(match[2])
      const destinationStart = parseHexCodePoint(match[3])
      if (
        sourceStart == null ||
        sourceEnd == null ||
        destinationStart == null
      ) {
        continue
      }
      const span = sourceEnd - sourceStart
      for (let offset = 0; offset <= span; offset += 1) {
        sourceToDestination.set(sourceStart + offset, destinationStart + offset)
      }
    }
  }

  return sourceToDestination
}

function pdfBufferLikelyContainsToUnicodeCMaps(buffer) {
  if (!buffer?.length) {
    return false
  }

  if (buffer.indexOf("begincmap") !== -1) {
    return true
  }

  if (buffer.indexOf("beginbfchar") !== -1 || buffer.indexOf("beginbfrange") !== -1) {
    return true
  }

  if (buffer.indexOf("/ToUnicode") !== -1) {
    return true
  }

  const puaHexMarkers = ["E002", "E053", "E076", "F643", "F644", "F645"]
  for (const marker of puaHexMarkers) {
    if (buffer.indexOf(marker) !== -1) {
      return true
    }
  }

  return false
}

// Finds every ">>" in `text` immediately (after optional whitespace)
// followed by "stream\r?\n", in a single forward pass - mirrors the
// ">>\s*stream\r?\n" portion of the object-stream pattern below without
// backtracking.
function findPdfStreamStartCandidates(text) {
  const candidates = []
  const whitespaceRunRegex = /\s*/y
  let searchFrom = 0

  while (true) {
    const closeIndex = text.indexOf(">>", searchFrom)
    if (closeIndex === -1) {
      break
    }

    whitespaceRunRegex.lastIndex = closeIndex + 2
    const afterWhitespace = closeIndex + 2 + whitespaceRunRegex.exec(text)[0].length

    if (text.startsWith("stream", afterWhitespace)) {
      const afterStreamKeyword = afterWhitespace + "stream".length
      if (text[afterStreamKeyword] === "\r" && text[afterStreamKeyword + 1] === "\n") {
        candidates.push({
          dictCloseIndex: closeIndex,
          streamContentStart: afterStreamKeyword + 2,
        })
      } else if (text[afterStreamKeyword] === "\n") {
        candidates.push({
          dictCloseIndex: closeIndex,
          streamContentStart: afterStreamKeyword + 1,
        })
      }
    }

    searchFrom = closeIndex + 2
  }

  return candidates
}

// Finds the earliest "endstream" at or after `fromIndex` that is
// immediately preceded by \r?\n - mirrors "\r?\nendstream" without
// backtracking.
function findNextPdfEndstreamBoundary(text, fromIndex) {
  let searchFrom = fromIndex

  while (true) {
    const index = text.indexOf("endstream", searchFrom)
    if (index === -1) {
      return null
    }

    if (index >= 1 && text[index - 1] === "\n") {
      const contentEnd = index >= 2 && text[index - 2] === "\r" ? index - 2 : index - 1
      return { contentEnd, afterEndstream: index + "endstream".length }
    }

    searchFrom = index + "endstream".length
  }
}

// Extracts every "N 0 obj << ... >> stream\r?\n ... \r?\nendstream" span
// from a raw PDF buffer. This used to be a single regex with two chained
// lazy wildcards ("<<([\s\S]*?)>>...stream\r?\n([\s\S]*?)\r?\nendstream")
// scanned across the whole file - on PDFs with many "N 0 obj <<" dict
// headers that never resolve to a real stream (font/encoding/page dicts
// with no stream of their own), that pattern backtracks across large spans
// of the file for every such header. Measured: 15s on a 0.6MB PDF with zero
// real streams, versus <=200ms on every other sample asset. This rewrite
// finds the same spans with two linear forward passes (indexOf-based, no
// backtracking) instead of one backtracking regex. It mirrors the original
// pattern's exact lazy-matching semantics: each "N 0 obj <<" header pairs
// with the nearest qualifying ">> ... stream" span and the nearest
// subsequent "endstream" after it, however far forward either is - verified
// byte-identical against the old implementation across the full sample set.
function extractToUnicodeCMapTextsFromPdfBuffer(buffer) {
  if (!pdfBufferLikelyContainsToUnicodeCMaps(buffer)) {
    return []
  }

  const pdfText = Buffer.from(buffer).toString("latin1")
  const cmapTexts = []
  const streamStartCandidates = findPdfStreamStartCandidates(pdfText)

  const objHeaderRegex = /(\d+) 0 obj/g
  const whitespaceRunRegex = /\s*/y
  let candidateIndex = 0
  let endstreamCursor = 0
  let headerMatch

  while ((headerMatch = objHeaderRegex.exec(pdfText)) !== null) {
    let cursor = headerMatch.index + headerMatch[0].length
    whitespaceRunRegex.lastIndex = cursor
    cursor += whitespaceRunRegex.exec(pdfText)[0].length

    if (!pdfText.startsWith("<<", cursor)) {
      continue
    }
    const dictBodyStart = cursor + 2

    while (
      candidateIndex < streamStartCandidates.length &&
      streamStartCandidates[candidateIndex].dictCloseIndex < dictBodyStart
    ) {
      candidateIndex += 1
    }
    if (candidateIndex >= streamStartCandidates.length) {
      break
    }

    const { dictCloseIndex, streamContentStart } = streamStartCandidates[candidateIndex]
    const body = pdfText.slice(dictBodyStart, dictCloseIndex)

    const endBoundary = findNextPdfEndstreamBoundary(
      pdfText,
      Math.max(streamContentStart, endstreamCursor)
    )
    if (!endBoundary) {
      break
    }
    endstreamCursor = endBoundary.afterEndstream

    const rawSlice = pdfText.slice(streamContentStart, endBoundary.contentEnd)
    const raw = Buffer.from(rawSlice, "latin1")
    let decoded = raw
    if (/\/Filter\s*\/FlateDecode/.test(body)) {
      try {
        decoded = zlib.inflateSync(raw)
      } catch {
        continue
      }
    }
    const text = decoded.toString("utf8")
    if (text.includes("begincmap")) {
      cmapTexts.push(text)
    }

    objHeaderRegex.lastIndex = endBoundary.afterEndstream
  }

  return cmapTexts
}

function buildPuaReplacementMapFromCMaps(buffer) {
  const replacementByPua = new Map()
  const cmapTexts = extractToUnicodeCMapTextsFromPdfBuffer(buffer)

  for (const cmapText of cmapTexts) {
    const sourceToDestination = parseToUnicodeCMapText(cmapText)
    for (const destination of sourceToDestination.values()) {
      if (!isPuaCodePoint(destination)) {
        continue
      }

      if (
        destination >= PUA_DIGIT_BLOCK_START &&
        destination <= PUA_DIGIT_BLOCK_START + 9
      ) {
        replacementByPua.set(
          destination,
          String(destination - PUA_DIGIT_BLOCK_START)
        )
        continue
      }

      if (
        destination >= PUA_LETTER_BLOCK_START &&
        destination <= PUA_LETTER_BLOCK_END
      ) {
        replacementByPua.set(
          destination,
          String.fromCharCode(
            "a".charCodeAt(0) + (destination - PUA_LETTER_BLOCK_START)
          )
        )
      }
    }
  }

  return replacementByPua
}

function hasPuaContentInBuffer(buffer) {
  return pdfBufferLikelyContainsToUnicodeCMaps(buffer)
}

function buildDefaultPuaReplacementMap(buffer = null) {
  const replacementByPua =
    buffer && hasPuaContentInBuffer(buffer)
      ? buildPuaReplacementMapFromCMaps(buffer)
      : new Map()

  for (let digit = 0; digit <= 9; digit += 1) {
    replacementByPua.set(PUA_DIGIT_BLOCK_START + digit, String(digit))
  }

  for (let offset = 0; offset <= PUA_LETTER_BLOCK_END - PUA_LETTER_BLOCK_START; offset += 1) {
    replacementByPua.set(
      PUA_LETTER_BLOCK_START + offset,
      String.fromCharCode("a".charCodeAt(0) + offset)
    )
  }

  for (const [glyph, replacement] of Object.entries(PUA_FALLBACK_MAP)) {
    const codePoint = glyph.codePointAt(0)
    if (codePoint != null) {
      replacementByPua.set(codePoint, replacement)
    }
  }

  return replacementByPua
}

function isSceneBreakOrnamentLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 24) {
    return false
  }

  const glyphs = [...trimmed]
  if (glyphs.length < 2 || glyphs.length > 5) {
    return false
  }

  const codePoints = glyphs.map((glyph) => glyph.codePointAt(0))
  if (!codePoints.every((codePoint) => isPuaCodePoint(codePoint))) {
    return false
  }

  return new Set(codePoints).size === 1
}

function isSceneBreakDividerText(text) {
  return (text ?? "").trim() === SCENE_BREAK_DIVIDER_TEXT.trim()
}

function pushSceneBreakBlock(blocks) {
  blocks.push({
    text: SCENE_BREAK_DIVIDER_TEXT.trim(),
    isHeading: true,
    fontSize: 12,
    chapterId: null,
    centered: true,
    textAlign: "center",
  })
}

function translatePuaCharacters(text, replacementByPua = null) {
  if (!text) {
    return ""
  }

  let normalized = ""
  for (const glyph of text) {
    if (Object.prototype.hasOwnProperty.call(PUA_FALLBACK_MAP, glyph)) {
      normalized += PUA_FALLBACK_MAP[glyph]
      continue
    }

    const codePoint = glyph.codePointAt(0)
    if (!isPuaCodePoint(codePoint)) {
      normalized += glyph
      continue
    }

    const replacement = replacementByPua?.get(codePoint)
    if (replacement != null) {
      normalized += replacement
      continue
    }

    // Drop unmapped PUA so it never renders as a tofu square.
  }

  return normalized.replace(/[\uE000-\uF8FF]/g, "")
}

const STORMLIGHT_TOC_CHAPTER_LINE_REGEX =
  /^\d{1,3}:\s+[A-Z][A-Z0-9\s'’.,\-]+(?:[.?!])?$/

const STORMLIGHT_TOC_INTERLUDE_LINE_REGEX = /^\d-\d{1,2}:\s+[A-Z]/i

const STORMLIGHT_TOC_PART_LINE_REGEX =
  /^Part\s+(?:One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|[IVXLCDM]+|\d+):/i

const STORMLIGHT_PRELUDE_OPENING_REGEX = /^Kalak rounded\b/i
const STORMLIGHT_PROLOGUE_OPENING_REGEX = /^Szeth-son-son-Vallano\b/i
// Survives a missed drop-cap "S" ("zeth-son-son-Vallano") and matches the
// distinctive prologue phrase. Only used inside the post-Prelude page window,
// where no interlude or later Szeth scene can appear.
const STORMLIGHT_PROLOGUE_ANCHOR_REGEX = /Szeth-son-son-Vallano|Truthless of Shinovar/i

const ILLUSTRATIONS_LIST_ENTRY_REGEX =
  /^(?:Map of\b|Prime Map of\b|Sketchbook:|Navani['\u2019]?s Notebook:|Relief of\b|Historical Greatshell|The History of Man\b|Detail of the|The Alethi Codes of War\b|Map of Four Cities\b|Shallan['\u2019]?s Sketchbook:)/i

function isIllustrationsListLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (isIllustrationsListEntryLine(trimmed)) {
    return true
  }
  return /^Shallan['\u2019]?s Sketchbook:\s+/i.test(trimmed)
}

function countStormlightTocMarkers(text) {
  const pattern = /\b\d{1,3}:\s+[A-Z][A-Z0-9\s'’.,\-]+/g
  let count = 0
  while (pattern.exec(text ?? "")) {
    count += 1
  }
  return count
}

function isStormlightPrintedTocLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }

  if (STORMLIGHT_TOC_CHAPTER_LINE_REGEX.test(trimmed)) {
    return true
  }

  if (STORMLIGHT_TOC_INTERLUDE_LINE_REGEX.test(trimmed)) {
    return true
  }

  if (STORMLIGHT_TOC_PART_LINE_REGEX.test(trimmed)) {
    return true
  }

  if (/^Prelude to the Stormlight Archive$/i.test(trimmed)) {
    return true
  }

  if (/^Book One of the Stormlight Archive$/i.test(trimmed)) {
    return true
  }

  if (/^Book One:\s+/i.test(trimmed)) {
    return true
  }

  if (/^Prologue:\s+/i.test(trimmed)) {
    return true
  }

  if (/^Epilogue:\s+/i.test(trimmed)) {
    return true
  }

  if (/^Ars Arcanum$/i.test(trimmed)) {
    return true
  }

  if (/^Interludes$/i.test(trimmed)) {
    return true
  }

  if (countStormlightTocMarkers(trimmed) >= 2) {
    return true
  }

  return false
}

function isIllustrationsListEntryLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }

  if (/^ILLUSTRATIONS$/i.test(trimmed)) {
    return true
  }

  return ILLUSTRATIONS_LIST_ENTRY_REGEX.test(trimmed)
}

function isPublisherBibliographyHeaderLine(text) {
  return /^TOR BOOKS BY\b/i.test((text ?? "").trim())
}

function isBibliographySeriesTitleLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 72) {
    return false
  }

  return /^(?:The )?(?:Mistborn Trilogy|Stormlight Archive|Wheel of Time)$/i.test(trimmed)
}

function isTitlePageBookLabelLine(text) {
  const trimmed = (text ?? "").trim()
  return (
    /^Book One of\.?$/i.test(trimmed) ||
    /^THE STORMLIGHT ARCHIVE$/i.test(trimmed) ||
    /^A TOM DOHERTY ASSOCIATES BOOK/i.test(trimmed)
  )
}

function stripEmbeddedRunningHeader(text) {
  const trimmed = (text ?? "").trim()

  // Never strip the legitimate series title from the Prelude heading. The
  // running-header strip below matches "the Stormlight Archive" case-insensitively
  // and would otherwise truncate "Prelude to the Stormlight Archive" to "Prelude to",
  // which then fails chapter detection and drops it from the table of contents.
  if (/^Prelude to the Stormlight Archive$/i.test(trimmed)) {
    return trimmed
  }

  return trimmed
    .replace(/\s+THE WAY OF KINGS\s*$/i, "")
    .replace(/\s+THE STORMLIGHT ARCHIVE\s*$/i, "")
    .trim()
}

function isPrintedTocHeading(text) {
  const trimmed = (text ?? "").trim()
  return /^(?:contents|table\s+of\s+contents)$/i.test(trimmed.replace(/\s+/g, " "))
}

function isPrintedTocTitlePageLine(text) {
  const trimmed = (text ?? "").trim()
  const match = trimmed.match(/^(.+?)\s+(\d{1,4})$/)
  if (!match) {
    return false
  }

  const titlePart = match[1].trim()
  if (
    CHAPTER_PATTERN.test(titlePart) ||
    CHAPTER_WITH_SUBTITLE_REGEX.test(titlePart) ||
    parseChapterOnlyHeading(titlePart)
  ) {
    return false
  }

  const words = titlePart.split(/\s+/).filter(Boolean)
  return words.length >= 2 && words.length <= 14 && titlePart.length <= 90
}

function isFusedSpelledChapterTocResidue(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  // Letter-spaced printed-TOC markers collapse to a single token
  // ("CHAPTERELEVEN", "CHAPTERTWENTY-EIGHT"). Real chapter headings keep a
  // space ("Chapter Eleven") and must not be treated as TOC residue.
  if (/\s/.test(trimmed)) {
    return false
  }
  return parseSpelledChapterMarker(trimmed) != null
}

function isPrintedTocEntryLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (isStormlightPrintedTocLine(trimmed)) {
    return true
  }
  if (isPrintedTocHeading(trimmed)) {
    return true
  }
  // Fused letter-spaced printed-TOC markers such as "CHAPTERELEVEN" /
  // "CHAPTERTWENTY-EIGHT". Short forms ONE-TEN were previously swallowed by the
  // glossary all-caps length gate (/^[A-Z]{3,12}$/); ELEVEN+ and hyphenated
  // compounds escape that gate and must be filtered here explicitly.
  if (isFusedSpelledChapterTocResidue(trimmed)) {
    return true
  }
  if (isTocChapterListingLine(trimmed)) {
    return true
  }
  if (isTocDenseListingLine(trimmed)) {
    return true
  }
  if (isTocPageReferenceLine(trimmed)) {
    return true
  }
  if (isPrintedTocTitlePageLine(trimmed)) {
    return true
  }

  // Printed front-matter lists like "I. Loomings 1" / "XXIII. Postscript 88".
  if (
    /^(?:[IVXLCDM]{1,10}|\d{1,3})\.\s+\S/.test(trimmed) &&
    !/^chapter\b/i.test(trimmed)
  ) {
    return true
  }

  if (isPrintedTocRomanRowLine(trimmed)) {
    return true
  }

  return false
}

function isPrintedTocRomanRowLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || /^chapter\b/i.test(trimmed)) {
    return false
  }

  return /^(?:[IVXLCDM]{1,10}|\d{1,3})\.\s+.+\s+\d{1,4}\s*$/.test(trimmed)
}

function countPrintedTocRomanEntries(text) {
  const pattern = /(?:^|\s)(?:[IVXLCDM]{1,10}|\d{1,3})\.\s+.+?\s+\d{1,4}/g
  let count = 0
  while (pattern.exec(text ?? "")) {
    count += 1
  }
  return count
}

function isMergedPrintedTocBlock(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (countStormlightTocMarkers(trimmed) >= 2) {
    return true
  }
  if (countPrintedTocRomanEntries(trimmed) >= 2) {
    return true
  }
  if (countStructuralMarkers(trimmed) >= 2) {
    return true
  }
  return isTocDenseListingLine(trimmed)
}

function findFirstChapterBlockIndex(blocks) {
  return blocks.findIndex((block) => {
    const text = (block?.text ?? "").trim()
    return (
      /^Chapter\s+(?:\d+|[IVXLCDM]+)\s*-/i.test(text) ||
      Boolean(parseChapterOnlyHeading(text))
    )
  })
}

function isShortChapterHeadingSubtitleLine(text, line) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || (line?.fontSize ?? 0) < CHAPTER_HEADING_MIN_FONT_SIZE) {
    return false
  }
  if (!isLikelyChapterSubtitleText(trimmed)) {
    return false
  }

  const letters = trimmed.replace(/[^A-Za-z]/g, "")
  return trimmed.length <= 24 && letters.length > 0 && letters.length <= 14
}

function isLargeFontAllCapsChapterWrapLine(text, line) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || (line?.fontSize ?? 0) < MULTILINE_CHAPTER_WRAP_MIN_FONT_SIZE) {
    return false
  }

  const letters = trimmed.replace(/[^A-Za-z]/g, "")
  if (letters.length < 2) {
    return false
  }

  return (
    letters === letters.toUpperCase() &&
    !isNarrativeSentenceLine(trimmed) &&
    !parseChapterOnlyHeading(trimmed)
  )
}

const ALL_CAPS_CHAPTER_SUBTITLE_MIN_FONT_SIZE = 11.5
const ALL_CAPS_CHAPTER_SUBTITLE_MAX_CHARS = 120
const ALL_CAPS_CHAPTER_SUBTITLE_MAX_WORDS = 22

function isAllCapsChapterSubtitleText(text, options = {}) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (CHAPTER_PATTERN.test(trimmed) || CHAPTER_ONLY_HEADING_REGEX.test(trimmed)) {
    return false
  }
  if (CHAPTER_WITH_SUBTITLE_REGEX.test(trimmed)) {
    return false
  }
  // allowAuthorLikeOpening: chapter-only collector may see legitimate subtitles
  // that begin with "By ..." (e.g. Narnia's "BY CALDRON POOL"). isAuthorStructuralLine
  // itself stays unchanged; only this subtitle-path gate opts out.
  if (
    isScannerWatermarkLine(trimmed) ||
    (!options.allowAuthorLikeOpening && isAuthorStructuralLine(trimmed))
  ) {
    return false
  }
  if (/^[a-z]/.test(trimmed)) {
    return false
  }

  const letters = trimmed.replace(/[^A-Za-z]/g, "")
  if (letters.length < 3 || letters !== letters.toUpperCase()) {
    return false
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  return (
    words.length >= 1 &&
    words.length <= ALL_CAPS_CHAPTER_SUBTITLE_MAX_WORDS &&
    trimmed.length <= ALL_CAPS_CHAPTER_SUBTITLE_MAX_CHARS
  )
}

function isAllCapsChapterSubtitleLine(text, line, options = {}) {
  if (!isAllCapsChapterSubtitleText(text, options)) {
    return false
  }
  if (isDropCapChapterSubtitleArtifact(text)) {
    return false
  }
  return (line?.fontSize ?? 0) >= ALL_CAPS_CHAPTER_SUBTITLE_MIN_FONT_SIZE
}

function isDropCapChapterSubtitleArtifact(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return false
  }

  // Fused drop-cap scrap: a lone capital + a tiny capitalized fragment
  // ("A Nd", "T He"). Second-word letter count must be <= 2 so legitimate
  // article openings like "A Day ..." / "A Good ..." (3+ letter second words)
  // are not discarded after title-casing from all-caps source lines.
  {
    const scrap = trimmed.match(/\b[A-Z]\s+([A-Z][a-z]*)\b/)
    if (scrap && scrap[1].replace(/[^A-Za-z]/g, "").length <= 2) {
      return true
    }
  }

  if (/^[A-Z](?:\s+[A-Z]{1,3}){1,5}$/.test(trimmed)) {
    return true
  }

  if (
    words.length <= 3 &&
    words.every((word) => word.replace(/[^A-Za-z]/g, "").length <= 3) &&
    words.some((word) => word.replace(/[^A-Za-z]/g, "").length <= 2)
  ) {
    return true
  }

  if (
    words.length <= 4 &&
    /^(?:I|We|He|She|They|It|My|Mr\.?|Mrs\.?|Miss|When|Had)\s+/i.test(trimmed) &&
    trimmed.length <= 24
  ) {
    return true
  }

  return false
}

function isChapterOnlyHeadingText(text) {
  return Boolean(parseChapterOnlyHeading((text ?? "").trim()))
}

function isIntentionalWrappedChapterTitleFragment(block) {
  const text = (block?.text ?? "").trim()
  if (!text || isDropCapChapterSubtitleArtifact(text)) {
    return false
  }

  const fontSize = block?.fontSize ?? 0

  if (isDisplayChapterTitleText(text)) {
    return fontSize >= DISPLAY_CHAPTER_TITLE_MIN_FONT_SIZE || block?.isHeading === true
  }

  if (
    fontSize >= MULTILINE_CHAPTER_WRAP_MIN_FONT_SIZE &&
    isLargeFontAllCapsChapterWrapLine(text, block)
  ) {
    return true
  }

  if (
    fontSize >= DISPLAY_CHAPTER_TITLE_MIN_FONT_SIZE &&
    isAllCapsChapterSubtitleText(text) &&
    !isNarrativeSentenceLine(text)
  ) {
    return true
  }

  return false
}

function isDedicatedChapterSubtitleBlock(block) {
  const text = (block?.text ?? "").trim()
  if (!text || isDropCapChapterSubtitleArtifact(text)) {
    return false
  }

  if (block?.isHeading) {
    return isLikelyChapterSubtitleText(text)
  }

  return (
    (block?.fontSize ?? 0) >= DISPLAY_CHAPTER_TITLE_MIN_FONT_SIZE &&
    isDisplayChapterTitleText(text)
  )
}

function shouldUsePrintedTocChapterSubtitle(tocSubtitle, parts) {
  const trimmed = (tocSubtitle ?? "").trim()
  if (!trimmed) {
    return false
  }

  const chapterOnlyLabel = formatChapterLabel(parts.kind, parts.number, "")
  if (trimmed.toLowerCase() === chapterOnlyLabel.toLowerCase()) {
    return false
  }

  if (/^(?:chapter|letter)\s+[\dIVXLCDM]+\.?$/i.test(trimmed)) {
    return false
  }

  return true
}


function collectFollowingAllCapsChapterSubtitleTexts(blocks, startIndex) {
  const fragments = []
  let cursor = startIndex

  while (cursor < blocks.length) {
    const nextText = (blocks[cursor]?.text ?? "").trim()
    if (!isAllCapsChapterSubtitleText(nextText)) {
      break
    }
    fragments.push(nextText)
    cursor += 1
  }

  return { fragments, cursor }
}

const PRELUDE_HEADING_REGEX = /^PRELUDE TO THE STORMLIGHT ARCHIVE$/i

function mergeEndOfPartBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  const merged = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const text = (block?.text ?? "").trim()

    if (/^THE END OF\.?$/i.test(text)) {
      let mergedEndOfPart = false

      for (let nextIndex = index + 1; nextIndex < Math.min(index + 6, blocks.length); nextIndex += 1) {
        const nextBlock = blocks[nextIndex]
        if (nextBlock?.type === "image" || nextBlock?.type === "image_candidate") {
          break
        }

        const nextText = (nextBlock?.text ?? "").trim()
        if (!nextText) {
          continue
        }

        const partMatch = nextText.match(
          /^Part\s+(One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)\b/i
        )
        if (partMatch) {
          const partWord =
            partMatch[1].charAt(0).toUpperCase() + partMatch[1].slice(1).toLowerCase()
          merged.push({
            ...block,
            text: `The End of Part ${partWord}`,
            isHeading: true,
            fontSize: Math.max(block.fontSize ?? 12, nextBlock.fontSize ?? 12),
          })
          index = nextIndex
          mergedEndOfPart = true
          break
        }

        break
      }

      if (mergedEndOfPart) {
        continue
      }
    }

    merged.push(block)
  }

  return merged
}

function normalizePublisherBibliographyBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  let inBibliography = false

  return blocks.map((block) => {
    if (block?.type === "image" || block?.type === "image_candidate") {
      return block
    }

    const text = (block?.text ?? "").trim()

    if (isTitlePageBookLabelLine(text) || /^ACKNOWLEDGMENTS$/i.test(text)) {
      inBibliography = false
    }

    if (isPublisherBibliographyHeaderLine(text)) {
      inBibliography = true
      return {
        ...block,
        isHeading: false,
        fontSize: 12,
        textAlign: "center",
      }
    }

    if (!inBibliography || !block?.isHeading) {
      return block
    }

    if (isBibliographySeriesTitleLine(text)) {
      return {
        ...block,
        isHeading: false,
        fontSize: 13,
        bold: true,
        textAlign: "center",
      }
    }

    if (text.length <= 48 && !CHAPTER_PATTERN.test(text)) {
      return {
        ...block,
        isHeading: false,
        fontSize: 12,
        textAlign: "center",
      }
    }

    return block
  })
}

function demoteTitlePageLabelHeadings(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  return blocks.map((block) => {
    const text = (block?.text ?? "").trim()
    if (block?.isHeading && isTitlePageBookLabelLine(text)) {
      return {
        ...block,
        isHeading: false,
        fontSize: 12,
        textAlign: "center",
      }
    }
    return block
  })
}

function demoteIllustrationsListBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  let inIllustrationsList = false
  const result = []

  for (const block of blocks) {
    if (block?.type === "image" || block?.type === "image_candidate") {
      if (inIllustrationsList) {
        inIllustrationsList = false
      }
      result.push(block)
      continue
    }

    const stripped = stripEmbeddedRunningHeader(block?.text ?? "")
    const text = stripped.trim()

    if (block?.isHeading && isIllustrationsListLine(text)) {
      result.push({
        ...block,
        text,
        isHeading: false,
        fontSize: 12,
        textAlign: "center",
      })
      continue
    }

    if (/^ILLUSTRATIONS$/i.test(text)) {
      inIllustrationsList = true
      result.push({
        ...block,
        text,
        isHeading: false,
        fontSize: 12,
        textAlign: "center",
      })
      continue
    }

    if (inIllustrationsList) {
      if (
        STORMLIGHT_PRELUDE_OPENING_REGEX.test(text) ||
        /^THE STORMLIGHT ARCHIVE$/i.test(text)
      ) {
        inIllustrationsList = false
      } else if (isIllustrationsListEntryLine(text) || block?.isHeading) {
        result.push({
          ...block,
          text,
          isHeading: false,
          fontSize: 12,
          textAlign: "center",
        })
        continue
      } else if (text.length > 80) {
        inIllustrationsList = false
      }
    }

    if (stripped !== (block?.text ?? "").trim()) {
      result.push({ ...block, text: stripped })
    } else {
      result.push(block)
    }
  }

  return result
}

function injectStormlightPreludeHeading(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  const result = []
  let injected = false

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const text = stripEmbeddedRunningHeader(block?.text ?? "").trim()

    if (
      !injected &&
      block?.type !== "image" &&
      block?.type !== "image_candidate" &&
      STORMLIGHT_PRELUDE_OPENING_REGEX.test(text)
    ) {
      if (result.length > 0) {
        const previous = result[result.length - 1]
        const previousText = (previous?.text ?? "").trim()
        if (
          previous?.type !== "image" &&
          /^THE STORMLIGHT ARCHIVE$/i.test(previousText)
        ) {
          result.pop()
        }
      }

      const hasPrelude = result
        .slice(-6)
        .some((entry) =>
          /^Prelude to the Stormlight Archive$/i.test((entry?.text ?? "").trim())
        )

      if (!hasPrelude) {
        result.push({
          text: "Prelude to the Stormlight Archive",
          isHeading: true,
          fontSize: 15,
          isChapterStart: true,
          chapterId: null,
          chapterTitle: "Prelude to the Stormlight Archive",
          sourcePdfPageIndex: block.sourcePdfPageIndex ?? null,
        })
      }

      injected = true
      result.push({ ...block, text, isHeading: false, fontSize: 12 })
      continue
    }

    if (
      /^THE STORMLIGHT ARCHIVE$/i.test(text) &&
      blocks[index + 1] &&
      STORMLIGHT_PRELUDE_OPENING_REGEX.test(
        stripEmbeddedRunningHeader(blocks[index + 1]?.text ?? "")
      )
    ) {
      continue
    }

    if (text !== (block?.text ?? "").trim()) {
      result.push({ ...block, text })
    } else {
      result.push(block)
    }
  }

  return result
}

function normalizeBiographyAppendixBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  const result = []
  let inAppendix = false

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const text = (block?.text ?? "").trim()

    if (/^THE END\.?$/i.test(text)) {
      inAppendix = true
      result.push(block)
      continue
    }

    if (!inAppendix || block?.type === "image" || block?.type === "image_candidate") {
      result.push(block)
      continue
    }

    if (/For Whom the Bell$/i.test(text)) {
      const nextBlock = blocks[index + 1]
      const nextText = (nextBlock?.text ?? "").trim()
      if (/^Tolls$/i.test(nextText)) {
        result.push({
          ...block,
          text: `${text} ${nextText}`,
          isHeading: false,
          fontSize: 12,
        })
        index += 1
        continue
      }
    }

    if (/^Works$/i.test(text)) {
      const nextText = (blocks[index + 1]?.text ?? "").trim()
      if (/^Novels\/Novellas$/i.test(nextText)) {
        result.push({
          ...block,
          text: "Works — Novels/Novellas",
          isHeading: true,
          fontSize: 13,
          textAlign: "center",
        })
        index += 1
        continue
      }
    }

    if (/^•\s/.test(text) && /\s•\s/.test(text)) {
      const parts = text
        .split(/\s•\s/)
        .map((part) => part.trim())
        .filter(Boolean)
      for (const part of parts) {
        result.push({
          ...block,
          text: part.startsWith("•") ? part : `• ${part}`,
          isHeading: false,
          fontSize: 12,
        })
      }
      continue
    }

    if (/^[A-Z][a-z]+\s+[A-Z][a-z]+,\s+(Writer|Author|Novelist)$/.test(text)) {
      result.push({
        ...block,
        isHeading: true,
        fontSize: 13,
        textAlign: "center",
      })
      continue
    }

    result.push(block)
  }

  return result
}

function injectStormlightPrologueHeading(blocks, printedToc = null) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  const prologueSubtitle = printedToc?.sections?.get("prologue") ?? "To Kill"
  const prologueHeadingText = `Prologue: ${prologueSubtitle}`

  // Anchor the Prologue to the Prelude. The Prologue always sits between the
  // Prelude and Part One, never deep in the interludes, so a hard page window
  // after the Prelude prevents the heading from attaching to a later Szeth
  // interlude (e.g. I-6 "A Work of Art").
  let preludeIndex = -1
  let preludeSourcePage = null
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block?.type === "image" || block?.type === "image_candidate") {
      continue
    }
    const text = (block?.text ?? "").trim()
    if (
      /^Prelude to the Stormlight Archive$/i.test(text) ||
      STORMLIGHT_PRELUDE_OPENING_REGEX.test(stripEmbeddedRunningHeader(block?.text ?? ""))
    ) {
      preludeIndex = index
      preludeSourcePage = Number.isFinite(block?.sourcePdfPageIndex)
        ? block.sourcePdfPageIndex
        : null
      break
    }
  }

  const PROLOGUE_MAX_PAGES_AFTER_PRELUDE = 60

  const result = []
  let injected = false

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const text = stripEmbeddedRunningHeader(block?.text ?? "").trim()
    const sourcePage = Number.isFinite(block?.sourcePdfPageIndex)
      ? block.sourcePdfPageIndex
      : null

    const withinPrologueWindow =
      index > preludeIndex &&
      (preludeSourcePage == null ||
        sourcePage == null ||
        sourcePage - preludeSourcePage <= PROLOGUE_MAX_PAGES_AFTER_PRELUDE)

    const looksLikePrologueOpening =
      STORMLIGHT_PROLOGUE_OPENING_REGEX.test(text) ||
      STORMLIGHT_PROLOGUE_ANCHOR_REGEX.test(text)

    if (
      !injected &&
      block?.type !== "image" &&
      block?.type !== "image_candidate" &&
      withinPrologueWindow &&
      looksLikePrologueOpening
    ) {
      const hasPrologue = result
        .slice(-8)
        .some((entry) => /^Prologue:\s+/i.test((entry?.text ?? "").trim()))

      if (!hasPrologue) {
        result.push({
          text: prologueHeadingText,
          isHeading: true,
          fontSize: 15,
          isChapterStart: true,
          chapterId: null,
          chapterTitle: prologueHeadingText,
          sourcePdfPageIndex: block.sourcePdfPageIndex ?? null,
        })
      }

      injected = true
      result.push({ ...block, text, isHeading: false, fontSize: 12 })
      continue
    }

    if (text !== (block?.text ?? "").trim()) {
      result.push({ ...block, text })
    } else {
      result.push(block)
    }
  }

  return result
}

function stripResidualFrontMatterBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  const preludeIndex = blocks.findIndex(
    (block) =>
      block?.type !== "image" &&
      block?.type !== "image_candidate" &&
      (STORMLIGHT_PRELUDE_OPENING_REGEX.test(stripEmbeddedRunningHeader(block?.text ?? "")) ||
        /^Prelude to the Stormlight Archive$/i.test((block?.text ?? "").trim()))
  )

  if (preludeIndex <= 0) {
    return blocks
  }

  return blocks.filter((block, index) => {
    if (index >= preludeIndex) {
      return true
    }

    if (block?.type === "image" || block?.type === "image_candidate") {
      return true
    }

    const text = (block?.text ?? "").trim()
    if (!text) {
      return false
    }

    if (isStormlightPrintedTocLine(text) || isMergedPrintedTocBlock(text)) {
      return false
    }

    if (
      /^THE (?:WAY OF KINGS|STORMLIGHT ARCHIVE)$/i.test(text) &&
      index >= preludeIndex - 6 &&
      index < preludeIndex
    ) {
      return false
    }

    return true
  })
}

function normalizeFrontAndBackMatterBlocks(blocks) {
  return stripResidualFrontMatterBlocks(
    normalizeBiographyAppendixBlocks(
      demoteIllustrationsListBlocks(
        demoteTitlePageLabelHeadings(normalizePublisherBibliographyBlocks(blocks))
      )
    )
  )
}

function promoteStructuralSectionHeadings(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  return blocks.map((block) => {
    const normalized = (block?.text ?? "").replace(/\s+/g, " ").trim()
    if (!normalized) {
      return block
    }

    if (PRELUDE_HEADING_REGEX.test(normalized)) {
      return {
        ...block,
        text: "Prelude to the Stormlight Archive",
        isHeading: true,
        isChapterStart: true,
        fontSize: Math.max(block.fontSize ?? 0, 15),
        chapterTitle: "Prelude to the Stormlight Archive",
      }
    }

    const partLabel = resolvePartHeadingLabel(normalized)
    if (partLabel) {
      return {
        ...block,
        text: partLabel,
        isHeading: true,
        isChapterStart: true,
        fontSize: Math.max(block.fontSize ?? 0, CHAPTER_DISPLAY_FONT_SIZE),
        chapterTitle: block.chapterTitle ?? partLabel,
        textAlign: block.textAlign === "center" || block.centered ? "center" : block.textAlign,
      }
    }

    return block
  })
}

function excludePrintedTocBlocks(blocks) {
  const dropIndices = new Set()
  let inPrintedTocSection = false
  const firstChapterIndex = findFirstChapterBlockIndex(blocks)
  const preludeIndex = blocks.findIndex((block) =>
    STORMLIGHT_PRELUDE_OPENING_REGEX.test(stripEmbeddedRunningHeader(block?.text ?? ""))
  )
  const frontMatterEndIndex =
    preludeIndex > 0 ? preludeIndex : firstChapterIndex > 0 ? firstChapterIndex : blocks.length

  for (let index = 0; index < blocks.length; index += 1) {
    const text = (blocks[index]?.text ?? "").trim()
    if (isPrintedTocHeading(text)) {
      inPrintedTocSection = true
      dropIndices.add(index)
      continue
    }

    if (inPrintedTocSection) {
      if (isPrintedTocEntryLine(text) || isMergedPrintedTocBlock(text)) {
        dropIndices.add(index)
        continue
      }
      inPrintedTocSection = false
    }

    if (
      index < frontMatterEndIndex &&
      (isStormlightPrintedTocLine(text) || isMergedPrintedTocBlock(text))
    ) {
      dropIndices.add(index)
    }
  }

  if (firstChapterIndex > 1) {
    for (let index = 1; index < firstChapterIndex; index += 1) {
      const text = (blocks[index]?.text ?? "").trim()
      if (
        isPrintedTocEntryLine(text) ||
        isPrintedTocRomanRowLine(text) ||
        isMergedPrintedTocBlock(text)
      ) {
        dropIndices.add(index)
      }
    }
  }

  let runStart = -1
  let runLength = 0
  for (let index = 0; index < blocks.length; index += 1) {
    const text = (blocks[index]?.text ?? "").trim()
    if (
      isPrintedTocEntryLine(text) ||
      isPrintedTocRomanRowLine(text) ||
      isMergedPrintedTocBlock(text)
    ) {
      if (runLength === 0) {
        runStart = index
      }
      runLength += 1
      continue
    }

    if (runLength >= PRINTED_TOC_RUN_MIN_LENGTH) {
      for (let dropIndex = runStart; dropIndex < runStart + runLength; dropIndex += 1) {
        dropIndices.add(dropIndex)
      }
    }
    runLength = 0
  }

  if (runLength >= PRINTED_TOC_RUN_MIN_LENGTH) {
    for (let dropIndex = runStart; dropIndex < runStart + runLength; dropIndex += 1) {
      dropIndices.add(dropIndex)
    }
  }

  return blocks.filter((_, index) => !dropIndices.has(index))
}

// Poetry collections deliberately bypass excludePrintedTocBlocks so the prose
// cleaners cannot reflow verse, but that bypass also left printed tables of
// contents sitting in the reading text (maya_angelou carries ten pages of
// poem-title listing before its first poem). Running the prose exclusion here
// would not help: every predicate it uses keys on a trailing page number or a
// "Chapter N" marker, and a poetry contents page is a bare list of poem titles,
// so only the "Contents" line itself matches - one block out of 182.
//
// Matching listing text against poem titles is NOT a safe alternative. The
// listing carries its own extraction errors ("A Zono Man" for the poem "A Zorro
// Man") so it under-matches, and many real verse lines are identical to poem
// titles ("When I think about myself,") so it over-matches into the body.
//
// The listing is therefore removed by whole pages, anchored on the "Contents"
// line and bounded hard by the first promoted poem title. This leans on an
// invariant buildPoetryBlocksFromLines already maintains on purpose: a poem
// title is promoted to isChapterStart only when two body-font verse lines
// follow it, so contents entries - a prominent line followed by another
// prominent line - stay unpromoted. Consumption stops at the first page that
// does not look like a listing, which is what protects the dedication page that
// follows the contents in this book.
const POETRY_TOC_MIN_ENTRIES_PER_PAGE = 5
const POETRY_TOC_MAX_ENTRY_LENGTH = 90
const POETRY_TOC_MAX_PAGES = 40

// Upper bound for the prose front-matter cleaners when they run over a poetry
// collection. Verse blocks carry no font or heading styling to distinguish them
// from a publisher catalog listing, so a page of short title-case poem lines -
// or of printed-TOC entries - satisfies the same "several title-like lines on
// one page" shape a catalog page does. Bounding the scan to the stretch strictly
// before the printed-TOC heading and before the first promoted poem keeps those
// cleaners on real front matter: they can never reach a poem, and they can never
// consume the "Contents" anchor that stripPoetryPrintedTocPages needs.
function findPoetryFrontMatterLimit(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return 0
  }

  let limit = blocks.length
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block?.isChapterStart || block?.isPoemTitle) {
      limit = index
      break
    }
    if (block?.type === "image" || block?.type === "image_candidate") {
      continue
    }
    if (isPrintedTocHeading((block?.text ?? "").trim())) {
      limit = index
      break
    }
  }

  return limit
}

function stripPoetryPrintedTocPages(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  // Nothing at or after the first promoted poem may ever be removed here.
  const firstPoemIndex = blocks.findIndex((block) => block?.isChapterStart)
  const limit = firstPoemIndex >= 0 ? firstPoemIndex : blocks.length

  const anchorIndex = blocks.findIndex(
    (block, index) =>
      index < limit &&
      block?.type !== "image" &&
      block?.type !== "image_candidate" &&
      isPrintedTocHeading((block?.text ?? "").trim())
  )
  if (anchorIndex < 0) {
    return blocks
  }

  const anchorPage = blocks[anchorIndex]?.sourcePdfPageIndex
  if (!Number.isFinite(anchorPage)) {
    return blocks
  }

  const pageEntries = new Map()
  for (let index = anchorIndex; index < limit; index += 1) {
    const page = blocks[index]?.sourcePdfPageIndex
    if (!Number.isFinite(page) || page < anchorPage) {
      continue
    }
    if (!pageEntries.has(page)) {
      pageEntries.set(page, [])
    }
    pageEntries.get(page).push(index)
  }

  const isListingPage = (indices) => {
    const textIndices = indices.filter(
      (index) =>
        blocks[index]?.type !== "image" && blocks[index]?.type !== "image_candidate"
    )
    if (textIndices.length < POETRY_TOC_MIN_ENTRIES_PER_PAGE) {
      return false
    }

    return textIndices.every((index) => {
      const block = blocks[index]
      if (block?.isChapterStart || block?.isPoemTitle) {
        return false
      }
      const text = (block?.text ?? "").trim()
      return text.length > 0 && text.length <= POETRY_TOC_MAX_ENTRY_LENGTH
    })
  }

  const dropIndices = new Set()
  const orderedPages = [...pageEntries.keys()].sort((left, right) => left - right)
  let consumedPages = 0

  for (const page of orderedPages) {
    if (consumedPages >= POETRY_TOC_MAX_PAGES) {
      break
    }
    const indices = pageEntries.get(page)
    if (!isListingPage(indices)) {
      break
    }
    for (const index of indices) {
      dropIndices.add(index)
    }
    consumedPages += 1
  }

  if (dropIndices.size === 0) {
    return blocks
  }

  return blocks.filter((_, index) => !dropIndices.has(index))
}

function isWrappedChapterTitleFragment(block) {
  const text = (block?.text ?? "").trim()
  if (!text) {
    return false
  }
  if (isAllCapsChapterSubtitleText(text) || isDisplayChapterTitleText(text)) {
    return true
  }
  if (!block?.isHeading) {
    return false
  }
  if (parseChapterOnlyHeading(text)) {
    return false
  }
  if (CHAPTER_WITH_SUBTITLE_REGEX.test(text)) {
    return false
  }
  if (isPrintedTocEntryLine(text)) {
    return false
  }

  const letters = text.replace(/[^A-Za-z]/g, "")
  if (
    letters.length >= 4 &&
    letters === letters.toUpperCase() &&
    !/[.!?]\s*$/.test(text)
  ) {
    return true
  }

  if ((block.fontSize ?? 0) >= HEADING_STRING_MIN_FONT_SIZE) {
    const words = text.split(/\s+/).filter(Boolean)
    if (words.length <= 24 && text.length <= 160 && !isNarrativeSentenceLine(text)) {
      return true
    }
  }

  return false
}

function parseChapterHeadingWithInlineTitle(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || CHAPTER_WITH_SUBTITLE_REGEX.test(trimmed)) {
    return null
  }

  const match = trimmed.match(
    new RegExp(
      `^(chapter|letter)\\s+(\\d{1,3}|[ivxlcdm]+|${CHAPTER_WORD_NUMBERS})\\s+(.+)$`,
      "i"
    )
  )
  if (!match) {
    return null
  }

  let subtitle = match[3].trim()
  const quoteIndex = subtitle.search(/\s["'\u201c]/)
  if (quoteIndex > 0 && subtitle.length - quoteIndex > 40) {
    subtitle = subtitle.slice(0, quoteIndex).trim()
  }
  if (!subtitle || subtitle.length > 120 || isNarrativeSentenceLine(subtitle)) {
    return null
  }
  if (isDropCapChapterSubtitleArtifact(subtitle)) {
    return null
  }

  return {
    kind: match[1],
    number: match[2],
    subtitle: formatChapterSubtitleText(subtitle),
  }
}

function mergeMultilineChapterTitleBlocks(blocks) {
  const merged = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const inlineParts = parseChapterHeadingWithInlineTitle(block.text)
    if (inlineParts) {
      const displayTitle = formatChapterLabel(
        inlineParts.kind,
        inlineParts.number,
        inlineParts.subtitle
      )
      merged.push({
        ...block,
        text: displayTitle,
        chapterTitle: displayTitle,
        fontSize: CHAPTER_DISPLAY_FONT_SIZE,
        isHeading: true,
        isChapterStart: true,
      })
      continue
    }

    const parts = parseChapterOnlyHeading(block.text)

    if (!parts) {
      merged.push(block)
      continue
    }

    const titleFragments = []
    let cursor = index + 1
    const chapterOnlyHeading = isChapterOnlyHeadingText(block.text)
    while (cursor < blocks.length) {
      const candidate = blocks[cursor]
      const acceptsFragment = chapterOnlyHeading
        ? isIntentionalWrappedChapterTitleFragment(candidate)
        : isWrappedChapterTitleFragment(candidate)
      if (!acceptsFragment) {
        break
      }
      titleFragments.push((candidate.text ?? "").trim())
      cursor += 1
    }

    const rawSubtitle = titleFragments.join(" ").replace(/\s+/g, " ").trim()
    const subtitle =
      rawSubtitle && !isDropCapChapterSubtitleArtifact(rawSubtitle)
        ? formatChapterSubtitleText(rawSubtitle)
        : ""
    const displayTitle = formatChapterLabel(parts.kind, parts.number, subtitle)

    merged.push({
      ...block,
      text: displayTitle,
      chapterTitle: displayTitle,
      fontSize: CHAPTER_DISPLAY_FONT_SIZE,
      isHeading: true,
      isChapterStart: true,
    })
    index = cursor - 1
  }

  return merged
}

function isTrailingChapterTitleFragment(block) {
  const text = (block?.text ?? "").trim()
  if (!text) {
    return false
  }
  if (isAllCapsChapterSubtitleText(text) || isDisplayChapterTitleText(text)) {
    return true
  }
  if (!block?.isHeading) {
    return false
  }
  if (CHAPTER_WITH_SUBTITLE_REGEX.test(text) || parseChapterOnlyHeading(text)) {
    return false
  }

  const letters = text.replace(/[^A-Za-z]/g, "")
  if (letters.length < 4) {
    return false
  }

  return (
    letters === letters.toUpperCase() &&
    text.length <= 120 &&
    !isNarrativeSentenceLine(text)
  )
}

function parseChapterLabelWithOnPageTitle(text) {
  const trimmed = (text ?? "").trim()
  const match = trimmed.match(/^(chapter|letter)\s+([ivxlcdm\d]+)\.\s+(.+)$/i)
  if (!match) {
    return null
  }
  return { kind: match[1], number: match[2], title: match[3].trim() }
}

function mergeInlineChapterLabelTitles(blocks) {
  const merged = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const parts = parseChapterLabelWithOnPageTitle(block.text)

    if (!block.isHeading || !parts) {
      merged.push(block)
      continue
    }

    const tailFragments = []
    let cursor = index + 1
    while (cursor < blocks.length && isTrailingChapterTitleFragment(blocks[cursor])) {
      tailFragments.push((blocks[cursor].text ?? "").trim())
      cursor += 1
    }

    const subtitle = formatChapterSubtitleText(
      [parts.title, ...tailFragments].join(" ").replace(/\s+/g, " ").trim()
    )
    const displayTitle = formatChapterLabel(parts.kind, parts.number, subtitle)
    merged.push({
      ...block,
      text: displayTitle,
      chapterTitle: displayTitle,
      fontSize: CHAPTER_DISPLAY_FONT_SIZE,
      isHeading: true,
      isChapterStart: true,
    })
    index = cursor - 1
  }

  return merged
}

function mergeTrailingChapterTitleFragments(blocks) {
  const merged = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const text = (block.text ?? "").trim()

    if (
      block.isHeading &&
      !isChapterOnlyHeadingText(text) &&
      (CHAPTER_WITH_SUBTITLE_REGEX.test(text) || parseChapterOnlyHeading(text))
    ) {
      const tailFragments = []
      let cursor = index + 1

      while (cursor < blocks.length && isTrailingChapterTitleFragment(blocks[cursor])) {
        tailFragments.push((blocks[cursor].text ?? "").trim())
        cursor += 1
      }

      if (tailFragments.length > 0) {
        const match = text.match(
          /^(chapter|letter)\s+(\S+)\s*-\s*(.*)$/i
        )
        if (match) {
          const label = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase()
          const combinedSubtitle = formatChapterSubtitleText(
            `${match[3]} ${tailFragments.join(" ")}`.replace(/\s+/g, " ").trim()
          )
          const displayTitle = `${label} ${match[2]} - ${combinedSubtitle}`
          merged.push({
            ...block,
            text: displayTitle,
            chapterTitle: displayTitle,
            fontSize: CHAPTER_DISPLAY_FONT_SIZE,
            isHeading: true,
            isChapterStart: true,
          })
          index = cursor - 1
          continue
        }
      }
    }

    merged.push(block)
  }

  return merged
}

function isFableTitleLeadFragment(block) {
  const text = (block?.text ?? "").trim()
  if (!text) {
    return false
  }
  if (!isPureAllCapsTitleText(text)) {
    return false
  }
  return isHeadingIncompleteEnding(text) || /,\s*$/.test(text)
}

// The first physical line of a prominent display title that wraps. It is an
// all-caps phrase that does not end as a complete sentence and is not a
// structural label (Chapter/Part/Volume/standalone roman). Comma-heavy heads
// (e.g. "THE MOUSE, THE CAT, AND THE") qualify here even though the stricter
// isPureAllCapsTitleText rejects them, because the large font marks them as a
// display title rather than an enumeration in prose.
function isWrappedDisplayTitleHeadLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 80) {
    return false
  }
  const letters = trimmed.replace(/[^A-Za-z]/g, "")
  if (letters.length < 3 || letters !== letters.toUpperCase()) {
    return false
  }
  if (/[.!?]["\u201d\u2019']?\s*$/.test(trimmed)) {
    return false
  }
  if (isNarrativeSentenceLine(trimmed)) {
    return false
  }
  if (
    CHAPTER_PATTERN.test(trimmed) ||
    PART_HEADING_PATTERN.test(normalizeHeadingCandidate(trimmed)) ||
    VOLUME_HEADING_PATTERN.test(trimmed) ||
    resolvePartHeadingLabel(trimmed) ||
    parseChapterOnlyHeading(trimmed) ||
    parseValidStandaloneRomanNumeral(trimmed)
  ) {
    return false
  }
  return true
}

// The short trailing line that completes a wrapped display title (e.g. "KING",
// "COCK", "FISH", "SWEET HERBS"). It is one or two all-caps words, is not a
// structural label, and does not begin with an article (which would mark a
// subtitle such as "A NOVEL" rather than a wrapped noun). Font prominence is
// checked by the caller against the head and the following body line.
function isWrappedDisplayTitleTailLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  const letters = trimmed.replace(/[^A-Za-z]/g, "")
  if (letters.length < 2 || letters !== letters.toUpperCase()) {
    return false
  }
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 1 || words.length > 2) {
    return false
  }
  if (/^(?:a|an|the)$/i.test(words[0])) {
    return false
  }
  if (isNarrativeSentenceLine(trimmed)) {
    return false
  }
  if (
    CHAPTER_PATTERN.test(trimmed) ||
    parseValidStandaloneRomanNumeral(trimmed) ||
    resolvePartHeadingLabel(trimmed)
  ) {
    return false
  }
  return true
}

function isFableTitleTailFragmentText(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (!isPureAllCapsTitleText(trimmed)) {
    return false
  }
  const words = trimmed.split(/\s+/).filter(Boolean)
  return words.length >= 1 && words.length <= 6
}

function isFableTitleTailFragment(block) {
  return isFableTitleTailFragmentText(block?.text)
}

function makeFableHeadingBlock(sourceBlock, titleText) {
  return {
    ...sourceBlock,
    text: titleText,
    chapterTitle: titleText,
    isHeading: true,
    isChapterStart: true,
    fontSize: CHAPTER_DISPLAY_FONT_SIZE,
    centered: true,
    textAlign: "center",
  }
}

function inferCompleteFableTitleFromProse(leadTitle, proseText) {
  const leadUpper = leadTitle.replace(/\s+/g, " ").trim().toUpperCase()
  if (!leadUpper || !isHeadingIncompleteEnding(leadTitle)) {
    return null
  }

  const words = (proseText ?? "").trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return null
  }

  const phraseWords = []
  for (let index = 0; index < words.length; index += 1) {
    const core = words[index].replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "")
    if (!core) {
      break
    }

    if (index === 0 && /^THE$/i.test(core)) {
      phraseWords.push("THE")
      continue
    }
    if (/^[A-Z][a-z]+$/.test(core) || /^(and|the)$/i.test(core)) {
      phraseWords.push(core.toUpperCase())
      continue
    }
    break
  }

  if (phraseWords.length < 3) {
    return null
  }

  const fullTitle = phraseWords.join(" ")
  if (!fullTitle.startsWith(leadUpper)) {
    return null
  }
  if (fullTitle.toUpperCase() === leadUpper) {
    return null
  }

  const consumedWordCount = phraseWords.length
  let remainderProse = words.slice(consumedWordCount).join(" ").trim()
  if (remainderProse) {
    remainderProse =
      remainderProse.charAt(0).toUpperCase() + remainderProse.slice(1)
  }
  return {
    title: formatInferredTitleText(fullTitle),
    remainderProse,
  }
}

function mergeMultilineFableTitleBlocks(blocks) {
  const merged = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const text = (block.text ?? "").trim()

    if (!isFableTitleLeadFragment(block)) {
      merged.push(block)
      continue
    }

    const fragments = [text]
    let cursor = index + 1

    while (cursor < blocks.length && isFableTitleTailFragment(blocks[cursor])) {
      fragments.push((blocks[cursor].text ?? "").trim())
      cursor += 1
      const lastFragment = fragments[fragments.length - 1]
      if (!isHeadingIncompleteEnding(lastFragment) && !/,\s*$/.test(lastFragment)) {
        break
      }
    }

    if (fragments.length >= 2) {
      merged.push(
        makeFableHeadingBlock(
          block,
          formatInferredTitleText(fragments.join(" ").replace(/\s+/g, " ").trim())
        )
      )
      index = cursor - 1
      continue
    }

    if (cursor < blocks.length && !blocks[cursor].isHeading) {
      const inferred = inferCompleteFableTitleFromProse(text, blocks[cursor].text)
      if (inferred) {
        merged.push(makeFableHeadingBlock(block, inferred.title))
        if (inferred.remainderProse) {
          merged.push({ ...blocks[cursor], text: inferred.remainderProse })
        }
        index = cursor
        continue
      }
    }

    merged.push(block)
  }

  return merged
}

const FABLE_NON_STORY_HEADING_REGEX =
  /^(introduction|preface|prologue|epilogue|conclusion|contents|illustrations|acknowledge?ments?)$/i

function isFableStoryTitleBlock(block) {
  if (!block?.isHeading || block?.type === "image") {
    return false
  }

  const text = (block.text ?? "").trim()
  if (!text || text.length > 90) {
    return false
  }

  const fontSize = block.fontSize ?? 0
  if (fontSize >= 40) {
    return false
  }

  if (FABLE_NON_STORY_HEADING_REGEX.test(text)) {
    return false
  }
  if (CHAPTER_PATTERN.test(text)) {
    return false
  }
  if (PART_HEADING_PATTERN.test(text) || VOLUME_HEADING_PATTERN.test(text)) {
    return false
  }
  if (isTocChapterListingLine(text) || isTocDenseListingLine(text)) {
    return false
  }
  if (isCleanStructuralHeadingText(text, block)) {
    return false
  }

  if (
    block.isChapterStart &&
    (block.textAlign === "center" || block.centered)
  ) {
    // Centered all-caps lines of up to eight words are treated as decorative
    // prose by isCenteredDecorativeProseText, so an eight-word story title (e.g.
    // "THE DRUM AND THE VASE OF SWEET HERBS") must stay recognized here to keep
    // its heading status; only reject longer lines that are likely sentences.
    if (countWordsInText(text) > 8) {
      return false
    }
    return true
  }

  if (fontSize >= 20 && fontSize <= 35 && isPureAllCapsTitleText(text)) {
    return true
  }

  // Single-line comma titles (e.g. "THE HAWK, KITE, AND PIGEONS") fail
  // isPureAllCapsTitleText but are still fable story openings when set in the
  // display-title size band. Body-ratio is skipped here (pageMetrics are gone
  // by transform time); the size band plus wrap-head refusals gate the match.
  if (
    fontSize >= 20 &&
    fontSize <= 35 &&
    isCompleteLargeFontAllCapsCommaTitle(
      text,
      { fontSize },
      { pageMetrics: { bodyFontSize: 0 } }
    )
  ) {
    return true
  }

  return false
}

function promoteFableStoryTitleBlocks(blocks) {
  return blocks.map((block) => {
    if (!isFableStoryTitleBlock(block)) {
      return block
    }

    const titleText = (block.chapterTitle ?? block.text ?? "").trim()
    return {
      ...block,
      text: titleText || block.text,
      chapterTitle: titleText || block.chapterTitle,
      isHeading: true,
      isChapterStart: true,
      fontSize: CHAPTER_DISPLAY_FONT_SIZE,
      centered: true,
      textAlign: "center",
    }
  })
}

function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
}

function getItemFontSize(item) {
  const matrix = Array.isArray(item.transform) ? item.transform : []
  const scaleX = Number.isFinite(matrix[0]) ? Math.abs(matrix[0]) : 0
  const scaleY = Number.isFinite(matrix[3]) ? Math.abs(matrix[3]) : 0
  return Number(Math.max(scaleX, scaleY).toFixed(2))
}

function getItemY(item) {
  const matrix = Array.isArray(item.transform) ? item.transform : []
  return Number.isFinite(matrix[5]) ? matrix[5] : 0
}

function getItemX(item) {
  const matrix = Array.isArray(item.transform) ? item.transform : []
  return Number.isFinite(matrix[4]) ? matrix[4] : 0
}

function getItemFontTraits(item) {
  const fontName = String(item.fontName ?? "").toLowerCase()
  let bold =
    /\b(bold|black|heavy|semibold|demi|extrabold|ultra)\b/.test(fontName) ||
    /-bd\b|_bd\b/.test(fontName)
  let italic =
    /\b(italic|oblique|ita)\b/.test(fontName) || /-it\b|_it\b/.test(fontName)

  if (/\b(regular|book|normal|light|roman|medium)\b/.test(fontName)) {
    bold = false
  }
  if (bold && /\b(bolditalic|bold-italic|boldoblique)\b/.test(fontName)) {
    italic = true
  }

  const matrix = Array.isArray(item.transform) ? item.transform : []
  const shearX = Number.isFinite(matrix[2]) ? Math.abs(matrix[2]) : 0
  const scaleY = Number.isFinite(matrix[3]) ? Math.abs(matrix[3]) : 1
  if (scaleY > 0 && shearX / scaleY > 0.12) {
    italic = true
  }

  return { bold, italic }
}

function buildRunsFromLineItems(items) {
  const runs = []

  for (const entry of items) {
    const piece = (entry.str ?? "").trim()
    if (!piece) {
      continue
    }

    const traits = getItemFontTraits(entry)
    const last = runs[runs.length - 1]

    if (last && last.bold === traits.bold && last.italic === traits.italic) {
      last.text = `${last.text} ${piece}`.replace(/\s+/g, " ").trim()
    } else {
      runs.push({
        text: piece,
        bold: traits.bold,
        italic: traits.italic,
      })
    }
  }

  return runs
}

const EBOOK_WATERMARK_SITE_REGEX =
  /\b(?:asiaing|e-?books?(?:directory|dictionary|archive)?)(?:\.(?:com|net|org|info))?\b/i

function isScannerWatermarkLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (EBOOK_WATERMARK_SITE_REGEX.test(trimmed)) {
    return true
  }
  if (/^ebd$/i.test(trimmed)) {
    return true
  }
  if (/^www\.[a-z0-9.-]+\.(com|net|org|info)$/i.test(trimmed)) {
    return true
  }
  if (/^[a-z0-9][a-z0-9.-]*\.(com|net|org|info)$/i.test(trimmed)) {
    return true
  }
  if (/^(?:presented|brought)\s+(?:to\s+you\s+)?by\b/i.test(trimmed)) {
    return true
  }
  if (/^free\s+(?:e-?book|download)\b/i.test(trimmed)) {
    return true
  }
  return false
}

function stripWatermarkPhrasesFromText(text) {
  return (text ?? "")
    .replace(/\s*asiaing\.com\s*/gi, " ")
    .replace(/\s*e-booksdirectory\.com\s*/gi, " ")
    .replace(/\s*e-booksdictionary\.com\s*/gi, " ")
    .replace(EBOOK_WATERMARK_SITE_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function formatInferredTitleText(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return ""
  }

  const letters = trimmed.replace(/[^A-Za-z]/g, "")
  if (
    letters.length >= 4 &&
    letters === letters.toUpperCase() &&
    /[A-Z]/.test(letters)
  ) {
    return applyBookTitleCasing(trimmed.toLowerCase())
  }

  return applyBookTitleCasing(trimmed)
}

// Chapter subtitles, unlike inferred book titles, come from text the subtitle
// detector (isChapterSubtitleWord et al.) has already validated using the source
// PDF's own capitalization - that detection would be undermined by re-deriving
// casing afterward, and applyBookTitleCasing's English-only minor-word list
// mangles non-English names it doesn't recognize (French "de"/"du" get
// capitalized, mid-title "The" after an em-dash gets lowercased). All-caps
// source text carries no usable casing information though (e.g. Oliver Twist's
// drop-cap-fused subtitles render in full capitals in the PDF), so that case
// still needs derivation via applyBookTitleCasing; only already-mixed-case
// source text is trusted verbatim.
function formatChapterSubtitleText(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return ""
  }

  const letters = trimmed.replace(/[^A-Za-z]/g, "")
  if (
    letters.length >= 4 &&
    letters === letters.toUpperCase() &&
    /[A-Z]/.test(letters)
  ) {
    return applyBookTitleCasing(trimmed.toLowerCase())
  }

  return trimmed
}

function looksLikeFilenameSlug(title) {
  const trimmed = (title ?? "").trim()
  if (!trimmed) {
    return true
  }
  if (/^[A-Z][a-z]+,\s*.+\s*-\s*.+/i.test(trimmed)) {
    return true
  }
  if (/\s/.test(trimmed)) {
    return false
  }
  if (/^\d{1,4}$/.test(trimmed)) {
    return false
  }
  if (/^[A-Z][a-z]{3,}$/.test(trimmed)) {
    return false
  }
  if (/[a-z][A-Z]/.test(trimmed)) {
    return true
  }
  if (/^[A-Za-z]+\d+[A-Za-z0-9]*$/.test(trimmed)) {
    return true
  }
  return /^[a-z0-9_-]+$/i.test(trimmed)
}

function sanitizePdfTitle(title) {
  let trimmed = stripWatermarkPhrasesFromText(title)
  if (!trimmed || isScannerWatermarkLine(trimmed)) {
    return ""
  }

  const catalogMatch = trimmed.match(/^[A-Z][^\n-]{0,80}?,\s*[^-]{1,80}?\s*-\s*(.+)$/i)
  if (catalogMatch) {
    const extracted = stripWatermarkPhrasesFromText(catalogMatch[1])
    if (extracted && !isScannerWatermarkLine(extracted)) {
      return formatInferredTitleText(extracted)
    }
  }

  return formatInferredTitleText(trimmed)
}

function extractTrailingYearTitleFromFileName(fileName) {
  const stem = (fileName ?? "").replace(/\.pdf$/i, "").trim()
  const match = stem.match(/([A-Za-z]+)(\d{4})$/)
  if (!match) {
    return ""
  }

  const prefix = match[1]
  if (prefix.length > 24) {
    return ""
  }

  return match[2]
}

function inferBookTitleFromEarlyBlocks(blocks) {
  const candidates = []
  const scan = blocks.slice(0, 40)
  const titleCountByPage = new Map()

  for (const block of scan) {
    const text = (block.text ?? "").trim()
    if (!looksLikeStandaloneBookTitle(text)) {
      continue
    }
    const page = block.sourcePdfPageIndex ?? 0
    titleCountByPage.set(page, (titleCountByPage.get(page) ?? 0) + 1)
  }

  for (const block of scan) {
    const text = (block.text ?? "").trim()
    if (!text || isScannerWatermarkLine(text)) {
      continue
    }
    if (CHAPTER_PATTERN.test(text)) {
      continue
    }
    if (/\bcontents\b/i.test(text)) {
      continue
    }
    if (/^book\s+(?:one|two|three|four|five)\s+of\b/i.test(text)) {
      continue
    }
    if (isAuthorBylineHeadingText(text) || /^by\s+/i.test(text)) {
      continue
    }
    if (/^to\s+[A-Z]/i.test(text) && text.length < 90) {
      continue
    }

    const page = block.sourcePdfPageIndex ?? 0
    if ((titleCountByPage.get(page) ?? 0) >= 3) {
      continue
    }

    const words = text.split(/\s+/).filter(Boolean)
    if (words.length < 2 || words.length > 14) {
      continue
    }
    if (text.length > 90 && /[.!?]/.test(text)) {
      continue
    }

    const letters = text.replace(/[^A-Za-z]/g, "")
    if (
      letters.length >= 8 &&
      letters === letters.toUpperCase() &&
      /[A-Z]/.test(letters)
    ) {
      candidates.push({
        text: formatInferredTitleText(text),
        score: 92,
      })
      continue
    }

    const looksLikeTitleCase = words.every(
      (word) =>
        /^[A-Z][a-z]+(?:['-][A-Z][a-z]+)?$/.test(word) ||
        BOOK_TITLE_MINOR_WORDS.has(word.toLowerCase())
    )

    if (block.isHeading && looksLikeTitleCase && !isAuthorStructuralLine(text)) {
      candidates.push({
        text: formatInferredTitleText(text),
        score: (block.fontSize ?? 0) >= 16 ? 88 : 75,
      })
      continue
    }

    if (
      !block.isHeading &&
      looksLikeTitleCase &&
      words.length <= 10 &&
      !/["\u201c\u201d]/.test(text)
    ) {
      candidates.push({
        text: formatInferredTitleText(text),
        score: 68,
      })
    }
  }

  if (candidates.length === 0) {
    return ""
  }

  candidates.sort((left, right) => right.score - left.score)
  return candidates[0].text
}

const BOOK_TITLE_MINOR_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "in",
  "nor",
  "of",
  "on",
  "or",
  "so",
  "the",
  "to",
  "up",
  "yet",
])

function capitalizeTitleWord(word, forceMajor = false) {
  const lower = word.toLowerCase()
  if (!forceMajor && BOOK_TITLE_MINOR_WORDS.has(lower)) {
    return lower
  }
  if (/^[ivxlcdm]+$/i.test(word)) {
    return word.toUpperCase()
  }
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function applyBookTitleCasing(title) {
  const words = title.split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return ""
  }

  return words
    .map((word, index) => {
      const isMinor =
        index > 0 && index < words.length - 1 && !word.includes("-")

      if (word.includes("-")) {
        const parts = word.split("-")
        return parts
          .map((part, partIndex) =>
            capitalizeTitleWord(
              part,
              partIndex === 0 || index === 0 || index === words.length - 1
            )
          )
          .join("-")
      }

      if (isMinor && BOOK_TITLE_MINOR_WORDS.has(word.toLowerCase())) {
        return word.toLowerCase()
      }

      return capitalizeTitleWord(word, index === 0 || index === words.length - 1)
    })
    .join(" ")
}

function humanizeBookTitleFromFileName(fileName) {
  const stem = (fileName ?? "").replace(/\.pdf$/i, "").trim()
  if (!stem) {
    return ""
  }

  let title = stem.replace(/[-_]+/g, " ")
  title = title.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  title = title.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  return applyBookTitleCasing(title.replace(/\s+/g, " ").trim())
}

function looksLikeStandaloneBookTitle(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 90 || trimmed.length < 6) {
    return false
  }
  if (CHAPTER_PATTERN.test(trimmed)) {
    return false
  }
  if (/\bcontents\b/i.test(trimmed)) {
    return false
  }
  if (isAuthorBylineHeadingText(trimmed)) {
    return false
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 2 || words.length > 12) {
    return false
  }

  return words.every(
    (word) =>
      /^[A-Z][a-z]+(?:[''-][A-Z]?[a-z]+)?$/.test(word) ||
      BOOK_TITLE_MINOR_WORDS.has(word.toLowerCase())
  )
}

function isPublisherCatalogInEarlyBlocks(blocks) {
  const titleCountByPage = new Map()

  for (const block of blocks.slice(0, 40)) {
    if (block?.type === "image" || block?.type === "image_candidate") {
      continue
    }

    const text = (block.text ?? "").trim()
    if (!looksLikeStandaloneBookTitle(text)) {
      continue
    }

    const page = block.sourcePdfPageIndex ?? 0
    titleCountByPage.set(page, (titleCountByPage.get(page) ?? 0) + 1)
  }

  for (const count of titleCountByPage.values()) {
    if (count >= 3) {
      return true
    }
  }

  return false
}

function titlesRoughlyMatch(left, right) {
  const leftKey = normalizeTitleComparisonKey(left)
  const rightKey = normalizeTitleComparisonKey(right)
  if (!leftKey || !rightKey) {
    return false
  }
  return leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey)
}

function isDedicationAddresseeLine(text) {
  const trimmed = (text ?? "").trim()
  return /^(?:to|by)\s+[a-z]/i.test(trimmed)
}

function stripPublisherCatalogBlocks(blocks, bookTitle, { scanLimit } = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  const bookKey = normalizeTitleComparisonKey(bookTitle)
  if (!bookKey) {
    return blocks
  }

  const firstChapterIndex = findFirstChapterBlockIndex(blocks)
  let scanEnd = firstChapterIndex > 0 ? firstChapterIndex : Math.min(blocks.length, 32)
  if (Number.isFinite(scanLimit)) {
    scanEnd = Math.min(scanEnd, scanLimit)
  }
  const titleLikeByPage = new Map()

  for (let index = 0; index < scanEnd; index += 1) {
    const block = blocks[index]
    if (block?.type === "image" || block?.type === "image_candidate") {
      continue
    }

    const text = (block.text ?? "").trim()
    // Dedication lines ("To Charlie Shribner", "By Ernest Hemingway") coincidentally
    // satisfy the Title-Case "looks like a book title" shape. On chapterless books the
    // scan window runs past the front matter into real prose without an early chapter
    // boundary to stop it, so counting these toward the catalog threshold can flag a
    // page that mixes a dedication with genuine narrative content, not a catalog list.
    if (!looksLikeStandaloneBookTitle(text) || isDedicationAddresseeLine(text)) {
      continue
    }

    const page = block.sourcePdfPageIndex ?? 0
    if (!titleLikeByPage.has(page)) {
      titleLikeByPage.set(page, [])
    }
    titleLikeByPage.get(page).push({
      index,
      key: normalizeTitleComparisonKey(text),
    })
  }

  const dropIndices = new Set()
  const catalogPages = new Set()
  for (const [page, entries] of titleLikeByPage.entries()) {
    if (entries.length >= 3) {
      catalogPages.add(page)
    }
  }

  for (const [page, entries] of titleLikeByPage.entries()) {
    if (!catalogPages.has(page)) {
      continue
    }

    for (const entry of entries) {
      const matchesBook =
        entry.key === bookKey ||
        entry.key.includes(bookKey) ||
        bookKey.includes(entry.key)
      if (!matchesBook) {
        dropIndices.add(entry.index)
      }
    }
  }

  if (catalogPages.size > 0) {
    for (let index = 0; index < scanEnd; index += 1) {
      if (dropIndices.has(index)) {
        continue
      }

      const block = blocks[index]
      const page = block?.sourcePdfPageIndex ?? 0
      if (!catalogPages.has(page)) {
        continue
      }
      if (block?.type === "image" || block?.type === "image_candidate") {
        continue
      }

      const blockKey = normalizeTitleComparisonKey(block?.text)
      const matchesBook =
        blockKey &&
        (blockKey === bookKey ||
          blockKey.includes(bookKey) ||
          bookKey.includes(blockKey))
      if (!matchesBook) {
        dropIndices.add(index)
      }
    }
  }

  if (dropIndices.size === 0) {
    return blocks
  }

  return blocks.filter((_, index) => !dropIndices.has(index))
}

// Trailing non-narrative matter: publisher catalogs, distribution/license
// boilerplate, and production notes appended after the story ends. Detection is
// deliberately anchored on literal trigger lines rather than any structural
// "looks non-narrative" heuristic - a general heuristic cannot tell a final
// epilogue from boilerplate, and an over-broad match here eats real content
// (the failure mode stripPublisherCatalogBlocks hit on The Old Man and the
// Sea). Every anchor is additionally position-gated to the last stretch of the
// book so a coincidental mid-narrative match can never truncate the story.
const TRAILING_MATTER_ANCHOR_PATTERNS = [
  // Project Gutenberg transcriber/license boilerplate
  /^\*{3,}\s*This file should be named\b/i,
  /^START: FULL LICENSE\b/i,
  /^\*{3}\s*END OF TH(?:E|IS) PROJECT GUTENBERG\b/i,
  /^End of (?:the )?Project Gutenberg\b/i,
  // Publisher catalog/announcement sections (all-caps exact, case-sensitive)
  /^ANNOUNCEMENTS$/,
  // Distributor promo + copyright-information tails
  /^This book was distributed courtesy of:?$/i,
  /^COPYRIGHT INFORMATION$/,
  /^More classics here:?$/i,
  // Production/adaptation notes ("This book was adaptated into LaTeX ... from
  // the Gutenberg project" - the source PDF itself misspells "adaptated")
  /^This book was adapt(?:at)?ed into\b[\s\S]*\bGutenberg\b/i,
  // Saddleback Jungle Book back-cover synopsis. That edition's "Saddleback
  // E-Book" footer does not survive into text blocks, and it shares no Core
  // Classics series-listing line with the Treasure Island back cover, so the
  // only safe hook is this literal marketing opening - unique in the corpus
  // and never a narrative closer.
  /^In long ago India, a toddler wanders off\b/,
]

const TRAILING_MATTER_MAX_PAGES_FROM_END = 12
const TRAILING_MATTER_MIN_INDEX_RATIO = 0.8

// Library of Congress cataloging-in-publication records are printed on the last
// page of many trade editions, and the block set carries no literal "Library of
// Congress" line for the anchor list above to match. They are recognized instead
// by the fields the record format mandates - none of which is a phrase a
// narrative would produce.
const CATALOGING_RECORD_FIELD_PATTERNS = [
  // LC call number, e.g. "PS3551.N464A17 1994"
  /^[A-Z]{1,3}\d{2,5}(?:\.[A-Z0-9]+){1,3}(?:\s+\d{4}[a-z]?)?$/,
  // Collation statement
  /^p\.\s*cm\.?$/i,
  // Dewey class number, e.g. "8n'.54-dc20 94-14501"
  /(?:^|\s)\d{1,3}\S{0,12}[-–—]{1,2}dc\d{2}\b/i,
  // Added-entry tracing, e.g. "I. Title."
  /^[IVXL]+\.\s*Title\.?$/,
  // Bracketed uniform title, e.g. "[Poems]"
  /^\[[A-Z][A-Za-z][A-Za-z .,'’-]{0,38}\]$/,
]

// Main-entry heading that opens the record, e.g. "Angelou, Maya."
const CATALOGING_RECORD_MAIN_ENTRY_PATTERN =
  /^[A-Z][A-Za-z'’-]+,\s+[A-Z][A-Za-z'’.-]*\.?$/

const CATALOGING_RECORD_WINDOW_BLOCKS = 8

// Core Classics small-caps mastheads extract with tracked capitals split into
// lone letters ("Co R e C LA ssi C s"). Clean "Core Classics" also appears.
const CORE_CLASSICS_SPACED_PATTERN = /Co\s*R\s*e\s+C\s*LA\s*ssi\s*C\s*s/i
const CORE_CLASSICS_PLAIN_PATTERN = /Core\s*Classics/i

const CORE_CLASSICS_BACK_COVER_WINDOW_BLOCKS = 8

function mentionsCoreClassics(text) {
  return CORE_CLASSICS_SPACED_PATTERN.test(text) || CORE_CLASSICS_PLAIN_PATTERN.test(text)
}

function matchedCatalogingFieldIndex(text) {
  return CATALOGING_RECORD_FIELD_PATTERNS.findIndex((pattern) => pattern.test(text))
}

function isTrailingCatalogingRecordAnchor(blocks, index) {
  const text = (blocks[index]?.text ?? "").trim()
  const anchorField = matchedCatalogingFieldIndex(text)
  if (anchorField < 0 && !CATALOGING_RECORD_MAIN_ENTRY_PATTERN.test(text)) {
    return false
  }

  // A lone field can occur by coincidence (a surname-comma line in dialogue, a
  // bracketed stage direction), so require two distinct field types across the
  // record, at least one of them below the anchor. That makes the anchor fire on
  // the first line of the record - which is where the strip must begin - without
  // letting any single line trigger it.
  const seenFields = new Set()
  if (anchorField >= 0) {
    seenFields.add(anchorField)
  }

  let corroborating = 0
  let scanned = 0
  for (
    let cursor = index + 1;
    cursor < blocks.length && scanned < CATALOGING_RECORD_WINDOW_BLOCKS;
    cursor += 1
  ) {
    const candidate = blocks[cursor]
    if (candidate?.type === "image" || candidate?.type === "image_candidate") {
      continue
    }
    scanned += 1

    const field = matchedCatalogingFieldIndex((candidate?.text ?? "").trim())
    if (field >= 0) {
      corroborating += 1
      seenFields.add(field)
    }
  }

  return corroborating > 0 && seenFields.size >= 2
}

function isTrailingEditionNoticeAnchor(blocks, index) {
  const text = (blocks[index]?.text ?? "").trim()
  if (!/^This is a work of fiction\./.test(text)) {
    return false
  }

  // Require corroborating legal lines nearby so an in-story sentence that
  // happens to open the same way can never trigger the strip.
  let seen = 0
  for (let cursor = index; cursor < blocks.length && seen < 8; cursor += 1) {
    const candidate = blocks[cursor]
    if (candidate?.type === "image" || candidate?.type === "image_candidate") {
      continue
    }
    seen += 1
    const candidateText = (candidate?.text ?? "").trim()
    if (/^Copyright\s*(?:©|\(c\))/i.test(candidateText) || /^ISBN[:\s]/.test(candidateText)) {
      return true
    }
  }
  return false
}

function isCoreClassicsSeriesListingLine(text) {
  const trimmed = (text ?? "").trim()
  return mentionsCoreClassics(trimmed) && /\btitles include:?$/i.test(trimmed)
}

function isCoreClassicsBackCoverMastheadLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 80) {
    return false
  }
  if (!mentionsCoreClassics(trimmed)) {
    return false
  }
  // Masthead lines carry a trademark mark and/or the Core Knowledge prefix.
  return /[®™]|\((?:R|TM)\)/i.test(trimmed) || /^Core Knowledge\b/i.test(trimmed)
}

function isCoreClassicsAbridgedFeatureBullet(text) {
  return /^[•·\-]\s*Abridged texts for young readers\b/i.test((text ?? "").trim())
}

function hasCoreClassicsBackCoverCorroboration(blocks, index) {
  let seenListing = isCoreClassicsSeriesListingLine((blocks[index]?.text ?? "").trim())
  let seenMasthead = isCoreClassicsBackCoverMastheadLine((blocks[index]?.text ?? "").trim())
  let seenBullet = isCoreClassicsAbridgedFeatureBullet((blocks[index]?.text ?? "").trim())

  let scanned = 0
  for (
    let cursor = index + 1;
    cursor < blocks.length && scanned < CORE_CLASSICS_BACK_COVER_WINDOW_BLOCKS;
    cursor += 1
  ) {
    const candidate = blocks[cursor]
    if (candidate?.type === "image" || candidate?.type === "image_candidate") {
      continue
    }
    scanned += 1
    const candidateText = (candidate?.text ?? "").trim()
    if (isCoreClassicsSeriesListingLine(candidateText)) {
      seenListing = true
    }
    if (isCoreClassicsBackCoverMastheadLine(candidateText)) {
      seenMasthead = true
    }
    if (isCoreClassicsAbridgedFeatureBullet(candidateText)) {
      seenBullet = true
    }
  }

  return [seenListing, seenMasthead, seenBullet].filter(Boolean).length >= 2
}

function isTrailingCoreClassicsBackCoverAnchor(blocks, index) {
  const text = (blocks[index]?.text ?? "").trim()
  if (!text) {
    return false
  }

  if (isCoreClassicsSeriesListingLine(text) || isCoreClassicsBackCoverMastheadLine(text)) {
    return hasCoreClassicsBackCoverCorroboration(blocks, index)
  }

  // Marketing blurb printed on the same page as the series promo, immediately
  // before it. Same-page gating keeps an earlier author-bio paragraph from
  // matching just because the promo appears a few blocks later.
  const page = blocks[index]?.sourcePdfPageIndex
  if (!Number.isFinite(page) || text.length < 120) {
    return false
  }

  let scanned = 0
  for (
    let cursor = index + 1;
    cursor < blocks.length && scanned < 6;
    cursor += 1
  ) {
    const candidate = blocks[cursor]
    if (candidate?.type === "image" || candidate?.type === "image_candidate") {
      continue
    }
    scanned += 1
    if (candidate?.sourcePdfPageIndex !== page) {
      return false
    }
    const candidateText = (candidate?.text ?? "").trim()
    if (
      (isCoreClassicsSeriesListingLine(candidateText) ||
        isCoreClassicsBackCoverMastheadLine(candidateText)) &&
      hasCoreClassicsBackCoverCorroboration(blocks, cursor)
    ) {
      return true
    }
  }

  return false
}

function stripTrailingNonNarrativeMatterBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 40) {
    return blocks
  }

  let maxSourcePage = -1
  for (const block of blocks) {
    if (Number.isFinite(block?.sourcePdfPageIndex)) {
      maxSourcePage = Math.max(maxSourcePage, block.sourcePdfPageIndex)
    }
  }

  const minIndex = Math.floor(blocks.length * TRAILING_MATTER_MIN_INDEX_RATIO)

  for (let index = minIndex; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block?.type === "image" || block?.type === "image_candidate") {
      continue
    }

    const page = block?.sourcePdfPageIndex
    if (
      maxSourcePage >= 0 &&
      Number.isFinite(page) &&
      page < maxSourcePage - TRAILING_MATTER_MAX_PAGES_FROM_END
    ) {
      continue
    }

    const text = (block?.text ?? "").trim()
    if (!text) {
      continue
    }

    const isAnchor =
      TRAILING_MATTER_ANCHOR_PATTERNS.some((pattern) => pattern.test(text)) ||
      isTrailingEditionNoticeAnchor(blocks, index) ||
      isTrailingCatalogingRecordAnchor(blocks, index) ||
      isTrailingCoreClassicsBackCoverAnchor(blocks, index)
    if (isAnchor) {
      return blocks.slice(0, index)
    }
  }

  return blocks
}

// Core Knowledge licence/title-page leftovers that are not publisher catalogs
// and are not the book title: a small-caps series tagline ("Co R e C LA ssi C s
// Ab R idged ...") and the trademark-enumeration line on the licence page.
// Bounded to the pre-chapter window so narrative mentions of the foundation
// cannot match.
function isGarbledCoreClassicsSeriesTagline(text) {
  const trimmed = (text ?? "").trim()
  if (!CORE_CLASSICS_SPACED_PATTERN.test(trimmed)) {
    return false
  }
  return /Ab\s*R\s*idged/i.test(trimmed) && /y\s*oung|Re\s*A\s*de/i.test(trimmed)
}

function isCoreKnowledgeTrademarkBoilerplateLine(text) {
  const trimmed = (text ?? "").trim()
  return (
    mentionsCoreClassics(trimmed) &&
    /are trademarks of the Core Knowledge Foundation\.?$/i.test(trimmed)
  )
}

function stripCoreKnowledgeFrontMatterBoilerplate(blocks, { scanLimit } = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  const firstChapterIndex = findFirstChapterBlockIndex(blocks)
  let scanEnd = firstChapterIndex > 0 ? firstChapterIndex : Math.min(blocks.length, 32)
  if (Number.isFinite(scanLimit)) {
    scanEnd = Math.min(scanEnd, scanLimit)
  }

  const dropIndices = new Set()
  for (let index = 0; index < scanEnd; index += 1) {
    const block = blocks[index]
    if (block?.type === "image" || block?.type === "image_candidate") {
      continue
    }
    const text = (block?.text ?? "").trim()
    if (!text) {
      continue
    }
    if (isGarbledCoreClassicsSeriesTagline(text) || isCoreKnowledgeTrademarkBoilerplateLine(text)) {
      dropIndices.add(index)
    }
  }

  if (dropIndices.size === 0) {
    return blocks
  }

  return blocks.filter((_, index) => !dropIndices.has(index))
}

// A reprint series prints its brand masthead above the work's own title on the
// title page ("Core Classics(R)" over "Treasure Island"), and the masthead is
// the larger, earlier line - so block inference picks the brand, not the book.
// The registered-trademark or trademark mark is what separates the two: a series
// brand is a mark its publisher must assert, and a book title essentially never
// carries one. Only the block-inferred candidate is tested; a mark inside a
// metadata or filename title is not evidence of the same confusion.
function looksLikeSeriesBrandTitle(title) {
  const trimmed = (title ?? "").trim()
  if (!trimmed) {
    return false
  }
  return /[®™]|\((?:R|TM)\)/i.test(trimmed)
}

function resolveBookTitle(parsedText, fileName = "", blocks = []) {
  const fromMeta = sanitizePdfTitle(parsedText?.info?.Title ?? "")
  const fromFile = humanizeBookTitleFromFileName(fileName)
  const fromBlocks = inferBookTitleFromEarlyBlocks(blocks)
  const catalogPresent = isPublisherCatalogInEarlyBlocks(blocks)

  // Kept out of the ranked branches below but still available as a last resort:
  // a masthead beats returning no title at all.
  const rankedFromBlocks = looksLikeSeriesBrandTitle(fromBlocks) ? "" : fromBlocks

  if (fromMeta && !looksLikeFilenameSlug(fromMeta) && !/^untitled$/i.test(fromMeta)) {
    return fromMeta
  }

  if (fromFile && !looksLikeFilenameSlug(fromFile)) {
    if (catalogPresent || !rankedFromBlocks || titlesRoughlyMatch(fromFile, rankedFromBlocks)) {
      return fromFile
    }
  }

  if (rankedFromBlocks && !looksLikeFilenameSlug(rankedFromBlocks)) {
    return rankedFromBlocks
  }

  const yearFromFile = extractTrailingYearTitleFromFileName(fileName)
  if (yearFromFile) {
    return yearFromFile
  }

  return fromBlocks || fromMeta || fromFile || ""
}

function sanitizePdfAuthor(author) {
  const trimmed = stripWatermarkPhrasesFromText(author)
  if (!trimmed || isScannerWatermarkLine(trimmed)) {
    return ""
  }
  if (EBOOK_WATERMARK_SITE_REGEX.test(trimmed)) {
    return ""
  }
  return trimmed
}

function isAuthorBylineHeadingText(text) {
  return /^by\s+/i.test((text ?? "").trim())
}

// The Author field records whoever produced the PDF, which is only sometimes the
// person who wrote the book. Distrusting it needs two independent signals, since
// a correct author is the common case and dropping one is its own defect:
//
//   1. The same producer wrote an unusable Title, so its metadata is unreliable
//      as a whole rather than wrong in one field.
//   2. The name appears nowhere in the document text. A real author is named on
//      the title page, in a byline, or in the back-matter biography; a
//      production credit that appears in no printed line is not the author.
//
// Either signal alone produces false positives on this sample - a junk Title
// accompanies correct authors, and a correct author can be missing from the
// opening pages while appearing later - so both are required.
function metadataAuthorLooksLikeProducerCredit(authorText, metaTitle, pageData) {
  const author = (authorText ?? "").trim()
  if (!author) {
    return false
  }

  const titleUsable =
    Boolean(metaTitle) &&
    !looksLikeFilenameSlug(metaTitle) &&
    !/^untitled$/i.test((metaTitle ?? "").trim())
  if (titleUsable) {
    return false
  }

  const nameParts = author
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((part) => part.length > 2)
  if (nameParts.length === 0) {
    return false
  }

  for (const page of pageData ?? []) {
    for (const line of page?.lines ?? []) {
      const text = (line.text ?? "").toLowerCase()
      if (!text) {
        continue
      }
      if (nameParts.every((part) => text.includes(part))) {
        return false
      }
    }
  }

  return true
}

function contentStartsWithBookTitle(blocks, bookTitle) {
  const normalizedBook = normalizeHeadingCandidate(bookTitle).toLowerCase()
  if (!normalizedBook) {
    return false
  }

  const minMatchLength = Math.max(8, Math.floor(normalizedBook.length * 0.7))

  for (const block of blocks.slice(0, 20)) {
    if (!block?.isHeading) {
      continue
    }

    const normalizedBlock = normalizeHeadingCandidate(block.text ?? "").toLowerCase()
    if (!normalizedBlock || isAuthorBylineHeadingText(normalizedBlock)) {
      continue
    }
    if (CHAPTER_PATTERN.test(normalizedBlock)) {
      continue
    }

    if (normalizedBlock === normalizedBook) {
      return true
    }

    if (
      normalizedBlock.length >= minMatchLength &&
      (normalizedBlock.includes(normalizedBook) || normalizedBook.includes(normalizedBlock))
    ) {
      return true
    }
  }

  return false
}

function isGarbledSplitBookTitleText(text, bookTitle) {
  const normalizedBlock = normalizeTitleComparisonKey(text)
  const normalizedBook = normalizeTitleComparisonKey(bookTitle)
  if (!normalizedBlock || !normalizedBook || normalizedBlock.length >= normalizedBook.length) {
    return false
  }
  return (
    normalizedBook.startsWith(normalizedBlock) ||
    normalizedBlock === "thebook" ||
    normalizedBlock === "the"
  )
}

// A small-caps title-page byline extracts with its tracked capitals split out
// as lone letters ("by Robe R t Louis s tevenson"). Rejoin each lone letter
// with its neighboring fragment, then recase the damaged words so the byline
// reads "by Robert Louis Stevenson". Clean bylines have no lone-letter tokens
// (initials keep their periods) and pass through untouched.
function repairSmallCapsSplitByline(text) {
  const trimmed = (text ?? "").trim()
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (!tokens.some((token, index) => index > 0 && /^[A-Za-z]$/.test(token))) {
    return trimmed
  }

  const words = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (index === 0 || !/^[A-Za-z]$/.test(token)) {
      words.push(token)
      continue
    }
    const next = tokens[index + 1]
    if (next && /^[a-z]{2,}/.test(next)) {
      words.push(token + next)
      index += 1
    } else if (words.length > 0) {
      words[words.length - 1] += token
    } else {
      words.push(token)
    }
  }

  return words
    .map((word, index) => {
      if (index === 0 || !(/^[a-z]/.test(word) || /[a-z][A-Z]/.test(word))) {
        return word
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(" ")
}

function extractTitlePageAuthorFromPageData(pageData, knownTitles = []) {
  const knownTitleKeys = knownTitles
    .map((title) => normalizeTitleComparisonKey(title))
    .filter(Boolean)

  for (let pageIndex = 0; pageIndex < Math.min(2, pageData.length); pageIndex += 1) {
    for (const line of pageData[pageIndex]?.lines ?? []) {
      const text = (line.text ?? "").trim()
      if (!text || text.length > 48) {
        continue
      }
      if (/^by\s+/i.test(text)) {
        return repairSmallCapsSplitByline(text)
      }
      // A title page often repeats the work's own title in a name-like layout
      // ("Treasure Island"); the book's known titles are never its author.
      if (knownTitleKeys.includes(normalizeTitleComparisonKey(text))) {
        continue
      }
      if (
        /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$/.test(text) &&
        !/^(?:The|Book|Jungle|Count|Gulliver|Prince|Prince|Oliver|Hound|Last|Three|Musketeers)$/i.test(
          text
        )
      ) {
        return text
      }
    }
  }
  return ""
}

function injectCoverTitlePage(
  blocks,
  { bookTitle, authorText = "", metaTitle = "", pageData = [], fileName = "" } = {}
) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  const resolvedTitle =
    bookTitle && !/^untitled$/i.test(bookTitle)
      ? bookTitle
      : humanizeBookTitleFromFileName(fileName)
  if (!resolvedTitle) {
    return blocks
  }

  const coverImageIndex = blocks.findIndex(
    (block) =>
      (block?.type === "image" || block?.type === "image_candidate") &&
      (block.pageNumber ?? (block.sourcePdfPageIndex ?? 0) + 1) === 1 &&
      block.imageRole === PDF_IMAGE_ROLE.FULL_PAGE_ILLUSTRATION
  )

  const garbledTitleIndex = blocks.findIndex(
    (block, index) =>
      index < 16 &&
      block?.type !== "image" &&
      block?.type !== "image_candidate" &&
      isGarbledSplitBookTitleText(block?.text, resolvedTitle)
  )

  let result = [...blocks]
  if (garbledTitleIndex >= 0) {
    result.splice(garbledTitleIndex, 1)
  }

  const titlePageBlocks = [
    {
      text: resolvedTitle,
      isHeading: true,
      fontSize: 24,
      textAlign: "center",
      centered: true,
      isTitlePage: true,
      sourcePdfPageIndex: 0,
    },
  ]

  const metadataAuthor = metadataAuthorLooksLikeProducerCredit(
    sanitizePdfAuthor(authorText),
    metaTitle,
    pageData
  )
    ? ""
    : sanitizePdfAuthor(authorText)

  const resolvedAuthor =
    metadataAuthor ||
    extractTitlePageAuthorFromPageData(pageData, [
      resolvedTitle,
      humanizeBookTitleFromFileName(fileName),
    ])
  if (resolvedAuthor && !isScannerWatermarkLine(resolvedAuthor)) {
    titlePageBlocks.push({
      text: /^by\s/i.test(resolvedAuthor) ? resolvedAuthor : `By ${resolvedAuthor}`,
      isHeading: true,
      fontSize: 13,
      textAlign: "center",
      centered: true,
      isTitlePage: true,
      sourcePdfPageIndex: 0,
    })
  }

  if (coverImageIndex >= 0) {
    result[coverImageIndex] = {
      ...result[coverImageIndex],
      isTitlePageCover: true,
    }
    const insertAt = coverImageIndex + 1
    result.splice(insertAt, 0, ...titlePageBlocks)
    return result
  }

  return [...titlePageBlocks, ...result]
}

function isDialogueAttributionFragment(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 40) {
    return false
  }

  const letters = trimmed.replace(/[^A-Za-z]/g, "")
  if (
    letters.length >= 4 &&
    letters === letters.toUpperCase() &&
    /[A-Z]/.test(letters)
  ) {
    return false
  }

  if (/^(?:the|an?)\s+end\.?$/i.test(trimmed)) {
    return false
  }

  if (
    /^(?:Mr\.|Mrs\.|Miss|Ms\.|Dr\.|Sir|Lady|Colonel|Captain|Professor)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?[.!?]?[\u201c\u201d"']?\s*$/i.test(
      trimmed
    )
  ) {
    return true
  }

  return /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?[.!?]?[\u201c\u201d"']?\s*$/.test(trimmed)
}

function applyProseFormattingToBlock(block, line) {
  const lineText = (line.text ?? block.text ?? "").trim()
  if (
    line.centered &&
    !isShortDialogueLine(lineText) &&
    !isDisplayChapterTitleText(lineText) &&
    !isIncompleteNarrativeLineFragment(lineText)
  ) {
    block.textAlign = "center"
  }

  const runs = line.runs ?? []
  if (runs.length > 1) {
    block.runs = runs.map((run) => ({
      text: run.text,
      ...(run.bold ? { bold: true } : {}),
      ...(run.italic ? { italic: true } : {}),
    }))
  }
}

function proseFormattingDiffers(line, previousBlock) {
  if (!previousBlock) {
    return false
  }

  const lineCentered = Boolean(line.centered)
  const prevCentered = previousBlock.textAlign === "center"
  return lineCentered !== prevCentered
}

// Trailing closers observed after [.!?] in the sample PDF set: straight quotes,
// curly left/right singles and doubles, and ')'. Zero or more are allowed so a
// bare "ended." still matches, while nested closes such as danger.'"(U+2019 then
// U+201D) also match. A bare quote with no terminal punctuation before it does
// not match - the pattern still requires [.!?].
//
// Used only by the heading-continuation gate below. Widening the same test inside
// isProseLineContinuation / dialogue-split / extract-merge moved block boundaries
// on most sample books; those consumers stay on the legacy single-closer pattern
// until a dedicated reflow review.
const ENDS_WITH_SENTENCE_TERMINATOR_REGEX =
  /[.!?]["'\u2018\u2019\u201c\u201d)]*\s*$/

function endsWithSentenceTerminator(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  return ENDS_WITH_SENTENCE_TERMINATOR_REGEX.test(trimmed)
}

// A display-sized all-caps title line (anthology fable titles at ~25pt). Used to
// exempt those lines from heading-gate prose-continuation so a leading "THE "
// is not treated as a connective when the previous block is incomplete junk
// (illustration OCR). Requires pure-title shape and type well above body size
// (~1.5x, and at least 20pt) so modest all-caps back-matter labels (e.g. WoK
// "THE END OF ENDNOTE") stay out of this path.
function isDisplaySizedAllCapsTitleLine(text, line = null, entry = null) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 90) {
    return false
  }
  const lineFontSize = line?.fontSize ?? 0
  if (lineFontSize < 20) {
    return false
  }
  const bodyFontSize =
    entry?.pageMetrics?.bodyFontSize ?? line?.pageMetrics?.bodyFontSize ?? 0
  if (bodyFontSize > 0 && lineFontSize < bodyFontSize * 1.5) {
    return false
  }
  if (!isPureAllCapsTitleText(trimmed)) {
    return false
  }
  const words = trimmed.split(/\s+/).filter(Boolean)
  return words.length >= 2 && words.length <= 14
}

// Single-line all-caps titles that contain internal commas but are already
// complete (e.g. "THE HAWK, KITE, AND PIGEONS"). isPureAllCapsTitleText rejects
// these via isIncompleteAllCapsWrapLine's any-comma rule, which exists to keep
// wrap heads such as "THE MOUSE, THE FROG, AND THE" from promoting alone.
// Gate on display font size and refuse lines that still look like wrap heads
// (trailing comma/dash or dangling article) so wrappedDisplayTitle merge stays
// responsible for multi-line titles.
function isCompleteLargeFontAllCapsCommaTitle(text, line = null, entry = null) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 90) {
    return false
  }
  if (isTocChapterListingLine(trimmed) || isTocDenseListingLine(trimmed)) {
    return false
  }
  if (isNarrativeSentenceLine(trimmed) || isScannerWatermarkLine(trimmed)) {
    return false
  }
  if ((trimmed.match(/,/g) ?? []).length < 1) {
    return false
  }
  if (/[-\u2014\u2013,]\s*$/.test(trimmed)) {
    return false
  }
  if (HEADING_DANGLING_ENDING_REGEX.test(trimmed)) {
    return false
  }
  if (/[.!?][\u201d"\u2019']?\s*$/.test(trimmed)) {
    return false
  }
  const letters = trimmed.replace(/[^A-Za-z]/g, "")
  if (letters.length < 3 || letters !== letters.toUpperCase()) {
    return false
  }
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 2 || words.length > 14) {
    return false
  }
  const lineFontSize = line?.fontSize ?? 0
  if (lineFontSize < 20) {
    return false
  }
  const bodyFontSize =
    entry?.pageMetrics?.bodyFontSize ?? line?.pageMetrics?.bodyFontSize ?? 0
  if (bodyFontSize > 0 && lineFontSize < bodyFontSize * 1.5) {
    return false
  }
  return true
}

// Heading-only variant of isProseLineContinuation: when the previous block ends
// with terminal punctuation plus one or more closing quotes (nested dialogue),
// treat it as a completed sentence and apply only the post-sentence continuation
// rules. The shared isProseLineContinuation still uses the legacy single-closer
// regex so ordinary paragraph merges stay byte-stable.
function isHeadingProseLineContinuation(text, previousBlock, line = null, entry = null) {
  const trimmed = (text ?? "").trim()
  const prevTrim = (previousBlock?.text ?? "").trim()
  if (!trimmed || !prevTrim || previousBlock?.isHeading) {
    return false
  }
  // Display-sized all-caps titles are never prose continuations for heading
  // gating - even when they start with THE and the previous block is incomplete
  // illustration OCR ("LIVINGSTAN BOL"). Includes complete single-line comma
  // titles ("THE HAWK, KITE, AND PIGEONS") which isPureAllCapsTitleText rejects.
  // Lowercase "the ..." still continues via isProseLineContinuation's /^[a-z]/ branch.
  if (
    isDisplaySizedAllCapsTitleLine(trimmed, line, entry) ||
    isCompleteLargeFontAllCapsCommaTitle(trimmed, line, entry)
  ) {
    return false
  }
  if (endsWithSentenceTerminator(prevTrim)) {
    if (isVerseLineText(trimmed) || isVerseLineText(prevTrim)) {
      return false
    }
    if (previousBlock.textAlign === "center") {
      return false
    }
    if (isAllCapsCalloutLine(trimmed)) {
      return false
    }
    if (/^[a-z(\u201c]/.test(trimmed)) {
      return true
    }
    if (/^(and|but|or|then|who|which|that|as|if|like|sea)\s/i.test(trimmed)) {
      return true
    }
    return false
  }
  return isProseLineContinuation(text, previousBlock)
}

function isProseLineContinuation(text, previousBlock) {
  const trimmed = (text ?? "").trim()
  const prevTrim = (previousBlock?.text ?? "").trim()
  if (!trimmed || !prevTrim || previousBlock?.isHeading) {
    return false
  }
  if (isVerseLineText(trimmed) || isVerseLineText(prevTrim)) {
    return false
  }
  if (previousBlock.textAlign === "center") {
    return false
  }
  if (!/[.!?]["'\u201d]?\s*$/.test(prevTrim)) {
    if (/^[a-z(\u201c(']/.test(trimmed)) {
      return true
    }
    if (
      /,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s*$/.test(prevTrim) &&
      /^[A-Z][a-z]+\s/.test(trimmed)
    ) {
      return true
    }
    if (/^(and|but|or|then|who|which|that|as|if|like|for|of|to|in|at|on|with|from|by|the|a|an|apples|out)\s/i.test(trimmed)) {
      return true
    }
    if (HEADING_DANGLING_ENDING_REGEX.test(prevTrim)) {
      return true
    }
    const letters = trimmed.replace(/[^A-Za-z]/g, "")
    if (letters.length >= 8) {
      const upperRatio = (trimmed.match(/[A-Z]/g) ?? []).length / letters.length
      if (upperRatio >= 0.85) {
        if (isPureAllCapsTitleText(trimmed)) {
          return false
        }
        return true
      }
    }
    if (/[.!?]["'\u201d]?\s*$/.test(trimmed) && countWordsInText(trimmed) <= 15) {
      return true
    }
    return false
  }
  if (isAllCapsCalloutLine(trimmed)) {
    return false
  }
  if (/^[a-z(\u201c]/.test(trimmed)) {
    return true
  }
  if (/^(and|but|or|then|who|which|that|as|if|like|sea)\s/i.test(trimmed)) {
    return true
  }
  return false
}

function isShortProseContinuation(text, previousBlock) {
  return (
    isProseLineContinuation(text, previousBlock) &&
    countWordsInText(text) <= SHORT_PROSE_CONTINUATION_MAX_WORDS
  )
}

const Y_LINE_GROUP_TOLERANCE_PX = 3
const INDENT_THRESHOLD_PX = 12
const PARAGRAPH_GAP_MULTIPLIER = 1.25
const HEADING_FONT_BODY_RATIO = 1.15
const INTER_LINE_GAP_MAX_FOR_MEDIAN_PX = 20
const HEADING_STRING_MIN_FONT_SIZE = 16

// "if" is excluded from the shared word list and matched separately with a negative
// lookbehind for a preceding apostrophe: elided-article place names ending in "d'If" /
// "l'If" (e.g. Monte Cristo's Chateau d'If) are complete, not dangling, but a genuine
// standalone trailing "if" (preceded by whitespace or punctuation, not an apostrophe)
// should still be flagged.
const HEADING_DANGLING_ENDING_REGEX =
  /\b(?:of|the|a|an|and|but|or|nor|for|yet|so|left|fell|was|be|on|in|at|to|by|with|from|into|that|which|who|as|their|his|her|its|our|your|had|has|have|not|are|were|is)\s*$|(?<!['‘’ʼ`])\bif\s*$/i
const RUNNING_HEADER_MIN_PAGES = 3
const CENTERED_LINE_LEFT_GAP_MIN_PX = 20
const CENTERED_LINE_CENTER_TOLERANCE_PX = 25
const CENTERED_LINE_MAX_WIDTH_RATIO = 0.55
const CENTERED_REPEATED_LINE_MIN_COUNT = 2
const CENTERED_REPEATED_LINE_MAX_CHARS = 80

const INLINE_PAGE_DECORATOR_REGEX = /\s*-\s*\d+\s*-\s*/g
const FOOTNOTE_REFERENCE_REGEX = /\[\d+\]/g
const RUNNING_HEADER_INLINE_REGEX =
  /\s+\d{1,3}\s+(?:chapter|letter)\s+(?:[IVXLCDM]+|\d+)\b/gi
const ROMAN_PREFIX_BEFORE_HEADING_REGEX =
  /\b[ivxlcdm]{1,4}\s+(?=(?:PREFACE|Chapter|Letter)\b)/gi
const EMBEDDED_PREFACE_PAGE_MARKER_REGEX = /\bPREFACE\s+[ivxlcdm]{1,4}\b/gi

const STANDALONE_PAGE_NUMBER_REGEX = /^-?\s*\d+\s*-?\s*$/
const STANDALONE_ROMAN_PAGE_MARKER_REGEX = /^[ivxlcdm]{1,4}$/i
const VALID_ROMAN_NUMERAL_REGEX =
  /^(?:M{0,3})(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i
const AMBIGUOUS_SINGLE_ROMAN_LETTERS = new Set(["I", "V", "X", "L", "C", "D", "M"])
const ROMAN_PAGE_MARKER_CLUSTER_REGEX = /^[ivxlcdm]{1,4}(?:\s+[ivxlcdm]{1,4}){0,3}$/i
const STANDALONE_RUNNING_HEAD_REGEX =
  /^\d{1,3}\s+(?:chapter|letter)\s+(?:[IVXLCDM]+|\d+)$/i
const ROMAN_SECTION_RUNNING_HEAD_REGEX =
  /^[IVXLCDM]{1,4}\s+(?:INTRODUCTION|PREFACE|PROLOGUE|EPILOGUE|CONCLUSION|CONTENTS|CHAPTER|PART)\b/i
const EMBEDDED_ROMAN_SECTION_RUNNING_HEAD_REGEX =
  /\b[IVXLCDM]{1,4}\s+(?:INTRODUCTION|PREFACE|PROLOGUE|EPILOGUE|CONCLUSION)\b/gi
const TOC_HEADER_LINE_REGEX = /^-\s*\d+\s*-\s*.+$/

function parseValidStandaloneRomanNumeral(text) {
  const trimmed = (text ?? "").trim().replace(/\.$/, "")
  if (!STANDALONE_ROMAN_PAGE_MARKER_REGEX.test(trimmed)) {
    return null
  }
  const upper = trimmed.toUpperCase()
  if (!VALID_ROMAN_NUMERAL_REGEX.test(upper)) {
    return null
  }
  return upper
}

function isRomanPartOpenerLine(
  text,
  { distinctPageCount = 1, fontSize = 0, centered = false, romanNumeralsOnPage = 1 } = {}
) {
  const roman = parseValidStandaloneRomanNumeral(text)
  if (!roman) {
    return false
  }

  if (distinctPageCount >= RUNNING_HEADER_MIN_PAGES) {
    return false
  }

  // Printed TOC pages list multiple roman numerals (e.g. Frankenstein: II, IV, VI).
  if (romanNumeralsOnPage >= 2) {
    return false
  }

  if (roman.length >= 2) {
    return (
      fontSize >= CHAPTER_HEADING_MIN_FONT_SIZE ||
      centered ||
      distinctPageCount <= 2
    )
  }

  if (!AMBIGUOUS_SINGLE_ROMAN_LETTERS.has(roman)) {
    return false
  }

  return distinctPageCount === 1 && fontSize >= 14
}

function countRomanNumeralsOnPage(allLines, pageIndex, text) {
  const numerals = new Set()
  for (const entry of allLines ?? []) {
    if (entry.pageIndex !== pageIndex) {
      continue
    }
    const roman = parseValidStandaloneRomanNumeral(entry.text)
    if (roman) {
      numerals.add(roman)
    }
  }
  return numerals.size
}

function romanPartOpenerHasFollowingBody(allLines, startIndex) {
  for (
    let index = startIndex + 1;
    index < Math.min(startIndex + 10, allLines.length);
    index += 1
  ) {
    const text = (allLines[index]?.text ?? "").trim()
    if (!text) {
      continue
    }
    if (parseValidStandaloneRomanNumeral(text)) {
      return false
    }
    if (/^volume\b/i.test(text) || /^letter\b/i.test(text) || CHAPTER_PATTERN.test(text)) {
      return false
    }
    if (/^contents$/i.test(text) || isPrintedTocEntryLine(text)) {
      return false
    }
    if (text.length >= 48 || /^[a-z("\u201c]/.test(text)) {
      return true
    }
  }
  return false
}

function isFrontMatterRomanNumeralTocEntry(allLines, startIndex) {
  let firstVolumeOrLetterIndex = -1
  for (let index = 0; index < allLines.length; index += 1) {
    const text = (allLines[index]?.text ?? "").trim()
    if (!text || parseValidStandaloneRomanNumeral(text)) {
      continue
    }
    if (
      /^volume\s+/i.test(text) ||
      CHAPTER_PATTERN.test(text) ||
      /^letter\s+/i.test(text)
    ) {
      firstVolumeOrLetterIndex = index
      break
    }
  }
  if (firstVolumeOrLetterIndex < 0) {
    return false
  }
  return startIndex < firstVolumeOrLetterIndex
}

function countDistinctPagesForLineText(allLines, text) {
  const normalized = (text ?? "").trim()
  const pages = new Set()
  for (const entry of allLines ?? []) {
    if ((entry.text ?? "").trim() === normalized) {
      pages.add(entry.pageIndex)
    }
  }
  return pages.size
}

const MARGIN_CALLOUT_MAX_WORDS = 9
const MARGIN_CALLOUT_MAX_CHARS = 52
const MARGIN_CALLOUT_FRAGMENT_MAX_WORDS = 7
const MARGIN_CALLOUT_MIN_LONG_LINES = 5
const MARGIN_CALLOUT_LONG_LINE_CHARS = 65
const MARGIN_CALLOUT_SUBSTRING_PARENT_GAP = 12
const MARGIN_CALLOUT_LEFT_DISPLACE_PX = 16
const MARGIN_CALLOUT_RIGHT_DISPLACE_PX = 48

const PROSE_BLOCKLIST_WORD_REGEX = /^(and|or|but|the|a|an)$/i

function medianValue(values) {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function computePageLineMetrics(pageLines) {
  const fontSizes = pageLines
    .map((line) => line.fontSize)
    .filter((value) => Number.isFinite(value) && value > 0)

  const bodyFontSize = fontSizes.length > 0 ? medianValue(fontSizes) : 12

  const sortedByY = [...pageLines].sort((a, b) => (b.y ?? 0) - (a.y ?? 0))
  const interLineGaps = []

  for (let index = 1; index < sortedByY.length; index += 1) {
    const gap = (sortedByY[index - 1].y ?? 0) - (sortedByY[index].y ?? 0)
    if (gap > 0 && gap < INTER_LINE_GAP_MAX_FOR_MEDIAN_PX) {
      interLineGaps.push(gap)
    }
  }

  const dominantLineHeight =
    interLineGaps.length > 0 ? medianValue(interLineGaps) : bodyFontSize * 1.2

  return {
    bodyFontSize,
    dominantLineHeight,
    gapThreshold: dominantLineHeight * PARAGRAPH_GAP_MULTIPLIER,
  }
}

function annotatePageLineGaps(pageLines, pageMetrics) {
  const sortedByY = [...pageLines].sort((a, b) => (b.y ?? 0) - (a.y ?? 0))

  for (let index = 0; index < sortedByY.length; index += 1) {
    const line = sortedByY[index]
    const gapAboveOnPage =
      index > 0 ? (sortedByY[index - 1].y ?? 0) - (line.y ?? 0) : null
    const gapBelowOnPage =
      index < sortedByY.length - 1
        ? (line.y ?? 0) - (sortedByY[index + 1].y ?? 0)
        : null

    line.gapAboveOnPage = gapAboveOnPage
    line.gapBelowOnPage = gapBelowOnPage
    line.pageMetrics = pageMetrics
  }

  return pageLines
}

function isHeadingIncompleteEnding(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }

  if (/[,;:\u2014\u2013-]\s*$/.test(trimmed)) {
    return true
  }

  return HEADING_DANGLING_ENDING_REGEX.test(trimmed)
}

function isHeadingTerminalOrStructural(text, line = null) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }

  if (isCleanStructuralHeadingText(trimmed, line)) {
    return true
  }

  if (isHeadingIncompleteEnding(trimmed)) {
    return false
  }

  return /[.!?][\u201d"\u2019']?\s*$/.test(trimmed)
}

function isLineIsolatedOnPage(line, gapThreshold) {
  if (!line || gapThreshold <= 0) {
    return false
  }

  const above = line.gapAboveOnPage
  const below = line.gapBelowOnPage

  if (above == null || below == null) {
    return false
  }

  return above > gapThreshold && below > gapThreshold
}

function isIncompleteAllCapsWrapLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length < 12) {
    return false
  }
  const letters = trimmed.replace(/[^A-Za-z]/g, "")
  if (letters.length < 10 || letters !== letters.toUpperCase()) {
    return false
  }
  if (/[.!?]\s*$/.test(trimmed)) {
    return false
  }
  if (/[-\u2014\u2013,]\s*$/.test(trimmed)) {
    return true
  }
  if ((trimmed.match(/,/g) ?? []).length >= 1) {
    return true
  }
  return false
}

function isPureAllCapsTitleText(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (isTocChapterListingLine(trimmed) || isTocDenseListingLine(trimmed)) {
    return false
  }
  if (isNarrativeSentenceLine(trimmed)) {
    return false
  }
  if (isIncompleteAllCapsWrapLine(trimmed)) {
    return false
  }
  if ((trimmed.match(/,/g) ?? []).length >= 2) {
    return false
  }
  if (/[.!?][\u201d"\u2019']?\s*$/.test(trimmed)) {
    return false
  }

  const letters = trimmed.replace(/[^A-Za-z]/g, "")
  if (letters.length < 3 || letters !== letters.toUpperCase()) {
    return false
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  return words.length >= 1 && words.length <= 14
}

const TEMPORAL_SCENE_MARKER_REGEX =
  /^(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\s+later|(?:moments?|minutes?|hours?|days?|weeks?|months?|years?)\s+later|some\s+time\s+later|much\s+later|(?:the\s+)?next\s+(?:morning|evening|night|day|week|month|year)|(?:later\s+that|that)\s+(?:morning|evening|night|day|week|month|year)|a\s+(?:few|couple\s+of)\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+later)$/i

function isTemporalSceneMarkerText(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  return TEMPORAL_SCENE_MARKER_REGEX.test(trimmed)
}

function isCenteredDecorativeProseText(text, line = null, entry = null) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (isTemporalSceneMarkerText(trimmed)) {
    return true
  }

  const centered = Boolean(
    line?.centered ||
      line?.textAlign === "center" ||
      entry?.line?.centered ||
      entry?.line?.textAlign === "center"
  )

  if (centered && isPureAllCapsTitleText(trimmed)) {
    if (
      parseChapterOnlyHeading(trimmed) ||
      CHAPTER_PATTERN.test(trimmed) ||
      CHAPTER_WITH_SUBTITLE_REGEX.test(trimmed)
    ) {
      return false
    }
    // A centered all-caps line set noticeably larger than the body font is a
    // prominent display title (e.g. anthology fable titles rendered at ~1.7x
    // body), not decorative prose. Genuine centered decorative prose - a
    // temporal scene marker, a repeated chant such as 1984's "DOWN WITH BIG
    // BROTHER", a centered dialogue fragment - is set at body size. Defer to
    // display-title detection so the larger lines can be promoted to headings.
    const metrics = entry?.pageMetrics ?? line?.pageMetrics
    const bodyFontSize = metrics?.bodyFontSize ?? 0
    const lineFontSize = line?.fontSize ?? entry?.line?.fontSize ?? 0
    if (bodyFontSize > 0 && lineFontSize >= bodyFontSize * 1.35) {
      return false
    }
    const words = trimmed.split(/\s+/).filter(Boolean)
    if (words.length >= 1 && words.length <= 8 && trimmed.length <= 72) {
      return true
    }
  }

  if (
    parseChapterOnlyHeading(trimmed) ||
    CHAPTER_PATTERN.test(trimmed) ||
    CHAPTER_WITH_SUBTITLE_REGEX.test(trimmed)
  ) {
    return false
  }
  if (isDisplayChapterTitleText(trimmed) || isScannerWatermarkLine(trimmed)) {
    return false
  }
  if (isNarrativeSentenceLine(trimmed)) {
    return false
  }

  return false
}

function isQuotedEpistolarySalutationLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }

  // Quoted letter openings such as "My dear Sir," / "DEAR SIR," are often set a
  // point or two larger than body type. That modest bump must not promote them
  // to headings. Require an opening quote and a bare trailing comma so real
  // chapter titles and hyphen-continued openings ("Dear Sir,-") stay intact.
  if (!/^["\u201c\u2018']/.test(trimmed)) {
    return false
  }
  if (!/,\s*$/.test(trimmed) || /[-–—]\s*$/.test(trimmed)) {
    return false
  }

  const core = trimmed
    .replace(/^["\u201c\u2018']+\s*/, "")
    .replace(/,\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!core || core.length > 48) {
    return false
  }

  const words = core.split(/\s+/).filter(Boolean)
  if (words.length < 2 || words.length > 6) {
    return false
  }

  return /^(?:My\s+)?Dear\s+[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}$/i.test(
    core
  )
}

function isLikelyAllCapsDisplayTitle(text, line = null, entry = null) {
  if (isCenteredDecorativeProseText(text, line, entry)) {
    return false
  }
  if (isQuotedEpistolarySalutationLine(text)) {
    return false
  }
  const pureTitle = isPureAllCapsTitleText(text)
  const commaTitle =
    !pureTitle && isCompleteLargeFontAllCapsCommaTitle(text, line, entry)
  if (!pureTitle && !commaTitle) {
    return false
  }

  const trimmed = (text ?? "").trim()
  const metrics = entry?.pageMetrics ?? line?.pageMetrics
  const bodyFontSize = metrics?.bodyFontSize ?? 0
  const lineFontSize = line?.fontSize ?? 0
  const centered = Boolean(line?.centered || line?.textAlign === "center")

  if (bodyFontSize > 0 && lineFontSize >= bodyFontSize * 1.35) {
    return true
  }
  if (lineFontSize >= HEADING_STRING_MIN_FONT_SIZE) {
    return true
  }
  if (centered && !isHeadingIncompleteEnding(trimmed)) {
    const words = trimmed.split(/\s+/).filter(Boolean)
    if (words.length <= 8) {
      return true
    }
  }
  if (isHeadingIncompleteEnding(trimmed)) {
    const words = trimmed.split(/\s+/).filter(Boolean)
    if (words.length <= 5 && isPureAllCapsTitleText(trimmed)) {
      return true
    }
    return false
  }
  if (/,\s*$/.test(trimmed)) {
    return true
  }

  return false
}

function isProminentDisplayTitleLine(text, line, entry = null) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || isScannerWatermarkLine(trimmed)) {
    return false
  }
  if (isQuotedEpistolarySalutationLine(trimmed)) {
    return false
  }
  if (isCenteredDecorativeProseText(trimmed, line, entry)) {
    return false
  }
  if (CHAPTER_PATTERN.test(trimmed) || isAuthorStructuralLine(trimmed)) {
    return false
  }
  if (isLikelyAllCapsDisplayTitle(trimmed, line, entry)) {
    return true
  }
  // A small-caps chapter opening run is body prose, not a display title.
  // It is long, mostly uppercase, and does not read as a short title.
  {
    const letters = trimmed.replace(/[^A-Za-z]/g, "")
    const upper = (trimmed.match(/[A-Z]/g) ?? []).length
    if (
      letters.length >= 16 &&
      upper / Math.max(1, letters.length) >= 0.85 &&
      trimmed.split(/\s+/).filter(Boolean).length >= 5
    ) {
      return false
    }
  }
  if (
    isIllustrationsListEntryLine(trimmed) ||
    isIllustrationsListLine(trimmed) ||
    isBibliographySeriesTitleLine(trimmed) ||
    isStormlightPrintedTocLine(trimmed) ||
    isTitlePageBookLabelLine(trimmed) ||
    isPublisherBibliographyHeaderLine(trimmed)
  ) {
    return false
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 2 || words.length > 12) {
    return false
  }
  if (isHeadingIncompleteEnding(trimmed)) {
    return false
  }
  if (/[.!?][\u201d"\u2019']?\s*$/.test(trimmed)) {
    return false
  }

  const metrics = entry?.pageMetrics ?? line?.pageMetrics
  const bodyFontSize = metrics?.bodyFontSize ?? line?.fontSize ?? 0
  const lineFontSize = line?.fontSize ?? 0
  if (
    bodyFontSize > 0 &&
    lineFontSize < bodyFontSize * HEADING_FONT_BODY_RATIO &&
    lineFontSize < HEADING_STRING_MIN_FONT_SIZE
  ) {
    return false
  }

  const gapThreshold = metrics?.gapThreshold ?? 0
  if (!isLineIsolatedOnPage(line, gapThreshold)) {
    return false
  }

  return /^[A-Z]/.test(trimmed)
}

function passesVisualHeadingGuards(text, line, entry = null) {
  if (isCleanStructuralHeadingText(text, line)) {
    return true
  }

  if (!isHeadingTerminalOrStructural(text, line)) {
    return false
  }

  const metrics = entry?.pageMetrics ?? line?.pageMetrics
  const bodyFontSize = metrics?.bodyFontSize ?? line?.fontSize ?? 0
  const lineFontSize = line?.fontSize ?? 0

  if (bodyFontSize > 0 && lineFontSize < bodyFontSize * HEADING_FONT_BODY_RATIO) {
    return false
  }

  const gapThreshold = metrics?.gapThreshold ?? 0
  if (!isLineIsolatedOnPage(line, gapThreshold)) {
    return false
  }

  return true
}

const SPLIT_WORD_STOPWORDS =
  /^(of|in|on|at|to|by|or|an|the|he|she|it|we|is|was|be|as|if|so|no|do|up|my|me|and|but|for|not|you|all|are|had|her|his|him|has|were|been|from|that|this|with|they|them|then|than|when|what|will|would|could|should|ear|red)$/i

const SPLIT_SYLLABLE_SUFFIX =
  /^(cient|tion|sion|ing|ment|ments|ness|able|ible|ure|ous|ive|ly|ed|es|er|est|ple)$/i

function joinSplitWordFragments(text) {
  return (text ?? "").replace(
    /\b([a-z]{2,})\s+([a-z]{2,})\b/gi,
    (match, left, right) => {
      if (SPLIT_WORD_STOPWORDS.test(right)) {
        return match
      }
      if (/^[A-Z]/.test(right)) {
        return match
      }
      if (left.length <= 6 && SPLIT_SYLLABLE_SUFFIX.test(right)) {
        return `${left}${right}`
      }
      return match
    }
  )
}

// Collapse PDF letter-spacing (tracking) on display lines so that
// "T R E A S U R E I S L A N D" becomes "TREASUREISLAND" and
// "c h a p t e r 7" becomes "chapter 7". Only acts when a line is
// dominated by single-character tokens, so normal prose and titles
// (multi-character word items) are returned unchanged.
function collapseLetterSpacing(text) {
  if (!text || text.indexOf(" ") === -1) {
    return text
  }

  const tokens = text.trim().split(/\s+/)
  const singleCharTokenCount = tokens.filter((token) => token.length === 1).length

  if (singleCharTokenCount < 3 || singleCharTokenCount < tokens.length * 0.6) {
    return text
  }

  const collapsedTokens = []
  let run = []

  const flushRun = () => {
    if (run.length >= 3) {
      let word = ""
      let previousCharClass = null
      for (const character of run) {
        const charClass = /[0-9]/.test(character) ? "digit" : "other"
        if (previousCharClass && charClass !== previousCharClass) {
          word += " "
        }
        word += character
        previousCharClass = charClass
      }
      collapsedTokens.push(word)
    } else {
      collapsedTokens.push(...run)
    }
    run = []
  }

  for (const token of tokens) {
    if (token.length === 1) {
      run.push(token)
    } else {
      flushRun()
      collapsedTokens.push(token)
    }
  }
  flushRun()

  return collapsedTokens.join(" ")
}

// Print-production artifacts that show up as real text in the PDF's
// content stream: the prepress filename/timestamp slug, and the
// unfilled running-header placeholder left in the template.
const PRODUCTION_SLUG_REGEX = /\.(?:qxd|qxp|qx\d|indd)\b/i
const CHAPTER_PLACEHOLDER_REGEX = /^chapter\s*heading\s*goes\s*here\.?$/i

// A collapsed running header: an all-caps title run (letter-spacing
// already fused by collapseLetterSpacing, so it has no internal spaces),
// optionally flanked by a 1 to 4 digit folio on either side. The title
// run allows the punctuation that appears inside chapter and book titles
// set in tracked small caps: straight and curly quotes, apostrophes,
// periods, commas, and dashes.
const COLLAPSED_RUNNING_HEADER_REGEX =
  /^(?:(\d{1,4})\s+)?([A-Z][A-Z0-9.,!?'\u2018\u2019"\u201c\u201d\u2013\u2014-]{2,60})(?:\s+(\d{1,4}))?$/

function isCollapsedRunningHeaderLine(text) {
  const match = (text ?? "").trim().match(COLLAPSED_RUNNING_HEADER_REGEX)
  if (!match) {
    return false
  }
  const leadingNumber = match[1]
  const titleRun = match[2]
  const trailingNumber = match[3]
  if (/\s/.test(titleRun)) {
    return false
  }
  const letters = titleRun.replace(/[^A-Za-z]/g, "")
  if (letters.length < 4 || letters !== letters.toUpperCase()) {
    return false
  }
  // With a folio on either side it is unambiguously a running head. Without
  // one, require a longer run so a lone all-caps prose word ("STOP", "NOOO")
  // is not mistaken for a header.
  if (leadingNumber || trailingNumber) {
    return true
  }
  return letters.length >= 8
}

function isLetterSpacedProductionArtifact(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }

  const normalized = trimmed.replace(/\s+/g, "")
  if (CHAPTER_PLACEHOLDER_REGEX.test(normalized)) {
    return true
  }
  if (/^CHAPTERHEADINGGOESHERE$/i.test(normalized)) {
    return true
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (
    tokens.length >= 4 &&
    tokens.every((token) => token.length === 1 && /[A-Za-z]/.test(token))
  ) {
    const joined = tokens.join("").toUpperCase()
    if (
      /^(CHAPTER|HEADING|GOES|HERE|TREASURE|ISLAND)/.test(joined) ||
      joined.includes("CHAPTERHEADING")
    ) {
      return true
    }
  }

  return false
}

function isSpacedRunningHeaderLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }

  const match = trimmed.match(/^(.+?)\s+(\d{1,4})$/)
  if (!match) {
    return false
  }

  const titlePart = match[1].replace(/\s+/g, " ").trim()
  const letters = titlePart.replace(/[^A-Za-z]/g, "")
  if (letters.length < 8) {
    return false
  }

  const upperCount = (titlePart.match(/[A-Z]/g) ?? []).length
  if (upperCount / letters.length < 0.8) {
    return false
  }

  if (letters === letters.toUpperCase()) {
    return true
  }

  return /^THE[A-Z]/i.test(titlePart.replace(/\s+/g, ""))
}

const EMBEDDED_RUNNING_HEADER_REGEX =
  /\s+(?:THE[A-Z0-9"“”'.,\u2013\u2014-]{8,80}|[A-Z][A-Z0-9"“”'.,\u2013\u2014-\s]{8,80})\s+\d{1,4}\s+/g
const STORY_SECTION_RUNNING_HEAD_REGEX = /^.{1,80}\s•\s*\d{1,3}$/
const EMBEDDED_STORY_SECTION_RUNNING_HEAD_REGEX = /\s+[^.!?\n]{1,72}\s•\s*\d{1,3}\s+/g
const EMBEDDED_RECURRING_BOOK_TITLE_REGEX = /\bTHE JUNGLE BOOK\b/gi
const SADDLEBACK_CHAPTER_DIGIT_MIN_FONT = 30
const EMBEDDED_CHAPTER_PLACEHOLDER_REGEX = /\bCHAPTER\s*HEADING\s*GOES\s*HERE\b/gi

function isStorySectionRunningHeadLine(text) {
  const trimmed = (text ?? "").trim()
  if (!STORY_SECTION_RUNNING_HEAD_REGEX.test(trimmed)) {
    return false
  }
  if (/[.!?]/.test(trimmed)) {
    return false
  }
  const words = trimmed.split(/\s+/).filter(Boolean)
  return words.length >= 2 && words.length <= 10
}

function isRecurringBookTitleRunningHeadLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  // Saddleback editions repeat this exact running head in the margin.
  // Do not generalize to other all-caps lines — that drops real chapter
  // headings such as "CHAPTER I" / "CHAPTER ONE" in Moby Dick and Narnia.
  return /^THE JUNGLE BOOK$/i.test(trimmed)
}

function isSaddlebackChapterNumberLine(text, line, pageMetrics) {
  const trimmed = (text ?? "").trim()
  if (!/^\d{1,2}$/.test(trimmed)) {
    return false
  }
  const fontSize = line?.fontSize ?? 0
  const bodySize = pageMetrics?.bodyFontSize ?? 12
  return fontSize >= Math.max(SADDLEBACK_CHAPTER_DIGIT_MIN_FONT, bodySize * 2.2)
}

function isSaddlebackTitleFragmentLine(text, line, pageMetrics) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 56) {
    return false
  }
  if (/^\d{1,3}$/.test(trimmed)) {
    return false
  }
  if (isStorySectionRunningHeadLine(trimmed) || isRecurringBookTitleRunningHeadLine(trimmed)) {
    return false
  }
  const fontSize = line?.fontSize ?? 0
  const bodySize = pageMetrics?.bodyFontSize ?? 12
  if (fontSize < Math.max(18, bodySize * 1.45)) {
    return false
  }
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 1 || words.length > 5) {
    return false
  }
  if (
    looksLikeChapterOpeningProse(trimmed) &&
    (words.length > 4 || fontSize < Math.max(20, bodySize * 1.8))
  ) {
    return false
  }
  return /^[A-Z"'\u201c]/.test(trimmed)
}

function isSaddlebackLayoutPreservationLine(line, pageLines) {
  const text = (line?.text ?? "").trim()
  if (!text) {
    return false
  }
  const pageMetrics = computePageLineMetrics(pageLines ?? [])
  return (
    isSaddlebackChapterNumberLine(text, line, pageMetrics) ||
    isSaddlebackTitleFragmentLine(text, line, pageMetrics)
  )
}

function normalizeSaddlebackTitleText(text) {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
}

function titlesMatchSaddlebackOpener(combined, expectedTitle) {
  const combinedNorm = normalizeSaddlebackTitleText(combined)
  const expectedNorm = normalizeSaddlebackTitleText(expectedTitle)
  if (!combinedNorm || !expectedNorm) {
    return false
  }
  if (
    expectedNorm.startsWith(combinedNorm) ||
    combinedNorm.startsWith(expectedNorm)
  ) {
    return true
  }
  const expectedWords = expectedNorm.split(/\s+/).filter(Boolean)
  const combinedWords = combinedNorm.split(/\s+/).filter(Boolean)
  if (combinedWords.length >= 2) {
    return expectedNorm.includes(combinedNorm)
  }
  return expectedWords[0] === combinedWords[0]
}

function cleanStoryChapterTitle(text) {
  return (text ?? "")
    .replace(/^[\s\u201c\u201d"'`]+|[\s\u201c\u201d"'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function tryConsumeSaddlebackChapterOpener(
  allLines,
  startIndex,
  printedToc,
  nextChapterKey = 1
) {
  if (!printedToc?.chapters?.size || startIndex >= allLines.length) {
    return null
  }

  const chapterKey = String(nextChapterKey)
  const expectedTitle = printedToc.chapters.get(chapterKey)
  if (!expectedTitle) {
    return null
  }

  const startPage = allLines[startIndex].pageIndex
  let cursor = startIndex

  while (cursor < allLines.length && allLines[cursor].pageIndex === startPage) {
    const candidateText = allLines[cursor].text.trim()
    if (
      isStorySectionRunningHeadLine(candidateText) ||
      isRecurringBookTitleRunningHeadLine(candidateText)
    ) {
      cursor += 1
      continue
    }
    break
  }

  let digitIndex = -1
  let chapterNumber = null

  for (
    let scanIndex = cursor;
    scanIndex < Math.min(cursor + 6, allLines.length);
    scanIndex += 1
  ) {
    if (allLines[scanIndex].pageIndex !== startPage) {
      break
    }

    const candidateText = allLines[scanIndex].text.trim()
    if (
      isSaddlebackChapterNumberLine(
        candidateText,
        allLines[scanIndex].line,
        allLines[scanIndex].pageMetrics
      )
    ) {
      digitIndex = scanIndex
      chapterNumber = candidateText
      break
    }
  }

  if (chapterNumber && printedToc.chapters.has(chapterNumber)) {
    const title = printedToc.chapters.get(chapterNumber)
    let endIndex = digitIndex + 1
    while (endIndex < allLines.length && allLines[endIndex].pageIndex === startPage) {
      const candidateText = allLines[endIndex].text.trim()
      if (
        isSaddlebackTitleFragmentLine(
          candidateText,
          allLines[endIndex].line,
          allLines[endIndex].pageMetrics
        )
      ) {
        endIndex += 1
        continue
      }
      break
    }

    return {
      chapterNumber,
      title,
      nextIndex: endIndex,
      pageIndex: startPage,
      line: allLines[digitIndex].line,
    }
  }

  const fragments = []
  let endIndex = cursor
  while (endIndex < allLines.length && allLines[endIndex].pageIndex === startPage) {
    const candidateText = allLines[endIndex].text.trim()
    if (
      isSaddlebackTitleFragmentLine(
        candidateText,
        allLines[endIndex].line,
        allLines[endIndex].pageMetrics
      )
    ) {
      fragments.push(candidateText)
      endIndex += 1
      continue
    }
    break
  }

  if (fragments.length === 0) {
    return null
  }

  const combined = fragments.join(" ").replace(/\s+/g, " ").trim()
  if (!titlesMatchSaddlebackOpener(combined, expectedTitle)) {
    return null
  }

  return {
    chapterNumber: chapterKey,
    title: expectedTitle,
    nextIndex: endIndex,
    pageIndex: startPage,
    line: allLines[cursor].line,
  }
}

function isDisplayChapterTitleText(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (parseChapterOnlyHeading(trimmed) || CHAPTER_WITH_SUBTITLE_REGEX.test(trimmed)) {
    return false
  }
  if (isScannerWatermarkLine(trimmed) || isLetterSpacedProductionArtifact(trimmed)) {
    return false
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 1 || words.length > 8 || trimmed.length > 90) {
    return false
  }
  if (isNarrativeSentenceLine(trimmed)) {
    return false
  }
  if (words.length >= 5 && /[.!?]/.test(trimmed)) {
    return false
  }

  if (/^[a-z]/.test(trimmed)) {
    return words.length <= 6 && trimmed.length <= 48
  }

  return isLikelyChapterSubtitleText(trimmed)
}

function isDisplayChapterTitleLine(text, line) {
  if ((line?.fontSize ?? 0) < DISPLAY_CHAPTER_TITLE_MIN_FONT_SIZE) {
    return false
  }
  return isDisplayChapterTitleText(text)
}

function estimateBodyFontSize(lines) {
  const sizes = (lines ?? [])
    .map((line) => line.fontSize ?? 0)
    .filter((size) => size >= 9 && size <= 16)
  if (sizes.length === 0) {
    return 12
  }
  return medianValue(sizes)
}

function isDropCapTargetLine(text, line, dropCapThreshold) {
  const trimmed = (text ?? "").trim()
  const fontSize = line?.fontSize ?? 0
  if (fontSize >= dropCapThreshold || fontSize >= DISPLAY_CHAPTER_TITLE_MIN_FONT_SIZE) {
    return false
  }
  if (!/^[a-z]/.test(trimmed)) {
    return false
  }
  if (isDisplayChapterTitleText(trimmed)) {
    return false
  }
  if (parseChapterOnlyHeading(trimmed)) {
    return false
  }
  if (isCollapsedRunningHeaderLine(trimmed) || isSpacedRunningHeaderLine(trimmed)) {
    return false
  }
  return true
}

function repairDropCapLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return lines
  }

  const bodySize = estimateBodyFontSize(lines)
  const dropCapThreshold = bodySize * 3
  const ordered = [...lines].sort((left, right) => (right.y ?? 0) - (left.y ?? 0))
  let pageHadDropCap = false

  for (let index = 0; index < ordered.length; index += 1) {
    const line = ordered[index]
    const text = (line.text ?? "").trim()
    const fontSize = line.fontSize ?? 0
    if (fontSize < dropCapThreshold) {
      continue
    }

    let letter = null
    let removeLine = false

    if (/^[A-Z]$/.test(text)) {
      letter = text
      removeLine = true
    } else {
      const merged = text.match(/^([A-Z])\s+(.+)$/)
      if (merged?.[2]?.length >= 3) {
        letter = merged[1]
        line.text = merged[2]
        line.fontSize = bodySize
      }
    }

    if (!letter) {
      continue
    }

    pageHadDropCap = true

    for (let targetIndex = 0; targetIndex < index; targetIndex += 1) {
      const target = ordered[targetIndex]
      if (isDropCapTargetLine(target.text, target, dropCapThreshold)) {
        target.text = `${letter}${(target.text ?? "").trim()}`
        target.dropCapContinuation = true
        break
      }
    }

    if (removeLine) {
      ordered.splice(index, 1)
      index -= 1
    }
  }

  if (pageHadDropCap) {
    for (const line of ordered) {
      line.pageHadDropCap = true
    }
  }

  return ordered.sort((left, right) => (right.y ?? 0) - (left.y ?? 0))
}

function repairSplitSmallCapsOpening(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    return lines
  }

  const ordered = [...lines].sort((left, right) => (right.y ?? 0) - (left.y ?? 0))

  for (let index = 0; index < ordered.length - 1; index += 1) {
    const current = ordered[index]
    const next = ordered[index + 1]
    const text = (current.text ?? "").trim()
    const nextText = (next.text ?? "").trim()

    const orphanLead = text.match(/^([A-Z])\s+([A-Z].*)$/)
    const splitNext = nextText.match(/^([A-Z])([a-z]{2,})(.*)$/)
    if (!orphanLead || !splitNext) {
      continue
    }

    const bodyPart = orphanLead[2]
    const bodyWords = bodyPart.split(/\s+/).filter(Boolean)
    const leadingCapsWords = bodyWords.filter((word) => /^[A-Z]{2,}$/.test(word))
    if (leadingCapsWords.length < 3 || bodyWords.length < 4) {
      continue
    }
    if (/[.!?:]["'\u201d]?\s*$/.test(text)) {
      continue
    }

    const restoredWord = splitNext[1] + orphanLead[1]
    const remainder = splitNext[3].trim()
    current.text = `${restoredWord} ${bodyPart} ${splitNext[2]}${remainder ? ` ${remainder}` : ""}`
      .replace(/\s+/g, " ")
      .trim()

    ordered.splice(index + 1, 1)
    index -= 1
  }

  return ordered.sort((left, right) => (right.y ?? 0) - (left.y ?? 0))
}

function isIncompleteNarrativeLineFragment(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || /[.!?:]["'\u201d]?\s*$/.test(trimmed)) {
    return false
  }
  if (isLikelyChapterSubtitleText(trimmed) || isDisplayChapterTitleText(trimmed)) {
    return false
  }
  if (/^["'\u201c]/.test(trimmed)) {
    return false
  }

  const words = countWordsInText(trimmed)
  if (words < 3 || words > 14) {
    return false
  }

  return /^(We|I|He|She|They|It|The|My|Our|His|Her|Their|This|That|There|When|As|But|And|Now|Then|So|Yet|For|In|On|At|By|A|An)\b/i.test(
    trimmed
  )
}

function isGlossarySidebarLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 56) {
    return false
  }
  if (/^Wooden bars used$/i.test(trimmed)) {
    return true
  }
  if (/^to wind up the$/i.test(trimmed)) {
    return true
  }
  if (/^chain\.?$/i.test(trimmed)) {
    return true
  }
  if (/ship'?s anchor (?:chain|chest)/i.test(trimmed)) {
    return true
  }
  if (/^CAPTAIN\s+BARS$/i.test(trimmed)) {
    return true
  }
  if (/^[A-Z]{3,12}$/.test(trimmed) && trimmed === trimmed.toUpperCase()) {
    return true
  }
  return false
}

function isVerseLineText(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (/fifteen men on the dead man/i.test(trimmed)) {
    return true
  }
  if (/yo-?ho-?ho/i.test(trimmed)) {
    return true
  }
  if (/^Drink and the devil had done for the rest/i.test(trimmed)) {
    return true
  }
  if (
    /^["'\u201c].*(?:—|–|-).*["'\u201d]?\s*$/u.test(trimmed) &&
    countWordsInText(trimmed) <= 16
  ) {
    return true
  }
  return false
}

function isAdjacentPageProseEcho(text, pageIndex, pagesBeforeFilter, line = null) {
  const trimmed = (text ?? "").trim()
  if (trimmed.length < 12 || trimmed.length > 96) {
    return false
  }
  if (/[.!?:]["'\u201d]?\s*$/.test(trimmed)) {
    return false
  }
  // Centered lines, such as 1984 diary chants, are deliberate content even when
  // the same phrase appears inside prose on a neighboring page.
  if (line?.centered) {
    return false
  }
  // A chapter-opening heading ("Chapter VIII") is echoed verbatim inside a
  // neighboring page's running header ("150 Chapter VIII"); the heading is the
  // source of that echo, not a duplicate of it, so it is never dropped here.
  // Running headers themselves stay droppable: merged forms carry page numbers
  // (failing CHAPTER_PATTERN's anchors) and render at body font size.
  if (
    CHAPTER_PATTERN.test(trimmed) &&
    (line?.fontSize ?? 0) >= CHAPTER_HEADING_MIN_FONT_SIZE
  ) {
    return false
  }
  // A display-sized heading (poem titles at ~16pt, other large titles) is the
  // SOURCE of refrain / running-header echoes, not a duplicate of them.
  // "Take Time Out" is echoed as "Take Time Out." on the next page; the refrain
  // itself stays droppable because it renders at body font size.
  if ((line?.fontSize ?? 0) >= HEADING_STRING_MIN_FONT_SIZE) {
    return false
  }

  for (const offset of [-1, 1]) {
    const adjacentPage = pagesBeforeFilter[pageIndex + offset]
    if (!adjacentPage?.lines) {
      continue
    }
    for (const adjacentLine of adjacentPage.lines) {
      const other = (adjacentLine.text ?? "").trim()
      if (other.length <= trimmed.length || !other.includes(trimmed)) {
        continue
      }
      // Neighbor quotes the phrase inside narrative prose, not as a duplicate
      // running-header echo of this standalone line.
      if (/[a-z]/.test(other) && other.length > trimmed.length + 8) {
        continue
      }
      return true
    }
  }

  return false
}

function joinWrappedText(left, right) {
  const leftText = (left ?? "").trim()
  const rightText = (right ?? "").trim()
  if (!leftText) {
    return rightText
  }
  if (!rightText) {
    return leftText
  }

  // Reconnect a word split across a line break: the previous line ends with a
  // trailing word fragment + hyphen that continues on the next line.
  const hyphenMatch = leftText.match(/([A-Za-z]+)-$/)
  if (hyphenMatch) {
    const fragment = hyphenMatch[1]
    const rightLetter = rightText[0]
    const fragmentAllCaps = /^[A-Z]+$/.test(fragment) && fragment.length >= 2
    if (/[a-z]/.test(rightLetter)) {
      // Lowercase continuation: a syllable break ("simulta-" + "neously").
      return `${leftText.slice(0, -1)}${rightText}`.replace(/\s+/g, " ").trim()
    }
    if (/[A-Z]/.test(rightLetter)) {
      if (fragmentAllCaps) {
        // All-caps word continued in caps ("CIGA-" + "RETTES" -> "CIGARETTES").
        return `${leftText.slice(0, -1)}${rightText}`.replace(/\s+/g, " ").trim()
      }
      // Capitalised continuation after a non-all-caps fragment is a hyphenated
      // compound ("Anti-" + "Sex" -> "Anti-Sex"): keep the hyphen, drop the gap.
      return `${leftText}${rightText}`.replace(/\s+/g, " ").trim()
    }
  }

  return `${leftText} ${rightText}`.replace(/\s+/g, " ").trim()
}

function normalizeExtractedText(text, options = {}) {
  if (!text) {
    return ""
  }

  const withoutNullBytes = text.includes("\u0000") ? text.replace(/\u0000/g, "") : text

  const puaNormalized = translatePuaCharacters(
    withoutNullBytes,
    options.puaReplacementMap ?? null
  )

  return stripInlineArtifacts(
    joinSplitWordFragments(
      repairEpistolaryPdfArtifacts(puaNormalized)
        .replace(/\u00AD/g, "")
        .replace(/\b([a-zA-Z]{2,})-\s+([a-z])/g, "$1$2")
        .replace(/\bfi\s+(?=[a-z])/gi, "fi")
        .replace(/\bfl\s+(?=[a-z])/gi, "fl")
        .replace(/([a-z]+f[il])\s+(?=[a-z])/g, "$1")
        .replace(/\b([a-z]{4,})\s+(ed|ing|ly|es|er|est)\b/gi, "$1$2")
        .replace(/([a-z])([A-Z]{2,})/g, "$1 $2")
        .replace(
          /\b(of|the|and|to|in|on|at|by|for|with|from|as|an|a)([A-Z][a-z]{2,})/g,
          "$1 $2"
        )
        .replace(/\bout-\s+/gi, "out-")
        .replace(/\b(the|at|in|on)(edge|op)\b/gi, "$1 $2")
    )
  )
}

function isAllCapsCalloutLine(text) {
  const trimmed = (text ?? "").trim()
  if (trimmed.length < 20 || trimmed.length > 220) {
    return false
  }
  const letters = trimmed.replace(/[^A-Za-z]/g, "")
  if (letters.length < 16) {
    return false
  }
  const upperCount = (trimmed.match(/[A-Z]/g) ?? []).length
  if (upperCount / letters.length < 0.85) {
    return false
  }
  // A small-caps chapter opening ("BOUT NOON I BROUGHT THE CAPTAIN SOME COOLING")
  // runs straight into lowercase prose on the next line and does not end on
  // terminal punctuation. A genuine all-caps callout is a complete line that
  // ends cleanly. Require terminal punctuation so opening runs are excluded.
  if (!/[.!?:][\u201d"\u2019']?\s*$/.test(trimmed)) {
    return false
  }
  return true
}

function countWordsInText(text) {
  return (text ?? "").trim().split(/\s+/).filter(Boolean).length
}

function proseBlockExceedsMergeLimit(block) {
  const text = block?.text ?? ""
  return (
    countWordsInText(text) >= MAX_PROSE_BLOCK_WORDS ||
    text.length >= MAX_PROSE_BLOCK_CHARS
  )
}

function isShortDialogueLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 48) {
    return false
  }
  if (isDialogueAttributionFragment(trimmed)) {
    return true
  }
  if (/^[''\u2018\u201c][^''""]{0,40}[''\u2019\u201d]?\.?$/.test(trimmed)) {
    return true
  }
  return /^[''\u2018]?\s*(yes|no|ok|okay)\.?\s*[''\u2019]?\.?$/i.test(trimmed)
}

function isLikelyDialogueContinuationLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (/^[''\u2018\u201c"]/.test(trimmed)) {
    return true
  }
  if (/[—–-]{2,}\s*[''\u2019"]?\s*$/u.test(trimmed)) {
    return true
  }
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\s*[—–-]{1,2}/.test(trimmed)) {
    return true
  }
  return false
}

function stripInlineArtifacts(text) {
  if (!text) {
    return ""
  }

  return text
    .replace(INLINE_PAGE_DECORATOR_REGEX, " ")
    .replace(EMBEDDED_STORY_SECTION_RUNNING_HEAD_REGEX, " ")
    .replace(EMBEDDED_RECURRING_BOOK_TITLE_REGEX, " ")
    .replace(RUNNING_HEADER_INLINE_REGEX, " ")
    .replace(EMBEDDED_RUNNING_HEADER_REGEX, " ")
    .replace(EMBEDDED_ROMAN_SECTION_RUNNING_HEAD_REGEX, " ")
    .replace(EMBEDDED_CHAPTER_PLACEHOLDER_REGEX, " ")
    .replace(ROMAN_PREFIX_BEFORE_HEADING_REGEX, "")
    .replace(EMBEDDED_PREFACE_PAGE_MARKER_REGEX, "")
    .replace(FOOTNOTE_REFERENCE_REGEX, "")
    .replace(/\s+/g, " ")
    .trim()
}

function pageHasDropCapLetter(entries) {
  if (entries.some((entry) => entry.line.pageHadDropCap || entry.line.dropCapContinuation)) {
    return true
  }

  const bodySizes = entries
    .map((entry) => entry.line.fontSize)
    .filter(
      (value) =>
        Number.isFinite(value) && value > 0 && value <= HEADING_STRING_MIN_FONT_SIZE + 2
    )
  const bodySize = bodySizes.length > 0 ? medianValue(bodySizes) : 10.5
  const threshold = bodySize * 3

  return entries.some((entry) => {
    const text = (entry.text ?? "").trim()
    return (entry.line.fontSize ?? 0) >= threshold && /^[A-Z]$/.test(text)
  })
}

function isDropCapIndentedContinuation(line, bodyLeftX, entries) {
  if (line.dropCapContinuation) {
    return true
  }

  if (!pageHasDropCapLetter(entries)) {
    return false
  }

  const x = Number.isFinite(line.x) ? line.x : bodyLeftX
  return x > bodyLeftX + MARGIN_CALLOUT_RIGHT_DISPLACE_PX
}

function isShortLineSubstringOfLongerLine(shortText, longTexts) {
  const minParentLength = shortText.length + MARGIN_CALLOUT_SUBSTRING_PARENT_GAP

  for (const other of longTexts) {
    if (other === shortText || other.length < minParentLength) {
      continue
    }
    if (other.includes(shortText)) {
      return true
    }
  }

  return false
}

const PROMINENT_TITLE_WORD_REGEX = /^[A-Z][A-Za-z'\u2019-]{2,}$/

// A single title-case word rendered prominently larger than the page's body
// text and optically centered on the page's line bounds is display typography
// (a poem or section title), not a margin callout. Poetry collections set
// one-word poem titles this way (Maya Angelou: "Tears", "Willie", "Alone"),
// and the generic keep path above requires two or more words, so without this
// carve-out they are deleted as right-displaced callouts before the poetry
// promotion logic ever sees them. Centering is measured with
// measuredRightEdge (exact glyph widths): the character-count rightEdge
// estimate skews wide at display sizes and misplaces the optical center.
// Requires a lowercase letter so all-caps margin labels stay droppable, and
// three or more characters so orphan drop-cap letters are never kept. Bare
// conjunctions/articles are excluded: a display-set "And" between dedication
// lines (Old Man and the Sea) is connective text, not a title.
function isProminentCenteredTitleWordLine(line, text, pageFontMedian, bounds) {
  if (!PROMINENT_TITLE_WORD_REGEX.test(text) || !/[a-z]/.test(text)) {
    return false
  }
  if (PROSE_BLOCKLIST_WORD_REGEX.test(text)) {
    return false
  }
  const fontSize = line.fontSize ?? 0
  if (
    fontSize < HEADING_STRING_MIN_FONT_SIZE ||
    (pageFontMedian > 0 && fontSize < pageFontMedian * 1.2)
  ) {
    return false
  }
  const columnWidth = bounds.right - bounds.left
  if (!(columnWidth > 0)) {
    return false
  }
  const left = Number.isFinite(line.x) ? line.x : bounds.left
  const right = line.measuredRightEdge ?? line.rightEdge ?? left
  const width = Math.max(0, right - left)
  if (!(width > 0) || width / columnWidth > CENTERED_LINE_MAX_WIDTH_RATIO) {
    return false
  }
  const tolerance = Math.max(
    CENTERED_LINE_CENTER_TOLERANCE_PX * 2,
    columnWidth * 0.12
  )
  const columnCenter = (bounds.left + bounds.right) / 2
  return Math.abs((left + right) / 2 - columnCenter) <= tolerance
}

function dropMarginCalloutLines(lines, pageIndex = -1) {
  const entries = lines
    .map((line) => ({ line, text: (line.text ?? "").trim() }))
    .filter((entry) => entry.text)

  if (entries.length === 0) {
    return lines
  }

  const texts = entries.map((entry) => entry.text)
  const longTextsOnPage = texts.filter(
    (candidate) =>
      candidate.length >
      MARGIN_CALLOUT_MAX_CHARS + MARGIN_CALLOUT_SUBSTRING_PARENT_GAP
  )

  // Body column left edge. A genuine margin callout/side note sits outside this
  // column; prose that merely ends a paragraph on a short line is aligned to
  // the column (or its paragraph indent) and must never be treated as a callout.
  const bodyXs = entries
    .filter((entry) => !entry.line.centered && Number.isFinite(entry.line.x))
    .map((entry) => entry.line.x)
  if (bodyXs.length === 0) {
    return lines
  }
  const bodyLeftX = medianValue(bodyXs)

  // Page-level measured bounds and body font for the prominent-title-word
  // carve-out (optical centering needs the full line extents on this page).
  let measuredLeftBound = Infinity
  let measuredRightBound = -Infinity
  for (const entry of entries) {
    const left = Number.isFinite(entry.line.x) ? entry.line.x : 0
    const right = entry.line.measuredRightEdge ?? entry.line.rightEdge ?? left
    if (left < measuredLeftBound) {
      measuredLeftBound = left
    }
    if (right > measuredRightBound) {
      measuredRightBound = right
    }
  }
  const measuredBounds = { left: measuredLeftBound, right: measuredRightBound }
  const pageFontMedian = medianValue(
    entries.map((entry) => entry.line.fontSize ?? 0).filter((value) => value > 0)
  )

  return entries
    .filter((entry, entryIndex) => {
      const { text, line } = entry
      const previousText = entryIndex > 0 ? entries[entryIndex - 1].text : ""
      let keep = true
      let reason = "keep"

      if (
        parseChapterOnlyHeading(previousText) &&
        (isLikelyChapterSubtitleText(text) || isAllCapsChapterSubtitleText(text))
      ) {
        keep = true
        reason = "chapter-subtitle-after-heading"
      } else if (line.centered) {
        keep = true
        reason = "centered"
      } else if (isSceneBreakOrnamentLine(text)) {
        keep = true
        reason = "scene-break"
      } else if (
        CHAPTER_TITLE_TAIL_WORD_REGEX.test(text) &&
        (line.fontSize ?? 0) >= HEADING_STRING_MIN_FONT_SIZE
      ) {
        keep = true
        reason = "chapter-title-tail"
      } else if (
        isCleanStructuralHeadingText(text, { fontSize: line.fontSize ?? 0 }) ||
        PART_HEADING_PATTERN.test(text) ||
        VOLUME_HEADING_PATTERN.test(text) ||
        CHAPTER_PATTERN.test(text)
      ) {
        keep = true
        reason = "structural-heading"
      } else if (
        isEpistolaryAddressLine(text) ||
        isEpistolarySignOffLine(text) ||
        isEpistolarySignatureLine(text)
      ) {
        keep = true
        reason = "epistolary"
      } else {
        const words = text.split(/\s+/).filter(Boolean)
        const isShort =
          text.length <= MARGIN_CALLOUT_MAX_CHARS &&
          words.length <= MARGIN_CALLOUT_MAX_WORDS

        if (
          words.length >= 2 &&
          (line.fontSize ?? 0) >= HEADING_STRING_MIN_FONT_SIZE
        ) {
          keep = true
          reason = "large-font-short-line"
        } else if (
          isProminentCenteredTitleWordLine(
            line,
            text,
            pageFontMedian,
            measuredBounds
          )
        ) {
          keep = true
          reason = "prominent-centered-title-word"
        } else if (!isShort) {
          keep = true
          reason = "not-short"
        } else if (isShortLineSubstringOfLongerLine(text, longTextsOnPage)) {
          if (isLikelyChapterSubtitleText(text)) {
            keep = true
            reason = "substring-chapter-subtitle"
          } else {
            keep = false
            reason = "substring-of-longer-line"
          }
        } else {
          const x = Number.isFinite(line.x) ? line.x : bodyLeftX
          const displacedLeft = x < bodyLeftX - MARGIN_CALLOUT_LEFT_DISPLACE_PX
          const displacedRight = x > bodyLeftX + MARGIN_CALLOUT_RIGHT_DISPLACE_PX

          if (!displacedLeft && !displacedRight) {
            keep = true
            reason = "body-column-aligned"
          } else if (isLikelyDialogueContinuationLine(text)) {
            keep = true
            reason = "dialogue-continuation"
          } else if (isDropCapIndentedContinuation(line, bodyLeftX, entries)) {
            keep = true
            reason = "drop-cap-continuation"
          } else {
            keep = false
            reason = displacedLeft
              ? "margin-callout-displaced-left"
              : "margin-callout-displaced-right"
          }
        }
      }

      if (bbMatchesPhrase(text)) {
        bbLog("dropMarginCalloutLines", {
          pageIndex,
          distinctPageCount: null,
          text,
          keep,
          reason,
          x: line.x,
          bodyLeftX,
          centered: Boolean(line.centered),
        })
      }

      return keep
    })
    .map((entry) => entry.line)
}

function countStructuralMarkers(text) {
  const pattern =
    /\b(chapter|letter|volume|part|section|book)\s+([IVXLCDM]+|\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/gi
  let count = 0
  while (pattern.exec(text)) {
    count += 1
  }
  return count
}

function isTocDenseListingLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (countStructuralMarkers(trimmed) >= 2) {
    return true
  }
  if (
    /\b(?:letter|chapter|volume)\s+[IVXLCDM\d]+\s+\d{1,4}\b.*\b(?:letter|chapter|volume)\s+/i.test(
      trimmed
    )
  ) {
    return true
  }
  return false
}

function isTocPageReferenceLine(text) {
  const trimmed = (text ?? "").trim()
  return /^(?:(?:chapter|letter|volume|part)\s+[IVXLCDM\d]+\s+\d{1,4}|volume\s+[IVXLCDM\d]+\s+\d{1,4})$/i.test(
    trimmed
  )
}

function isRunningHeaderMergedLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (isScannerWatermarkLine(trimmed)) {
    return true
  }
  if (/asiaing\.com/i.test(trimmed)) {
    return true
  }
  if (isTocPageReferenceLine(trimmed)) {
    return true
  }
  if (isSpacedRunningHeaderLine(trimmed)) {
    return true
  }
  if (isStorySectionRunningHeadLine(trimmed) || isRecurringBookTitleRunningHeadLine(trimmed)) {
    return true
  }
  if (
    /^(?:chapter|letter)\s+[IVXLCDM\d]+\s+\d{0,3}\s+[a-z]/i.test(trimmed) ||
    /^(?:chapter|letter)\s+[IVXLCDM\d]+\s+\d{1,3}\s+[A-Z][a-z]{2,}/.test(trimmed)
  ) {
    return true
  }
  return false
}

function isHeaderPageMarkerLine(text) {
  const trimmed = (text ?? "").trim()
  return /^(?:preface|introduction|prologue|epilogue|conclusion)\s+[ivxlcdm]{1,4}$/i.test(
    trimmed
  )
}

function normalizeHeadingCandidate(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return ""
  }

  const expandedPart = parseCompactPartHeading(trimmed)
  if (expandedPart) {
    return expandedPart
  }

  if (CHAPTER_PATTERN.test(trimmed)) {
    return trimmed
  }

  const withoutPrintedPage = trimmed.replace(
    /^(?:(?:chapter|letter|volume|part|section|book|stave)\s+(?:[IVXLCDM]+|\d+|one|two|three|four|five|six|seven|eight|nine|ten))\s+\d{1,4}$/i,
    "$1"
  )
  if (CHAPTER_PATTERN.test(withoutPrintedPage)) {
    return withoutPrintedPage
  }

  return withoutPrintedPage
    .replace(/\s+[ivxlcdm]+\s*$/i, "")
    .replace(/\s+\d{1,3}\s*$/, "")
    .trim()
}

function isCleanStructuralHeadingText(text, line = null) {
  const raw = (text ?? "").trim()
  if (!raw) {
    return false
  }
  if (isScannerWatermarkLine(raw)) {
    return false
  }
  if (/^contents$/i.test(raw)) {
    return false
  }
  if (isTocChapterListingLine(raw)) {
    return false
  }
  if (isTocDenseListingLine(raw)) {
    return false
  }
  if (isTocPageReferenceLine(raw)) {
    return false
  }
  if (isRunningHeaderMergedLine(raw)) {
    return false
  }
  if (isHeaderPageMarkerLine(raw)) {
    return false
  }
  if (
    isStormlightPrintedTocLine(raw) ||
    isIllustrationsListEntryLine(raw) ||
    isBibliographySeriesTitleLine(raw) ||
    isTitlePageBookLabelLine(raw)
  ) {
    return false
  }

  const trimmed = normalizeHeadingCandidate(raw)
  if (!trimmed) {
    return false
  }
  if (trimmed.length > STRUCTURAL_HEADING_MAX_CHARS) {
    return false
  }
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length > STRUCTURAL_HEADING_MAX_WORDS) {
    return false
  }
  if ((trimmed.match(/[.!?]/g) ?? []).length >= 2) {
    return false
  }
  if (CHAPTER_PATTERN.test(trimmed)) {
    return true
  }
  if (PART_HEADING_PATTERN.test(trimmed) || VOLUME_HEADING_PATTERN.test(trimmed)) {
    return true
  }
  if (STRUCTURAL_HEADING_PREFIX_REGEX.test(trimmed)) {
    if (/^book\s+one\s+of\.?$/i.test(trimmed)) {
      return false
    }
    if (/[;,]/.test(trimmed)) {
      return false
    }

    const afterPrefix = trimmed.replace(STRUCTURAL_HEADING_PREFIX_REGEX, "").trim()
    if (
      /^(?:and|or|but|the|a|an|without|with|from|in|on|at|to|by|as|if)\b/i.test(
        afterPrefix
      )
    ) {
      return false
    }

    if (/^[a-z]/.test(trimmed)) {
      return false
    }

    const fontSize = line?.fontSize ?? 0
    if (words.length <= 4 && fontSize >= CHAPTER_HEADING_MIN_FONT_SIZE) {
      return true
    }
  }
  return false
}

function isNarrativeBoundaryLine(text, line = null) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || isTocChapterListingLine(trimmed)) {
    return false
  }
  if (isScannerWatermarkLine(trimmed)) {
    return false
  }
  if (resolvePartHeadingLabel(trimmed)) {
    return true
  }
  if (isIncompleteAllCapsWrapLine(trimmed)) {
    return false
  }
  if (isNarrativeSentenceLine(trimmed)) {
    return false
  }
  return isCleanStructuralHeadingText(trimmed, line)
}

function isEpistolaryAddressLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 100) {
    return false
  }
  // Do not use \b after "Mrs." — the period and following space are both non-word chars.
  return /^To\s+(?:Mrs?\.?\s+|Mr\.?\s+|Miss\s+|Dr\.?\s+|Sir\s+|Madame\s+|My\s+dear\s+)/i.test(
    trimmed
  )
}

function isEpistolarySignOffLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 100) {
    return false
  }
  return (
    /^Your affectionate\b/i.test(trimmed) ||
    /^Most affectionately yours\b/i.test(trimmed) ||
    /^Affectionately yours\b/i.test(trimmed) ||
    /^Yours sincerely\b/i.test(trimmed)
  )
}

function isEpistolarySignatureLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 50) {
    return false
  }
  return (
    /^R\.\s+W\s+ALTON\s*\.?$/i.test(trimmed) ||
    /^R\.\s+W\s*\.?$/i.test(trimmed) ||
    /^[A-Z]\.\s+[A-Z]\.\s+[A-Z]{2,}\s*\.?$/i.test(trimmed)
  )
}

function repairEpistolaryPdfArtifacts(text) {
  if (!text) {
    return ""
  }

  return text
    .replace(/\bTo\s+Mrs\.?\s+S\s+AVILLE\s*,\s*England\s*\.?/gi, "To Mrs. Saville, England.")
    .replace(
      /\bYour affectionate brother,\s*R\.\s+W\s+ALTON\s*\.?/gi,
      "Your affectionate brother, R. Walton."
    )
    .replace(/\bR\.\s+W\s+ALTON\b/gi, "R. Walton")
}

function isStandalonePageNumberText(text) {
  const trimmed = (text ?? "").trim()
  return (
    STANDALONE_PAGE_NUMBER_REGEX.test(trimmed) ||
    STANDALONE_ROMAN_PAGE_MARKER_REGEX.test(trimmed) ||
    /^-\s*\d{1,4}\s*-$/.test(trimmed)
  )
}

function explainShouldDropExtractedLine(
  text,
  distinctPageCount,
  occurrencesOnThisPage = 1,
  isCentered = false,
  pageIndex = 0,
  lineFirstPageIndex = null,
  fontSize = 0
) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return { drop: true, reason: "empty" }
  }
  if (PRODUCTION_SLUG_REGEX.test(trimmed)) {
    return { drop: true, reason: "production-slug" }
  }
  if (CHAPTER_PLACEHOLDER_REGEX.test(trimmed)) {
    return { drop: true, reason: "chapter-placeholder" }
  }
  if (isLetterSpacedProductionArtifact(trimmed)) {
    return { drop: true, reason: "letter-spaced-artifact" }
  }
  if (isSpacedRunningHeaderLine(trimmed)) {
    return { drop: true, reason: "spaced-running-header" }
  }
  if (ROMAN_SECTION_RUNNING_HEAD_REGEX.test(trimmed)) {
    return { drop: true, reason: "roman-section-running-head" }
  }
  if (isSceneBreakOrnamentLine(trimmed)) {
    return { drop: false, reason: "scene-break-ornament-keep" }
  }
  if (
    /^[A-Z]{2,8}\.?$/.test(trimmed) &&
    distinctPageCount <= 1 &&
    !CHAPTER_PATTERN.test(trimmed)
  ) {
    return { drop: false, reason: "short-all-caps-keep" }
  }
  if (
    CHAPTER_PATTERN.test(trimmed) ||
    STRUCTURAL_HEADING_PREFIX_REGEX.test(trimmed)
  ) {
    return { drop: false, reason: "chapter-or-structural-keep" }
  }
  if (isCollapsedRunningHeaderLine(trimmed)) {
    if (distinctPageCount >= RUNNING_HEADER_MIN_PAGES) {
      return { drop: true, reason: "collapsed-running-header" }
    }
    return { drop: false, reason: "collapsed-running-header-below-page-threshold" }
  }
  if (STANDALONE_PAGE_NUMBER_REGEX.test(trimmed)) {
    return { drop: true, reason: "standalone-page-number" }
  }
  if (STANDALONE_ROMAN_PAGE_MARKER_REGEX.test(trimmed)) {
    if (
      isRomanPartOpenerLine(trimmed, {
        distinctPageCount,
        fontSize,
        centered: isCentered,
      })
    ) {
      return { drop: false, reason: "roman-part-opener-keep" }
    }
    return { drop: true, reason: "standalone-roman-page-marker" }
  }
  if (ROMAN_PAGE_MARKER_CLUSTER_REGEX.test(trimmed)) {
    return { drop: true, reason: "roman-page-marker-cluster" }
  }
  if (STANDALONE_RUNNING_HEAD_REGEX.test(trimmed)) {
    return { drop: true, reason: "standalone-running-head" }
  }
  if (isHeaderPageMarkerLine(trimmed)) {
    return { drop: true, reason: "header-page-marker" }
  }
  if (isTocDenseListingLine(trimmed) || isTocPageReferenceLine(trimmed)) {
    return { drop: true, reason: "toc-listing" }
  }
  if (isRunningHeaderMergedLine(trimmed)) {
    return { drop: true, reason: "running-header-merged" }
  }
  if (isStorySectionRunningHeadLine(trimmed) || isRecurringBookTitleRunningHeadLine(trimmed)) {
    return { drop: true, reason: "story-section-running-head" }
  }
  if (isScannerWatermarkLine(trimmed)) {
    return { drop: true, reason: "scanner-watermark" }
  }
  if (isGlossarySidebarLine(trimmed)) {
    return { drop: true, reason: "glossary-sidebar" }
  }
  if (isLikelyChapterSubtitleText(trimmed)) {
    return { drop: false, reason: "chapter-subtitle-keep" }
  }
  if (TOC_HEADER_LINE_REGEX.test(trimmed)) {
    return { drop: true, reason: "toc-header" }
  }
  if (/^(?:preface|introduction|prologue|epilogue|conclusion)$/i.test(trimmed)) {
    if (occurrencesOnThisPage > 1) {
      return { drop: true, reason: "repeated-section-label-same-page" }
    }
    if (distinctPageCount >= RUNNING_HEADER_MIN_PAGES) {
      const firstPage = lineFirstPageIndex?.get(trimmed)
      if (firstPage !== undefined && pageIndex !== firstPage) {
        return { drop: true, reason: "repeated-section-label-other-page" }
      }
    }
  }
  if (isCentered || isNarrativeBoundaryLine(trimmed) || CHAPTER_NUMBER_REGEX.test(trimmed)) {
    return { drop: false, reason: "centered-or-boundary-keep" }
  }
  if (
    isEpistolaryAddressLine(trimmed) ||
    isEpistolarySignOffLine(trimmed) ||
    isEpistolarySignatureLine(trimmed)
  ) {
    return { drop: false, reason: "epistolary-keep" }
  }
  if (
    distinctPageCount >= RUNNING_HEADER_MIN_PAGES &&
    occurrencesOnThisPage <= 1
  ) {
    return { drop: true, reason: "recurring-line-running-header" }
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return { drop: true, reason: "url" }
  }
  if (/^www\./i.test(trimmed)) {
    return { drop: true, reason: "www" }
  }
  return { drop: false, reason: "keep-default" }
}

function shouldDropExtractedLine(
  text,
  distinctPageCount,
  occurrencesOnThisPage = 1,
  isCentered = false,
  pageIndex = 0,
  lineFirstPageIndex = null,
  fontSize = 0
) {
  return explainShouldDropExtractedLine(
    text,
    distinctPageCount,
    occurrencesOnThisPage,
    isCentered,
    pageIndex,
    lineFirstPageIndex,
    fontSize
  ).drop
}

function groupTextItemsIntoLines(items, pageIndex = -1) {
  if (!items.length) {
    return []
  }

  const sortedItems = [...items].sort((a, b) => b.y - a.y)
  const lineGroups = []
  let currentGroup = null

  for (const item of sortedItems) {
    if (
      currentGroup &&
      Math.abs(item.y - currentGroup.runningY) <= Y_LINE_GROUP_TOLERANCE_PX
    ) {
      currentGroup.items.push(item)
      const itemCount = currentGroup.items.length
      currentGroup.runningY =
        currentGroup.items.reduce((sum, entry) => sum + entry.y, 0) / itemCount
      currentGroup.y = currentGroup.runningY
    } else {
      if (currentGroup) {
        lineGroups.push(currentGroup)
      }
      currentGroup = {
        y: item.y,
        runningY: item.y,
        items: [item],
      }
    }
  }

  if (currentGroup) {
    lineGroups.push(currentGroup)
  }

  const lines = []

  for (const group of lineGroups) {
    group.items.sort((a, b) => a.x - b.x)
    const leftmost = group.items[0]
    const rightmost = group.items[group.items.length - 1]
    const joinedText = group.items
      .map((entry) => entry.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
    const text = collapseLetterSpacing(joinedText)

    if (bbMatchesPhrase(joinedText) || bbMatchesPhrase(text)) {
      bbLog("raw-after-extraction", {
        pageIndex,
        distinctPageCount: null,
        raw: joinedText,
        collapsed: text,
        collapsedRunningHeader: isCollapsedRunningHeaderLine(text),
        y: group.y,
        x: leftmost.x,
      })
      bbLog("after-collapseLetterSpacing", {
        pageIndex,
        distinctPageCount: null,
        collapsed: text,
        spacingRecovered: text.includes(" "),
        fusedSingleToken: !text.includes(" ") && bbMatchesPhrase(text),
      })
      bbLog("isCollapsedRunningHeaderLine", {
        pageIndex,
        distinctPageCount: null,
        text,
        result: isCollapsedRunningHeaderLine(text),
      })
    }

    if (!text) {
      continue
    }

    const fontSize = Math.max(...group.items.map((entry) => entry.fontSize))
    const runs = buildRunsFromLineItems(group.items)

    const rightEdge =
      rightmost.x + (rightmost.str?.length ?? 0) * fontSize * 0.5
    // Exact right edge from the pdfjs item widths. The character-count
    // estimate above skews wide (glyphs are narrower than 0.5em at display
    // sizes), which misplaces the optical center of short prominent lines;
    // consumers that need real centering geometry should prefer this value.
    const measuredRightEdge = Math.max(
      ...group.items.map((entry) =>
        entry.width > 0
          ? entry.x + entry.width
          : entry.x + (entry.str?.length ?? 0) * entry.fontSize * 0.5
      )
    )

    lines.push({
      text,
      x: leftmost.x,
      rightEdge,
      measuredRightEdge,
      y: group.y,
      fontSize,
      runs,
    })
  }

  lines.sort((a, b) => b.y - a.y)

  return lines
}

function isLikelyWrappedProseContinuation(text, previousText) {
  const trimmed = (text ?? "").trim()
  const prevTrim = (previousText ?? "").trim()
  if (!trimmed || !prevTrim) {
    return false
  }
  if (/[.!?]["'\u201d]?\s*$/.test(prevTrim)) {
    return false
  }
  if (/^[a-z(\u201c(']/.test(trimmed)) {
    return true
  }
  if (/^(and|but|or|then|who|which|that|as|if|like|for|of|to|in|at|on|with|from|by|the|a|an|apples|out)\s/i.test(trimmed)) {
    return true
  }
  if (HEADING_DANGLING_ENDING_REGEX.test(prevTrim)) {
    return true
  }
  const letters = trimmed.replace(/[^A-Za-z]/g, "")
  if (letters.length >= 8) {
    const upperRatio = (trimmed.match(/[A-Z]/g) ?? []).length / letters.length
    if (upperRatio >= 0.85) {
      if (isPureAllCapsTitleText(trimmed)) {
        return false
      }
      return true
    }
  }
  if (/[.!?]["'\u201d]?\s*$/.test(trimmed) && countWordsInText(trimmed) <= 15) {
    return true
  }
  return false
}

function isProseSentenceFragment(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (resolvePartHeadingLabel(trimmed)) {
    return false
  }
  if (/^[a-z(\u201c(']/.test(trimmed)) {
    return true
  }
  if (/^(and|but|or|then|who|which|that|as|if|like|for)\s/i.test(trimmed)) {
    return true
  }
  if (isIncompleteNarrativeLineFragment(trimmed)) {
    return true
  }
  if (/[.!?]["'\u201d]?\s*$/.test(trimmed) && countWordsInText(trimmed) <= 20) {
    const letters = trimmed.replace(/[^A-Za-z]/g, "")
    if (letters.length < 12) {
      return true
    }
    const upperRatio = (trimmed.match(/[A-Z]/g) ?? []).length / letters.length
    if (upperRatio < 0.75) {
      return true
    }
  }
  return false
}

function annotateLinesCentered(lines) {
  if (!lines.length) {
    return
  }

  let leftBound = Infinity
  let rightBound = -Infinity

  for (const line of lines) {
    const leftEdge = line.x ?? 0
    const rightEdge = line.rightEdge ?? leftEdge
    if (leftEdge < leftBound) {
      leftBound = leftEdge
    }
    if (rightEdge > rightBound) {
      rightBound = rightEdge
    }
  }

  if (!Number.isFinite(leftBound) || !Number.isFinite(rightBound)) {
    return
  }

  const columnWidth = rightBound - leftBound
  const columnCenter = (leftBound + rightBound) / 2
  const centerTolerance = Math.max(
    CENTERED_LINE_CENTER_TOLERANCE_PX * 2,
    columnWidth * 0.12
  )

  const lineCountsOnPage = new Map()
  for (const line of lines) {
    const trimmed = (line.text ?? "").trim()
    if (!trimmed) {
      continue
    }
    lineCountsOnPage.set(trimmed, (lineCountsOnPage.get(trimmed) ?? 0) + 1)
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const trimmed = (line.text ?? "").trim()
    const previousLineText =
      lineIndex > 0 ? (lines[lineIndex - 1].text ?? "").trim() : ""

    if (isShortDialogueLine(trimmed) || isDialogueAttributionFragment(trimmed)) {
      line.centered = false
      continue
    }

    if (isLikelyWrappedProseContinuation(trimmed, previousLineText)) {
      line.centered = false
      continue
    }

    if (isAllCapsCalloutLine(trimmed)) {
      const leftEdge = line.x ?? 0
      const rightEdge = line.rightEdge ?? leftEdge
      const lineWidth = Math.max(0, rightEdge - leftEdge)
      const isNarrow =
        columnWidth > 0 &&
        lineWidth > 0 &&
        lineWidth / columnWidth <= CENTERED_LINE_MAX_WIDTH_RATIO
      line.centered = isNarrow
      continue
    }

    const leftEdge = line.x ?? 0
    const rightEdge = line.rightEdge ?? leftEdge
    const lineWidth = Math.max(0, rightEdge - leftEdge)
    const leftGap = leftEdge - leftBound
    const rightGap = rightBound - rightEdge
    const lineCenter = (leftEdge + rightEdge) / 2
    const isNarrowLine =
      columnWidth > 0 && lineWidth > 0 && lineWidth / columnWidth <= CENTERED_LINE_MAX_WIDTH_RATIO

    const symmetricMargins =
      isNarrowLine &&
      leftGap >= CENTERED_LINE_LEFT_GAP_MIN_PX &&
      rightGap >= CENTERED_LINE_LEFT_GAP_MIN_PX &&
      Math.abs(leftGap - rightGap) <= centerTolerance

    const nearColumnCenter =
      isNarrowLine && Math.abs(lineCenter - columnCenter) <= centerTolerance

    const repeatedDisplayLine =
      isNarrowLine &&
      trimmed.length > 0 &&
      trimmed.length <= CENTERED_REPEATED_LINE_MAX_CHARS &&
      (lineCountsOnPage.get(trimmed) ?? 0) >= CENTERED_REPEATED_LINE_MIN_COUNT &&
      !isDialogueAttributionFragment(trimmed)

    if (isProseSentenceFragment(trimmed)) {
      line.centered = false
      continue
    }

    line.centered = symmetricMargins || nearColumnCenter || repeatedDisplayLine
  }
}

function multiplyPdfTransform(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

function imageMetricsFromTransform(transform, pageWidth, pageHeight) {
  const width = Math.hypot(transform[0], transform[1])
  const height = Math.hypot(transform[2], transform[3])
  const x = transform[4]
  const y = transform[5]

  return {
    x,
    y,
    width,
    height,
    pageWidth,
    pageHeight,
  }
}

/** @deprecated Use classifyPdfImageRole — kept for regression scripts. */
function isChapterHeaderCandidate(metrics) {
  return classifyPdfImageRole(metrics) != null
}

function withSourcePdfPage(payload, pageIndex) {
  if (pageIndex == null) {
    return payload
  }

  return {
    ...payload,
    sourcePdfPageIndex: pageIndex,
  }
}

function generateImageCandidateId(pageNumber, streamIndex) {
  return `img-p${pageNumber}-s${streamIndex}-${crypto.randomUUID().slice(0, 8)}`
}

async function awaitPdfObject(pool, objId) {
  if (!pool?.get || !objId) {
    return null
  }

  if (typeof pool.has === "function" && pool.has(objId)) {
    try {
      return pool.get(objId)
    } catch {
      // Fall through to the callback form when data is still pending.
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const timeoutId = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      reject(new Error(`Image resolve timed out for ${objId}`))
    }, PDF_IMAGE_RESOLVE_TIMEOUT_MS)

    pool.get(objId, (data) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeoutId)
      if (data != null) {
        resolve(data)
      } else {
        reject(new Error(`Image object ${objId} returned empty data`))
      }
    })
  })
}

async function resolvePdfImageObject(page, imageRefId, pdf = null) {
  if (!imageRefId) {
    return null
  }

  const pools = [page?.objs, page?.commonObjs, pdf?.commonObjs].filter(Boolean)
  let lastError = null

  for (const pool of pools) {
    try {
      const data = await awaitPdfObject(pool, imageRefId)
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

function isPngImageBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  )
}

function isWebpImageBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
}

function isGifImageBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 6 &&
    (buffer.toString("ascii", 0, 6) === "GIF87a" ||
      buffer.toString("ascii", 0, 6) === "GIF89a")
  )
}

function isRasterImageBuffer(buffer) {
  return (
    isJpegImageBuffer(buffer) ||
    isPngImageBuffer(buffer) ||
    isWebpImageBuffer(buffer) ||
    isGifImageBuffer(buffer)
  )
}

function isJpegImageBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  )
}

function bufferFromByteSource(source) {
  if (!source) {
    return null
  }

  if (Buffer.isBuffer(source)) {
    return source.length > 0 ? source : null
  }

  if (source instanceof Uint8Array) {
    return Buffer.from(source.buffer, source.byteOffset, source.byteLength)
  }

  if (source instanceof ArrayBuffer) {
    return Buffer.from(source)
  }

  if (typeof source === "object" && source.buffer instanceof ArrayBuffer) {
    return Buffer.from(
      source.buffer,
      source.byteOffset ?? 0,
      source.byteLength ?? source.length ?? 0
    )
  }

  if (typeof source === "string") {
    const trimmed = source.trim()
    if (!trimmed) {
      return null
    }

    if (trimmed.startsWith("data:")) {
      const commaIndex = trimmed.indexOf(",")
      if (commaIndex === -1) {
        return null
      }
      return Buffer.from(trimmed.slice(commaIndex + 1), "base64")
    }

    return Buffer.from(trimmed, "base64")
  }

  return null
}

function extractCompressedPdfImageBytes(imageObject) {
  if (!imageObject) {
    return null
  }

  const compressedCandidates = [
    imageObject.srcData,
    imageObject.currentSrc,
    imageObject.bytes,
    imageObject.stream,
  ]

  for (const candidate of compressedCandidates) {
    const buffer = bufferFromByteSource(candidate)
    if (isRasterImageBuffer(buffer)) {
      return buffer
    }
  }

  if (typeof imageObject.src === "string" && imageObject.src.startsWith("data:image/")) {
    const buffer = bufferFromByteSource(imageObject.src)
    if (buffer?.length) {
      return buffer
    }
  }

  const dataBuffer = bufferFromByteSource(imageObject.data)
  if (isRasterImageBuffer(dataBuffer)) {
    return dataBuffer
  }

  return null
}

function expectedRawPixelByteLength(width, height, kind) {
  if (!width || !height) {
    return 0
  }

  if (kind === ImageKind.GRAYSCALE_1BPP) {
    return Math.ceil((width * height) / 8)
  }

  if (kind === ImageKind.RGB_24BPP) {
    return width * height * 3
  }

  if (kind === ImageKind.RGBA_32BPP) {
    return width * height * 4
  }

  return width * height * 4
}

function rawPdfPixelsToJpegBuffer(imageObject) {
  const width = imageObject?.width
  const height = imageObject?.height
  const kind = imageObject?.kind ?? ImageKind.RGBA_32BPP
  const pixelData = imageObject?.data

  if (!width || !height || !pixelData?.length) {
    return null
  }

  const expectedLength = expectedRawPixelByteLength(width, height, kind)
  if (expectedLength > 0 && pixelData.length < expectedLength) {
    return null
  }

  const canvas = createCanvas(width, height)
  const context = canvas.getContext("2d")
  const imageData = context.createImageData(width, height)

  if (kind === ImageKind.RGBA_32BPP) {
    imageData.data.set(pixelData.subarray(0, width * height * 4))
  } else if (kind === ImageKind.RGB_24BPP) {
    let sourceIndex = 0
    for (let destinationIndex = 0; destinationIndex < imageData.data.length; destinationIndex += 4) {
      imageData.data[destinationIndex] = pixelData[sourceIndex]
      imageData.data[destinationIndex + 1] = pixelData[sourceIndex + 1]
      imageData.data[destinationIndex + 2] = pixelData[sourceIndex + 2]
      imageData.data[destinationIndex + 3] = 255
      sourceIndex += 3
    }
  } else if (kind === ImageKind.GRAYSCALE_1BPP) {
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const bitIndex = row * width + column
        const byteIndex = bitIndex >> 3
        const bitMask = 0x80 >> (bitIndex & 7)
        const gray = pixelData[byteIndex] & bitMask ? 0 : 255
        const destinationIndex = (row * width + column) * 4
        imageData.data[destinationIndex] = gray
        imageData.data[destinationIndex + 1] = gray
        imageData.data[destinationIndex + 2] = gray
        imageData.data[destinationIndex + 3] = 255
      }
    }
  } else {
    return null
  }

  context.putImageData(imageData, 0, 0)
  return canvas.toBuffer("image/jpeg", { quality: 0.92 })
}

async function rasterBufferToJpegBuffer(buffer) {
  if (!buffer?.length) {
    return null
  }

  if (isJpegImageBuffer(buffer)) {
    return buffer
  }

  try {
    const source = await loadImage(buffer)
    const canvas = createCanvas(source.width, source.height)
    const context = canvas.getContext("2d")
    context.fillStyle = "#ffffff"
    context.fillRect(0, 0, source.width, source.height)
    context.drawImage(source, 0, 0)
    return canvas.toBuffer("image/jpeg", { quality: 0.92 })
  } catch {
    return null
  }
}

async function resolvePdfImageBuffer(imageObject) {
  const compressedBuffer = extractCompressedPdfImageBytes(imageObject)
  if (compressedBuffer?.length) {
    if (isJpegImageBuffer(compressedBuffer)) {
      return compressedBuffer
    }
    if (
      isPngImageBuffer(compressedBuffer) ||
      isWebpImageBuffer(compressedBuffer) ||
      isGifImageBuffer(compressedBuffer)
    ) {
      return rasterBufferToJpegBuffer(compressedBuffer)
    }
    return compressedBuffer
  }

  return rawPdfPixelsToJpegBuffer(imageObject)
}

async function extractPdfPageImageCandidatesFromOperatorList(
  page,
  pageNumber,
  operatorList,
  { resolveBuffers = true, pdf = null } = {}
) {
  const viewport = page.getViewport({ scale: 1 })
  const pageWidth = viewport.width
  const pageHeight = viewport.height
  const candidates = []

  let transform = [1, 0, 0, 1, 0, 0]
  const transformStack = []
  let streamIndex = 0

  for (let opIndex = 0; opIndex < operatorList.fnArray.length; opIndex += 1) {
    const op = operatorList.fnArray[opIndex]
    const args = operatorList.argsArray[opIndex]
    streamIndex += 1

    if (op === OPS.save) {
      transformStack.push([...transform])
      continue
    }

    if (op === OPS.restore) {
      transform = transformStack.pop() ?? [1, 0, 0, 1, 0, 0]
      continue
    }

    if (op === OPS.transform) {
      transform = multiplyPdfTransform(transform, args)
      continue
    }

    if (!PDF_IMAGE_PAINT_OPS.has(op)) {
      continue
    }

    const metrics = imageMetricsFromTransform(transform, pageWidth, pageHeight)
    if (
      metrics.width < PDF_IMAGE_MIN_DIMENSION_PX ||
      metrics.height < PDF_IMAGE_MIN_DIMENSION_PX
    ) {
      continue
    }

    const imageRole = classifyPdfImageRole(metrics)
    let buffer = null

    if (imageRole != null && resolveBuffers) {
      try {
        const imageObject =
          op === OPS.paintInlineImageXObject
            ? args?.[0]
            : await resolvePdfImageObject(page, args?.[0], pdf)
        buffer = await resolvePdfImageBuffer(imageObject)
      } catch {
        buffer = null
      }
    }

    candidates.push({
      type: "image_candidate",
      id: generateImageCandidateId(pageNumber, streamIndex),
      pageNumber,
      streamIndex,
      coordinates: {
        x: metrics.x,
        y: metrics.y,
        width: metrics.width,
        height: metrics.height,
        pageWidth,
        pageHeight,
      },
      imageRole,
      isCandidate: imageRole != null,
      buffer,
    })
  }

  return candidates
}

async function extractPdfPageImageCandidates(page, pageNumber) {
  const operatorList = await page.getOperatorList({ intent: "display" })
  return extractPdfPageImageCandidatesFromOperatorList(page, pageNumber, operatorList)
}

function buildPageTextCharCounts(blocks) {
  const counts = new Map()

  for (const block of blocks) {
    if (block?.type === "image" || block?.type === "image_candidate") {
      continue
    }

    const pageIndex = block?.sourcePdfPageIndex ?? -1
    if (pageIndex < 0) {
      continue
    }

    counts.set(pageIndex, (counts.get(pageIndex) ?? 0) + (block?.text ?? "").length)
  }

  return counts
}

const FULL_PAGE_OCR_MIN_PAGE = 28
const FULL_PAGE_OCR_MIN_HEIGHT_RATIO = 0.55
const TEXT_HEAVY_CHAPTER_PLATE_PAGE_CHARS = 120

function shouldOcrFullPageIllustration(block, pageTextCharCounts) {
  if (block?.imageRole !== "full_page_illustration") {
    return false
  }

  if (isLikelyChapterArchBannerBlock(block)) {
    return false
  }

  const pageNumber = block.pageNumber ?? 0
  if (pageNumber < FULL_PAGE_OCR_MIN_PAGE) {
    return false
  }

  if (getSamePageTextChars(pageTextCharCounts, block) > 80) {
    return false
  }

  const coords = block.coordinates ?? {}
  const pageHeight = coords.pageHeight ?? 0
  const height = coords.height ?? 0
  if (pageHeight > 0 && height / pageHeight < FULL_PAGE_OCR_MIN_HEIGHT_RATIO) {
    return false
  }

  return true
}

function isTextHeavyIllustrationPage(pageTextCharCounts, imageBlock) {
  if (
    imageBlock?.imageRole === "chapter_heading" ||
    isTallChapterArchBannerBlock(imageBlock)
  ) {
    return false
  }

  return (
    getSamePageTextChars(pageTextCharCounts, imageBlock) >
    TEXT_HEAVY_CHAPTER_PLATE_PAGE_CHARS
  )
}

function shouldRunIllustrationOcr(block, _ocrMetadata, pageTextCharCounts, printedToc = null) {
  if (block.imageRole === "illustration") {
    return false
  }

  if (block.imageRole === "chapter_heading" || isLikelyChapterArchBannerBlock(block)) {
    if (isTextHeavyIllustrationPage(pageTextCharCounts, block)) {
      return false
    }
    // Printed-TOC books number arch banners from the sequential TOC cursor,
    // so reading the stone plaque adds nothing there - skip the OCR call.
    // Full-page dividers keep OCR below (PART / INTERLUDES detection), and
    // books without a printed TOC keep plaque OCR as their only source of
    // chapter numbers and titles.
    if (printedToc) {
      return false
    }
    return true
  }

  return shouldOcrFullPageIllustration(block, pageTextCharCounts)
}

function resolveIllustrationOcrRole(block) {
  if (block.imageRole === "chapter_heading" || isLikelyChapterArchBannerBlock(block)) {
    return "chapter_heading"
  }

  return block.imageRole ?? null
}

function isChapterBannerCandidate(block) {
  if (block.imageRole === "illustration") {
    return false
  }

  return block.imageRole === "chapter_heading" || isLikelyChapterArchBannerBlock(block)
}

function getSamePageTextChars(pageTextCharCounts, imageBlock) {
  const pageIndex = Math.max(0, (imageBlock?.pageNumber ?? 1) - 1)
  return pageTextCharCounts.get(pageIndex) ?? 0
}

function shouldSkipChapterHeadingCandidate(block, blocks, blockIndex) {
  return shouldSkipChapterGraphicAnalysis(block, blocks, blockIndex)
}

function countPlannedOcrEntries(candidateEntries, pageTextCharCounts, blocks, printedToc = null) {
  let count = 0

  for (const { block, index: blockIndex } of candidateEntries) {
    if (!extractImageBlockPayload(block)) {
      continue
    }

    if (block.imageRole === "chapter_heading") {
      if (
        !printedToc &&
        !shouldSkipChapterHeadingCandidate(block, blocks, blockIndex) &&
        !isTextHeavyIllustrationPage(pageTextCharCounts, block)
      ) {
        count += 1
      }
      continue
    }

    if (isLikelyChapterArchBannerBlock(block)) {
      if (
        !printedToc &&
        !shouldSkipChapterGraphicAnalysis(block, blocks, blockIndex) &&
        !isTextHeavyIllustrationPage(pageTextCharCounts, block)
      ) {
        count += 1
      }
      continue
    }

    if (shouldOcrFullPageIllustration(block, pageTextCharCounts)) {
      count += 1
    }
  }

  return count
}

function normalizeBlockTextForPageMatch(text) {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase()
}

function buildPageLineQueue(pageData) {
  const queue = []

  for (let pageIndex = 0; pageIndex < pageData.length; pageIndex += 1) {
    for (const line of pageData[pageIndex]?.lines ?? []) {
      const text = (line.text ?? "").trim()
      if (!text) {
        continue
      }

      queue.push({
        pageIndex,
        y: line.y ?? 0,
        text,
      })
    }
  }

  return queue
}

function mapTextBlocksToPagePositions(blocks, pageData) {
  const lineQueue = buildPageLineQueue(pageData)
  let queueIndex = 0

  return blocks.map((block, blockIndex) => {
    if (block.type === "image_candidate") {
      return {
        block,
        blockIndex,
        pageIndex: block.pageNumber - 1,
        y: block.coordinates?.y ?? 0,
        streamIndex: block.streamIndex ?? blockIndex,
      }
    }

    const target = normalizeBlockTextForPageMatch(block.text)
    if (!target) {
      const fallbackPage = lineQueue[queueIndex]?.pageIndex ?? 0
      return {
        block,
        blockIndex,
        pageIndex: fallbackPage,
        y: lineQueue[queueIndex]?.y ?? 0,
        streamIndex: blockIndex * 1000,
      }
    }

    const startIndex = queueIndex
    let consumed = ""

    while (queueIndex < lineQueue.length) {
      consumed += normalizeBlockTextForPageMatch(lineQueue[queueIndex].text)
      queueIndex += 1

      if (
        consumed.startsWith(target.slice(0, Math.min(48, target.length))) ||
        target.startsWith(consumed.slice(0, Math.min(48, consumed.length)))
      ) {
        if (consumed.length >= target.length || queueIndex - startIndex >= 12) {
          break
        }
      }

      if (queueIndex - startIndex >= 24) {
        break
      }
    }

    const anchor = lineQueue[startIndex] ?? lineQueue[lineQueue.length - 1]

    return {
      block,
      blockIndex,
      pageIndex: anchor?.pageIndex ?? 0,
      y: anchor?.y ?? 0,
      streamIndex: blockIndex * 1000,
    }
  })
}

function interleaveImageCandidateBlocks(
  textBlocks,
  pageImageCandidates,
  pageData,
  { onProgress } = {}
) {
  const eligibleImages = (pageImageCandidates ?? [])
    .flat()
    .filter(
      (imageBlock) =>
        imageBlock?.isCandidate === true &&
        Boolean(extractImageBlockPayload(imageBlock))
    )

  if (eligibleImages.length === 0) {
    return textBlocks
  }

  const imagesByPage = new Map()
  for (const imageBlock of eligibleImages) {
    const pageIndex = Math.max(0, (imageBlock.pageNumber ?? 1) - 1)
    const pageImages = imagesByPage.get(pageIndex) ?? []
    pageImages.push(imageBlock)
    imagesByPage.set(pageIndex, pageImages)
  }

  const textBlocksByPage = new Map()
  for (const block of textBlocks) {
    const pageIndex = Math.max(0, block.sourcePdfPageIndex ?? 0)
    const pageBlocks = textBlocksByPage.get(pageIndex) ?? []
    pageBlocks.push(block)
    textBlocksByPage.set(pageIndex, pageBlocks)
  }

  const maxPageIndex = Math.max(
    pageData.length - 1,
    ...imagesByPage.keys(),
    ...textBlocksByPage.keys()
  )

  const interleaved = []
  const totalPages = maxPageIndex + 1

  for (let pageIndex = 0; pageIndex <= maxPageIndex; pageIndex += 1) {
    const pageImages = [...(imagesByPage.get(pageIndex) ?? [])].sort(
      (left, right) =>
        (right.coordinates?.y ?? 0) - (left.coordinates?.y ?? 0) ||
        (left.streamIndex ?? 0) - (right.streamIndex ?? 0)
    )
    const pageTextBlocks = textBlocksByPage.get(pageIndex) ?? []

    interleaved.push(...pageImages, ...pageTextBlocks)

    if (onProgress && (pageIndex % 25 === 0 || pageIndex === maxPageIndex)) {
      onProgress(pageIndex + 1, totalPages)
    }
  }

  return interleaved
}

function extractImageBlockPayload(block) {
  return block?.buffer ?? block?.imgData ?? ""
}

function releaseImageBlockBinary(block) {
  if (!block || typeof block !== "object") {
    return
  }

  block.buffer = null
  if (block.imgData != null) {
    if (typeof block.imgData === "object") {
      block.imgData.buffer = null
    }
    block.imgData = null
  }
}

function finalizeNonCandidateImageBlock(block) {
  const { isCandidate: _isCandidate, ...rest } = block

  return {
    ...rest,
    type: "image",
    isChapterBoundary: false,
    chapterMetadata: null,
  }
}

function finalizeVisionImageBlock(block, visionResult) {
  const { isCandidate: _isCandidate, ...rest } = block
  const isFullPageArt = isFullPageHeightIllustrationBlock(block)
  let resolvedVision = visionResult ?? null

  if (
    isFullPageArt &&
    resolvedVision?.isChapterBoundary &&
    (resolvedVision?.boundaryKind === "chapter" ||
      resolvedVision?.boundaryKind === "interlude")
  ) {
    resolvedVision = { ...SAFE_FALLBACK }
  }

  const includeInToc = resolvedVision?.includeInToc !== false
  const imageRole =
    isFullPageArt && block.imageRole !== PDF_IMAGE_ROLE.FULL_PAGE_ILLUSTRATION
      ? PDF_IMAGE_ROLE.FULL_PAGE_ILLUSTRATION
      : block.imageRole ?? null

  return {
    ...rest,
    type: "image",
    imageRole,
    isChapterBoundary: Boolean(resolvedVision?.isChapterBoundary),
    chapterMetadata: {
      boundaryKind: resolvedVision?.boundaryKind ?? null,
      title: resolvedVision?.title ?? null,
      number: resolvedVision?.number ?? null,
      rawText: resolvedVision?.rawText ?? null,
      includeInToc,
    },
  }
}

async function runWithConcurrency(items, concurrency, worker) {
  if (items.length === 0) {
    return []
  }

  const results = new Array(items.length)
  let nextIndex = 0

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await worker(items[currentIndex], currentIndex)
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))

  return results
}

async function finalizeIllustrationBlocks(
  blocks,
  {
    onProgress,
    printedToc = null,
    illustrationProgressRange = {
      start: PARSE_PROGRESS_ILLUSTRATION_START_PERCENT,
      end: PARSE_PROGRESS_ILLUSTRATION_END_PERCENT,
    },
  } = {}
) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  const pageTextCharCounts = buildPageTextCharCounts(blocks)

  const candidateEntries = blocks
    .map((block, index) => ({ block, index }))
    .filter(
      ({ block }) =>
        block?.type === "image_candidate" &&
        block.isCandidate === true &&
        Boolean(extractImageBlockPayload(block))
    )
    .sort(
      (left, right) =>
        (left.block.pageNumber ?? 0) - (right.block.pageNumber ?? 0) ||
        (left.block.streamIndex ?? 0) - (right.block.streamIndex ?? 0)
    )

  let chapterSequence = 0
  let interludeSequence = 0
  let pendingInterludes = 0
  let ocrCompleted = 0
  let processedCandidates = 0
  const totalCandidates = candidateEntries.length
  const illustrationSpan = Math.max(
    1,
    illustrationProgressRange.end - illustrationProgressRange.start
  )

  const plannedOcrTotal = countPlannedOcrEntries(
    candidateEntries,
    pageTextCharCounts,
    blocks,
    printedToc
  )

  const finalizedByIndex = new Map()
  const tocOrderCursor = printedToc ? { index: 0 } : null
  const assignedBoundaryKeys = new Set()

  // If the prelude was already emitted as a text heading upstream, don't let a
  // banner re-emit it. boundaryDedupeKey dedupes prelude/prologue/epilogue by kind.
  if (
    blocks.some(
      (candidate) =>
        candidate?.type !== "image" &&
        candidate?.type !== "image_candidate" &&
        /^Prelude to the Stormlight Archive$/i.test((candidate?.text ?? "").trim())
    )
  ) {
    assignedBoundaryKeys.add("prelude")
  }

  if (
    blocks.some(
      (candidate) =>
        candidate?.type !== "image" &&
        candidate?.type !== "image_candidate" &&
        /^Prologue:\s+/i.test((candidate?.text ?? "").trim())
    )
  ) {
    assignedBoundaryKeys.add("prologue")
  }

  const buildSequentialTocEntry =
    printedToc && tocOrderCursor
      ? () => takeNextSequentialTocEntryForImageBanner(printedToc, tocOrderCursor)
      : null

  const buildSequentialInterludeTocEntry =
    printedToc && tocOrderCursor
      ? () => takeNextSequentialInterludeTocEntry(printedToc, tocOrderCursor)
      : null

  // Front-matter art gate. Real numbered chapters always begin after the
  // Prologue, so the stream position of the injected Prologue text heading is
  // the end of front matter. Any image candidate at or before it (the Roshar
  // and Alethkar map spreads, the prelude and prologue arch banners) is
  // front-matter art: it must never be classified as a chapter, never consume a
  // printed-TOC slot, and never advance the sequential cursor. This is
  // OCR-independent, so a banner whose stone plaque OCR misreads "PROLOGUE" as
  // garbage can no longer fall through into a numbered chapter slot.
  let frontMatterCutoffIndex = -1
  for (let scan = 0; scan < blocks.length; scan += 1) {
    const candidate = blocks[scan]
    if (candidate?.type === "image" || candidate?.type === "image_candidate") {
      continue
    }
    if (/^Prologue:\s+/i.test((candidate?.text ?? "").trim())) {
      frontMatterCutoffIndex = scan
      break
    }
  }
  // Fallback to the Prelude heading if the Prologue heading is missing, so the
  // map spread before it still cannot steal slots even in the degraded case.
  if (frontMatterCutoffIndex === -1) {
    for (let scan = 0; scan < blocks.length; scan += 1) {
      const candidate = blocks[scan]
      if (candidate?.type === "image" || candidate?.type === "image_candidate") {
        continue
      }
      if (/^Prelude to the Stormlight Archive$/i.test((candidate?.text ?? "").trim())) {
        frontMatterCutoffIndex = scan
        break
      }
    }
  }

  if (process.env.BOOKY_FRONTMATTER_DEBUG === "1") {
    console.log("[frontMatterGate]", JSON.stringify({ frontMatterCutoffIndex }))
  }

  let lastInterludeTextScanIndex =
    frontMatterCutoffIndex >= 0 ? frontMatterCutoffIndex + 1 : 0
  let lastPartPlateScanIndex =
    frontMatterCutoffIndex >= 0 ? frontMatterCutoffIndex + 1 : 0
  let partBoundaryCount = 0

  function boundaryDedupeKey(analysisResult) {
    const kind = analysisResult?.boundaryKind
    const number = (analysisResult?.number ?? "").trim()
    if (!kind || kind === "flashback" || kind === "part" || kind === "interlude_divider") {
      return null
    }

    if (kind === "chapter") {
      const chapterKey = extractChapterKeyFromOcrNumber(number)
      return chapterKey ? `chapter:${chapterKey}` : null
    }

    if (kind === "interlude") {
      const match = number.match(/I-(\d{1,2})/i)
      return match ? `interlude:${match[1]}` : null
    }

    if (kind === "prelude" || kind === "prologue" || kind === "epilogue") {
      return kind
    }

    return null
  }

  function reportCandidateProgress({
    block,
    shouldRunOcr,
    imageBuffer,
  }) {
    const illustrationPercent =
      illustrationProgressRange.start +
      Math.round((processedCandidates / Math.max(1, totalCandidates)) * illustrationSpan)

    if (shouldRunOcr && imageBuffer?.length) {
      onProgress?.({
        phase: "ocr_illustrations",
        label:
          block.imageRole === "chapter_heading"
            ? "Reading chapter headers from artwork"
            : "Reading section dividers from artwork",
        current: ocrCompleted,
        total: Math.max(plannedOcrTotal, ocrCompleted),
        percent: illustrationPercent,
        usingPrintedToc: Boolean(printedToc),
        illustrationCurrent: processedCandidates,
        illustrationTotal: totalCandidates,
        ocrCurrent: ocrCompleted,
        ocrTotal: Math.max(plannedOcrTotal, ocrCompleted),
      })
      return
    }

    onProgress?.({
      phase: "classifying_illustrations",
      label: "Classifying artwork",
      current: processedCandidates,
      total: totalCandidates,
      percent: illustrationPercent,
      usingPrintedToc: Boolean(printedToc),
      illustrationCurrent: processedCandidates,
      illustrationTotal: totalCandidates,
    })
  }

  try {
    for (const { block, index } of candidateEntries) {
      const interludesFromText = scanPendingInterludesFromBlocks(
        blocks,
        lastInterludeTextScanIndex,
        index
      )
      if (interludesFromText > 0) {
        pendingInterludes = interludesFromText
      }

      if (
        printedToc &&
        tocOrderCursor &&
        scanStructuralPartDividerPlate(blocks, lastPartPlateScanIndex, index) &&
        isLastChapterSlotBeforePart(printedToc, tocOrderCursor)
      ) {
        const cursorBeforePartSeek = tocOrderCursor.index
        advanceTocCursorPastNextPartDivider(printedToc, tocOrderCursor)
        if (process.env.BOOKY_FRONTMATTER_DEBUG === "1") {
          console.log(
            "[partCursor]",
            JSON.stringify({
              reason: "structural-divider-plate",
              atIndex: index,
              cursorBefore: cursorBeforePartSeek,
              cursor: tocOrderCursor.index,
            })
          )
        }
      }

      lastPartPlateScanIndex = index
      lastInterludeTextScanIndex = index

      if (frontMatterCutoffIndex >= 0 && index <= frontMatterCutoffIndex) {
        if (process.env.BOOKY_FRONTMATTER_DEBUG === "1") {
          console.log(
            "[frontMatterGate] excluded",
            JSON.stringify({
              index,
              pageNumber: block.pageNumber,
              imageRole: block.imageRole,
            })
          )
        }
        finalizedByIndex.set(index, finalizeVisionImageBlock(block, SAFE_FALLBACK))
        releaseImageBlockBinary(blocks[index])
        processedCandidates += 1
        reportCandidateProgress({ block, shouldRunOcr: false, imageBuffer: null })
        continue
      }

      const imageBuffer = base64PayloadToImageBuffer(extractImageBlockPayload(block))
      let forceInterludeBoundary =
        pendingInterludes > 0 && isChapterBannerCandidate(block)

      if (
        isChapterBannerCandidate(block) &&
        shouldSkipChapterHeadingCandidate(block, blocks, index)
      ) {
        finalizedByIndex.set(index, finalizeVisionImageBlock(block, SAFE_FALLBACK))
        releaseImageBlockBinary(blocks[index])
        processedCandidates += 1
        reportCandidateProgress({
          block,
          shouldRunOcr: false,
          imageBuffer: null,
        })
        continue
      }

      let ocrMetadata = null
      const shouldRunOcr = shouldRunIllustrationOcr(block, null, pageTextCharCounts, printedToc)

      if (imageBuffer?.length && shouldRunOcr) {
        onProgress?.({
          phase: "ocr_illustrations",
          label:
            block.imageRole === "chapter_heading"
              ? "Reading chapter headers from artwork"
              : "Reading section dividers from artwork",
          current: ocrCompleted,
          total: Math.max(plannedOcrTotal, ocrCompleted + 1),
          percent:
            illustrationProgressRange.start +
            Math.round((processedCandidates / Math.max(1, totalCandidates)) * illustrationSpan),
          usingPrintedToc: Boolean(printedToc),
          illustrationCurrent: processedCandidates,
          illustrationTotal: totalCandidates,
          ocrCurrent: ocrCompleted,
          ocrTotal: Math.max(plannedOcrTotal, ocrCompleted + 1),
        })

        ocrMetadata = await ocrIllustrationMetadata(
          imageBuffer,
          resolveIllustrationOcrRole(block)
        )
        ocrCompleted += 1
      }

      // A confident chapter plaque (1 to 75, no I- prefix) overrides interlude
      // forcing and ends the run, so a failed part-divider OCR cannot turn the
      // first chapter of a new part into an interlude. Interlude and section
      // plaques (I-3, PROLOGUE, ...) return null here and stay forced.
      if (
        forceInterludeBoundary &&
        extractChapterKeyFromOcrNumber(ocrMetadata?.number)
      ) {
        forceInterludeBoundary = false
        pendingInterludes = 0
      }

      const tocCursorBefore = tocOrderCursor?.index ?? 0

      const analysisResult = analyzeChapterGraphicFromContext({
        imageBlock: block,
        blocks,
        blockIndex: index,
        chapterSequence: chapterSequence + 1,
        interludeSequence: interludeSequence + 1,
        ocrMetadata,
        printedToc,
        forceInterludeBoundary,
        precomputedPageCharCounts: pageTextCharCounts,
        tocOrderCursor,
        buildSequentialTocEntry,
        buildSequentialInterludeTocEntry,
      })

      let finalResult = analysisResult
      const dedupeKey = boundaryDedupeKey(analysisResult)
      if (
        dedupeKey &&
        analysisResult.isChapterBoundary &&
        assignedBoundaryKeys.has(dedupeKey)
      ) {
        finalResult = { ...SAFE_FALLBACK }
        if (tocOrderCursor) {
          tocOrderCursor.index = tocCursorBefore
        }
      } else if (dedupeKey && analysisResult.isChapterBoundary) {
        assignedBoundaryKeys.add(dedupeKey)
      }

      if (finalResult.boundaryKind === "interlude_divider") {
        pendingInterludes = countInterludeNamesInDivider(ocrMetadata) || 3
      } else if (finalResult.boundaryKind === "interlude") {
        interludeSequence += 1
        pendingInterludes = Math.max(0, pendingInterludes - 1)
      } else if (finalResult.boundaryKind === "chapter") {
        chapterSequence += 1
        pendingInterludes = 0
      } else if (finalResult.boundaryKind === "prelude") {
        pendingInterludes = 0
      } else if (finalResult.boundaryKind === "prologue") {
        pendingInterludes = 0
      } else if (finalResult.boundaryKind === "part") {
        pendingInterludes = 0
        partBoundaryCount += 1
        const cursorBeforePartSeek = tocOrderCursor?.index ?? null
        let partSeekKind = "none"
        if (
          printedToc &&
          tocOrderCursor &&
          isLastChapterSlotBeforePart(printedToc, tocOrderCursor)
        ) {
          advanceTocCursorPastNextPartDivider(printedToc, tocOrderCursor)
          partSeekKind = "advancePastNextPartDivider"
        } else if (printedToc && tocOrderCursor) {
          seekTocCursorToFirstChapterAfterNthPart(
            printedToc,
            tocOrderCursor,
            partBoundaryCount
          )
          partSeekKind = "seekToFirstChapterAfterNthPart"
        }
        if (process.env.BOOKY_FRONTMATTER_DEBUG === "1") {
          console.log(
            "[partCursor]",
            JSON.stringify({
              reason: "ocr-part-boundary",
              atIndex: index,
              partBoundaryCount,
              partSeekKind,
              cursorBefore: cursorBeforePartSeek,
              cursor: tocOrderCursor?.index ?? null,
            })
          )
        }
      } else if (finalResult.boundaryKind === "epilogue") {
        pendingInterludes = 0
      }

      if (process.env.BOOKY_FRONTMATTER_DEBUG === "1") {
        console.log(
          "[chapterAssign]",
          JSON.stringify({
            index,
            pageNumber: block.pageNumber,
            imageRole: block.imageRole,
            ocrKind: ocrMetadata?.boundaryKind ?? null,
            ocrNumber: ocrMetadata?.number ?? null,
            finalKind: finalResult?.boundaryKind ?? null,
            finalNumber: finalResult?.number ?? null,
            isBoundary: Boolean(finalResult?.isChapterBoundary),
            widthRatio: (block.coordinates?.pageWidth ?? 0)
              ? Number(((block.coordinates.width ?? 0) / block.coordinates.pageWidth).toFixed(3))
              : null,
            heightRatio: (block.coordinates?.pageHeight ?? 0)
              ? Number(((block.coordinates.height ?? 0) / block.coordinates.pageHeight).toFixed(3))
              : null,
            aspect: (block.coordinates?.height ?? 0)
              ? Number(((block.coordinates.width ?? 0) / block.coordinates.height).toFixed(3))
              : null,
          })
        )
      }

      finalizedByIndex.set(index, finalizeVisionImageBlock(block, finalResult))
      releaseImageBlockBinary(blocks[index])

      processedCandidates += 1
      reportCandidateProgress({
        block,
        shouldRunOcr,
        imageBuffer,
      })
    }

    if (totalCandidates > 0) {
      onProgress?.({
        phase: "classifying_illustrations",
        label: "Classifying artwork",
        current: totalCandidates,
        total: totalCandidates,
        percent: illustrationProgressRange.end,
        usingPrintedToc: Boolean(printedToc),
        illustrationCurrent: totalCandidates,
        illustrationTotal: totalCandidates,
      })
    }

    if (process.env.BOOKY_FRONTMATTER_DEBUG === "1") {
      const orderedBoundaries = []
      for (const { index } of candidateEntries) {
        const finalized = finalizedByIndex.get(index)
        if (finalized?.isChapterBoundary) {
          const coords = finalized.coordinates ?? {}
          const w = coords.width ?? 0
          const h = coords.height ?? 0
          const pw = coords.pageWidth ?? 0
          const ph = coords.pageHeight ?? 0
          orderedBoundaries.push({
            index,
            pageNumber: finalized.pageNumber ?? null,
            kind: finalized.chapterMetadata?.boundaryKind ?? null,
            number: finalized.chapterMetadata?.number ?? null,
            title: finalized.chapterMetadata?.title ?? null,
            widthRatio: pw ? Number((w / pw).toFixed(3)) : null,
            heightRatio: ph ? Number((h / ph).toFixed(3)) : null,
            aspect: h ? Number((w / h).toFixed(3)) : null,
          })
        }
      }
      console.log(
        "[boundarySummary]",
        JSON.stringify({ count: orderedBoundaries.length, orderedBoundaries })
      )
    }
  } finally {
    await terminateOcrWorker()
  }

  return blocks.flatMap((block, index) => {
    if (block?.type !== "image_candidate") {
      return [block]
    }

    const finalized = finalizedByIndex.get(index)
    if (finalized) {
      return [finalized]
    }

    if (block.isCandidate !== true) {
      return []
    }

    return []
  })
}

function extractImageBase64Payload(block) {
  if (typeof block?.imgData === "object" && block.imgData?.buffer != null) {
    return block.imgData.buffer
  }

  if (typeof block?.imgData === "string") {
    return block.imgData
  }

  return block?.buffer ?? ""
}

function base64PayloadToImageBuffer(payload) {
  if (Buffer.isBuffer(payload)) {
    return payload.length > 0 ? payload : null
  }

  const trimmed = (payload ?? "").trim()
  if (!trimmed) {
    return null
  }

  const cleanBase64 = trimmed.replace(/^data:image\/\w+;base64,/, "")
  return Buffer.from(cleanBase64, "base64")
}

function buildBookAssetStoragePath(bookId, blockId) {
  return `books/${bookId}/images/${blockId}.jpg`
}

function stripImageBinaryFields(block) {
  const { buffer: _buffer, imgData: _imgData, ...rest } = block
  return rest
}

function stripAllImageBinaryFieldsFromBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  return blocks.map((block) => {
    if (block?.buffer != null || block?.imgData != null) {
      return stripImageBinaryFields(block)
    }
    return block
  })
}

async function resolveUploadedImageAssetUrl(bucket, storagePath) {
  const { data: publicUrlData } = supabase.storage.from(bucket).getPublicUrl(storagePath)
  const publicUrl = publicUrlData?.publicUrl

  if (publicUrl && !publicUrl.endsWith("/")) {
    return publicUrl
  }

  const { data: signedData, error: signedError } = await supabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, BOOK_ASSET_SIGNED_URL_TTL_SECONDS)

  if (signedError || !signedData?.signedUrl) {
    throw new Error(
      `Failed to resolve accessible URL for image asset at ${storagePath}: ${
        signedError?.message ?? "missing signed URL"
      }`
    )
  }

  return signedData.signedUrl
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableStorageError(message) {
  const normalized = (message ?? "").toLowerCase()
  return (
    normalized.includes("service unavailable") ||
    normalized.includes("too many requests") ||
    normalized.includes("rate limit") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("econnreset") ||
    normalized.includes("etimedout") ||
    normalized.includes("fetch failed") ||
    normalized.includes("network") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("504") ||
    normalized.includes("429")
  )
}

async function uploadImageAssetBufferOnce(bookId, blockId, imageBuffer) {
  const filePath = buildBookAssetStoragePath(bookId, blockId)
  const uploadOptions = {
    contentType: PDF_IMAGE_JPEG_CONTENT_TYPE,
    upsert: true,
  }

  let bucket = process.env.BOOK_ASSETS_BUCKET ?? BOOK_ASSETS_BUCKET
  let storagePath = filePath

  let uploadResult = await supabase.storage
    .from(bucket)
    .upload(storagePath, imageBuffer, uploadOptions)

  if (
    uploadResult.error?.message?.includes("Bucket not found") &&
    bucket !== BOOK_ASSETS_FALLBACK_BUCKET
  ) {
    console.warn(
      `[uploadBookAssets] Bucket "${bucket}" not found; falling back to "${BOOK_ASSETS_FALLBACK_BUCKET}". Create a public "${bucket}" bucket in Supabase for CDN URLs.`
    )
    bucket = BOOK_ASSETS_FALLBACK_BUCKET
    storagePath = `${BOOK_ASSETS_BUCKET}/${filePath}`
    uploadResult = await supabase.storage
      .from(bucket)
      .upload(storagePath, imageBuffer, uploadOptions)
  }

  if (uploadResult.error) {
    throw new Error(
      `Failed to upload image asset ${blockId}: ${uploadResult.error.message}`
    )
  }

  return resolveUploadedImageAssetUrl(bucket, storagePath)
}

async function uploadImageAssetBuffer(bookId, blockId, imageBuffer) {
  let lastError = null

  for (let attempt = 0; attempt < BOOK_ASSET_UPLOAD_MAX_RETRIES; attempt += 1) {
    try {
      return await uploadImageAssetBufferOnce(bookId, blockId, imageBuffer)
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      const canRetry =
        attempt < BOOK_ASSET_UPLOAD_MAX_RETRIES - 1 &&
        isRetryableStorageError(message)

      if (!canRetry) {
        throw error
      }

      const delayMs = BOOK_ASSET_UPLOAD_RETRY_BASE_MS * 2 ** attempt
      console.warn(
        `[uploadBookAssets] Retrying ${blockId} in ${delayMs}ms (attempt ${attempt + 2}/${BOOK_ASSET_UPLOAD_MAX_RETRIES}): ${message}`
      )
      await sleep(delayMs)
    }
  }

  throw lastError ?? new Error(`Failed to upload image asset ${blockId}`)
}

async function uploadBookAssets(bookId, blocks, { onProgress } = {}) {
  if (!bookId) {
    throw new Error("uploadBookAssets requires a bookId")
  }

  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  const nextBlocks = [...blocks]
  const uploadableIndices = []

  for (let index = 0; index < nextBlocks.length; index += 1) {
    const block = nextBlocks[index]
    if (block?.type !== "image") {
      continue
    }

    if (block.src && !extractImageBase64Payload(block)) {
      continue
    }

    if (!extractImageBase64Payload(block)) {
      continue
    }

    uploadableIndices.push(index)
  }

  const totalImages = uploadableIndices.length
  let uploadedImages = 0
  let failedUploads = 0

  await runWithConcurrency(uploadableIndices, BOOK_ASSET_UPLOAD_CONCURRENCY, async (index, queueIndex) => {
    const block = nextBlocks[index]
    const blockId = block.id ?? `image-${index + 1}`
    let imageBuffer = base64PayloadToImageBuffer(extractImageBase64Payload(block))

    if (!imageBuffer || imageBuffer.length === 0) {
      console.warn("[uploadBookAssets]", {
        bookId,
        blockId,
        index,
        message: "Skipping image block with no uploadable binary data",
      })
      nextBlocks[index] = stripImageBinaryFields(block)
      return
    }

    if (queueIndex > 0) {
      await sleep(150 * (queueIndex % BOOK_ASSET_UPLOAD_CONCURRENCY))
    }

    let publicUrl
    try {
      publicUrl = await uploadImageAssetBuffer(bookId, blockId, imageBuffer)
    } catch (error) {
      failedUploads += 1
      console.error("[uploadBookAssets]", {
        bookId,
        blockId,
        message: error instanceof Error ? error.message : String(error),
      })
      nextBlocks[index] = stripImageBinaryFields(block)
      uploadedImages += 1
      onProgress?.({
        current: uploadedImages,
        total: totalImages,
      })
      return
    } finally {
      imageBuffer = null
      releaseImageBlockBinary(block)
    }

    nextBlocks[index] = {
      ...stripImageBinaryFields(block),
      id: blockId,
      src: publicUrl,
    }

    uploadedImages += 1
    onProgress?.({
      current: uploadedImages,
      total: totalImages,
    })
  })

  if (failedUploads > 0) {
    console.warn(
      `[uploadBookAssets] ${failedUploads}/${totalImages} illustration upload(s) failed after retries for book ${bookId}`
    )
  }

  for (let index = 0; index < nextBlocks.length; index += 1) {
    const block = nextBlocks[index]
    if (block?.type !== "image") {
      continue
    }

    if (block.buffer != null || block.imgData != null) {
      nextBlocks[index] = stripImageBinaryFields(block)
    }
  }

  return nextBlocks
}

async function readPdfInfo(pdf) {
  try {
    const metadata = await pdf.getMetadata()
    const metaInfo = metadata?.info ?? {}
    return {
      Title: sanitizePdfTitle(metaInfo.Title ?? ""),
      Author: sanitizePdfAuthor(metaInfo.Author ?? ""),
    }
  } catch {
    return { Title: "", Author: "" }
  }
}

function buildPdfPageLinesFromTextContent(textContent, headingStrings, pageIndex = -1) {
  const pageItems = []

  for (const item of textContent.items) {
    const str = (item.str ?? "").trim()
    if (!str) {
      continue
    }

    const fontSize = getItemFontSize(item)
    if (
      fontSize >= HEADING_STRING_MIN_FONT_SIZE &&
      !isScannerWatermarkLine(str) &&
      isCleanStructuralHeadingText(str, { fontSize })
    ) {
      headingStrings.add(str)
    }

    pageItems.push({
      str,
      x: getItemX(item),
      y: getItemY(item),
      width: Number.isFinite(item.width) ? Math.abs(item.width) : 0,
      fontSize,
      fontName: item.fontName ?? "",
      transform: item.transform,
    })
  }

  const rawLines = groupTextItemsIntoLines(pageItems, pageIndex)
  const repairedLines = repairSplitSmallCapsOpening(repairDropCapLines(rawLines))
  const medianX = medianValue(repairedLines.map((line) => line.x))

  for (const line of repairedLines) {
    line.indented = line.x > medianX + INDENT_THRESHOLD_PX
  }

  annotateLinesCentered(repairedLines)

  for (const line of repairedLines) {
    if (isSceneBreakOrnamentLine(line.text) && line.centered) {
      line.isSceneBreakOrnament = true
    }
  }

  return dropMarginCalloutLines(repairedLines, pageIndex)
}

async function buildPdfPageLines(page, headingStrings) {
  const textContent = await page.getTextContent()
  return buildPdfPageLinesFromTextContent(textContent, headingStrings)
}

async function loadPdfDocument(buffer) {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    wasmUrl: PDFJS_WASM_URL,
    standardFontDataUrl: PDFJS_STANDARD_FONT_URL,
  })
  return loadingTask.promise
}

const pdfDocumentAccessQueues = new WeakMap()

function withPdfDocumentAccessLock(pdf, task) {
  const previous = pdfDocumentAccessQueues.get(pdf) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(task)
  pdfDocumentAccessQueues.set(pdf, run)
  return run
}

async function withPdfPageOperationTimeout(operation, pageNumber, operationLabel) {
  let timeoutId
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              `${operationLabel} timed out on PDF page ${pageNumber} after ${PDF_PAGE_OPERATION_TIMEOUT_MS}ms`
            )
          )
        }, PDF_PAGE_OPERATION_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timeoutId)
  }
}

async function yieldToEventLoop() {
  await new Promise((resolve) => {
    setImmediate(resolve)
  })
}

async function runWithProgressPulse(intervalMs, onPulse, task) {
  const timer = setInterval(() => {
    try {
      onPulse()
    } catch {
      // ignore pulse errors
    }
  }, intervalMs)
  try {
    return await task()
  } finally {
    clearInterval(timer)
  }
}

async function extractAllPdfPages({
  pdf,
  totalPages,
  concurrency,
  extractSubphase,
  onPageProcessed,
  worker,
}) {
  const pageNumbers = Array.from({ length: totalPages }, (_, index) => index + 1)

  return runWithConcurrency(pageNumbers, concurrency, async (pageNumber) => {
    const operationLabel =
      extractSubphase === "images" ? "Artwork scan" : "Text extraction"

    try {
      const result = await withPdfPageOperationTimeout(
        () => worker(pageNumber),
        pageNumber,
        operationLabel
      )

      if (onPageProcessed) {
        onPageProcessed(pageNumber, totalPages, { extractSubphase })
      }

      await yieldToEventLoop()
      return { pageNumber, result }
    } catch (error) {
      console.warn(
        `[extract] ${operationLabel} failed on PDF page ${pageNumber}:`,
        error instanceof Error ? error.message : String(error)
      )

      if (onPageProcessed) {
        onPageProcessed(pageNumber, totalPages, { extractSubphase })
      }

      await yieldToEventLoop()
      return { pageNumber, result: extractSubphase === "images" ? [] : [] }
    }
  })
}

function extractPhasePercent(pageNumber, totalPages, extractSubphase = "text") {
  if (totalPages <= 0) {
    return 0
  }

  const fraction = pageNumber / totalPages

  if (extractSubphase === "images") {
    return Math.round(
      PARSE_PROGRESS_EXTRACT_MAX_PERCENT * EXTRACT_PROGRESS_TEXT_SHARE +
        fraction * PARSE_PROGRESS_EXTRACT_MAX_PERCENT * EXTRACT_PROGRESS_IMAGE_SHARE
    )
  }

  if (extractSubphase === "text_complete") {
    return Math.round(
      PARSE_PROGRESS_EXTRACT_MAX_PERCENT * EXTRACT_PROGRESS_TEXT_SHARE
    )
  }

  if (extractSubphase === "filtering") {
    return Math.round(
      PARSE_PROGRESS_EXTRACT_MAX_PERCENT *
        (0.97 + fraction * 0.03)
    )
  }

  return Math.round(
    fraction * PARSE_PROGRESS_EXTRACT_MAX_PERCENT * EXTRACT_PROGRESS_TEXT_SHARE
  )
}

async function extractPdfPageTextOnly(pdf, pageNumber, headingStrings) {
  return withPdfDocumentAccessLock(pdf, async () => {
    const page = await pdf.getPage(pageNumber)

    try {
      const textContent = await page.getTextContent()
      return buildPdfPageLinesFromTextContent(
        textContent,
        headingStrings,
        pageNumber - 1
      )
    } finally {
      if (typeof page.cleanup === "function") {
        page.cleanup()
      }
    }
  })
}

async function extractPdfPageImagesOnly(pdf, pageNumber) {
  return withPdfDocumentAccessLock(pdf, async () => {
    const page = await pdf.getPage(pageNumber)

    try {
      const operatorList = await page.getOperatorList({ intent: "display" })
      return extractPdfPageImageCandidatesFromOperatorList(
        page,
        pageNumber,
        operatorList,
        { resolveBuffers: false, pdf }
      )
    } finally {
      if (typeof page.cleanup === "function") {
        page.cleanup()
      }
    }
  })
}

const DECORATIVE_BACKGROUND_MIN_COVERAGE_RATIO = 0.92
const DECORATIVE_BACKGROUND_TEXT_HEAVY_CHARS = 120
const TEMPLATE_BACKGROUND_MIN_PAGES = 20
const TEMPLATE_BACKGROUND_PAGE_FRACTION = 0.85

function isNearFullPageImageCandidate(candidate) {
  const coords = candidate?.coordinates ?? {}
  const pageWidth = coords.pageWidth ?? 0
  const pageHeight = coords.pageHeight ?? 0
  const width = coords.width ?? 0
  const height = coords.height ?? 0

  if (!pageWidth || !pageHeight || !width || !height) {
    return false
  }

  return (
    width / pageWidth >= DECORATIVE_BACKGROUND_MIN_COVERAGE_RATIO &&
    height / pageHeight >= DECORATIVE_BACKGROUND_MIN_COVERAGE_RATIO
  )
}

function stripDecorativeImageCandidate(candidate) {
  return {
    ...candidate,
    imageRole: null,
    isCandidate: false,
    buffer: null,
  }
}

function filterDecorativePdfPageBackgrounds(pageImageCandidates, pagesBeforeFilter) {
  if (!Array.isArray(pageImageCandidates) || pageImageCandidates.length === 0) {
    return pageImageCandidates
  }

  const pageCharCounts = (pagesBeforeFilter ?? []).map((page) =>
    (page?.lines ?? []).reduce((sum, line) => sum + (line.text ?? "").length, 0)
  )

  let templateLikePages = 0
  let pagesWithActiveCandidates = 0

  for (let pageIndex = 0; pageIndex < pageImageCandidates.length; pageIndex += 1) {
    const candidates = pageImageCandidates[pageIndex]
    if (!Array.isArray(candidates)) {
      continue
    }

    const activeCandidates = candidates.filter(
      (candidate) => candidate?.isCandidate === true && candidate.imageRole != null
    )
    if (activeCandidates.length === 0) {
      continue
    }

    pagesWithActiveCandidates += 1
    if (
      activeCandidates.length === 1 &&
      isNearFullPageImageCandidate(activeCandidates[0])
    ) {
      templateLikePages += 1
    }
  }

  const isTemplateBackgroundPdf =
    pagesWithActiveCandidates >= TEMPLATE_BACKGROUND_MIN_PAGES &&
    templateLikePages / pagesWithActiveCandidates >= TEMPLATE_BACKGROUND_PAGE_FRACTION

  return pageImageCandidates.map((candidates, pageIndex) => {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return candidates
    }

    const pageChars = pageCharCounts[pageIndex] ?? 0
    const activeCandidates = candidates.filter(
      (candidate) => candidate?.isCandidate === true && candidate.imageRole != null
    )

    if (
      isTemplateBackgroundPdf &&
      activeCandidates.length === 1 &&
      isNearFullPageImageCandidate(activeCandidates[0])
    ) {
      return candidates.map((candidate) =>
        candidate?.isCandidate === true && candidate.imageRole != null
          ? stripDecorativeImageCandidate(candidate)
          : candidate
      )
    }

    return candidates.map((candidate) => {
      if (candidate?.isCandidate !== true || candidate.imageRole == null) {
        return candidate
      }

      if (
        pageChars >= DECORATIVE_BACKGROUND_TEXT_HEAVY_CHARS &&
        isNearFullPageImageCandidate(candidate)
      ) {
        return stripDecorativeImageCandidate(candidate)
      }

      return candidate
    })
  })
}

async function resolvePageImageCandidateBuffers(pdf, pageImageCandidates, onPageResolved) {
  if (!pdf || !Array.isArray(pageImageCandidates) || pageImageCandidates.length === 0) {
    return
  }

  const totalPages = pageImageCandidates.length
  let bufferPagesTotal = 0
  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    const candidates = pageImageCandidates[pageIndex]
    if (!Array.isArray(candidates) || candidates.length === 0) {
      continue
    }
    const needsBuffer = candidates.some(
      (candidate) =>
        candidate?.isCandidate === true &&
        candidate.imageRole != null &&
        !extractImageBlockPayload(candidate)
    )
    if (needsBuffer) {
      bufferPagesTotal += 1
    }
  }

  let bufferPagesDone = 0

  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    const pageNumber = pageIndex + 1
    const candidates = pageImageCandidates[pageIndex]
    if (!Array.isArray(candidates) || candidates.length === 0) {
      onPageResolved?.(pageNumber, totalPages, {
        imageBufferCurrent: bufferPagesDone,
        imageBufferTotal: bufferPagesTotal,
      })
      continue
    }

    const needsBuffer = candidates.some(
      (candidate) =>
        candidate?.isCandidate === true &&
        candidate.imageRole != null &&
        !extractImageBlockPayload(candidate)
    )

    if (!needsBuffer) {
      onPageResolved?.(pageNumber, totalPages, {
        imageBufferCurrent: bufferPagesDone,
        imageBufferTotal: bufferPagesTotal,
      })
      continue
    }

    bufferPagesDone += 1
    onPageResolved?.(pageNumber, totalPages, {
      imageBufferCurrent: bufferPagesDone,
      imageBufferTotal: bufferPagesTotal,
    })

    try {
      await runWithProgressPulse(
        3000,
        () => {
          onPageResolved?.(pageNumber, totalPages, {
            imageBufferCurrent: bufferPagesDone,
            imageBufferTotal: bufferPagesTotal,
            pulse: true,
          })
        },
        () =>
          withPdfPageOperationTimeout(
            () =>
              withPdfDocumentAccessLock(pdf, async () => {
                const page = await pdf.getPage(pageNumber)
                try {
                  const operatorList = await page.getOperatorList({ intent: "display" })
                  const resolved = await extractPdfPageImageCandidatesFromOperatorList(
                    page,
                    pageNumber,
                    operatorList,
                    { resolveBuffers: true, pdf }
                  )
                  const resolvedByStreamIndex = new Map(
                    resolved.map((candidate) => [candidate.streamIndex, candidate])
                  )

                  for (let index = 0; index < candidates.length; index += 1) {
                    const candidate = candidates[index]
                    const match = resolvedByStreamIndex.get(candidate.streamIndex)
                    if (match?.buffer) {
                      candidates[index] = { ...candidate, buffer: match.buffer }
                    }
                  }
                } finally {
                  if (typeof page.cleanup === "function") {
                    page.cleanup()
                  }
                }
              }),
            pageNumber,
            "Illustration buffer load"
          )
      )
    } catch (error) {
      console.warn(
        `[extract] Illustration buffer load failed on PDF page ${pageNumber}:`,
        error instanceof Error ? error.message : String(error)
      )
    }

    await yieldToEventLoop()
  }
}

async function extractPdfPageContent(pdf, pageNumber, headingStrings) {
  const page = await pdf.getPage(pageNumber)

  try {
    const [textContent, operatorList] = await Promise.all([
      page.getTextContent(),
      page.getOperatorList({ intent: "display" }),
    ])
    const lines = buildPdfPageLinesFromTextContent(textContent, headingStrings)
    const images = await extractPdfPageImageCandidatesFromOperatorList(
      page,
      pageNumber,
      operatorList
    )
    return { lines, images }
  } finally {
    if (typeof page.cleanup === "function") {
      page.cleanup()
    }
  }
}

async function extractPdfStructure(
  buffer,
  { onPageProcessed, onExtractReady, puaReplacementMap, pdf: pdfInput = null } = {}
) {
  const pdf = pdfInput ?? (await loadPdfDocument(buffer))
  const puaMap = puaReplacementMap ?? buildDefaultPuaReplacementMap(buffer)
  const headingStrings = new Set()
  const pdfInfo = await readPdfInfo(pdf)
  const totalPages = pdf.numPages

  if (onExtractReady) {
    onExtractReady(totalPages)
  }

  const pagesBeforeFilter = new Array(totalPages)
  const pageImageCandidates = new Array(totalPages)
  const byteLength = Buffer.isBuffer(buffer) ? buffer.length : buffer?.byteLength ?? 0
  const { text: textConcurrency, image: imageConcurrency } =
    resolvePdfExtractionConcurrency(totalPages, byteLength)

  try {
    const textResults = await extractAllPdfPages({
      pdf,
      totalPages,
      concurrency: textConcurrency,
      extractSubphase: "text",
      onPageProcessed,
      worker: (pageNumber) => extractPdfPageTextOnly(pdf, pageNumber, headingStrings),
    })

    for (const { pageNumber, result } of textResults) {
      pagesBeforeFilter[pageNumber - 1] = { lines: Array.isArray(result) ? result : [] }
    }

    if (onPageProcessed) {
      onPageProcessed(totalPages, totalPages, { extractSubphase: "text_complete" })
    }

    const imageResults = await extractAllPdfPages({
      pdf,
      totalPages,
      concurrency: imageConcurrency,
      extractSubphase: "images",
      onPageProcessed,
      worker: (pageNumber) => extractPdfPageImagesOnly(pdf, pageNumber),
    })

    for (const { pageNumber, result } of imageResults) {
      pageImageCandidates[pageNumber - 1] = Array.isArray(result) ? result : []
    }
  } finally {
    if (!pdfInput && typeof pdf.destroy === "function") {
      await pdf.destroy()
    }
  }

  if (onPageProcessed) {
    onPageProcessed(0, totalPages, { extractSubphase: "filtering" })
  }

  const lineDistinctPages = new Map()
  const lineOccurrencesPerPage = new Map()
  const lineFirstPageIndex = new Map()
  for (let pageIndex = 0; pageIndex < pagesBeforeFilter.length; pageIndex += 1) {
    for (const line of pagesBeforeFilter[pageIndex].lines) {
      if (!lineDistinctPages.has(line.text)) {
        lineDistinctPages.set(line.text, new Set())
        lineOccurrencesPerPage.set(line.text, new Map())
        lineFirstPageIndex.set(line.text, pageIndex)
      }
      lineDistinctPages.get(line.text).add(pageIndex)
      const pageCounts = lineOccurrencesPerPage.get(line.text)
      pageCounts.set(pageIndex, (pageCounts.get(pageIndex) ?? 0) + 1)
    }

    if (
      onPageProcessed &&
      (pageIndex % 10 === 0 || pageIndex === pagesBeforeFilter.length - 1)
    ) {
      onPageProcessed(pageIndex + 1, totalPages, { extractSubphase: "filtering" })
    }
  }

  const pageData = []

  for (let pageIndex = 0; pageIndex < pagesBeforeFilter.length; pageIndex += 1) {
    const page = pagesBeforeFilter[pageIndex]
    const lines = []

    for (const line of page.lines) {
      const distinctPageCount = lineDistinctPages.get(line.text)?.size ?? 0
      const occurrencesOnThisPage =
        lineOccurrencesPerPage.get(line.text)?.get(pageIndex) ?? 1
      const normalizedForDropCheck = translatePuaCharacters(line.text, puaMap).trim()

      if (bbMatchesPhrase(line.text) || bbMatchesPhrase(normalizedForDropCheck)) {
        const primaryDecision = explainShouldDropExtractedLine(
          line.text,
          distinctPageCount,
          occurrencesOnThisPage,
          Boolean(line.centered),
          pageIndex,
          lineFirstPageIndex,
          line.fontSize ?? 0
        )
        bbLog("shouldDropExtractedLine", {
          pageIndex,
          distinctPageCount,
          text: line.text,
          centered: Boolean(line.centered),
          occurrencesOnThisPage,
          drop: primaryDecision.drop,
          reason: primaryDecision.reason,
          collapsedRunningHeader: isCollapsedRunningHeaderLine(line.text),
        })
      }

      const preserveSaddlebackLayoutLine = isSaddlebackLayoutPreservationLine(
        line,
        page.lines
      )

      if (
        !preserveSaddlebackLayoutLine &&
        (shouldDropExtractedLine(
          line.text,
          distinctPageCount,
          occurrencesOnThisPage,
          Boolean(line.centered),
          pageIndex,
          lineFirstPageIndex,
          line.fontSize ?? 0
        ) ||
        (normalizedForDropCheck &&
          normalizedForDropCheck !== line.text.trim() &&
          shouldDropExtractedLine(
            normalizedForDropCheck,
            distinctPageCount,
            occurrencesOnThisPage,
            Boolean(line.centered),
            pageIndex,
            lineFirstPageIndex,
            line.fontSize ?? 0
          )) ||
        (isStandalonePageNumberText(normalizedForDropCheck) &&
          !preserveSaddlebackLayoutLine &&
          !isRomanPartOpenerLine(normalizedForDropCheck, {
            distinctPageCount,
            fontSize: line.fontSize ?? 0,
            centered: Boolean(line.centered),
          })))
      ) {
        if (bbMatchesPhrase(line.text)) {
          bbLog("extractPdfStructure-filter", {
            pageIndex,
            distinctPageCount,
            text: line.text,
            survived: false,
            stage: "shouldDropExtractedLine-or-page-number",
          })
        }
        continue
      }

      if (isAdjacentPageProseEcho(line.text, pageIndex, pagesBeforeFilter, line)) {
        if (bbMatchesPhrase(line.text)) {
          bbLog("extractPdfStructure-filter", {
            pageIndex,
            distinctPageCount,
            text: line.text,
            survived: false,
            stage: "adjacent-page-prose-echo",
          })
        }
        continue
      }

      if (isSceneBreakOrnamentLine(line.text) && !line.centered) {
        if (bbMatchesPhrase(line.text)) {
          bbLog("extractPdfStructure-filter", {
            pageIndex,
            distinctPageCount,
            text: line.text,
            survived: false,
            stage: "scene-break-not-centered",
          })
        }
        continue
      }

      if (bbMatchesPhrase(line.text)) {
        bbLog("extractPdfStructure-filter", {
          pageIndex,
          distinctPageCount,
          text: line.text,
          survived: true,
          stage: "into-pageData",
        })
      }

      const cleanedText = normalizeExtractedText(line.text, {
        puaReplacementMap: puaMap,
        isLine: true,
      })

      const isSceneBreak = Boolean(line.isSceneBreakOrnament)
      const outputText = isSceneBreak
        ? SCENE_BREAK_DIVIDER_TEXT.trim()
        : cleanedText

      if (!outputText) {
        continue
      }

      lines.push({
        text: outputText,
        indented: Boolean(line.indented),
        centered: Boolean(line.centered) || isSceneBreak,
        fontSize: line.fontSize,
        y: line.y,
        runs: line.runs ?? [],
      })
    }

    pageData.push({ lines })
  }

  const filteredPageImageCandidates = filterDecorativePdfPageBackgrounds(
    pageImageCandidates,
    pagesBeforeFilter
  )

  return {
    pageData,
    headingStrings,
    numPages: pdf.numPages,
    pdfInfo,
    pageImageCandidates: filteredPageImageCandidates,
  }
}

async function extractLinesByPosition(buffer, options = {}) {
  const { pageData } = await extractPdfStructure(buffer, options)
  return pageData
}

function isStandaloneChapterNumber(text, block) {
  const trimmed = (text ?? "").trim()
  const roman = parseValidStandaloneRomanNumeral(trimmed)
  if (roman) {
    if (block?.isChapterStart) {
      return true
    }
    if (!block?.isHeading) {
      return false
    }
    if (roman.length >= 2) {
      return (block.fontSize ?? 0) >= CHAPTER_HEADING_MIN_FONT_SIZE
    }
    return (block.fontSize ?? 0) >= 14
  }

  const chapterNumberRegex =
    /^(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\.?$/i
  if (!chapterNumberRegex.test(trimmed)) {
    return false
  }
  if (block?.isChapterStart) {
    return true
  }
  if (!block?.isHeading) {
    return false
  }
  return (block.fontSize ?? 0) >= CHAPTER_HEADING_MIN_FONT_SIZE
}

function qualifiesAsEmittedHeading(text, { fontSize = 0 } = {}) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }

  if (/^[a-z(\u201c]/.test(trimmed)) {
    return false
  }

  const roman = parseValidStandaloneRomanNumeral(trimmed)
  if (roman) {
    if (roman.length >= 2) {
      return fontSize >= CHAPTER_HEADING_MIN_FONT_SIZE
    }
    return fontSize >= 14
  }

  const core = trimmed.replace(/[.!?]+$/, "")
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length
  if (
    wordCount === 1 &&
    core.length < 6 &&
    !CHAPTER_PATTERN.test(trimmed) &&
    !STRUCTURAL_HEADING_PREFIX_REGEX.test(trimmed)
  ) {
    if (
      fontSize >= HEADING_STRING_MIN_FONT_SIZE &&
      /^[A-Z]+$/.test(core)
    ) {
      return true
    }
    return false
  }

  return true
}

function logHeadingPromotion(text, reasonLabel) {
  if (process.env.BOOKY_HEADING_DEBUG === "1") {
    console.log("[heading]", JSON.stringify(text), "via", reasonLabel)
  }
}

function pushHeadingBlock(blocks, payload, reasonLabel, pageIndex, line = null) {
  const text = (payload.text ?? "").trim()
  if (!qualifiesAsEmittedHeading(text, { fontSize: payload.fontSize ?? 0 })) {
    return false
  }

  const headingPayload = { ...payload }
  if (line?.centered && !isShortDialogueLine(text)) {
    headingPayload.textAlign = "center"
    headingPayload.centered = true
  }

  logHeadingPromotion(text, reasonLabel)
  blocks.push(withSourcePdfPage(headingPayload, pageIndex))
  return true
}

function isLikelyChapterNumberLine(text, line) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }

  // Wrapped title fragments (e.g. "three." from "Chapter Forty-three.") are not headings.
  if (/^[a-z]/.test(trimmed)) {
    return false
  }

  const roman = parseValidStandaloneRomanNumeral(trimmed)
  if (roman) {
    if (roman.length >= 2) {
      return (line.fontSize ?? 0) >= CHAPTER_HEADING_MIN_FONT_SIZE
    }
    return (line.fontSize ?? 0) >= 14
  }

  const core = trimmed.replace(/[.!?]+$/, "")
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length
  if (
    wordCount === 1 &&
    core.length < 6 &&
    !CHAPTER_PATTERN.test(trimmed) &&
    !STRUCTURAL_HEADING_PREFIX_REGEX.test(trimmed)
  ) {
    return false
  }

  const chapterNumberRegex =
    /^(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\.?$/i
  if (!chapterNumberRegex.test(trimmed)) {
    return false
  }
  return (line.fontSize ?? 0) >= CHAPTER_HEADING_MIN_FONT_SIZE
}

function isOrphanChapterSubtitleFragment(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (/^(chapter|letter)\s+/i.test(trimmed)) {
    return false
  }
  if (CHAPTER_WITH_SUBTITLE_REGEX.test(trimmed) || parseChapterOnlyHeading(trimmed)) {
    return false
  }
  if (isAllCapsChapterSubtitleText(trimmed)) {
    return false
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 5 || trimmed.length > 160) {
    return false
  }

  return (
    /^[A-Z][a-z]/.test(trimmed) &&
    !isNarrativeSentenceLine(trimmed) &&
    /\b(?:Concerning|Treats|Containing|Comprising|Relates|Particulars|Mingles|Goaded|Walks|Becomes|Involves|Introduces|Affording|Monks)\b/i.test(
      trimmed
    )
  )
}

function isChapterHeading(block) {
  if (block?.type === "image" || typeof block?.text !== "string") {
    return false
  }

  // Poem titles in a poetry collection are explicit chapter starts; their
  // mixed-case wording would not match any prose heading pattern below.
  if (block?.isPoemTitle === true) {
    return true
  }

  // Verse lines are never headings even when their wording happens to match a
  // structural pattern - e.g. a printed-contents "PART ONE" running label, or a
  // poem line that opens with a chapter-like word - so they cannot leak into the
  // table of contents.
  if (block?.isVerse === true) {
    return false
  }

  const text = block.text.trim()

  if (isOrphanChapterSubtitleFragment(text)) {
    return false
  }

  if (/^Prelude to the Stormlight Archive$/i.test(text)) {
    return true
  }
  if (/^Prologue:\s+/i.test(text)) {
    return true
  }
  if (/^Epilogue:\s+/i.test(text)) {
    return true
  }

  if (CHAPTER_WITH_SUBTITLE_REGEX.test(text)) {
    return true
  }

  if (PART_HEADING_PATTERN.test(normalizeHeadingCandidate(text))) {
    return true
  }

  if (isCleanStructuralHeadingText(text, { fontSize: block.fontSize ?? 0 })) {
    return true
  }

  if (
    isStormlightPrintedTocLine(text) ||
    isIllustrationsListEntryLine(text) ||
    isBibliographySeriesTitleLine(text) ||
    isTitlePageBookLabelLine(text)
  ) {
    return false
  }

  const blocklist = ["and", "or", "but", "the", "a", "an", "to", "by", "and."]
  if (blocklist.includes(text.toLowerCase())) {
    return false
  }

  if (/^To\s+[A-Z]/.test(text)) return false
  if (/^(by|written by|translated by)\s+/i.test(text)) return false

  if (/^[A-Z][a-z]+\s+[A-Z][a-z]+,\s+(Writer|Author|Novelist)$/.test(text)) {
    return true
  }

  if (isStandaloneChapterNumber(text, block)) return true

  if (isFableStoryTitleBlock(block)) {
    return true
  }

  if (block?.storyChapterNumber != null && block?.isChapterStart) {
    return true
  }

  return false
}

function contentHasChapterHeadings(content) {
  for (const page of content) {
    for (const block of page.blocks ?? []) {
      if (isChapterHeading(block)) {
        return true
      }
    }
  }
  return false
}

const CHAPTER_ONLY_HEADING_REGEX = new RegExp(
  `^(chapter|letter)\\s+(\\d{1,3}|[ivxlcdm]+|${CHAPTER_WORD_NUMBERS})\\.?\\s*$`,
  "i"
)

const CHAPTER_WITH_SUBTITLE_REGEX = new RegExp(
  `^(chapter|letter)\\s+(\\d{1,3}|[ivxlcdm]+|${CHAPTER_WORD_NUMBERS})\\s*-\\s+\\S`,
  "i"
)

function formatChapterLabel(kind, number, subtitle = "") {
  const label = kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase()
  const base = `${label} ${number}`
  const trimmedSubtitle = (subtitle ?? "").trim().replace(/\.+\s*$/, "")
  if (trimmedSubtitle) {
    return `${base} - ${trimmedSubtitle}`
  }
  return base
}

function parseChapterOnlyHeading(text) {
  const trimmed = (text ?? "").trim()
  const match = trimmed.match(CHAPTER_ONLY_HEADING_REGEX)
  if (!match) {
    return null
  }
  return { kind: match[1], number: match[2] }
}

const CHAPTER_SUBTITLE_MINOR_WORDS = new Set([
  ...BOOK_TITLE_MINOR_WORDS,
  "de",
  "du",
  "des",
  "la",
  "le",
  "les",
  "van",
  "von",
  "der",
  "den",
  "di",
  "da",
  "el",
  "al",
  "del",
  "della",
  "that",
  "which",
  "who",
  "whom",
  "whose",
  "where",
  "when",
  "while",
])

const CHAPTER_SUBTITLE_APOSTROPHE_REGEX = /['\u2018\u2019\u201a\u02bc`]/g

function isChapterSubtitleWord(word) {
  const trimmed = (word ?? "").trim()
  if (!trimmed) {
    return false
  }
  const lower = trimmed.toLowerCase().replace(CHAPTER_SUBTITLE_APOSTROPHE_REGEX, "")
  if (CHAPTER_SUBTITLE_MINOR_WORDS.has(lower)) {
    return true
  }
  if (/^M\.?$/i.test(trimmed)) {
    return true
  }
  if (/^[dl]['\u2018\u2019]?\p{Lu}[\p{L}\p{M}]*/u.test(trimmed)) {
    return true
  }
  if (/^[A-Z]{2,}$/.test(trimmed)) {
    return true
  }
  if (/^[\p{Lu}][\p{Ll}\p{M}]*/u.test(trimmed)) {
    return true
  }
  if (/^[A-Z\d]/.test(trimmed)) {
    return true
  }
  return /^[—–-]$/.test(trimmed)
}

function isLikelyChapterSubtitleText(text, options = {}) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (CHAPTER_PATTERN.test(trimmed) || CHAPTER_ONLY_HEADING_REGEX.test(trimmed)) {
    return false
  }
  if (CHAPTER_WITH_SUBTITLE_REGEX.test(trimmed)) {
    return false
  }
  // See isAllCapsChapterSubtitleText: chapter-only collector may pass
  // allowAuthorLikeOpening so "By Caldron Pool"-shaped subtitles are not
  // rejected as bylines. Global isAuthorStructuralLine is unchanged.
  if (
    isScannerWatermarkLine(trimmed) ||
    (!options.allowAuthorLikeOpening && isAuthorStructuralLine(trimmed))
  ) {
    return false
  }
  if (/^["'\u201c]/.test(trimmed)) {
    return false
  }
  if (/^[a-z]/.test(trimmed) && !/^e\.?\s/i.test(trimmed)) {
    return false
  }
  if (isHeadingIncompleteEnding(trimmed)) {
    return false
  }
  if (/^by\s+(?:this|the|now|then|that|which|whom)\b/i.test(trimmed)) {
    return false
  }
  if (trimmed.length > 72) {
    return false
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 1 || words.length > 14) {
    return false
  }
  if ((trimmed.match(/[.!?]/g) ?? []).length > 1) {
    return false
  }
  if (trimmed.length > 45 && /,\s/.test(trimmed)) {
    return false
  }
  if (/;\s/.test(trimmed)) {
    return false
  }

  if (!words.every(isChapterSubtitleWord)) {
    return false
  }

  return words.length <= 14 && trimmed.length <= 80
}

function isLikelyChapterSubtitleBlock(block) {
  const text = (block?.text ?? "").trim()
  if (!text) {
    return false
  }
  if (block?.isHeading && !isLikelyChapterSubtitleText(text)) {
    return false
  }
  return isLikelyChapterSubtitleText(text)
}

function looksLikeChapterOpeningProse(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length < 12) {
    return false
  }
  if (/^["'\u201c]/.test(trimmed)) {
    return true
  }
  if (/^(I|My|We|He|She|They|It|You)\s+/i.test(trimmed)) {
    return true
  }
  if (isNarrativeSentenceLine(trimmed)) {
    return true
  }
  return false
}

function normalizeChapterSubtitleForMatch(text) {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/['\u2018\u2019]/g, "'")
}

function looksLikeFollowOnChapterBody(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
  }
  if (looksLikeChapterOpeningProse(trimmed)) {
    return true
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 4) {
    return false
  }
  if (/^[a-z]/.test(trimmed) && !/^e\.?\s/i.test(trimmed)) {
    return true
  }
  if (/^[A-Z]/.test(trimmed) && /[a-z]/.test(trimmed)) {
    return true
  }

  return false
}

function splitEmbeddedSubtitleUsingPrintedToc(text, tocSubtitle) {
  const trimmed = (text ?? "").trim()
  const tocWords = (tocSubtitle ?? "").trim().split(/\s+/).filter(Boolean)
  if (!trimmed || tocWords.length === 0) {
    return null
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length <= tocWords.length) {
    return null
  }

  const prefix = words.slice(0, tocWords.length).join(" ")
  if (
    normalizeChapterSubtitleForMatch(prefix) !==
    normalizeChapterSubtitleForMatch(tocSubtitle)
  ) {
    return null
  }

  const prose = words.slice(tocWords.length).join(" ")
  if (!looksLikeFollowOnChapterBody(prose)) {
    return null
  }

  return {
    subtitle: formatChapterSubtitleText(tocSubtitle),
    prose,
  }
}

const EMBEDDED_SUBTITLE_INTERIOR_REJECT_WORDS = new Set([
  "who",
  "which",
  "that",
  "when",
  "where",
  "if",
  "had",
  "was",
  "were",
  "is",
  "are",
  "has",
  "have",
  "been",
  "being",
  "could",
  "would",
  "should",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "upon",
  "into",
  "onto",
  "over",
  "under",
  "after",
  "before",
  "because",
  "although",
  "while",
  "until",
  "unless",
  "since",
])

function isEmbeddedSubtitlePrefixValid(subtitle, { tocSubtitle = null } = {}) {
  const trimmed = (subtitle ?? "").trim()
  if (!trimmed) {
    return false
  }

  if (
    tocSubtitle &&
    normalizeChapterSubtitleForMatch(trimmed) ===
      normalizeChapterSubtitleForMatch(tocSubtitle)
  ) {
    return true
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length >= 2) {
    for (let wordIndex = 1; wordIndex < words.length; wordIndex += 1) {
      const lower = words[wordIndex].toLowerCase().replace(/[^a-z]/g, "")
      if (EMBEDDED_SUBTITLE_INTERIOR_REJECT_WORDS.has(lower)) {
        return false
      }
    }
    return true
  }

  return false
}

// Recover a chapter subtitle that a drop cap has fused to the body on a single
// extracted line. Some editions (e.g. Oliver Twist) have no printed TOC and set
// the subtitle as an inline all-caps line; normally that line stays dedicated,
// but when the body's drop-capped first letter is rendered ahead of the all-caps
// subtitle and the lowercase remainder of the body is glued onto its tail, the
// whole thing arrives as one mixed-case block, e.g.
//   "T" + "A STRANGE INTERVIEW, WHICH IS A SEQUEL TO THE LAST CHAPTER"
//       + "he girl's life had been squandered ..."
// The all-caps run is the subtitle; the body is the drop cap plus the lowercase
// remainder. The lowercase boundary is the discriminating signal: ordinary body
// prose never begins lowercase, so this only fires on the drop-cap fusion and
// cannot misread a normal capitalized sentence as a title. There is no length
// cap here, so Oliver Twist's unusually long titles are preserved in full.
function extractDropCapFusedSubtitle(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return null
  }

  const match = trimmed.match(/^([A-Z])([A-Z][A-Z'’.,\- ]*[A-Z])\s+([a-z].*)$/)
  if (!match) {
    return null
  }

  const dropCap = match[1]
  const capsRun = match[2].replace(/\s+/g, " ").trim()
  const bodyTail = match[3].trim()

  const subtitleWords = capsRun.split(/\s+/).filter(Boolean)
  if (subtitleWords.length < 3) {
    return null
  }
  if (bodyTail.length < 12) {
    return null
  }

  const subtitle = formatChapterSubtitleText(capsRun)
  if (!subtitle) {
    return null
  }

  return {
    subtitle,
    prose: `${dropCap}${bodyTail}`,
  }
}

function extractEmbeddedChapterSubtitle(text, { tocSubtitle = null } = {}) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return null
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 3) {
    return null
  }

  if (tocSubtitle) {
    const tocSplit = splitEmbeddedSubtitleUsingPrintedToc(trimmed, tocSubtitle)
    if (tocSplit) {
      return tocSplit
    }
  }

  const tocKey = tocSubtitle ? normalizeChapterSubtitleForMatch(tocSubtitle) : null
  let best = null
  const maxEnd = Math.min(14, words.length - 1)

  for (let end = maxEnd; end >= 1; end -= 1) {
    const subtitle = words.slice(0, end).join(" ")
    const prose = words.slice(end).join(" ")
    if (!isLikelyChapterSubtitleText(subtitle)) {
      continue
    }
    if (!isEmbeddedSubtitlePrefixValid(subtitle, { tocSubtitle })) {
      continue
    }
    if (!looksLikeFollowOnChapterBody(prose)) {
      continue
    }

    const candidate = {
      subtitle: formatChapterSubtitleText(subtitle),
      prose,
    }

    if (tocKey && normalizeChapterSubtitleForMatch(candidate.subtitle) === tocKey) {
      return candidate
    }

    if (!best) {
      best = candidate
    }
  }

  return best
}

function chapterHeadingAlreadyHasSubtitle(text) {
  return /\s-\s\S/.test((text ?? "").trim())
}

function supplementBannerlessPrintedChapters(blocks, printedToc) {
  if (!printedToc?.chapters?.size || !Array.isArray(blocks)) {
    return blocks
  }

  return blocks.map((block) => {
    if (!block?.isHeading || !block?.isChapterStart) {
      return block
    }

    const text = (block.text ?? "").trim()
    if (chapterHeadingAlreadyHasSubtitle(text)) {
      return block
    }

    const parts = parseChapterOnlyHeading(text)
    if (!parts) {
      return block
    }

    const tocTitle = lookupPrintedTocTitle(printedToc, {
      number: parts.number,
      boundaryKind: "chapter",
    })
    if (!shouldUsePrintedTocChapterSubtitle(tocTitle, parts)) {
      return block
    }

    const displayTitle = formatChapterLabel(parts.kind, parts.number, tocTitle)
    return {
      ...block,
      text: displayTitle,
      chapterTitle: displayTitle,
      fontSize: CHAPTER_DISPLAY_FONT_SIZE,
    }
  })
}

// The Way of Kings prints each "Part <N>" text label on the interlude-divider
// spread at the END of that part (source pages 189/485/788 carry only the text
// "Part One"/"Part Two"/"Part Three"), while the real part-opener plates before
// chapters 1/12/29 are pure art with no text layer. Anchoring the label where
// the text physically sits therefore places every part marker one full section
// late - right before the interludes that follow its own chapters. Re-anchor
// each late part heading block to sit immediately before its part's first
// chapter banner, using the printed-TOC structure (a part slot is immediately
// followed by its first chapter slot) as the source of truth for where the
// part begins. The move only fires when the heading sits AFTER its target
// banner, so books whose part headings already precede their first chapter
// are untouched, and parts with no text heading at all (WoK Parts Four/Five)
// have nothing to move and stay absent.
function reanchorLatePartHeadingBlocks(blocks, printedToc) {
  const ordered = printedToc?.ordered
  if (
    !Array.isArray(blocks) ||
    blocks.length === 0 ||
    !Array.isArray(ordered) ||
    ordered.length === 0
  ) {
    return blocks
  }

  const firstChapterKeyByPartValue = new Map()
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index]?.kind !== "part") {
      continue
    }
    const partValue = resolvePartOrdinalValue(ordered[index].key)
    if (partValue == null || firstChapterKeyByPartValue.has(partValue)) {
      continue
    }
    for (let scan = index + 1; scan < ordered.length; scan += 1) {
      const candidate = ordered[scan]
      if (candidate?.kind === "part") {
        break
      }
      if (candidate?.kind === "chapter") {
        firstChapterKeyByPartValue.set(partValue, String(candidate.key))
        break
      }
    }
  }
  if (firstChapterKeyByPartValue.size === 0) {
    return blocks
  }

  const result = [...blocks]

  for (const [partValue, chapterKey] of firstChapterKeyByPartValue) {
    const headingIndex = result.findIndex((block) => {
      if (
        !block?.isHeading ||
        !block?.isChapterStart ||
        block?.type === "image" ||
        block?.type === "image_candidate"
      ) {
        return false
      }
      const match = (block.text ?? "").trim().match(/^part\s+([a-z0-9]+)\.?$/i)
      return match ? resolvePartOrdinalValue(match[1]) === partValue : false
    })
    if (headingIndex < 0) {
      continue
    }

    const bannerIndex = result.findIndex(
      (block) =>
        (block?.type === "image" || block?.type === "image_candidate") &&
        block?.isChapterBoundary &&
        block?.chapterMetadata?.boundaryKind === "chapter" &&
        extractChapterKeyFromOcrNumber(block.chapterMetadata?.number) === chapterKey
    )
    if (bannerIndex < 0 || headingIndex <= bannerIndex) {
      continue
    }

    const [headingBlock] = result.splice(headingIndex, 1)
    result.splice(bannerIndex, 0, headingBlock)

    if (BOOKY_TOC_ORDER_DEBUG) {
      console.log(
        "[partReanchor]",
        JSON.stringify({
          part: partValue,
          firstChapter: chapterKey,
          fromBlockIndex: headingIndex,
          toBlockIndex: bannerIndex,
        })
      )
    }
  }

  return result
}

function mergeChapterSubtitleBlocks(blocks, printedToc = null) {
  const merged = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const text = (block.text ?? "").trim()
    const parts = block.isHeading ? parseChapterOnlyHeading(text) : null

    if (parts && index + 1 < blocks.length) {
      const isChapterOnly = isChapterOnlyHeadingText(text)
      const tocSubtitle = printedToc
        ? lookupPrintedTocTitle(printedToc, {
            number: parts.number,
            boundaryKind: "chapter",
          })
        : null

      if (isChapterOnly) {
        if (tocSubtitle && shouldUsePrintedTocChapterSubtitle(tocSubtitle, parts)) {
          const displayTitle = formatChapterLabel(parts.kind, parts.number, tocSubtitle)
          merged.push({
            ...block,
            text: displayTitle,
            chapterTitle: displayTitle,
            fontSize: CHAPTER_DISPLAY_FONT_SIZE,
            isHeading: true,
            isChapterStart: true,
          })

          // The body often re-renders the same subtitle right after the bare
          // chapter number. Now that the heading carries the printed-TOC
          // subtitle, consume that redundant copy so it is not duplicated by a
          // later trailing-fragment merge or shown twice in the reading view.
          //
          // Case 1: the title is its own block (or split across blocks), so the
          // following block(s) are fragments of the subtitle. Drop them, but only
          // once the full subtitle has appeared - prose is never a substring of
          // the subtitle, so real body text stays untouched.
          const tocKey = normalizeChapterSubtitleForMatch(tocSubtitle)
          let cursor = index + 1
          let sawFullSubtitle = false
          while (cursor < blocks.length) {
            const candidate = blocks[cursor]
            const candidateText = (candidate?.text ?? "").trim()
            if (!candidateText || candidate?.isChapterStart) {
              break
            }
            const candidateKey = normalizeChapterSubtitleForMatch(candidateText)
            if (!candidateKey || !tocKey.includes(candidateKey)) {
              break
            }
            if (candidateKey === tocKey) {
              sawFullSubtitle = true
            }
            cursor += 1
          }
          if (sawFullSubtitle) {
            index = cursor - 1
            continue
          }

          // Case 2: the title is glued to the front of the first prose block.
          // Split it off only when the prefix exactly matches the printed-TOC
          // subtitle, so prose for chapters whose title was dropped is untouched.
          const followingBlock = blocks[index + 1]
          const glued = followingBlock?.isHeading
            ? null
            : splitEmbeddedSubtitleUsingPrintedToc(followingBlock?.text, tocSubtitle)
          if (glued) {
            merged.push({
              ...followingBlock,
              text: glued.prose,
              isHeading: false,
              isChapterStart: false,
            })
            index += 1
          }
          continue
        } else {
          // No usable printed-TOC subtitle. Editions without a printed TOC (e.g.
          // Oliver Twist) render the subtitle inline; when a drop cap fuses it to
          // the body on one extracted line, the bare "Chapter N" would otherwise
          // lose its title. Recover it by splitting at the drop-cap boundary.
          const followingBlock = blocks[index + 1]
          const fused =
            followingBlock && !followingBlock.isHeading
              ? extractDropCapFusedSubtitle(followingBlock.text)
              : null
          if (fused) {
            const displayTitle = formatChapterLabel(
              parts.kind,
              parts.number,
              fused.subtitle
            )
            merged.push({
              ...block,
              text: displayTitle,
              chapterTitle: displayTitle,
              fontSize: CHAPTER_DISPLAY_FONT_SIZE,
              isHeading: true,
              isChapterStart: true,
            })
            merged.push({
              ...followingBlock,
              text: fused.prose,
              isHeading: false,
              isChapterStart: false,
            })
            index += 1
            continue
          }

          const displayTitle = formatChapterLabel(parts.kind, parts.number, "")
          merged.push({
            ...block,
            text: displayTitle,
            chapterTitle: displayTitle,
          })
        }
        continue
      }

      const nextBlock = blocks[index + 1]

      if (tocSubtitle && shouldUsePrintedTocChapterSubtitle(tocSubtitle, parts)) {
        const embeddedSubtitle = extractEmbeddedChapterSubtitle(nextBlock?.text, {
          tocSubtitle,
        })
        if (embeddedSubtitle && !nextBlock?.isHeading) {
          const displayTitle = formatChapterLabel(
            parts.kind,
            parts.number,
            embeddedSubtitle.subtitle
          )
          merged.push({
            ...block,
            text: displayTitle,
            chapterTitle: displayTitle,
            fontSize: CHAPTER_DISPLAY_FONT_SIZE,
            isHeading: true,
            isChapterStart: true,
          })
          merged.push({
            ...nextBlock,
            text: embeddedSubtitle.prose,
            isHeading: false,
            isChapterStart: false,
          })
          index += 1
          continue
        }
      }

      const subtitleParts = []
      let cursor = index + 1

      while (cursor < blocks.length) {
        const candidate = blocks[cursor]
        if (!isDedicatedChapterSubtitleBlock(candidate)) {
          break
        }

        subtitleParts.push((candidate?.text ?? "").trim())
        cursor += 1
      }

      if (subtitleParts.length > 0) {
        const subtitle = subtitleParts.join(" ")
        if (!isDropCapChapterSubtitleArtifact(subtitle)) {
          const displayTitle = formatChapterLabel(
            parts.kind,
            parts.number,
            subtitle
          )
          merged.push({
            ...block,
            text: displayTitle,
            chapterTitle: displayTitle,
            fontSize: CHAPTER_DISPLAY_FONT_SIZE,
            isHeading: true,
            isChapterStart: true,
          })
          index = cursor - 1
          continue
        }
      }

      if (process.env.BOOKY_SUBTITLE_DEBUG === "1") {
        console.log(
          "[subtitleMiss]",
          JSON.stringify({
            heading: text,
            next1: (blocks[index + 1]?.text ?? "").slice(0, 120),
            next1IsHeading: Boolean(blocks[index + 1]?.isHeading),
            next2: (blocks[index + 2]?.text ?? "").slice(0, 120),
          })
        )
      }

      const displayTitle = formatChapterLabel(parts.kind, parts.number, "")
      merged.push({
        ...block,
        text: displayTitle,
        chapterTitle: displayTitle,
      })
      continue
    }

    merged.push(block)
  }

  return merged
}

function isLikelyPartSubtitleLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > 72) {
    return false
  }
  if (resolvePartHeadingLabel(trimmed) || parseChapterOnlyHeading(trimmed)) {
    return false
  }
  if (CHAPTER_WITH_SUBTITLE_REGEX.test(trimmed) || CHAPTER_PATTERN.test(trimmed)) {
    return false
  }
  if (isNarrativeSentenceLine(trimmed) || isScannerWatermarkLine(trimmed)) {
    return false
  }
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 1 || words.length > 8) {
    return false
  }
  if (/[.!?]/.test(trimmed)) {
    return false
  }
  if (!/^[A-Z"'\u201c]/.test(trimmed)) {
    return false
  }
  return isLikelyChapterSubtitleText(trimmed) || isDisplayChapterTitleText(trimmed)
}

function splitEmbeddedPartHeadings(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  const result = []

  for (const block of blocks) {
    if (
      block?.type === "image" ||
      block?.type === "image_candidate" ||
      block?.isHeading
    ) {
      result.push(block)
      continue
    }

    const text = (block?.text ?? "").trim()
    const embeddedMatch = text.match(EMBEDDED_PART_WITH_SUBTITLE_REGEX)
    if (!embeddedMatch || embeddedMatch.index == null) {
      result.push(block)
      continue
    }

    const before = text.slice(0, embeddedMatch.index).trim()
    const partLabel = formatPartHeadingLabel(embeddedMatch[1])
    const subtitle = (embeddedMatch[2] ?? "").trim()

    if (before) {
      result.push({
        ...block,
        text: before,
        textAlign: undefined,
        centered: undefined,
      })
    }

    result.push({
      ...block,
      text: partLabel,
      chapterTitle: subtitle ? `${partLabel} — ${subtitle}` : partLabel,
      isHeading: true,
      isChapterStart: true,
      fontSize: CHAPTER_DISPLAY_FONT_SIZE,
      textAlign: "center",
    })
  }

  return result
}

function mergePartHeadingBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  const merged = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const text = (block?.text ?? "").trim()
    const partLabel = resolvePartHeadingLabel(text)

    if (!partLabel) {
      merged.push(block)
      continue
    }

    let cursor = index + 1
    let subtitle = null

    while (cursor < blocks.length) {
      const candidate = blocks[cursor]
      const candidateText = (candidate?.text ?? "").trim()
      if (!candidateText) {
        break
      }
      if (resolvePartHeadingLabel(candidateText)) {
        break
      }
      if (
        parseChapterOnlyHeading(candidateText) ||
        CHAPTER_WITH_SUBTITLE_REGEX.test(candidateText)
      ) {
        break
      }
      if (isLikelyPartSubtitleLine(candidateText)) {
        subtitle = subtitle ? `${subtitle} ${candidateText}` : candidateText
        cursor += 1
        continue
      }
      break
    }

    merged.push({
      ...block,
      text: partLabel,
      chapterTitle: subtitle ? `${partLabel} — ${subtitle}` : partLabel,
      isHeading: true,
      isChapterStart: true,
      fontSize: CHAPTER_DISPLAY_FONT_SIZE,
      textAlign: block.textAlign === "center" || block.centered ? "center" : block.textAlign,
    })
    index = cursor - 1
  }

  return merged
}

function normalizeTitleComparisonKey(text) {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim()
}

function dedupeFrontMatterTitleBlocks(blocks, bookTitle, { scanLimit } = {}) {
  const bookKey = normalizeTitleComparisonKey(bookTitle)
  if (!bookKey) {
    return blocks
  }

  const windowEnd = Number.isFinite(scanLimit) ? Math.min(20, scanLimit) : 20
  let keptTitleBlock = false

  return blocks.filter((block, index) => {
    if (index >= windowEnd) {
      return true
    }

    const blockKey = normalizeTitleComparisonKey(block.text)
    if (!blockKey || blockKey.length < 4) {
      return true
    }

    const matchesBook =
      blockKey === bookKey ||
      blockKey.includes(bookKey) ||
      bookKey.includes(blockKey)

    if (!matchesBook) {
      return true
    }

    if (CHAPTER_PATTERN.test((block.text ?? "").trim())) {
      return true
    }

    if (!keptTitleBlock && block.isHeading) {
      keptTitleBlock = true
      return true
    }

    if (index < 12 && !block.isHeading) {
      return false
    }

    return true
  })
}

function flattenContentBlocks(content) {
  const flat = []

  for (const page of content ?? []) {
    for (const block of page.blocks ?? []) {
      flat.push(block)
    }
  }

  return flat
}

function isOrphanTextPartHeading(block, flatBlocks, flatIndex) {
  const text = (block?.text ?? "").trim()
  if (!PART_HEADING_PATTERN.test(text)) {
    return false
  }

  for (
    let index = flatIndex + 1;
    index < Math.min(flatIndex + 24, flatBlocks.length);
    index += 1
  ) {
    const candidate = flatBlocks[index]
    if (candidate?.type !== "image" || !candidate.isChapterBoundary) {
      continue
    }

    const kind = candidate.chapterMetadata?.boundaryKind
    if (kind === "part" || kind === "interlude_divider") {
      return true
    }
  }

  return false
}

function formatImageBoundaryChapterTitle(chapterMetadata) {
  const boundaryKind = chapterMetadata?.boundaryKind ?? null
  const number = (chapterMetadata?.number ?? "").trim()
  const title = (chapterMetadata?.title ?? "").trim()

  if (boundaryKind === "prelude" || boundaryKind === "prologue" || boundaryKind === "epilogue") {
    if (number && title) {
      return `${number}: ${title}`
    }
    if (title) {
      return title
    }
    return number || (boundaryKind ? boundaryKind.charAt(0).toUpperCase() + boundaryKind.slice(1) : "Section")
  }

  if (boundaryKind === "interlude") {
    if (number && title) {
      return `${number}: ${title}`
    }
    return number || title || "Interlude"
  }

  if (number && title) {
    return `${number}: ${title}`
  }

  return number || title || "Chapter"
}

function appendImageBoundaryChapters(content, chapters, seenChapterIds) {
  for (const page of content) {
    for (let blockIndex = 0; blockIndex < (page.blocks ?? []).length; blockIndex += 1) {
      const block = page.blocks[blockIndex]

      if (block?.type !== "image" || !block.isChapterBoundary) {
        continue
      }
      if (block.chapterMetadata?.includeInToc === false) {
        continue
      }

      const kind = block.chapterMetadata?.boundaryKind
      if (
        !kind ||
        kind === "flashback" ||
        kind === "part" ||
        kind === "interlude_divider" ||
        kind === "book_divider"
      ) {
        continue
      }

      // A "chapter" image boundary that carries neither a number nor a title
      // resolves only to the bare "Chapter" fallback label - a meaningless TOC
      // entry produced when a decorative or stray image is misflagged as a
      // chapter boundary (e.g. Oliver Twist's end-matter image at pageIndex 98).
      // Drop it. This never affects prelude/prologue/epilogue/interlude
      // boundaries (they have their own fallback labels) or chapter boundaries
      // that carry a real number or title.
      const boundaryNumber = (block.chapterMetadata?.number ?? "").toString().trim()
      const boundaryTitle = (block.chapterMetadata?.title ?? "").toString().trim()
      if (kind === "chapter" && !boundaryNumber && !boundaryTitle) {
        continue
      }

      const title = formatImageBoundaryChapterTitle(block.chapterMetadata)
      const id = slugify(title) || `image-boundary-${page.pageIndex}-${blockIndex}`
      if (seenChapterIds.has(id)) {
        continue
      }

      seenChapterIds.add(id)
      chapters.push({
        id,
        title,
        pageIndex: page.pageIndex,
        blockIndex,
        ...(Number.isFinite(block.pageNumber)
          ? { sourcePageNumber: block.pageNumber }
          : {}),
        ...(BOOKY_TOC_ORDER_DEBUG ? { __tocSource: "image" } : {}),
      })
    }
  }

  return chapters
}

// Classifies an explicit "Chapter N" heading by its numeral style. Returns
// "arabic" for digit-numbered chapters, "roman" for roman-numeral chapters, and
// null for anything that is not a "Chapter <numeral>" heading (parts, volumes,
// spelled-out numbers, standalone numerals, etc.). Only the literal "Chapter"
// keyword is considered, so epistolary "Letter <roman>" dividers are untouched.
function chapterHeadingNumeralStyle(text) {
  const match = (text ?? "").trim().match(/^chapter\s+(\S+)/i)
  if (!match) {
    return null
  }
  const token = match[1].replace(/[.,:;)\]]+$/, "")
  if (/^\d{1,3}$/.test(token)) {
    return "arabic"
  }
  if (parseValidStandaloneRomanNumeral(token)) {
    return "roman"
  }
  return null
}

// A document "establishes" arabic chapter numbering when it has multiple arabic
// "Chapter N" headings that outnumber any roman-numeral "Chapter X" headings. In
// that case a roman-numeral chapter heading is a foreign artifact - for example
// the Goldstein book ("Chapter I", "Chapter III") nested inside 1984's prose,
// which numbers its real chapters with arabic numerals. The Metamorphosis is not
// affected: its dividers are standalone numerals (no "Chapter" keyword) handled
// by the romanPart path, and it has zero arabic chapter headings. Moby Dick is
// not affected either: its chapters are roman with no arabic counterpart.
function documentEstablishesArabicChapterNumbering(flatBlocks) {
  let arabicChapterCount = 0
  let romanChapterCount = 0
  for (const block of flatBlocks ?? []) {
    if (block?.isChapterStart !== true) {
      continue
    }
    const style = chapterHeadingNumeralStyle(block.chapterTitle ?? block.text)
    if (style === "arabic") {
      arabicChapterCount += 1
    } else if (style === "roman") {
      romanChapterCount += 1
    }
  }
  return arabicChapterCount >= 2 && arabicChapterCount > romanChapterCount
}

function detectChapters(content, bookTitle = "") {
  const trimmedBookTitle = (bookTitle ?? "").trim()
  const flatBlocks = flattenContentBlocks(content)
  const arabicChaptersEstablished =
    documentEstablishesArabicChapterNumbering(flatBlocks)
  let flatBlockIndex = 0

  if (!contentHasChapterHeadings(content) && trimmedBookTitle) {
    const id = slugify(trimmedBookTitle)
    const chapters = [
      {
        id,
        title: trimmedBookTitle,
        pageIndex: 0,
        blockIndex: 0,
      },
    ]

    const updatedContent = content.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) => ({
        ...block,
        chapterId: id,
        isChapterStart: false,
      })),
    }))

    return { chapters, content: updatedContent }
  }

  const chapters = []
  const seenChapterIds = new Set()
  let currentChapterId = null
  let currentPartId = null
  let currentPartTitle = null

  const updatedContent = content.map((page) => ({
    ...page,
    blocks: page.blocks.map((block, blockIndex) => {
      const currentFlatIndex = flatBlockIndex
      flatBlockIndex += 1

      let chapterId = currentChapterId
      let isChapterStart = false
      let displayChapterTitle = block.chapterTitle ?? null

      if (
        isChapterHeading(block) &&
        isOrphanTextPartHeading(block, flatBlocks, currentFlatIndex)
      ) {
        return {
          ...block,
          chapterId,
          isChapterStart: false,
        }
      }

      if (isChapterHeading(block)) {
        // Foreign roman-numeral chapter heading inside an arabic-numbered work
        // (e.g. the Goldstein book's "Chapter I"/"Chapter III" embedded in 1984's
        // prose). Keep the line as body text within the current chapter so it
        // does not pollute the table of contents.
        if (
          arabicChaptersEstablished &&
          chapterHeadingNumeralStyle(block.chapterTitle ?? block.text) === "roman"
        ) {
          return {
            ...block,
            chapterId: currentChapterId,
            isChapterStart: false,
            isHeading: false,
          }
        }

        const rawTitle = (block.chapterTitle ?? block.text ?? "").trim()
        const headingText = (block.text ?? rawTitle).trim()
        const canonicalTitle = normalizeHeadingCandidate(headingText) || headingText
        const partLabel = resolvePartHeadingLabel(headingText)

        // A reprinted copy of the book's own title (back-matter house ad,
        // series teaser page) is never a chapter of itself. Keep the line as a
        // display heading inside the current chapter instead of a TOC entry.
        // Poem titles are exempt: a collection's title poem legitimately shares
        // the book title.
        if (
          trimmedBookTitle &&
          block.isPoemTitle !== true &&
          !CHAPTER_PATTERN.test(canonicalTitle) &&
          normalizeTitleComparisonKey(canonicalTitle) ===
            normalizeTitleComparisonKey(trimmedBookTitle)
        ) {
          return {
            ...block,
            chapterId,
            isChapterStart: false,
          }
        }
        let id = slugify(canonicalTitle)
        let chapterTitle = block.chapterTitle ?? rawTitle
        const isFableTitle = isFableStoryTitleBlock(block)
        const isSaddlebackStoryTitle =
          block.storyChapterNumber != null && block.isChapterStart
        // Each poem is a self-contained chapter. Like fable titles it is always a
        // chapter start, is never folded under a part prefix, and gets a unique id
        // even when a poem title repeats across the omnibus (e.g. "Shaker, Why
        // Don't You Sing?").
        const isPoemTitle = block.isPoemTitle === true
        const isStandaloneStoryTitle =
          isFableTitle || isSaddlebackStoryTitle || isPoemTitle

        if (isStandaloneStoryTitle) {
          isChapterStart = true
          if (seenChapterIds.has(id)) {
            id = `${id}-${currentFlatIndex}`
          }
        }

        if (!isStandaloneStoryTitle && partLabel) {
          currentPartId = slugify(partLabel)
          currentPartTitle = partLabel
          id = slugify(block.chapterTitle ?? partLabel)
          chapterTitle = block.chapterTitle ?? partLabel
        } else if (
          !isStandaloneStoryTitle &&
          currentPartId &&
          (CHAPTER_NUMBER_REGEX.test(canonicalTitle) ||
            /^(chapter|letter)\s+/i.test(canonicalTitle))
        ) {
          id = `${currentPartId}-${slugify(canonicalTitle)}`
          const chapterLabel = block.chapterTitle ?? rawTitle
          chapterTitle = `${currentPartTitle ?? currentPartId} — ${chapterLabel}`
        } else if (
          !isStandaloneStoryTitle &&
          (PART_HEADING_PATTERN.test(canonicalTitle) ||
            VOLUME_HEADING_PATTERN.test(canonicalTitle))
        ) {
          currentPartId = id
          currentPartTitle = canonicalTitle
        }

        if (!seenChapterIds.has(id)) {
          seenChapterIds.add(id)
          chapters.push({
            id,
            title: chapterTitle,
            pageIndex: page.pageIndex,
            blockIndex,
            ...(block.storyChapterNumber != null
              ? { storyChapterNumber: String(block.storyChapterNumber) }
              : {}),
            ...(BOOKY_TOC_ORDER_DEBUG ? { __tocSource: "text" } : {}),
          })
          currentChapterId = id
          chapterId = id
          if (!isStandaloneStoryTitle) {
            isChapterStart = true
          }
          displayChapterTitle = chapterTitle
        } else if (isStandaloneStoryTitle) {
          chapterId = currentChapterId
          displayChapterTitle = chapterTitle
        } else {
          chapterId = currentChapterId
          if (BOOKY_TOC_MISS_DEBUG) {
            console.log(
              "[tocDemote]",
              JSON.stringify({
                text: headingText.slice(0, 80),
                chapterTitle: chapterTitle.slice(0, 80),
                collidedId: id,
                hadIsChapterStart: block.isChapterStart === true,
                pageIndex: page.pageIndex,
                blockIndex,
              })
            )
          }
        }
      }

      return {
        ...block,
        chapterId,
        isChapterStart,
        ...(isChapterStart && displayChapterTitle
          ? { chapterTitle: displayChapterTitle }
          : {}),
      }
    }),
  }))

  appendImageBoundaryChapters(content, chapters, seenChapterIds)

  // Text chapters and image/structural boundaries are collected in two separate
  // passes above, so the raw array is two concatenated lists rather than one
  // reading-order list. Merge them into a single reading-order sequence by
  // sorting once on the content-stream position (pageIndex, then blockIndex)
  // that every entry carries.
  sortChaptersByReadingOrder(chapters)

  if (BOOKY_TOC_ORDER_DEBUG) {
    console.log("[tocOrder] final chapters array (reading order):")
    chapters.forEach((chapter, index) => {
      console.log(
        "[tocOrder]",
        JSON.stringify({
          i: index,
          title: (chapter.title ?? "").slice(0, 60),
          pageIndex: chapter.pageIndex,
          blockIndex: chapter.blockIndex,
          source: chapter.__tocSource ?? "text",
        })
      )
    })
  }

  if (BOOKY_TOC_MISS_DEBUG) {
    logTocMissDiagnostics(updatedContent, chapters)
  }

  return { chapters, content: updatedContent }
}

/**
 * Sorts the unified chapters list (text chapters plus image/structural
 * boundaries) in place by a single reading-order key derived from each entry's
 * position in the final content stream: pageIndex first, then blockIndex. The
 * pageIndex here is the content page index produced by blocksToContent, not the
 * raw PDF page. The sort is made explicitly stable via the original insertion
 * index so entries that share an identical position keep their relative order.
 */
function sortChaptersByReadingOrder(chapters) {
  const decorated = chapters.map((chapter, insertionIndex) => ({
    chapter,
    insertionIndex,
  }))

  decorated.sort((left, right) => {
    const pageDelta =
      readingOrderPageIndex(left.chapter) - readingOrderPageIndex(right.chapter)
    if (pageDelta !== 0) {
      return pageDelta
    }

    const blockDelta =
      readingOrderBlockIndex(left.chapter) - readingOrderBlockIndex(right.chapter)
    if (blockDelta !== 0) {
      return blockDelta
    }

    return left.insertionIndex - right.insertionIndex
  })

  for (let index = 0; index < decorated.length; index += 1) {
    chapters[index] = decorated[index].chapter
  }

  return chapters
}

/**
 * Returns the content page index used as the primary reading-order key. Every
 * chapter (text or image-boundary) is expected to carry a finite pageIndex; a
 * missing key is a population bug, so it is surfaced (and pushed to the end via
 * a sentinel rather than clustering at the top) instead of being silently
 * normalized to 0.
 */
function readingOrderPageIndex(chapter) {
  if (Number.isFinite(chapter?.pageIndex)) {
    return chapter.pageIndex
  }
  if (BOOKY_TOC_ORDER_DEBUG) {
    console.log(
      "[tocOrder] WARNING missing pageIndex",
      JSON.stringify({ title: (chapter?.title ?? "").slice(0, 60) })
    )
  }
  return Number.MAX_SAFE_INTEGER
}

function readingOrderBlockIndex(chapter) {
  if (Number.isFinite(chapter?.blockIndex)) {
    return chapter.blockIndex
  }
  if (BOOKY_TOC_ORDER_DEBUG) {
    console.log(
      "[tocOrder] WARNING missing blockIndex",
      JSON.stringify({ title: (chapter?.title ?? "").slice(0, 60) })
    )
  }
  return Number.MAX_SAFE_INTEGER
}

function logTocMissDiagnostics(content, chapters) {
  const chapterIdSet = new Set(chapters.map((chapter) => chapter.id))
  const chapterPositionSet = new Set(
    chapters.map((chapter) => `${chapter.pageIndex}:${chapter.blockIndex}`)
  )

  for (const page of content) {
    const blocks = page.blocks ?? []
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex]
      const isImageBoundary =
        block?.type === "image" &&
        block.isChapterBoundary === true &&
        block.chapterMetadata?.includeInToc !== false
      const isTextStart = block?.type !== "image" && block?.isChapterStart === true

      if (!isImageBoundary && !isTextStart) {
        continue
      }

      let computedSlug
      let title
      let boundaryKind
      if (isImageBoundary) {
        title = formatImageBoundaryChapterTitle(block.chapterMetadata)
        computedSlug = slugify(title) || `image-boundary-${page.pageIndex}-${blockIndex}`
        boundaryKind = block.chapterMetadata?.boundaryKind ?? null
      } else {
        title = (block.chapterTitle ?? block.text ?? "").trim()
        computedSlug = block.chapterId ?? slugify(title)
        boundaryKind = block.chapterMetadata?.boundaryKind ?? null
      }

      const positionKey = `${page.pageIndex}:${blockIndex}`
      const registered =
        chapterIdSet.has(computedSlug) || chapterPositionSet.has(positionKey)

      if (!registered) {
        console.log(
          "[tocMiss]",
          JSON.stringify({
            text: (block.text ?? "").slice(0, 80),
            chapterTitle: (block.chapterTitle ?? "").slice(0, 80),
            boundaryKind,
            pageIndex: page.pageIndex,
            blockIndex,
            slug: computedSlug,
          })
        )
      }
    }
  }
}

function isAuthorStructuralLine(text) {
  if (isScannerWatermarkLine(text)) {
    return false
  }

  const trimmed = (text ?? "").trim()
  if (!/^(?:by|written by|translated by)\s+/i.test(trimmed)) {
    return false
  }

  const afterBy = trimmed.replace(/^(?:by|written by|translated by)\s+/i, "").trim()
  if (!afterBy || !/^\p{Lu}/u.test(afterBy)) {
    return false
  }

  // Narrative openers such as "By this time the schooner..." are prose, not credits.
  if (
    /^(?:this|the|now|then|that|which|whom|far|reason|day|night|morning|evening|chance|luck|turn|way|and|a|an|no|some|any|virtue|means|degrees?|contrast|comparison|default|order|itself|it)\b/i.test(
      afterBy
    )
  ) {
    return false
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length > 6) {
    return false
  }
  if (trimmed.length >= 50) {
    return false
  }
  if (/[.!?]/.test(trimmed)) {
    return false
  }
  return true
}

function isStructuralLine(text, nonEmptyLineIndex) {
  if (isAuthorStructuralLine(text)) {
    return true
  }

  if (nonEmptyLineIndex < 20 && /^To\s+[A-Z]/.test(text)) {
    return true
  }

  if (/^A (Novel|Story|Tale|Memoir)\b/i.test(text)) {
    return true
  }

  return false
}

function isTocChapterListingLine(text) {
  return TOC_CHAPTER_LISTING_REGEX.test((text ?? "").trim())
}

function isNarrativeSentenceLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || trimmed.length > STRUCTURAL_HEADING_MAX_CHARS) {
    return false
  }

  if (isCleanStructuralHeadingText(trimmed)) {
    return false
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 4) {
    return false
  }

  if (!/[.!?][\u201d"\u2019']?\s*$/.test(trimmed)) {
    return false
  }

  const punctuationCount = (trimmed.match(/[.!?]/g) ?? []).length
  if (punctuationCount >= 2) {
    return words.length >= 6 && /[a-z]/.test(trimmed)
  }

  return true
}

function isHeadingLine(text, line, headingStrings, entry = null) {
  if (isScannerWatermarkLine(text)) {
    return false
  }

  if (isQuotedEpistolarySalutationLine(text)) {
    return false
  }

  if (isCenteredDecorativeProseText(text, line, entry)) {
    return false
  }

  if (isProminentDisplayTitleLine(text, line, entry)) {
    return true
  }

  if (PROSE_BLOCKLIST_WORD_REGEX.test(text)) {
    return false
  }

  if (resolvePartHeadingLabel(text)) {
    return true
  }

  if (isIncompleteAllCapsWrapLine(text)) {
    return false
  }

  if (
    isHeadingIncompleteEnding((text ?? "").trim()) &&
    !isCleanStructuralHeadingText(text, line)
  ) {
    return false
  }

  if (/^[a-z(\u201c]/.test((text ?? "").trim())) {
    return false
  }

  if (isNarrativeSentenceLine(text)) {
    return false
  }

  {
    const trimmed = (text ?? "").trim()
    const letters = trimmed.replace(/[^A-Za-z]/g, "")
    const upper = (trimmed.match(/[A-Z]/g) ?? []).length
    if (
      !isLikelyAllCapsDisplayTitle(trimmed, line, entry) &&
      letters.length >= 16 &&
      upper / Math.max(1, letters.length) >= 0.85 &&
      trimmed.split(/\s+/).filter(Boolean).length >= 5 &&
      !isCleanStructuralHeadingText(text, line)
    ) {
      return false
    }
  }

  if (!text.includes(" ") && text.length < 5) {
    return false
  }

  if (isTocDenseListingLine(text) || isRunningHeaderMergedLine(text)) {
    return false
  }

  if (isCleanStructuralHeadingText(text, line)) {
    return true
  }

  if (headingStrings.has(text)) {
    return passesVisualHeadingGuards(text, line, entry)
  }

  if (text.length < 60 && passesVisualHeadingGuards(text, line, entry)) {
    return true
  }

  return false
}

function shouldStartNewProseBlock(line, previousBlock, entry = null, previousEntry = null) {
  const text = (line.text ?? entry?.line?.text ?? "").trim()
  const prevTrim = (previousBlock?.text ?? "").trim()
  const metrics = entry?.pageMetrics ?? line.pageMetrics

  if (line.centered) {
    return true
  }

  if (isVerseLineText(text)) {
    return true
  }

  if (previousBlock && isVerseLineText(previousBlock.text)) {
    return true
  }

  // Keep quoted letter salutations as their own prose blocks. Otherwise a narrow
  // gap can glue "DEAR SIR," onto the following paragraph once it is no longer
  // classified as a heading.
  if (
    isQuotedEpistolarySalutationLine(text) ||
    isQuotedEpistolarySalutationLine(prevTrim)
  ) {
    return true
  }

  // Opening quotation on a later PDF page is a new utterance when either (a)
  // there is a skipped page between (Stormlight empty illustration plate before
  // the chapter epigraph) or (b) the previous line already finished a sentence.
  // The shared isProseLineContinuation treats leading \u201c as continuation,
  // which glued those quotes onto the prior chapter's last paragraph (wrong
  // sourcePdfPageIndex); splitDialogueHeavyBlocks then re-split them while
  // inheriting that page, so the quote appeared before the chapter banner.
  // Cross-page only - same-page dialogue merge/split is unchanged.
  if (
    previousBlock &&
    entry &&
    previousEntry &&
    entry.pageIndex !== previousEntry.pageIndex &&
    /^["\u201c]/.test(text)
  ) {
    const pageGap = entry.pageIndex - previousEntry.pageIndex
    if (
      pageGap >= 2 ||
      /[.!?]["'\u201d]?\s*$/.test(prevTrim)
    ) {
      return true
    }
  }

  // Cross-page Szeth POV opening (prologue, later Szeth interludes, and Szeth
  // chapters that reuse the same formula). The v135 quote gate does not see
  // these: the new unit is a name, not a quote. isProseLineContinuation is
  // false, and /[.!?]$/ misses a previous line ending ." so the default would
  // merge and inherit the prior page. Reuses STORMLIGHT_PROLOGUE_OPENING_REGEX
  // rather than a new pattern; printed-TOC interlude titles ("The Glory Of
  // Ignorance") do not appear on the opening line. Cross-page only.
  if (
    previousBlock &&
    entry &&
    previousEntry &&
    entry.pageIndex !== previousEntry.pageIndex &&
    STORMLIGHT_PROLOGUE_OPENING_REGEX.test(text)
  ) {
    return true
  }

  if (previousBlock && isProseLineContinuation(text, previousBlock)) {
    return false
  }

  if (line.indented && !/^[a-z(\u201c]/.test(text)) {
    return true
  }

  if (!previousBlock) {
    return true
  }

  if (previousBlock.isHeading || previousBlock.textAlign === "center") {
    return true
  }

  if (
    entry &&
    previousEntry &&
    entry.pageIndex === previousEntry.pageIndex &&
    entry.line.gapAboveOnPage != null &&
    metrics?.gapThreshold
  ) {
    if (entry.line.gapAboveOnPage <= metrics.gapThreshold) {
      return false
    }

    if (entry.line.gapAboveOnPage > metrics.gapThreshold) {
      return true
    }
  }

  if (proseFormattingDiffers(line, previousBlock)) {
    return true
  }

  if (/^[A-Z]/.test(text) && /[.!?]$/.test(prevTrim)) {
    return true
  }

  if (/^["\u201c]/.test(text) && /["\u201d]?\s*$/.test(prevTrim)) {
    return true
  }

  if (/^["“”'']\s*[A-Z]/.test(text)) {
    return true
  }

  if (/^['\u2018\u201c]/.test(text)) {
    return true
  }

  return false
}

function applyProseBlockDefaults(proseBlock, line, proseText) {
  if (line.indented || /^['\u2018\u201c]/.test((proseText ?? "").trim())) {
    proseBlock.isIndented = true
  }
  applyProseFormattingToBlock(proseBlock, line)
}

const DEDICATION_LINE_REGEX = /^To\s+[A-Z]/

function isDedicationStructuralBlock(block) {
  return (
    block &&
    block.isHeading === true &&
    block.fontSize === 13 &&
    DEDICATION_LINE_REGEX.test((block.text ?? "").trim())
  )
}

function isTocHeadingCandidate(text, line, headingStrings, lineIndex, entry = null) {
  if (PROSE_BLOCKLIST_WORD_REGEX.test(text)) {
    return false
  }
  if (!text.includes(" ") && text.length < 5) {
    return false
  }
  if (isStructuralLine(text, lineIndex)) {
    return false
  }
  if (isTocChapterListingLine(text)) {
    return true
  }
  if (
    isStormlightPrintedTocLine(text) ||
    isIllustrationsListEntryLine(text) ||
    isBibliographySeriesTitleLine(text)
  ) {
    return false
  }
  return isHeadingLine(text, line, headingStrings, entry)
}

function consumeRepeatedSectionLabel(text, sectionLabelState) {
  const canonical = normalizeHeadingCandidate(text.trim()) || text.trim()
  const sectionLabelKey = /^(?:preface|introduction|prologue|epilogue|conclusion)$/i.test(
    canonical
  )
    ? canonical.toLowerCase()
    : null

  if (!sectionLabelKey) {
    if (
      CHAPTER_PATTERN.test(canonical) ||
      PART_HEADING_PATTERN.test(canonical) ||
      VOLUME_HEADING_PATTERN.test(canonical)
    ) {
      sectionLabelState.lastRepeatedSectionLabel = null
    }
    return { skip: false, canonical }
  }

  if (sectionLabelKey === sectionLabelState.lastRepeatedSectionLabel) {
    return { skip: true, canonical }
  }

  sectionLabelState.lastRepeatedSectionLabel = sectionLabelKey
  return { skip: false, canonical }
}

function collectConsecutiveTocHeadingRun(
  allLines,
  startIndex,
  headingStrings,
  baseLineIndex
) {
  const run = []
  let index = startIndex

  while (index < allLines.length) {
    const entry = allLines[index]
    const lineIndex = baseLineIndex + run.length

    if (!isTocHeadingCandidate(entry.text, entry.line, headingStrings, lineIndex, entry)) {
      break
    }

    run.push(entry)
    index += 1
  }

  return { run, nextIndex: index }
}

function splitDialogueHeavyBlocks(blocks) {
  const result = []

  for (const block of blocks) {
    const text = (block.text ?? "").trim()
    if (block.isHeading || !text || !/["\u201c\u201d]/.test(text)) {
      result.push(block)
      continue
    }

    const parts = text.split(/(?<=[.!?][\u201d"]?)\s+(?=[\u201c"])/)
    if (parts.length <= 1) {
      result.push(block)
      continue
    }

    for (const part of parts) {
      const piece = part.trim()
      if (piece) {
        result.push({ ...block, text: piece })
      }
    }
  }

  return result
}

// Detect a poetry collection (e.g. an omnibus of verse) so the dedicated verse
// block builder can be used instead of the prose-oriented one. The signal is
// robust: across the document a large majority of non-empty lines are short and
// do not end on sentence punctuation (verse lines), and many pages open with a
// prominent short lead line over body-font lines (poem titles). Prose books -
// even dialogue-heavy ones - score far below these thresholds, so this never
// trips for novels or fable anthologies.
function documentIsPoetryCollection(pageData) {
  if (!Array.isArray(pageData) || pageData.length === 0) {
    return false
  }

  const fontSizes = []
  let totalNonEmpty = 0
  for (const page of pageData) {
    for (const line of page?.lines ?? []) {
      const text = (line.text ?? "").trim()
      if (!text) {
        continue
      }
      totalNonEmpty += 1
      const fontSize = line.fontSize ?? 0
      if (Number.isFinite(fontSize) && fontSize > 0) {
        fontSizes.push(fontSize)
      }
    }
  }

  if (totalNonEmpty < 200) {
    return false
  }

  const bodyFont = medianValue(fontSizes)
  if (bodyFont <= 0) {
    return false
  }

  let shortUnterminated = 0
  let titlePages = 0
  for (const page of pageData) {
    const lines = (page?.lines ?? [])
      .map((line) => ({ text: (line.text ?? "").trim(), fontSize: line.fontSize ?? 0 }))
      .filter((entry) => entry.text)
    if (lines.length === 0) {
      continue
    }

    for (const { text } of lines) {
      const wordCount = text.split(/\s+/).filter(Boolean).length
      if (text.length <= 55 && wordCount <= 11 && !/[.!?:;]["'\u201d]?$/.test(text)) {
        shortUnterminated += 1
      }
    }

    const lead = lines[0]
    const followers = lines.slice(1, 3)
    if (
      lead.fontSize >= bodyFont * 1.15 &&
      lead.fontSize <= bodyFont * 1.55 &&
      lead.text.length <= 60 &&
      followers.length >= 2 &&
      followers.every((entry) => entry.fontSize < bodyFont * 1.15)
    ) {
      titlePages += 1
    }
  }

  const poetryRatio = shortUnterminated / totalNonEmpty
  return poetryRatio >= 0.6 && titlePages >= 15
}

// All-caps FOR dedications that sit between a poem title and its verse
// ("FOR PAUL", "FOR A. L.", "FOR DAVID P-B"). Title-case poem titles such as
// "For Us, Who Dare Not Dare" must not match.
function isPoetryDedicationLine(text) {
  return /^FOR\s+\S/.test((text ?? "").trim())
}

function isPoetryBackMatterHeading(text) {
  return /^ABOUT THE\b/i.test((text ?? "").trim())
}

// Dedicated block builder for poetry collections. Unlike the prose builder it
// never reflows consecutive lines into paragraphs: every source line is emitted
// as its own verse block so the reader preserves the poem's line breaks. A
// prominent short line that sits above body-font lines is promoted to a poem
// title (chapter start). The front matter (also-by lists, the printed contents,
// dedications) is not structured into chapters - those lines simply pass through
// as verse blocks, since none of them are prominent-line-over-body-lines poems.
function buildPoetryBlocksFromLines(pageData, { onProgress } = {}) {
  const blocks = []
  const allLines = []
  const totalPages = pageData.length

  for (let pageIndex = 0; pageIndex < pageData.length; pageIndex += 1) {
    const pageLines = pageData[pageIndex].lines ?? []
    for (const line of pageLines) {
      const text = (line.text ?? "").trim()
      if (text) {
        allLines.push({ line, text, pageIndex })
      }
    }
    if (onProgress && (pageIndex % 20 === 0 || pageIndex === totalPages - 1)) {
      onProgress(pageIndex + 1, totalPages)
    }
  }

  const docBodyFont = medianValue(
    allLines.map((entry) => entry.line.fontSize ?? 0).filter((value) => value > 0)
  )
  const titleMinFont = docBodyFont * 1.15
  const titleMaxFont = docBodyFont * 1.55

  const isBodyFontEntry = (entry) =>
    Boolean(entry) && (entry.line.fontSize ?? 0) < titleMinFont

  const isPoemTitleEntry = (entry) => {
    if (!entry) {
      return false
    }
    const fontSize = entry.line.fontSize ?? 0
    if (fontSize < titleMinFont || fontSize > titleMaxFont) {
      return false
    }
    const text = entry.text
    if (text.length > 60) {
      return false
    }
    if (isStandalonePageNumberText(text) || isScannerWatermarkLine(text)) {
      return false
    }
    // Front-matter list headers are prominent too; never treat them as poems.
    if (/^(?:contents|table of contents|also by\b)/i.test(text)) {
      return false
    }
    // Dedications and back-matter headings share title font and often sit
    // above body-font lines, but they are not poems. Keep the text; do not
    // promote them to chapters.
    if (isPoetryDedicationLine(text) || isPoetryBackMatterHeading(text)) {
      return false
    }
    return true
  }

  // Body-follower cursor: skip dedications, then same-page title-font
  // subsection headers ("The Student" under Communication II), without
  // consuming a later poem's title on a following page. The two-body-line
  // requirement itself is unchanged.
  const bodyFollowerIndexAfter = (startIndex, pageIndex) => {
    let cursor = startIndex
    while (allLines[cursor] && isPoetryDedicationLine(allLines[cursor].text)) {
      cursor += 1
    }
    while (
      allLines[cursor] &&
      allLines[cursor].pageIndex === pageIndex &&
      isPoemTitleEntry(allLines[cursor])
    ) {
      cursor += 1
    }
    return cursor
  }

  const promotedPoemPages = new Set()

  for (let index = 0; index < allLines.length; index += 1) {
    const entry = allLines[index]
    const { text, pageIndex } = entry

    if (isScannerWatermarkLine(text) || isStandalonePageNumberText(text)) {
      continue
    }

    // Poem title: a prominent short line followed by body-font verse lines.
    // Requiring two following body lines keeps printed-contents entries (a
    // prominent line followed by another prominent line) from being promoted.
    // Dedications and same-page subsection headers are skipped when counting
    // those followers; they stay in the stream as verse. A second title-font
    // line on a page that already opened a poem is a subsection, not a chapter.
    const followerIndex = bodyFollowerIndexAfter(index + 1, pageIndex)
    if (
      !promotedPoemPages.has(pageIndex) &&
      isPoemTitleEntry(entry) &&
      isBodyFontEntry(allLines[followerIndex]) &&
      isBodyFontEntry(allLines[followerIndex + 1])
    ) {
      const title = text.replace(/\s+/g, " ").trim()
      promotedPoemPages.add(pageIndex)
      blocks.push(
        withSourcePdfPage(
          {
            text: title,
            chapterTitle: title,
            isHeading: true,
            isChapterStart: true,
            isPoemTitle: true,
            fontSize: CHAPTER_DISPLAY_FONT_SIZE,
          },
          pageIndex
        )
      )
      continue
    }

    blocks.push(
      withSourcePdfPage(
        {
          text: text.replace(/\s+/g, " ").trim(),
          isHeading: false,
          isVerse: true,
          fontSize: 12,
        },
        pageIndex
      )
    )
  }

  return blocks
}

function buildBlocksFromLines(pageData, headingStrings, { onProgress, printedToc = null } = {}) {
  const blocks = []
  const allLines = []
  const totalPages = pageData.length

  for (let pageIndex = 0; pageIndex < pageData.length; pageIndex += 1) {
    const pageLines = pageData[pageIndex].lines ?? []
    const pageMetrics = computePageLineMetrics(pageLines)
    annotatePageLineGaps(pageLines, pageMetrics)

    for (const line of pageLines) {
      const text = (line.text ?? "").trim()
      if (text) {
        allLines.push({ line, text, pageIndex, pageMetrics })
      }
    }

    if (
      onProgress &&
      (pageIndex % 20 === 0 || pageIndex === totalPages - 1)
    ) {
      onProgress(pageIndex + 1, totalPages)
    }
  }

  let pendingConnective = null
  let nonEmptyLineIndex = 0
  let index = 0
  let inPrintedTocSection = false
  const sectionLabelState = { lastRepeatedSectionLabel: null }
  let saddlebackChapterCursor = 1

  while (index < allLines.length) {
    const entry = allLines[index]
    const { line, text } = entry
    const lineIndex = nonEmptyLineIndex
    nonEmptyLineIndex += 1

    if (isScannerWatermarkLine(text)) {
      index += 1
      continue
    }

    // Reassemble a prominent display title that wraps across two physical lines
    // (e.g. "THE FROGS WHO ASKED FOR A" + "KING", "THE MOUSE, THE CAT, AND THE"
    // + "COCK", "THE FISHERMAN AND THE LITTLE" + "FISH"). Anthology fable titles
    // are set well above body size; when one wraps, the short all-caps tail
    // would otherwise be dropped as a glossary artifact and the head glued onto
    // the following prose. Merge them into one chapter-start heading up front,
    // before any downstream branch can mishandle the pieces.
    {
      const tailEntry = allLines[index + 1]
      const afterTailEntry = allLines[index + 2]
      const headFontSize = line.fontSize ?? 0
      const tailFontSize = tailEntry?.line?.fontSize ?? 0
      const afterFontSize = afterTailEntry?.line?.fontSize ?? 0
      // A wrapped display title's two physical lines share the same large font,
      // and that font sits well above the body line that follows. Comparing the
      // head/tail font to the following body line is robust on sparse title
      // pages where the per-page median font is skewed by the title itself.
      if (
        tailEntry &&
        afterTailEntry &&
        tailEntry.pageIndex === entry.pageIndex &&
        headFontSize > 0 &&
        Math.abs(headFontSize - tailFontSize) <= 1.5 &&
        afterFontSize > 0 &&
        headFontSize >= afterFontSize * 1.2 &&
        isWrappedDisplayTitleHeadLine(text) &&
        isWrappedDisplayTitleTailLine(tailEntry.text) &&
        /[a-z]/.test(afterTailEntry.text ?? "")
      ) {
        const mergedTitle = joinWrappedText(text.trim(), tailEntry.text.trim())
          .replace(/\s+/g, " ")
          .trim()
        pendingConnective = null
        pushHeadingBlock(
          blocks,
          {
            text: mergedTitle,
            chapterTitle: mergedTitle,
            isHeading: true,
            fontSize: CHAPTER_DISPLAY_FONT_SIZE,
            isChapterStart: true,
            centered: true,
            textAlign: "center",
            chapterId: null,
          },
          "wrappedDisplayTitle",
          entry.pageIndex,
          line
        )
        nonEmptyLineIndex += 1
        index += 2
        continue
      }
    }

    if (printedToc?.isSaddlebackDotLeader && printedToc?.chapters?.size) {
      const opener = tryConsumeSaddlebackChapterOpener(
        allLines,
        index,
        printedToc,
        saddlebackChapterCursor
      )
      if (opener) {
        pendingConnective = null
        const chapterTitle = cleanStoryChapterTitle(opener.title) || opener.title
        const pushed = pushHeadingBlock(
          blocks,
          {
            text: chapterTitle,
            chapterTitle,
            storyChapterNumber: opener.chapterNumber,
            isHeading: true,
            fontSize: CHAPTER_DISPLAY_FONT_SIZE,
            isChapterStart: true,
            centered: true,
            textAlign: "center",
            chapterId: null,
          },
          "saddlebackChapterOpener",
          opener.pageIndex,
          opener.line
        )
        if (pushed) {
          saddlebackChapterCursor = Number(opener.chapterNumber) + 1
        }
        nonEmptyLineIndex += opener.nextIndex - index - 1
        index = opener.nextIndex
        continue
      }
    }

    if (isSceneBreakDividerText(text)) {
      pendingConnective = null
      blocks.push(
        withSourcePdfPage(
          {
            text: SCENE_BREAK_DIVIDER_TEXT.trim(),
            isHeading: true,
            fontSize: 12,
            chapterId: null,
            centered: true,
            textAlign: "center",
          },
          entry.pageIndex
        )
      )
      index += 1
      continue
    }

    if (
      isStandalonePageNumberText(text) &&
      !isSaddlebackChapterNumberLine(text, line, entry.pageMetrics) &&
      !isRomanPartOpenerLine(text, {
        distinctPageCount: countDistinctPagesForLineText(allLines, text),
        fontSize: line.fontSize ?? 0,
        centered: Boolean(line.centered),
      })
    ) {
      pendingConnective = null
      index += 1
      continue
    }

    if (
      isStorySectionRunningHeadLine(text) ||
      isRecurringBookTitleRunningHeadLine(text)
    ) {
      pendingConnective = null
      index += 1
      continue
    }

    const romanPart = parseValidStandaloneRomanNumeral(text)
    if (
      romanPart &&
      !isFrontMatterRomanNumeralTocEntry(allLines, index) &&
      romanPartOpenerHasFollowingBody(allLines, index) &&
      isRomanPartOpenerLine(text, {
        distinctPageCount: countDistinctPagesForLineText(allLines, text),
        fontSize: line.fontSize ?? 0,
        centered: Boolean(line.centered),
        romanNumeralsOnPage: countRomanNumeralsOnPage(
          allLines,
          entry.pageIndex,
          text
        ),
      })
    ) {
      pendingConnective = null
      pushHeadingBlock(
        blocks,
        {
          text: romanPart,
          chapterTitle: romanPart,
          romanPartNumber: romanPart,
          isHeading: true,
          fontSize: CHAPTER_DISPLAY_FONT_SIZE,
          isChapterStart: true,
          centered: Boolean(line.centered),
          textAlign: line.centered ? "center" : undefined,
          chapterId: null,
        },
        "standaloneRomanPart",
        entry.pageIndex,
        line
      )
      index += 1
      continue
    }

    const chapterOnlyParts = parseChapterOnlyHeading(text)
    if (chapterOnlyParts) {
      pendingConnective = null
      const titleFragments = []
      // Fragments collected from unambiguous all-caps display lines are not
      // fused drop-cap text; skip the post-format artifact check for them.
      let allCapsFragmentCount = 0
      let otherFragmentCount = 0
      let cursor = index + 1
      // Chapter-context only: allow "By ..." openings that isAuthorStructuralLine
      // would otherwise treat as bylines (Narnia "BY CALDRON POOL").
      const subtitlePathOptions = { allowAuthorLikeOpening: true }

      while (cursor < allLines.length) {
        const nextEntry = allLines[cursor]
        const nextText = nextEntry.text.trim()
        const nextFontSize = nextEntry.line.fontSize ?? 0

        if (
          nextFontSize >= MULTILINE_CHAPTER_WRAP_MIN_FONT_SIZE &&
          isLargeFontAllCapsChapterWrapLine(nextText, nextEntry.line)
        ) {
          titleFragments.push(nextText)
          otherFragmentCount += 1
          cursor += 1
          continue
        }

        if (
          isAllCapsChapterSubtitleLine(
            nextText,
            nextEntry.line,
            subtitlePathOptions
          )
        ) {
          titleFragments.push(nextText)
          allCapsFragmentCount += 1
          cursor += 1
          continue
        }

        if (
          isLikelyChapterSubtitleText(nextText, subtitlePathOptions) &&
          !looksLikeChapterOpeningProse(nextText)
        ) {
          titleFragments.push(nextText)
          otherFragmentCount += 1
          cursor += 1
          continue
        }

        if (
          nextFontSize >= HEADING_STRING_MIN_FONT_SIZE &&
          CHAPTER_TITLE_TAIL_WORD_REGEX.test(nextText)
        ) {
          titleFragments.push(nextText)
          otherFragmentCount += 1
          cursor += 1
          continue
        }

        if (isShortChapterHeadingSubtitleLine(nextText, nextEntry.line)) {
          titleFragments.push(nextText)
          otherFragmentCount += 1
          cursor += 1
          continue
        }

        if (isDisplayChapterTitleLine(nextText, nextEntry.line)) {
          titleFragments.push(nextText)
          otherFragmentCount += 1
          cursor += 1
          continue
        }

        break
      }

      const subtitle = titleFragments.length
        ? formatChapterSubtitleText(titleFragments.join(" ").replace(/\s+/g, " ").trim())
        : ""
      const skipArtifactCheck =
        allCapsFragmentCount > 0 && otherFragmentCount === 0
      const safeSubtitle =
        subtitle &&
        (skipArtifactCheck || !isDropCapChapterSubtitleArtifact(subtitle))
          ? subtitle
          : ""

      // If fragments were collected but rejected as artifacts, do not consume
      // those lines - leaving them in the stream is safer than swallowing them.
      if (titleFragments.length > 0 && !safeSubtitle) {
        cursor = index + 1
      }

      const displayTitle = formatChapterLabel(
        chapterOnlyParts.kind,
        chapterOnlyParts.number,
        safeSubtitle
      )

      pushHeadingBlock(
        blocks,
        {
          text: displayTitle,
          chapterTitle: displayTitle,
          isHeading: true,
          fontSize: CHAPTER_DISPLAY_FONT_SIZE,
          isChapterStart: true,
          chapterId: null,
        },
        "compiledMultilineChapter",
        entry.pageIndex,
        line
      )

      nonEmptyLineIndex += cursor - index - 1
      index = cursor
      continue
    }

    if (isPrintedTocHeading(text)) {
      pendingConnective = null
      inPrintedTocSection = true
      index += 1
      continue
    }

    if (
      inPrintedTocSection ||
      (lineIndex < PRINTED_TOC_SCAN_LINE_LIMIT && isPrintedTocEntryLine(text))
    ) {
      if (isPrintedTocEntryLine(text)) {
        pendingConnective = null
        inPrintedTocSection = true
        index += 1
        continue
      }

      if (inPrintedTocSection) {
        inPrintedTocSection = false
      }
    }

    if (
      isStormlightPrintedTocLine(text) ||
      isIllustrationsListLine(text)
    ) {
      pendingConnective = null
      index += 1
      continue
    }

    if (PROSE_BLOCKLIST_WORD_REGEX.test(text)) {
      const previousBlock = blocks[blocks.length - 1] ?? null

      if (isDedicationStructuralBlock(previousBlock)) {
        if (/^and$/i.test(text)) {
          previousBlock.text = `${previousBlock.text} ${text}`.trim()
          index += 1
          continue
        }
        pushHeadingBlock(
          blocks,
          {
            text,
            isHeading: true,
            fontSize: 13,
            chapterId: null,
          },
          "dedicationConnective",
          entry.pageIndex,
          line
        )
        index += 1
        continue
      }

      pendingConnective = text
      index += 1
      continue
    }

    if (isStructuralLine(text, lineIndex)) {
      pendingConnective = null
      pushHeadingBlock(
        blocks,
        {
          text,
          isHeading: true,
          fontSize: 13,
          chapterId: null,
        },
        "structuralLine",
        entry.pageIndex,
        line
      )
      index += 1
      continue
    }

    if (
      isTocDenseListingLine(text) ||
      isTocPageReferenceLine(text) ||
      isRunningHeaderMergedLine(text) ||
      isGlossarySidebarLine(text) ||
      isFusedSpelledChapterTocResidue(text)
    ) {
      pendingConnective = null
      index += 1
      continue
    }

    if (lineIndex < EARLY_TOC_SCAN_LINE_LIMIT && isTocChapterListingLine(text)) {
      pendingConnective = null
      index += 1
      continue
    }

    if (
      lineIndex < EARLY_TOC_SCAN_LINE_LIMIT &&
      isStormlightPrintedTocLine(text)
    ) {
      pendingConnective = null
      index += 1
      continue
    }

    if (lineIndex >= EARLY_TOC_SCAN_LINE_LIMIT && isTocChapterListingLine(text)) {
      pendingConnective = null
      pushHeadingBlock(
        blocks,
        {
          text,
          isHeading: true,
          fontSize: 15,
          isChapterStart: true,
          chapterId: null,
        },
        "tocChapterListing",
        entry.pageIndex,
        line
      )
      index += 1
      continue
    }

    const blockBeforeHeading = blocks.length > 0 ? blocks[blocks.length - 1] : null
    const trimmedContinuation = text.trim()
    const isWrappedTitleFragment =
      /^[a-z]/.test(trimmedContinuation) &&
      trimmedContinuation.split(/\s+/).filter(Boolean).length <= 3
    if (blockBeforeHeading?.isHeading && isWrappedTitleFragment) {
      const previousText = blockBeforeHeading.text.trim()
      const shouldMergeIntoHeading =
        isHeadingIncompleteEnding(previousText) ||
        /-\s*$/.test(previousText) ||
        /(?:chapter|part|section|book|volume)\s+/i.test(previousText)

      if (shouldMergeIntoHeading) {
        pendingConnective = null
        blockBeforeHeading.text = joinWrappedText(blockBeforeHeading.text, text)
        index += 1
        continue
      }
    }

    if (
      blockBeforeHeading?.isHeading &&
      (line.fontSize ?? 0) >= HEADING_STRING_MIN_FONT_SIZE &&
      CHAPTER_TITLE_TAIL_WORD_REGEX.test(trimmedContinuation)
    ) {
      pendingConnective = null
      blockBeforeHeading.text = joinWrappedText(blockBeforeHeading.text, text)
      index += 1
      continue
    }

    if (isCenteredDecorativeProseText(text, line, entry)) {
      pendingConnective = null
      const proseBlock = {
        text,
        isHeading: false,
        fontSize: 12,
        chapterId: null,
        textAlign: "center",
        centered: true,
      }
      applyProseFormattingToBlock(proseBlock, line)
      if (proseBlock.runs) {
        proseBlock.runs = proseBlock.runs.map((run) => ({
          ...run,
          bold: false,
        }))
      }
      blocks.push(withSourcePdfPage(proseBlock, entry.pageIndex))
      index += 1
      continue
    }

    if (isLikelyChapterNumberLine(text, line)) {
      pendingConnective = null
      if (
        pushHeadingBlock(
          blocks,
          {
            text: text.trim(),
            isHeading: true,
            fontSize: 15,
            isChapterStart: true,
            chapterId: null,
          },
          "likelyChapterNumber",
          entry.pageIndex,
          line
        )
      ) {
        index += 1
        continue
      }
    }

    const partLabel = resolvePartHeadingLabel(text)
    if (partLabel) {
      pendingConnective = null
      pushHeadingBlock(
        blocks,
        {
          text: partLabel,
          isHeading: true,
          fontSize: CHAPTER_DISPLAY_FONT_SIZE,
          isChapterStart: true,
          chapterId: null,
        },
        "compactPartHeading",
        entry.pageIndex,
        line
      )
      index += 1
      continue
    }

    if (isNarrativeBoundaryLine(text, line)) {
      pendingConnective = null
      const { skip, canonical } = consumeRepeatedSectionLabel(text, sectionLabelState)
      if (skip) {
        index += 1
        continue
      }

      pushHeadingBlock(
        blocks,
        {
          text: canonical,
          isHeading: true,
          fontSize: 15,
          isChapterStart: true,
          chapterId: null,
        },
        "narrativeBoundary",
        entry.pageIndex,
        line
      )
      index += 1
      continue
    }

    const headingPreviousBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null
    const skipHeadingForProseContinuation =
      headingPreviousBlock &&
      !headingPreviousBlock.isHeading &&
      isHeadingProseLineContinuation(text, headingPreviousBlock, line, entry)

    if (
      !skipHeadingForProseContinuation &&
      isTocHeadingCandidate(text, line, headingStrings, lineIndex, entry)
    ) {
      const { run, nextIndex } = collectConsecutiveTocHeadingRun(
        allLines,
        index,
        headingStrings,
        lineIndex
      )

      const runIsTocListings = run.every((entry) => isTocChapterListingLine(entry.text))

      if (run.length >= 3 && runIsTocListings) {
        pendingConnective = null
        nonEmptyLineIndex += run.length - 1
        index = nextIndex
        continue
      }

      pendingConnective = null
      for (let runIndex = 0; runIndex < run.length; runIndex += 1) {
        const runEntry = run[runIndex]
        const runText = runEntry.text.trim()
        const { skip, canonical } = consumeRepeatedSectionLabel(
          runText,
          sectionLabelState
        )
        if (skip) {
          continue
        }

        const isListing = isTocChapterListingLine(runText)
        const isBoundary = isNarrativeBoundaryLine(runText, runEntry.line)
        const isStructuralStart = isCleanStructuralHeadingText(
          runText,
          runEntry.line
        )
        pushHeadingBlock(
          blocks,
          {
            text: canonical,
            isHeading: true,
            fontSize: isListing || isBoundary
              ? 15
              : Math.max(14, Math.round(runEntry.line.fontSize ?? 16)),
            isChapterStart: isStructuralStart,
            chapterId: null,
          },
          isListing
            ? "tocHeadingRunListing"
            : isBoundary
              ? "tocHeadingRunBoundary"
              : "tocHeadingRun",
          runEntry.pageIndex,
          runEntry.line
        )
      }
      nonEmptyLineIndex += run.length - 1
      index = nextIndex
      continue
    }

    let proseText = text
    if (pendingConnective) {
      proseText = joinWrappedText(pendingConnective, proseText)
      pendingConnective = null
    }

    const previousBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null
    const previousEntry = index > 0 ? allLines[index - 1] : null

    const previous = blocks[blocks.length - 1]
    const forceNewProseBlock =
      previous &&
      !previous.isHeading &&
      proseBlockExceedsMergeLimit(previous) &&
      !isShortProseContinuation(proseText, previous)

    if (
      shouldStartNewProseBlock(line, previousBlock, entry, previousEntry) ||
      forceNewProseBlock
    ) {
      const proseBlock = {
        text: proseText,
        isHeading: false,
        fontSize: 12,
        chapterId: null,
      }
      applyProseBlockDefaults(proseBlock, line, proseText)
      blocks.push(withSourcePdfPage(proseBlock, entry.pageIndex))
      index += 1
      continue
    }

    if (
      proseFormattingDiffers(line, previous) &&
      !isProseLineContinuation(proseText, previous)
    ) {
      const splitBlock = {
        text: proseText,
        isHeading: false,
        fontSize: 12,
        chapterId: null,
      }
      applyProseBlockDefaults(splitBlock, line, proseText)
      blocks.push(withSourcePdfPage(splitBlock, entry.pageIndex))
      index += 1
      continue
    }

    const previousWordCount = (previous.text ?? "").split(/\s+/).filter(Boolean).length
    const previousCharCount = (previous.text ?? "").length
    const proseWordCount = proseText.split(/\s+/).filter(Boolean).length
    if (
      !isShortProseContinuation(proseText, previous) &&
      (previousWordCount >= MAX_PROSE_BLOCK_WORDS ||
        previousCharCount >= MAX_PROSE_BLOCK_CHARS ||
        previousWordCount + proseWordCount > MAX_PROSE_BLOCK_WORDS ||
        previousCharCount + proseText.length + 1 > MAX_PROSE_BLOCK_CHARS)
    ) {
      const proseBlock = {
        text: proseText,
        isHeading: false,
        fontSize: 12,
        chapterId: null,
      }
      applyProseBlockDefaults(proseBlock, line, proseText)
      blocks.push(withSourcePdfPage(proseBlock, entry.pageIndex))
    } else {
      previous.text = joinWrappedText(previous.text, proseText)
      if (line.indented) {
        previous.isIndented = true
      }
      applyProseFormattingToBlock(previous, line)
    }
    index += 1
  }

  return blocks
}

function countWordsInPlainText(text) {
  if (typeof text !== "string" || !text.trim()) {
    return 0
  }

  return text
    .replace(/\u00AD/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean).length
}

function countWordsFromContent(content) {
  if (!Array.isArray(content)) {
    return 0
  }

  let total = 0

  for (const page of content) {
    for (const block of page.blocks ?? []) {
      if (block?.type === "image_candidate" || block?.type === "image") {
        continue
      }
      total += countWordsInPlainText(block.text)
    }
  }

  return total
}

function countWordsFromBlocks(blocks) {
  if (!Array.isArray(blocks)) {
    return 0
  }

  return blocks.reduce((total, block) => {
    if (block?.type === "image_candidate" || block?.type === "image") {
      return total
    }
    return total + countWordsInPlainText(block.text)
  }, 0)
}

async function resolveWordCountForDocument(documentRow, userId) {
  const storedCount = Number(documentRow.word_count)
  if (Number.isFinite(storedCount) && storedCount > 0) {
    return storedCount
  }

  const fromContent = countWordsFromContent(documentRow.content)
  if (fromContent > 0) {
    void supabase
      .from("documents")
      .update({ word_count: fromContent })
      .eq("id", documentRow.id)
      .eq("user_id", userId)
      .then(({ error }) => {
        if (error) {
          console.warn(
            `[word-count] Failed to backfill word_count for ${documentRow.id}:`,
            error.message
          )
        }
      })
    return fromContent
  }

  return 0
}

function toPublicDocument(documentRow, wordCount) {
  return {
    id: documentRow.id,
    name: documentRow.name,
    total_pages: documentRow.total_pages,
    created_at: documentRow.created_at,
    word_count: wordCount,
    parse_status: documentRow.parse_status ?? PARSE_STATUS.READY,
  }
}

function readStoredDocumentContent(documentRow) {
  if (Array.isArray(documentRow?.content) && documentRow.content.length > 0) {
    return {
      parsedText: {
        numpages: documentRow.total_pages ?? documentRow.content.length,
      },
      chapters: documentRow.chapters ?? [],
      contentWithChapters: documentRow.content,
      wordCount: documentRow.word_count ?? 0,
    }
  }

  try {
    const cached =
      typeof documentRow?.parsed_cache === "string"
        ? JSON.parse(documentRow.parsed_cache)
        : documentRow.parsed_cache
    if (!cached || !Array.isArray(cached.contentWithChapters)) {
      return null
    }
    return cached
  } catch {
    return null
  }
}

function buildParsedCacheFields() {
  return {
    parsed_cache: null,
    parsed_cache_version: PARSER_VERSION,
  }
}

function sanitizeStorageString(value) {
  if (typeof value !== "string") {
    return value
  }
  if (!value.includes("\u0000")) {
    return value
  }
  return value.replace(/\u0000/g, "")
}

function sanitizeDocumentStoragePayload(payload) {
  if (payload == null) {
    return payload
  }

  if (typeof payload === "string") {
    return sanitizeStorageString(payload)
  }

  if (Array.isArray(payload)) {
    return payload.map((entry) => sanitizeDocumentStoragePayload(entry))
  }

  if (typeof payload !== "object") {
    return payload
  }

  const sanitized = {}
  for (const [key, value] of Object.entries(payload)) {
    sanitized[key] = sanitizeDocumentStoragePayload(value)
  }
  return sanitized
}

function buildOpenDocumentPayload(documentRow, cached) {
  return {
    id: documentRow.id,
    name: documentRow.name,
    total_pages: cached.parsedText?.numpages ?? documentRow.total_pages,
    chapters: cached.chapters,
    content: cached.contentWithChapters,
    parser_version: documentRow.parser_version ?? PARSER_VERSION,
  }
}

async function downloadStoredPdfBuffer(storagePath, { timeoutMs = 120_000 } = {}) {
  const downloadPromise = supabase.storage.from("pdfs").download(storagePath)

  let timeoutId
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("PDF download timed out")),
      timeoutMs
    )
  })

  try {
    const { data: storageFile, error: downloadError } = await Promise.race([
      downloadPromise,
      timeoutPromise,
    ])

    if (downloadError || !storageFile) {
      throw new Error("Failed to download source PDF")
    }

    return Buffer.from(await storageFile.arrayBuffer())
  } finally {
    clearTimeout(timeoutId)
  }
}

async function resumePendingDocumentParses() {
  const { data, error } = await supabase
    .from("documents")
    .select("id, user_id, storage_path, name, parse_status")
    .eq("parse_status", PARSE_STATUS.PENDING)
    .order("created_at", { ascending: true })
    .limit(3)

  if (error || !Array.isArray(data)) {
    if (error) {
      console.warn("[parse-resume] Failed to list pending documents:", error.message)
    }
    return
  }

  for (const row of data) {
    if (!row?.id || !row.storage_path || backgroundParseInFlight.has(row.id)) {
      continue
    }

    console.log(`[parse-resume] Resuming pending parse for document ${row.id}`)
    void parseDocumentInBackground(row.id, row.user_id, row.storage_path, row.name ?? "")
  }
}

const SAVE_PARSED_DOCUMENT_MAX_RETRIES = 6
const SAVE_PARSED_DOCUMENT_RETRY_BASE_MS = 1500

function scheduleBackgroundParse(documentId, userId, storagePath, fileName) {
  // Detach from the upload HTTP request. The client may navigate away or close
  // the connection as soon as the upload response arrives; parsing must continue.
  setImmediate(() => {
    void parseDocumentInBackground(documentId, userId, storagePath, fileName)
  })
}

async function saveParsedDocumentWithRetry(documentId, userId, documentUpdate) {
  let lastError = null

  for (let attempt = 1; attempt <= SAVE_PARSED_DOCUMENT_MAX_RETRIES; attempt += 1) {
    const { error: updateError } = await supabase
      .from("documents")
      .update(documentUpdate)
      .eq("id", documentId)
      .eq("user_id", userId)

    if (!updateError) {
      return
    }

    lastError = updateError
    const message = updateError.message ?? String(updateError)
    const retryable = isRetryableStorageError(message)

    console.warn(
      `[parse-save] Attempt ${attempt}/${SAVE_PARSED_DOCUMENT_MAX_RETRIES} failed for ${documentId}: ${message}`
    )

    if (!retryable || attempt >= SAVE_PARSED_DOCUMENT_MAX_RETRIES) {
      break
    }

    await sleep(SAVE_PARSED_DOCUMENT_RETRY_BASE_MS * attempt)
  }

  const message = lastError?.message ?? "Unknown error"
  throw new Error(
    message ? `Failed to save parsed document: ${message}` : "Failed to save parsed document"
  )
}

async function parseDocumentInBackground(documentId, userId, storagePath, fileName) {
  if (backgroundParseInFlight.has(documentId)) {
    return
  }

  backgroundParseInFlight.add(documentId)
  setDocumentParseProgress(documentId, {
    phase: "starting",
    label: "Opening PDF",
    current: 0,
    total: 0,
    percent: 0,
  })

  const parseStartedAt = Date.now()
  const progressHeartbeat = setInterval(() => {
    const live = getDocumentParseProgress(documentId)
    if (live) {
      setDocumentParseProgress(documentId, {
        ...live,
        updatedAt: Date.now(),
      })
    }
  }, 2000)

  try {
    await runWithFullParseGate(
      async () => {
        assertParseNotCancelled(documentId)

        setDocumentParseProgress(documentId, {
          phase: "starting",
          label: "Downloading PDF",
          current: 0,
          total: 0,
          percent: 1,
        })

        const buffer = await downloadStoredPdfBuffer(storagePath)
        assertParseNotCancelled(documentId)

        setDocumentParseProgress(documentId, {
          phase: "starting",
          label: "Opening PDF",
          current: 0,
          total: 0,
          percent: 2,
        })

        const { parsedText, chapters, contentWithChapters, wordCount } =
          await parsePdfBuffer(buffer, fileName, {
            documentId,
            onPageProcessed(pageNumber, totalPages) {
              if (pageNumber % 100 === 0 || pageNumber === totalPages) {
                console.log(
                  `Parsed ${pageNumber}/${totalPages} pages for document ${documentId}`
                )
              }
            },
            onProgress(progress) {
              assertParseNotCancelled(documentId)
              setDocumentParseProgress(documentId, progress)
            },
          })

        assertParseNotCancelled(documentId)

        setDocumentParseProgress(documentId, {
          phase: "saving",
          label: "Saving to your library",
          current: 0,
          total: 0,
          percent: PARSE_PROGRESS_SAVE_PERCENT,
        })

        console.log(
          `Background parse finished for ${documentId} (${parsedText.numpages} PDF pages, ${wordCount.toLocaleString()} words) in ${((Date.now() - parseStartedAt) / 1000).toFixed(1)}s`
        )

        const documentUpdate = sanitizeDocumentStoragePayload({
          total_pages: parsedText.numpages,
          chapters,
          content: contentWithChapters,
          word_count: wordCount,
          parser_version: PARSER_VERSION,
          parse_status: PARSE_STATUS.READY,
          parse_progress: null,
          ...buildParsedCacheFields(),
        })

        await saveParsedDocumentWithRetry(documentId, userId, documentUpdate)

        clearDocumentParseProgress(documentId)
      },
      {
        wait: true,
        priority: PARSE_GATE_UPLOAD_PRIORITY,
        documentId,
        onWaiting() {
          setDocumentParseProgress(documentId, {
            phase: "starting",
            label: "Waiting to start",
            current: 0,
            total: 0,
            percent: 0,
          })
        },
      }
    )
  } catch (error) {
    if (error instanceof Error && error.message === "PARSE_CANCELLED") {
      console.log(`Background parse cancelled for document ${documentId}`)
      clearDocumentParseProgress(documentId)
      return
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(
      `Background parse failed for document ${documentId}:`,
      errorMessage,
      error instanceof Error && error.stack ? `\n${error.stack}` : ""
    )

    setDocumentParseProgress(documentId, {
      phase: "error",
      // Internal exception text stays in server logs; clients polling the
      // status endpoint get a generic label instead.
      label: "Processing failed. Please retry.",
      current: 0,
      total: 0,
      percent: 0,
    })

    await setDocumentParseStatus(documentId, PARSE_STATUS.ERROR, userId)
  } finally {
    clearInterval(progressHeartbeat)
    backgroundParseInFlight.delete(documentId)
    clearCancelledBackgroundParse(documentId)
  }
}

function normalizeChapterHeadingFontSizes(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  return blocks.map((block) => {
    if (block?.type === "image" || block?.type === "image_candidate") {
      return block
    }
    if (block?.isHeading && block?.isChapterStart) {
      return { ...block, fontSize: CHAPTER_DISPLAY_FONT_SIZE }
    }
    return block
  })
}

function stripBoldFromCenteredProseBlock(block) {
  const runs = block.runs?.map((run) => {
    const nextRun = { ...run }
    delete nextRun.bold
    return nextRun
  })

  return {
    ...block,
    isHeading: false,
    isChapterStart: false,
    chapterTitle: undefined,
    fontSize: 12,
    centered: true,
    textAlign: "center",
    bold: false,
    ...(runs?.length ? { runs } : {}),
  }
}

// A centered title "opens a new story section" when the next meaningful block
// is narrative prose rather than another heading. This separates an anthology
// fable title (followed by the fable's prose) from back-to-back display lines
// such as a back-matter advertisement list, where one heading follows another.
function centeredTitleOpensNewStorySection(blocks, index) {
  for (let cursor = index + 1; cursor < blocks.length; cursor += 1) {
    const next = blocks[cursor]
    if (next?.type === "image" || next?.type === "image_candidate") {
      continue
    }
    const nextText = (next?.text ?? "").trim()
    if (!nextText) {
      continue
    }
    if (next.isHeading || next.isChapterStart) {
      return false
    }
    return isNarrativeSentenceLine(nextText) || nextText.length >= 40
  }
  return false
}

function normalizeCenteredDecorativeProseBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  return blocks.map((block, index) => {
    if (block?.type === "image" || block?.type === "image_candidate") {
      return block
    }

    const text = (block?.text ?? "").trim()
    const lineLike = {
      centered: block.centered,
      textAlign: block.textAlign,
      fontSize: block.fontSize,
    }
    const shouldNormalize =
      isCenteredDecorativeProseText(text, lineLike, null) ||
      (block?.isHeading && isCenteredDecorativeProseText(text, lineLike, null))

    if (!shouldNormalize) {
      return block
    }

    // Defer to story-title detection: in an anthology each fable opens with a
    // short centered title (often all-caps) that is a genuine promoted chapter
    // start followed by the fable's narrative prose. The decorative-prose
    // normalization would otherwise strip that heading status and merge the
    // title into the body. Genuine centered decorative prose (temporal scene
    // markers, repeated chant lines such as 1984's "DOWN WITH BIG BROTHER",
    // centered dialogue fragments) is never promoted to a heading and never
    // opens a new section, so it is left untouched here.
    if (
      !isTemporalSceneMarkerText(text) &&
      isFableStoryTitleBlock(block) &&
      centeredTitleOpensNewStorySection(blocks, index)
    ) {
      return block
    }

    return stripBoldFromCenteredProseBlock(block)
  })
}

function applyBlockTransformPipeline(blocks, { printedToc = null } = {}) {
  return normalizeCenteredDecorativeProseBlocks(
    normalizeChapterHeadingFontSizes(
      promoteFableStoryTitleBlocks(
        promoteStructuralSectionHeadings(
          mergeEndOfPartBlocks(
            mergeTrailingChapterTitleFragments(
              mergeInlineChapterLabelTitles(
                mergePartHeadingBlocks(
                  mergeChapterSubtitleBlocks(
                    mergeMultilineFableTitleBlocks(
                      mergeMultilineChapterTitleBlocks(
                        splitDialogueHeavyBlocks(splitEmbeddedPartHeadings(blocks))
                      )
                    ),
                    printedToc
                  )
                )
              )
            )
          )
        )
      )
    )
  )
}

function blocksToContent(blocks, blocksPerPage = 40) {
  const content = []

  for (let index = 0; index < blocks.length; index += blocksPerPage) {
    content.push({
      pageIndex: content.length,
      blocks: blocks.slice(index, index + blocksPerPage),
    })
  }

  return content
}

async function parsePdfBuffer(
  buffer,
  fileName = "",
  { onPageProcessed, onProgress, documentId } = {}
) {
  let progressSnapshot = null
  const reportProgress = (patch) => {
    progressSnapshot = mergeParseProgressSnapshot(progressSnapshot, patch)
    onProgress?.(progressSnapshot)
  }

  reportProgress({
    phase: "starting",
    label: "Opening PDF",
    current: 0,
    total: 0,
    percent: 0,
  })

  const [puaReplacementMap, pdf] = await Promise.all([
    Promise.resolve(buildDefaultPuaReplacementMap(buffer)),
    loadPdfDocument(buffer),
  ])

  reportProgress({
    phase: "extracting",
    label: "Reading PDF pages",
    current: 0,
    total: pdf.numPages,
    percent: 0,
    extractSubphase: "text",
  })

  let pageData
  let headingStrings
  let numPages
  let pdfInfo
  let pageImageCandidates

  try {
    ;({
      pageData,
      headingStrings,
      numPages,
      pdfInfo,
      pageImageCandidates,
    } = await extractPdfStructure(buffer, {
      pdf,
      puaReplacementMap,
      onPageProcessed(pageNumber, totalPages, { extractSubphase = "text" } = {}) {
        onPageProcessed?.(pageNumber, totalPages)

        let label =
          extractSubphase === "filtering"
            ? "Cleaning extracted text"
            : extractSubphase === "text_complete"
              ? "Text scan complete"
              : extractSubphase === "images"
                ? "Scanning page artwork"
                : totalPages > 0
                  ? `Reading page ${pageNumber} of ${totalPages}`
                  : "Reading PDF pages"

        reportProgress({
          phase: "extracting",
          label,
          current: pageNumber,
          total: totalPages,
          extractSubphase,
          percent: extractPhasePercent(pageNumber, totalPages, extractSubphase),
        })
      },
    }))
    await resolvePageImageCandidateBuffers(pdf, pageImageCandidates, (pageNumber, totalPages, extra = {}) => {
      reportProgress({
        phase: "extracting",
        label: "Loading illustration data",
        current: pageNumber,
        total: totalPages,
        extractSubphase: "images",
        percent: extractPhasePercent(pageNumber, totalPages, "images"),
        imageBufferCurrent: extra.imageBufferCurrent ?? null,
        imageBufferTotal: extra.imageBufferTotal ?? null,
      })
    })
  } finally {
    if (typeof pdf.destroy === "function") {
      await pdf.destroy()
    }
  }

  const parsedText = {
    numpages: numPages,
    info: pdfInfo,
    text: "",
  }

  reportProgress({
    phase: "structuring",
    label: "Organizing book text",
    structureStep: "lines",
    current: 0,
    total: numPages,
    percent: structurePhasePercent("lines", 0, numPages),
    counters: {
      pages: { current: 0, total: numPages },
      illustrations: { current: 0, total: 0 },
      ocr: { current: 0, total: 0 },
      uploads: { current: 0, total: 0 },
    },
    pageCurrent: 0,
    pageTotal: numPages,
  })

  const printedTocFromPages = extractPrintedTocFromPageData(pageData)
  const isPoetryCollection = documentIsPoetryCollection(pageData)

  const reportLineProgress = (current, total) => {
    reportProgress({
      phase: "structuring",
      label: "Organizing book text",
      structureStep: "lines",
      current,
      total,
      percent: structurePhasePercent("lines", current, total),
    })
  }

  // Poetry collections are built by a dedicated verse builder that preserves
  // each source line and promotes poem titles to chapters. It deliberately
  // bypasses the prose-oriented transform pipeline (paragraph reflow, chapter /
  // subtitle merging) which would destroy the line breaks the verse relies on.
  let blocks = isPoetryCollection
    ? buildPoetryBlocksFromLines(pageData, { onProgress: reportLineProgress })
    : applyBlockTransformPipeline(
        buildBlocksFromLines(pageData, headingStrings, {
          printedToc: printedTocFromPages,
          onProgress: reportLineProgress,
        }),
        { printedToc: printedTocFromPages }
      )

  reportProgress({
    phase: "structuring",
    label: "Merging chapters and paragraphs",
    structureStep: "transform",
    current: numPages,
    total: numPages,
    percent: structurePhasePercent("transform"),
  })

  const bookTitle = resolveBookTitle(parsedText, fileName, blocks)

  // Removing publisher front matter is a separate concern from preserving verse,
  // so the front-matter cleaners run for poetry too - but bounded to the stretch
  // ahead of the printed-TOC heading and the first poem. Unbounded, their
  // "several title-like lines on one page" test flags the printed contents page
  // of a poetry collection as a catalog page and consumes the "Contents" anchor
  // stripPoetryPrintedTocPages depends on.
  const frontMatterScanLimit = isPoetryCollection
    ? findPoetryFrontMatterLimit(blocks)
    : undefined
  blocks = stripPublisherCatalogBlocks(blocks, bookTitle, {
    scanLimit: frontMatterScanLimit,
  })
  blocks = dedupeFrontMatterTitleBlocks(blocks, bookTitle, {
    scanLimit: frontMatterScanLimit,
  })
  blocks = stripCoreKnowledgeFrontMatterBoilerplate(blocks, {
    scanLimit: frontMatterScanLimit,
  })

  reportProgress({
    phase: "structuring",
    label: "Reading chapter outline",
    structureStep: "outline",
    current: numPages,
    total: numPages,
    percent: structurePhasePercent("outline"),
  })

  const printedToc =
    printedTocFromPages ?? extractPrintedTocLookup(blocks)
  if (!isPoetryCollection) {
    blocks = excludePrintedTocBlocks(blocks)
    blocks = normalizeFrontAndBackMatterBlocks(blocks)
    blocks = injectStormlightPreludeHeading(blocks)
    blocks = injectStormlightPrologueHeading(blocks, printedToc)
  } else {
    // Printed-TOC removal is a separate concern from verse preservation, so it
    // runs for poetry too - via the page-anchored variant, which touches only
    // whole contents pages ahead of the first poem and never reflows a line.
    blocks = stripPoetryPrintedTocPages(blocks)
  }

  reportProgress({
    phase: "structuring",
    label: "Placing illustrations in layout",
    structureStep: "interleave",
    current: 0,
    total: numPages,
    percent: structurePhasePercent("interleave", 0, numPages),
  })

  blocks = interleaveImageCandidateBlocks(blocks, pageImageCandidates, pageData, {
    onProgress(current, total) {
      reportProgress({
        phase: "structuring",
        label: "Placing illustrations in layout",
        structureStep: "interleave",
        current,
        total,
        percent: structurePhasePercent("interleave", current, total),
      })
    },
  })

  const illustrationCandidateCount = blocks.filter(
    (block) => block?.type === "image_candidate" && block.isCandidate
  ).length

  reportProgress({
    phase: "classifying_illustrations",
    label: "Classifying artwork",
    current: 0,
    total: illustrationCandidateCount,
    percent: PARSE_PROGRESS_ILLUSTRATION_START_PERCENT,
    usingPrintedToc: Boolean(printedToc),
    illustrationCurrent: 0,
    illustrationTotal: illustrationCandidateCount,
  })

  blocks = await finalizeIllustrationBlocks(blocks, {
    onProgress: reportProgress,
    printedToc,
    illustrationProgressRange: {
      start: PARSE_PROGRESS_ILLUSTRATION_START_PERCENT,
      end: PARSE_PROGRESS_ILLUSTRATION_END_PERCENT,
    },
  })

  blocks = injectCoverTitlePage(blocks, {
    bookTitle,
    authorText: sanitizePdfAuthor(parsedText?.info?.Author ?? ""),
    metaTitle: parsedText?.info?.Title ?? "",
    pageData,
    fileName,
  })

  // In a poetry collection the recurring decorative plates (e.g. the woven
  // "I Shall Not Be Moved" quilt that opens a sub-collection) are extracted as
  // mid-size "chapter_heading" images and would otherwise be crammed beneath the
  // preceding poem. Present them as full-page illustrations that occupy their own
  // page so they read as the section plates they are. The cover, already a
  // full_page_illustration, is left untouched.
  if (isPoetryCollection) {
    blocks = blocks.map((block) =>
      block?.type === "image" && block.imageRole === "chapter_heading"
        ? { ...block, imageRole: "full_page_illustration", forcesOwnPage: true }
        : block
    )
  }

  if (printedToc) {
    blocks = supplementBannerlessPrintedChapters(blocks, printedToc)
    blocks = reanchorLatePartHeadingBlocks(blocks, printedToc)
  }

  // Runs after image interleave/classification so trailing art plates on
  // stripped pages (e.g. the Way of Kings back-matter plate) go with the text
  // instead of dangling as the book's final content.
  blocks = stripTrailingNonNarrativeMatterBlocks(blocks)

  await terminateOcrWorker()

  const imageBlockCount = blocks.filter((block) => block?.type === "image").length
  if (documentId && imageBlockCount > 0) {
    reportProgress({
      phase: "uploading_assets",
      label: "Uploading book illustrations",
      current: 0,
      total: imageBlockCount,
      percent: PARSE_PROGRESS_ILLUSTRATION_END_PERCENT,
    })

    blocks = await uploadBookAssets(documentId, blocks, {
      onProgress({ current, total }) {
        const uploadSpan =
          PARSE_PROGRESS_UPLOAD_MAX_PERCENT - PARSE_PROGRESS_ILLUSTRATION_END_PERCENT
        const uploadPercent =
          total > 0
            ? Math.round((current / total) * uploadSpan)
            : uploadSpan
        reportProgress({
          phase: "uploading_assets",
          label: "Uploading book illustrations",
          current,
          total,
          percent: PARSE_PROGRESS_ILLUSTRATION_END_PERCENT + uploadPercent,
        })
      },
    })
  }

  blocks = stripAllImageBinaryFieldsFromBlocks(blocks)

  const content = blocksToContent(blocks)

  const { chapters, content: contentWithChapters } = detectChapters(content, bookTitle)
  const wordCount = countWordsFromBlocks(blocks)

  if (BOOKY_BB_DEBUG) {
    const flatBlocks = contentWithChapters.flatMap((page) => page.blocks ?? [])
    const standaloneHits = flatBlocks.filter((block) =>
      /^DOWN WITH BIG BROTHER$/i.test((block.text ?? "").trim())
    )
    const embeddedHits = flatBlocks.filter((block) =>
      bbMatchesPhrase(block.text) &&
      !/^DOWN WITH BIG BROTHER$/i.test((block.text ?? "").trim())
    )
    bbLog("final-structured-blocks", {
      standaloneCount: standaloneHits.length,
      embeddedCount: embeddedHits.length,
      chapterCount: chapters.length,
      wordCount,
      samples: standaloneHits.slice(0, 5).map((block) => ({
        text: block.text,
        textAlign: block.textAlign,
        isHeading: block.isHeading,
      })),
    })
  }

  reportProgress({
    phase: "finalizing",
    label: "Detecting chapters",
    current: 0,
    total: 0,
    percent: PARSE_PROGRESS_FINALIZE_PERCENT,
  })

  return {
    parsedText,
    chapters,
    contentWithChapters,
    wordCount,
    bookTitle,
    pageImageCandidates,
    imageCandidateCount: (pageImageCandidates ?? []).flat().length,
  }
}

function isValidAdminSecret(secret) {
  const expected = process.env.ADMIN_SECRET
  if (!expected || typeof secret !== "string") {
    return false
  }
  // Constant-time comparison so response timing does not reveal how many
  // leading characters of the secret matched. Buffers must be equal length
  // for timingSafeEqual, so hash both sides first.
  const secretDigest = crypto.createHash("sha256").update(secret).digest()
  const expectedDigest = crypto.createHash("sha256").update(expected).digest()
  return crypto.timingSafeEqual(secretDigest, expectedDigest)
}

function contentLooksStale(content) {
  if (!Array.isArray(content)) {
    return false
  }

  for (const page of content) {
    for (const block of page.blocks ?? []) {
      const text = block.text ?? ""
      if (/Go to With a sort of military precision/i.test(text)) {
        return true
      }
      if (isScannerWatermarkLine(text)) {
        return true
      }
      if (
        isShortDialogueLine(text) &&
        (block.textAlign === "center" || block.centered === true)
      ) {
        return true
      }
    }
  }

  return false
}

function documentNeedsReparse(documentRow, { force = false } = {}) {
  if (force) {
    return Boolean(documentRow.storage_path)
  }
  if (!documentRow.storage_path) {
    return false
  }

  const documentParserVersion = Number(documentRow.parser_version ?? 0)
  if (documentParserVersion > PARSER_VERSION) {
    return false
  }
  if (documentParserVersion < PARSER_VERSION) {
    return true
  }
  return contentLooksStale(documentRow.content)
}

async function reparseDocumentInBackgroundFromRow(documentRow, { skipIfParseBusy = false } = {}) {
  const documentId = documentRow?.id
  if (!documentId || backgroundParseInFlight.has(documentId)) {
    return
  }

  backgroundParseInFlight.add(documentId)
  try {
    const result = await reparseDocumentIfOutdated(documentRow, {
      waitForParseSlot: !skipIfParseBusy,
    })
    if (result?.skipped) {
      console.log(
        `[parseGate] Skipped background reparse for ${documentId} — another full parse is in progress`
      )
    }
  } catch (error) {
    console.error(`Background re-parse failed for ${documentId}:`, error)
    await setDocumentParseStatus(documentId, PARSE_STATUS.ERROR)
  } finally {
    backgroundParseInFlight.delete(documentId)
  }
}

async function reparseDocumentIfOutdated(documentRow, options = {}) {
  if (!documentNeedsReparse(documentRow, options)) {
    return { updated: false }
  }

  const waitForParseSlot = options.waitForParseSlot !== false
  const gateOutcome = await runWithFullParseGate(
    () => reparseDocumentIfOutdatedCore(documentRow),
    {
      wait: waitForParseSlot,
      priority: PARSE_GATE_REPARSE_PRIORITY,
    }
  )

  if (gateOutcome?.skipped) {
    return { updated: false, skipped: true }
  }

  return gateOutcome
}

async function reparseDocumentIfOutdatedCore(documentRow) {
  try {
    const fileBuffer = await downloadStoredPdfBuffer(documentRow.storage_path)
    const parseResult = await parsePdfBuffer(fileBuffer, documentRow.name ?? "", {
      documentId: documentRow.id,
    })
    const { parsedText, chapters, contentWithChapters, wordCount } = parseResult

    const { error: updateError } = await supabase
      .from("documents")
      .update(
        sanitizeDocumentStoragePayload({
          total_pages: parsedText.numpages,
          chapters,
          content: contentWithChapters,
          word_count: wordCount,
          parser_version: PARSER_VERSION,
          parse_status: PARSE_STATUS.READY,
          ...buildParsedCacheFields(),
        })
      )
      .eq("id", documentRow.id)

    if (updateError) {
      throw new Error("Failed to update document with re-parsed content")
    }

    return { updated: true }
  } catch (error) {
    await setDocumentParseStatus(documentRow.id, PARSE_STATUS.ERROR)
    throw error
  }
}

async function reparseOutdatedDocuments({ limit = 5 } = {}) {
  const summary = {
    reparsed: 0,
    failed: [],
    skipped: 0,
  }

  const { data: documents, error: fetchError } = await supabase
    .from("documents")
    .select("id, storage_path, name, parser_version, content")
    .or(`parser_version.lt.${PARSER_VERSION},parser_version.is.null`)
    .order("created_at", { ascending: true })
    .limit(limit)

  if (fetchError) {
    throw new Error("Failed to load outdated documents")
  }

  const total = documents?.length ?? 0
  if (total === 0) {
    return summary
  }

  for (let index = 0; index < total; index += 1) {
    const documentRow = documents[index]

    if (!documentRow.storage_path) {
      summary.skipped += 1
      continue
    }

    console.log(`Re-parsing document ${documentRow.id} (${index + 1} of ${total})...`)

    try {
      const result = await reparseDocumentIfOutdated(documentRow, {
        waitForParseSlot: false,
      })
      if (result.updated) {
        summary.reparsed += 1
      } else {
        summary.skipped += 1
      }
    } catch (error) {
      summary.failed.push({
        id: documentRow.id,
        error: error instanceof Error ? error.message : "Re-parse failed",
      })
      await setDocumentParseStatus(documentRow.id, PARSE_STATUS.ERROR)
    }
  }

  return summary
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      cb(new Error("Only PDF files are supported."))
      return
    }
    cb(null, true)
  },
})

app.post("/upload", requireAuth, (req, res) => {
  upload.single("file")(req, res, async (uploadError) => {
    if (uploadError) {
      // Client mistakes (too large, wrong type) are 4xx, not 500. Multer size
      // rejections carry code LIMIT_FILE_SIZE; the PDF fileFilter rejection is
      // a plain Error with our own message.
      if (uploadError instanceof multer.MulterError) {
        const status = uploadError.code === "LIMIT_FILE_SIZE" ? 413 : 400
        const message =
          uploadError.code === "LIMIT_FILE_SIZE"
            ? "File is too large (max 50 MB)."
            : "Invalid upload request."
        res.status(status).json({ success: false, error: message })
        return
      }
      res.status(400).json({ success: false, error: uploadError.message })
      return
    }

    try {
      const uploadedFile = req.file

      if (!uploadedFile) {
        res.status(400).json({ success: false, error: "No file uploaded." })
        return
      }

      // The multer fileFilter only sees the client-declared MIME type, which
      // is trivially spoofed. Check the PDF magic bytes so arbitrary payloads
      // never reach storage or the parse pipeline.
      if (!uploadedFile.buffer?.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
        res.status(400).json({ success: false, error: "File is not a valid PDF." })
        return
      }

      const title =
        humanizeBookTitleFromFileName(uploadedFile.originalname) ||
        uploadedFile.originalname.replace(/\.pdf$/i, "")
      // Storage keys must not inherit path separators or exotic characters
      // from the client-supplied filename.
      const safeFileName =
        uploadedFile.originalname
          .replace(/\.pdf$/i, "")
          .replace(/[^a-zA-Z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 120) || "document"
      const storagePath = `${Date.now()}-${safeFileName}.pdf`
      const { data: storageData, error: storageError } = await supabase.storage
        .from("pdfs")
        .upload(storagePath, uploadedFile.buffer, {
          contentType: "application/pdf",
        })

      if (storageError) {
        res.status(500).json({ success: false, error: "Storage upload failed" })
        return
      }

      const { data: insertedDocument, error: insertError } = await supabase
        .from("documents")
        .insert({
          name: title,
          storage_path: storageData.path,
          total_pages: 0,
          word_count: 0,
          chapters: null,
          content: null,
          parser_version: PARSER_VERSION,
          parse_status: PARSE_STATUS.PENDING,
          user_id: req.userId,
        })
        .select("id")
        .single()

      if (insertError) {
        res.status(500).json({ success: false, error: "Database insert failed" })
        return
      }

      const documentId = insertedDocument.id
      const userId = req.userId
      const originalName = uploadedFile.originalname

      scheduleBackgroundParse(documentId, userId, storageData.path, originalName)

      res.json({
        success: true,
        document: {
          id: documentId,
          title,
          status: PARSE_STATUS.PENDING,
        },
      })
    } catch (error) {
      console.error("[upload] Upload failed:", error)
      res.status(500).json({ success: false, error: "Upload failed." })
    }
  })
})

app.post("/admin/reparse", async (req, res) => {
  const adminSecret = req.headers["x-admin-secret"]
  if (!isValidAdminSecret(adminSecret)) {
    res.status(401).json({ success: false, error: "Unauthorized" })
    return
  }

  try {
    const summary = await reparseOutdatedDocuments()
    res.json(summary)
  } catch (error) {
    console.error("[admin] Reparse failed:", error)
    res.status(500).json({ success: false, error: "Re-parse failed" })
  }
})

export {
  parsePdfBuffer,
  extractLinesByPosition,
  documentIsPoetryCollection,
  normalizeExtractedText,
  classifyPdfImageRole,
  isChapterHeaderCandidate,
  PDF_IMAGE_ROLE,
  interleaveImageCandidateBlocks,
  finalizeIllustrationBlocks,
  uploadBookAssets,
  PARSER_VERSION,
}

const isServerEntryPoint =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])

app.use((error, req, res, _next) => {
  applyCorsHeaders(req, res)
  console.error(
    `[server] ${req.method} ${req.path}:`,
    error instanceof Error ? error.message : String(error)
  )

  if (!res.headersSent) {
    res.status(500).json({ success: false, error: "Internal server error" })
  }
})

if (isServerEntryPoint) {
  // Background parse work runs detached from any request (setImmediate /
  // void promises), so a missed rejection there would otherwise kill the
  // process with no context. Log and keep serving; parse_status/error paths
  // already mark affected documents.
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[process] Unhandled promise rejection:",
      reason instanceof Error ? (reason.stack ?? reason.message) : reason
    )
  })
  process.on("uncaughtException", (error) => {
    console.error("[process] Uncaught exception:", error.stack ?? error)
  })

  const PORT = process.env.PORT || 3000
  app.listen(PORT, () => {
    console.log(`Server on port ${PORT}`)

    setTimeout(() => {
      void resumePendingDocumentParses()
    }, 5_000)

    if (process.env.BOOKY_REPARSE_ON_BOOT === "1") {
      setTimeout(async () => {
        try {
          const summary = await reparseOutdatedDocuments({ limit: 3 })
          if (summary.reparsed > 0 || summary.failed.length > 0) {
            console.log(
              `Background re-parse: ${summary.reparsed} updated, ${summary.failed.length} failed, ${summary.skipped} skipped`
            )
          }
        } catch (error) {
          console.error(
            "Background re-parse failed:",
            error instanceof Error ? error.message : "Unknown error"
          )
        }
      }, 5_000)
    }
  })
}
