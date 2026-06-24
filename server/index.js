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
  analyzeChapterHeadingBanner,
  shouldSkipChapterGraphicAnalysis,
  SAFE_FALLBACK,
} from "./chapterGraphicService.js"
import {
  countInterludeNamesInDivider,
  ocrIllustrationMetadata,
  terminateOcrWorker,
} from "./imageOcrService.js"
import {
  extractPrintedTocLookup,
  extractPrintedTocFromPageData,
  lookupPrintedTocTitle,
} from "./printedTocService.js"
import {
  buildReformattedHtml,
  buildReformattedPdfBuffer,
} from "./reformattedExportService.js"
import {
  extractChapterKeyFromOcrNumber,
  countInterludesAfterUpcomingBannerlessChapters,
  scanPendingInterludesFromBlocks,
  takeNextSequentialInterludeTocEntry,
  takeNextSequentialTocEntryForImageBanner,
} from "./stormlightEpigraphService.js"

const PARSER_VERSION = 92
const PDF_IMAGE_JPEG_CONTENT_TYPE = "image/jpeg"

const PDF_IMAGE_PAINT_OPS = new Set(
  [OPS.paintImageXObject, OPS.paintInlineImageXObject].filter((op) => op != null)
)
const PDF_IMAGE_RESOLVE_TIMEOUT_MS = 8000
const PDF_PAGE_OPERATION_TIMEOUT_MS = 45_000
const PDF_LARGE_BOOK_PAGE_THRESHOLD = 120
const PDF_LARGE_FILE_BYTES = 12 * 1024 * 1024
const ILLUSTRATION_VISION_CONCURRENCY = 4
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
  backgroundParseInFlight.delete(documentId)
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
const PDF_IMAGE_EXTRACTION_CONCURRENCY = 4
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

    const cached = readParsedCache(data)
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
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to load document.",
    })
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
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to re-parse document.",
    })
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

    setImmediate(() => {
      void parseDocumentInBackground(id, req.userId, data.storage_path, data.name ?? "")
    })

    res.json({ success: true, retrying: true })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to retry processing.",
    })
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

function extractToUnicodeCMapTextsFromPdfBuffer(buffer) {
  if (!pdfBufferLikelyContainsToUnicodeCMaps(buffer)) {
    return []
  }

  const pdfText = Buffer.from(buffer).toString("latin1")
  const cmapTexts = []
  const streamRegex =
    /(\d+) 0 obj\s*<<([\s\S]*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g

  for (const match of pdfText.matchAll(streamRegex)) {
    const body = match[2]
    const raw = Buffer.from(match[3], "latin1")
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

function isAllCapsChapterSubtitleText(text) {
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
  if (isScannerWatermarkLine(trimmed) || isAuthorStructuralLine(trimmed)) {
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

function isAllCapsChapterSubtitleLine(text, line) {
  if (!isAllCapsChapterSubtitleText(text)) {
    return false
  }
  return (line?.fontSize ?? 0) >= ALL_CAPS_CHAPTER_SUBTITLE_MIN_FONT_SIZE
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

  return {
    kind: match[1],
    number: match[2],
    subtitle: formatInferredTitleText(subtitle),
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
    while (cursor < blocks.length && isWrappedChapterTitleFragment(blocks[cursor])) {
      titleFragments.push((blocks[cursor].text ?? "").trim())
      cursor += 1
    }

    const rawSubtitle = titleFragments.join(" ").replace(/\s+/g, " ").trim()
    const subtitle = rawSubtitle ? formatInferredTitleText(rawSubtitle) : ""
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

    const subtitle = formatInferredTitleText(
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
          const combinedSubtitle = formatInferredTitleText(
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
  /^(introduction|preface|prologue|epilogue|conclusion|contents|illustrations)$/i

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
    if (countWordsInText(text) >= 8) {
      return false
    }
    return true
  }

  if (fontSize >= 20 && fontSize <= 35 && isPureAllCapsTitleText(text)) {
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

function resolveBookTitle(parsedText, fileName = "", blocks = []) {
  const fromMeta = sanitizePdfTitle(parsedText?.info?.Title ?? "")
  if (fromMeta && !looksLikeFilenameSlug(fromMeta)) {
    return fromMeta
  }

  const fromBlocks = inferBookTitleFromEarlyBlocks(blocks)
  if (fromBlocks && !looksLikeFilenameSlug(fromBlocks)) {
    return fromBlocks
  }

  const fromFile = humanizeBookTitleFromFileName(fileName)
  if (fromFile && !looksLikeFilenameSlug(fromFile)) {
    return fromFile
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

function contentStartsWithBookTitle(blocks, bookTitle) {
  const normalizedBook = normalizeHeadingCandidate(bookTitle).toLowerCase()
  if (!normalizedBook) {
    return false
  }

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

    if (
      normalizedBlock === normalizedBook ||
      normalizedBlock.includes(normalizedBook) ||
      normalizedBook.includes(normalizedBlock)
    ) {
      return true
    }
  }

  return false
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

const HEADING_DANGLING_ENDING_REGEX =
  /\b(?:of|the|a|an|and|but|or|nor|for|yet|so|left|fell|was|be|on|in|at|to|by|with|from|into|that|which|who|as|if|their|his|her|its|our|your|had|has|have|not|are|were|is)\s*$/i
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
const ROMAN_PAGE_MARKER_CLUSTER_REGEX = /^[ivxlcdm]{1,4}(?:\s+[ivxlcdm]{1,4}){0,3}$/i
const STANDALONE_RUNNING_HEAD_REGEX =
  /^\d{1,3}\s+(?:chapter|letter)\s+(?:[IVXLCDM]+|\d+)$/i
const ROMAN_SECTION_RUNNING_HEAD_REGEX =
  /^[IVXLCDM]{1,4}\s+(?:INTRODUCTION|PREFACE|PROLOGUE|EPILOGUE|CONCLUSION|CONTENTS|CHAPTER|PART)\b/i
const EMBEDDED_ROMAN_SECTION_RUNNING_HEAD_REGEX =
  /\b[IVXLCDM]{1,4}\s+(?:INTRODUCTION|PREFACE|PROLOGUE|EPILOGUE|CONCLUSION)\b/gi
const TOC_HEADER_LINE_REGEX = /^-\s*\d+\s*-\s*.+$/

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

function isLikelyAllCapsDisplayTitle(text, line = null, entry = null) {
  if (isCenteredDecorativeProseText(text, line, entry)) {
    return false
  }
  if (!isPureAllCapsTitleText(text)) {
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
const EMBEDDED_CHAPTER_PLACEHOLDER_REGEX = /\bCHAPTER\s*HEADING\s*GOES\s*HERE\b/gi

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

function isAdjacentPageProseEcho(text, pageIndex, pagesBeforeFilter) {
  const trimmed = (text ?? "").trim()
  if (trimmed.length < 12 || trimmed.length > 96) {
    return false
  }
  if (/[.!?:]["'\u201d]?\s*$/.test(trimmed)) {
    return false
  }

  for (const offset of [-1, 1]) {
    const adjacentPage = pagesBeforeFilter[pageIndex + offset]
    if (!adjacentPage?.lines) {
      continue
    }
    for (const line of adjacentPage.lines) {
      const other = (line.text ?? "").trim()
      if (other.length > trimmed.length && other.includes(trimmed)) {
        return true
      }
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

function dropMarginCalloutLines(lines) {
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

  return entries
    .filter((entry, entryIndex) => {
      const { text, line } = entry
      const previousText = entryIndex > 0 ? entries[entryIndex - 1].text : ""

      if (
        parseChapterOnlyHeading(previousText) &&
        (isLikelyChapterSubtitleText(text) || isAllCapsChapterSubtitleText(text))
      ) {
        return true
      }

      if (line.centered) {
        return true
      }

      if (isSceneBreakOrnamentLine(text)) {
        return true
      }

      if (
        CHAPTER_TITLE_TAIL_WORD_REGEX.test(text) &&
        (line.fontSize ?? 0) >= HEADING_STRING_MIN_FONT_SIZE
      ) {
        return true
      }

      if (
        isCleanStructuralHeadingText(text, { fontSize: line.fontSize ?? 0 }) ||
        PART_HEADING_PATTERN.test(text) ||
        VOLUME_HEADING_PATTERN.test(text) ||
        CHAPTER_PATTERN.test(text)
      ) {
        return true
      }

      if (
        isEpistolaryAddressLine(text) ||
        isEpistolarySignOffLine(text) ||
        isEpistolarySignatureLine(text)
      ) {
        return true
      }

      const words = text.split(/\s+/).filter(Boolean)
      const isShort =
        text.length <= MARGIN_CALLOUT_MAX_CHARS &&
        words.length <= MARGIN_CALLOUT_MAX_WORDS

      if (
        words.length >= 2 &&
        (line.fontSize ?? 0) >= HEADING_STRING_MIN_FONT_SIZE
      ) {
        return true
      }

      // Body-length lines are always content.
      if (!isShort) {
        return true
      }

      // A short fragment fully contained inside a longer line on the same page
      // (e.g. a running header echoed within body text) is a duplicate artifact.
      if (isShortLineSubstringOfLongerLine(text, longTextsOnPage)) {
        if (isLikelyChapterSubtitleText(text)) {
          return true
        }
        return false
      }

      const x = Number.isFinite(line.x) ? line.x : bodyLeftX
      const displacedLeft = x < bodyLeftX - MARGIN_CALLOUT_LEFT_DISPLACE_PX
      const displacedRight = x > bodyLeftX + MARGIN_CALLOUT_RIGHT_DISPLACE_PX

      // Short line aligned to the body column: keep it, it is paragraph prose.
      if (!displacedLeft && !displacedRight) {
        return true
      }

      // Displaced short line that still reads like narrative dialogue: keep.
      if (isLikelyDialogueContinuationLine(text)) {
        return true
      }

      // Lines indented beside a drop cap (e.g. "nce when his stepson...") sit
      // outside the body column but are paragraph prose, not margin callouts.
      if (isDropCapIndentedContinuation(line, bodyLeftX, entries)) {
        return true
      }

      // Displaced short line out in the margin: a genuine callout/side note.
      return false
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

function shouldDropExtractedLine(
  text,
  distinctPageCount,
  occurrencesOnThisPage = 1,
  isCentered = false,
  pageIndex = 0,
  lineFirstPageIndex = null
) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return true
  }
  if (PRODUCTION_SLUG_REGEX.test(trimmed)) {
    return true
  }
  if (CHAPTER_PLACEHOLDER_REGEX.test(trimmed)) {
    return true
  }
  if (isLetterSpacedProductionArtifact(trimmed)) {
    return true
  }
  if (isSpacedRunningHeaderLine(trimmed)) {
    return true
  }
  if (ROMAN_SECTION_RUNNING_HEAD_REGEX.test(trimmed)) {
    return true
  }
  if (isSceneBreakOrnamentLine(trimmed)) {
    return false
  }
  if (
    /^[A-Z]{2,8}\.?$/.test(trimmed) &&
    distinctPageCount <= 1 &&
    !CHAPTER_PATTERN.test(trimmed)
  ) {
    return false
  }
  if (
    CHAPTER_PATTERN.test(trimmed) ||
    STRUCTURAL_HEADING_PREFIX_REGEX.test(trimmed)
  ) {
    return false
  }
  if (isCollapsedRunningHeaderLine(trimmed)) {
    // A genuine running header repeats across many pages. A one-page all-caps
    // run, such as 1984's letter-spaced "DOWN WITH BIG BROTHER" diary lines
    // (fused into a single token by collapseLetterSpacing), appears on only one
    // or two pages and is content, not a header. Only drop when it recurs like
    // a real running header so book text is never skipped.
    if (distinctPageCount >= RUNNING_HEADER_MIN_PAGES) {
      if (process.env.BOOKY_DROP_DEBUG === "1") {
        console.log(
          "[dropLine] collapsed-running-header",
          JSON.stringify({ trimmed, distinctPageCount })
        )
      }
      return true
    }
  }
  if (STANDALONE_PAGE_NUMBER_REGEX.test(trimmed)) {
    return true
  }
  if (STANDALONE_ROMAN_PAGE_MARKER_REGEX.test(trimmed)) {
    return true
  }
  if (ROMAN_PAGE_MARKER_CLUSTER_REGEX.test(trimmed)) {
    return true
  }
  if (STANDALONE_RUNNING_HEAD_REGEX.test(trimmed)) {
    return true
  }
  if (isHeaderPageMarkerLine(trimmed)) {
    return true
  }
  if (isTocDenseListingLine(trimmed) || isTocPageReferenceLine(trimmed)) {
    return true
  }
  if (isRunningHeaderMergedLine(trimmed)) {
    return true
  }
  if (isScannerWatermarkLine(trimmed)) {
    return true
  }
  if (isGlossarySidebarLine(trimmed)) {
    return true
  }
  if (isLikelyChapterSubtitleText(trimmed)) {
    return false
  }
  if (TOC_HEADER_LINE_REGEX.test(trimmed)) {
    return true
  }
  if (/^(?:preface|introduction|prologue|epilogue|conclusion)$/i.test(trimmed)) {
    if (occurrencesOnThisPage > 1) {
      return true
    }
    if (distinctPageCount >= RUNNING_HEADER_MIN_PAGES) {
      const firstPage = lineFirstPageIndex?.get(trimmed)
      if (firstPage !== undefined && pageIndex !== firstPage) {
        return true
      }
    }
  }
  if (isCentered || isNarrativeBoundaryLine(trimmed) || CHAPTER_NUMBER_REGEX.test(trimmed)) {
    return false
  }
  if (
    isEpistolaryAddressLine(trimmed) ||
    isEpistolarySignOffLine(trimmed) ||
    isEpistolarySignatureLine(trimmed)
  ) {
    return false
  }
  if (
    distinctPageCount >= RUNNING_HEADER_MIN_PAGES &&
    occurrencesOnThisPage <= 1
  ) {
    return true
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return true
  }
  if (/^www\./i.test(trimmed)) {
    return true
  }
  return false
}

function groupTextItemsIntoLines(items) {
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

    if (!text) {
      continue
    }

    const fontSize = Math.max(...group.items.map((entry) => entry.fontSize))
    const runs = buildRunsFromLineItems(group.items)

    const rightEdge =
      rightmost.x + (rightmost.str?.length ?? 0) * fontSize * 0.5

    lines.push({
      text,
      x: leftmost.x,
      rightEdge,
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

import {
  classifyPdfImageRole,
  isChapterLikeOcrMetadata,
  isFullPageHeightIllustrationBlock,
  isFullPageSpreadHalf,
  isLikelyChapterArchBannerBlock,
  isTallChapterArchBannerBlock,
  PDF_IMAGE_ROLE,
} from "./pdfImageRoleUtils.js"

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

function shouldRunIllustrationOcr(block, _ocrMetadata, pageTextCharCounts) {
  if (block.imageRole === "illustration") {
    return false
  }

  if (block.imageRole === "chapter_heading" || isLikelyChapterArchBannerBlock(block)) {
    if (isTextHeavyIllustrationPage(pageTextCharCounts, block)) {
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

function countPlannedOcrEntries(candidateEntries, pageTextCharCounts, blocks) {
  let count = 0

  for (const { block, index: blockIndex } of candidateEntries) {
    if (!extractImageBlockPayload(block)) {
      continue
    }

    if (block.imageRole === "chapter_heading") {
      if (
        !shouldSkipChapterHeadingCandidate(block, blocks, blockIndex) &&
        !isTextHeavyIllustrationPage(pageTextCharCounts, block)
      ) {
        count += 1
      }
      continue
    }

    if (isLikelyChapterArchBannerBlock(block)) {
      if (
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
    blocks
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
        isChapterBannerCandidate(block) &&
        pendingInterludes === 0
      ) {
        const interludesFromToc = countInterludesAfterUpcomingBannerlessChapters(
          printedToc,
          tocOrderCursor
        )
        if (interludesFromToc > 0) {
          pendingInterludes = interludesFromToc
        }
      }

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
      const shouldRunOcr = shouldRunIllustrationOcr(block, null, pageTextCharCounts)

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

function buildPdfPageLinesFromTextContent(textContent, headingStrings) {
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
      fontSize,
      fontName: item.fontName ?? "",
      transform: item.transform,
    })
  }

  const rawLines = groupTextItemsIntoLines(pageItems)
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

  return dropMarginCalloutLines(repairedLines)
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
      return buildPdfPageLinesFromTextContent(textContent, headingStrings)
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
      if (
        shouldDropExtractedLine(
          line.text,
          distinctPageCount,
          occurrencesOnThisPage,
          Boolean(line.centered),
          pageIndex,
          lineFirstPageIndex
        ) ||
        (normalizedForDropCheck &&
          normalizedForDropCheck !== line.text.trim() &&
          shouldDropExtractedLine(
            normalizedForDropCheck,
            distinctPageCount,
            occurrencesOnThisPage,
            Boolean(line.centered),
            pageIndex,
            lineFirstPageIndex
          )) ||
        isStandalonePageNumberText(normalizedForDropCheck)
      ) {
        continue
      }

      if (isAdjacentPageProseEcho(line.text, pageIndex, pagesBeforeFilter)) {
        continue
      }

      if (isSceneBreakOrnamentLine(line.text) && !line.centered) {
        continue
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
  const chapterNumberRegex =
    /^(\d{1,2}|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\.?$/i
  const trimmed = (text ?? "").trim()
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
    /^(\d{1,2}|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\.?$/i
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

function isLikelyChapterSubtitleText(text) {
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
  if (isScannerWatermarkLine(trimmed) || isAuthorStructuralLine(trimmed)) {
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

function extractEmbeddedChapterSubtitle(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return null
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 3) {
    return null
  }

  for (let end = 1; end <= Math.min(10, words.length - 1); end += 1) {
    const subtitle = words.slice(0, end).join(" ")
    const prose = words.slice(end).join(" ")
    if (!isLikelyChapterSubtitleText(subtitle)) {
      continue
    }
    if (!looksLikeChapterOpeningProse(prose)) {
      continue
    }
    return { subtitle, prose }
  }

  return null
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
    if (!tocTitle) {
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

function mergeChapterSubtitleBlocks(blocks) {
  const merged = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const text = (block.text ?? "").trim()
    const parts = block.isHeading ? parseChapterOnlyHeading(text) : null

    if (parts && index + 1 < blocks.length) {
      const nextBlock = blocks[index + 1]
      const embeddedSubtitle = extractEmbeddedChapterSubtitle(nextBlock?.text)
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

      const { fragments: allCapsFragments, cursor: afterAllCaps } =
        collectFollowingAllCapsChapterSubtitleTexts(blocks, index + 1)

      if (allCapsFragments.length > 0) {
        const displayTitle = formatChapterLabel(
          parts.kind,
          parts.number,
          allCapsFragments.join(" ")
        )
        merged.push({
          ...block,
          text: displayTitle,
          chapterTitle: displayTitle,
          fontSize: CHAPTER_DISPLAY_FONT_SIZE,
          isHeading: true,
          isChapterStart: true,
        })
        index = afterAllCaps - 1
        continue
      }

      const subtitleParts = []
      let cursor = index + 1

      while (cursor < blocks.length) {
        const candidate = blocks[cursor]
        const candidateText = (candidate?.text ?? "").trim()
        if (!candidateText) {
          break
        }

        const isSubtitle =
          isLikelyChapterSubtitleBlock(candidate) ||
          ((candidate?.fontSize ?? 0) >= DISPLAY_CHAPTER_TITLE_MIN_FONT_SIZE &&
            isDisplayChapterTitleText(candidateText))

        if (!isSubtitle) {
          break
        }

        subtitleParts.push(candidateText)
        cursor += 1
      }

      if (subtitleParts.length > 0) {
        const displayTitle = formatChapterLabel(
          parts.kind,
          parts.number,
          subtitleParts.join(" ")
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

      const displayTitle = formatChapterLabel(parts.kind, parts.number)
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

function dedupeFrontMatterTitleBlocks(blocks, bookTitle) {
  const bookKey = normalizeTitleComparisonKey(bookTitle)
  if (!bookKey) {
    return blocks
  }

  let keptTitleBlock = false

  return blocks.filter((block, index) => {
    if (index >= 20) {
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
      })
    }
  }

  return chapters
}

function detectChapters(content, bookTitle = "") {
  const trimmedBookTitle = (bookTitle ?? "").trim()
  const flatBlocks = flattenContentBlocks(content)
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
        const rawTitle = (block.chapterTitle ?? block.text ?? "").trim()
        const headingText = (block.text ?? rawTitle).trim()
        const canonicalTitle = normalizeHeadingCandidate(headingText) || headingText
        const partLabel = resolvePartHeadingLabel(headingText)
        let id = slugify(canonicalTitle)
        let chapterTitle = block.chapterTitle ?? rawTitle
        const isFableTitle = isFableStoryTitleBlock(block)

        if (isFableTitle) {
          isChapterStart = true
          if (seenChapterIds.has(id)) {
            id = `${id}-${currentFlatIndex}`
          }
        }

        if (!isFableTitle && partLabel) {
          currentPartId = slugify(partLabel)
          currentPartTitle = partLabel
          id = slugify(block.chapterTitle ?? partLabel)
          chapterTitle = block.chapterTitle ?? partLabel
        } else if (
          !isFableTitle &&
          currentPartId &&
          (CHAPTER_NUMBER_REGEX.test(canonicalTitle) ||
            /^(chapter|letter)\s+/i.test(canonicalTitle))
        ) {
          id = `${currentPartId}-${slugify(canonicalTitle)}`
          const chapterLabel = block.chapterTitle ?? rawTitle
          chapterTitle = `${currentPartTitle ?? currentPartId} — ${chapterLabel}`
        } else if (
          !isFableTitle &&
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
          })
          currentChapterId = id
          chapterId = id
          if (!isFableTitle) {
            isChapterStart = true
          }
          displayChapterTitle = chapterTitle
        } else if (isFableTitle) {
          chapterId = currentChapterId
          displayChapterTitle = chapterTitle
        } else {
          chapterId = currentChapterId
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

  return { chapters, content: updatedContent }
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

function buildBlocksFromLines(pageData, headingStrings, { onProgress } = {}) {
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

  while (index < allLines.length) {
    const entry = allLines[index]
    const { line, text } = entry
    const lineIndex = nonEmptyLineIndex
    nonEmptyLineIndex += 1

    if (isScannerWatermarkLine(text)) {
      index += 1
      continue
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

    if (isStandalonePageNumberText(text)) {
      pendingConnective = null
      index += 1
      continue
    }

    const chapterOnlyParts = parseChapterOnlyHeading(text)
    if (chapterOnlyParts) {
      pendingConnective = null
      const titleFragments = []
      let cursor = index + 1

      while (cursor < allLines.length) {
        const nextEntry = allLines[cursor]
        const nextText = nextEntry.text.trim()
        const nextFontSize = nextEntry.line.fontSize ?? 0

        if (
          nextFontSize >= MULTILINE_CHAPTER_WRAP_MIN_FONT_SIZE &&
          isLargeFontAllCapsChapterWrapLine(nextText, nextEntry.line)
        ) {
          titleFragments.push(nextText)
          cursor += 1
          continue
        }

        if (isAllCapsChapterSubtitleLine(nextText, nextEntry.line)) {
          titleFragments.push(nextText)
          cursor += 1
          continue
        }

        if (
          isLikelyChapterSubtitleText(nextText) &&
          !looksLikeChapterOpeningProse(nextText)
        ) {
          titleFragments.push(nextText)
          cursor += 1
          continue
        }

        if (
          nextFontSize >= HEADING_STRING_MIN_FONT_SIZE &&
          CHAPTER_TITLE_TAIL_WORD_REGEX.test(nextText)
        ) {
          titleFragments.push(nextText)
          cursor += 1
          continue
        }

        if (isShortChapterHeadingSubtitleLine(nextText, nextEntry.line)) {
          titleFragments.push(nextText)
          cursor += 1
          continue
        }

        if (isDisplayChapterTitleLine(nextText, nextEntry.line)) {
          titleFragments.push(nextText)
          cursor += 1
          continue
        }

        break
      }

      const subtitle = titleFragments.length
        ? formatInferredTitleText(titleFragments.join(" ").replace(/\s+/g, " ").trim())
        : ""
      const displayTitle = formatChapterLabel(
        chapterOnlyParts.kind,
        chapterOnlyParts.number,
        subtitle
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
      isGlossarySidebarLine(text)
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
      isProseLineContinuation(text, headingPreviousBlock)

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

function hasValidParsedCache(documentRow) {
  return Boolean(readStoredDocumentContent(documentRow))
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

function readParsedCache(documentRow) {
  return readStoredDocumentContent(documentRow)
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
          ...buildParsedCacheFields(),
        })

        const { error: updateError } = await supabase
          .from("documents")
          .update(documentUpdate)
          .eq("id", documentId)
          .eq("user_id", userId)

        if (updateError) {
          console.error(
            `Failed to save parsed document ${documentId}:`,
            updateError.message ?? updateError
          )
          throw new Error(
            updateError.message
              ? `Failed to save parsed document: ${updateError.message}`
              : "Failed to save parsed document"
          )
        }

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
      label: errorMessage,
      current: 0,
      total: 0,
      percent: 0,
    })

    await supabase
      .from("documents")
      .update({ parse_status: PARSE_STATUS.ERROR })
      .eq("id", documentId)
      .eq("user_id", userId)
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

function normalizeCenteredDecorativeProseBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  return blocks.map((block) => {
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

    return stripBoldFromCenteredProseBlock(block)
  })
}

function applyBlockTransformPipeline(blocks) {
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
                    )
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

  let blocks = applyBlockTransformPipeline(
    buildBlocksFromLines(pageData, headingStrings, {
      onProgress(current, total) {
        reportProgress({
          phase: "structuring",
          label: "Organizing book text",
          structureStep: "lines",
          current,
          total,
          percent: structurePhasePercent("lines", current, total),
        })
      },
    })
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

  if (!contentStartsWithBookTitle(blocks, bookTitle)) {
    const authorText = sanitizePdfAuthor(parsedText?.info?.Author ?? "")
    const synthetic = []

    if (bookTitle && !looksLikeFilenameSlug(bookTitle)) {
      synthetic.push({
        text: bookTitle,
        isHeading: true,
        fontSize: 20,
        chapterId: null,
        sourcePdfPageIndex: 0,
      })
    }

    if (authorText) {
      const authorLine = /^by\s/i.test(authorText) ? authorText : `By ${authorText}`
      if (!isScannerWatermarkLine(authorLine)) {
        synthetic.push({
          text: authorLine,
          isHeading: true,
          fontSize: 13,
          chapterId: null,
          sourcePdfPageIndex: 0,
        })
      }
    }

    if (synthetic.length > 0) {
      blocks = [...synthetic, ...blocks]
    }
  }

  blocks = dedupeFrontMatterTitleBlocks(blocks, bookTitle)

  reportProgress({
    phase: "structuring",
    label: "Reading chapter outline",
    structureStep: "outline",
    current: numPages,
    total: numPages,
    percent: structurePhasePercent("outline"),
  })

  const printedToc =
    extractPrintedTocFromPageData(pageData) ?? extractPrintedTocLookup(blocks)
  blocks = excludePrintedTocBlocks(blocks)
  blocks = normalizeFrontAndBackMatterBlocks(blocks)
  blocks = injectStormlightPreludeHeading(blocks)
  blocks = injectStormlightPrologueHeading(blocks, printedToc)

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

  if (printedToc) {
    blocks = supplementBannerlessPrintedChapters(blocks, printedToc)
  }

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
  return Boolean(process.env.ADMIN_SECRET) && secret === process.env.ADMIN_SECRET
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
    await supabase
      .from("documents")
      .update({ parse_status: PARSE_STATUS.ERROR })
      .eq("id", documentId)
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
    await supabase
      .from("documents")
      .update({ parse_status: PARSE_STATUS.ERROR })
      .eq("id", documentRow.id)
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
      await supabase
        .from("documents")
        .update({ parse_status: PARSE_STATUS.ERROR })
        .eq("id", documentRow.id)
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
      res.status(500).json({ success: false, error: uploadError.message })
      return
    }

    try {
      const uploadedFile = req.file

      if (!uploadedFile) {
        res.status(500).json({ success: false, error: "No file uploaded." })
        return
      }

      const title =
        humanizeBookTitleFromFileName(uploadedFile.originalname) ||
        uploadedFile.originalname.replace(/\.pdf$/i, "")
      const storagePath = `${Date.now()}-${uploadedFile.originalname}`
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

      setImmediate(() => {
        void parseDocumentInBackground(documentId, userId, storageData.path, originalName)
      })

      res.json({
        success: true,
        document: {
          id: documentId,
          title,
          status: PARSE_STATUS.PENDING,
        },
      })
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to parse PDF.",
      })
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
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Re-parse failed",
    })
  }
})

export {
  parsePdfBuffer,
  extractLinesByPosition,
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
