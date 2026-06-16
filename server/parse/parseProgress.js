import { supabase } from "../supabaseClient.js"

const documentParseProgress = new Map()
const parseProgressDbWriteAt = new Map()
const PARSE_PROGRESS_DB_WRITE_MS = 750
const PDF_PAGE_EXTRACTION_CONCURRENCY = 6
const PDF_TEXT_EXTRACTION_CONCURRENCY = 8
const PDF_IMAGE_EXTRACTION_CONCURRENCY = 4
const EXTRACT_PROGRESS_TEXT_SHARE = 0.62
const EXTRACT_PROGRESS_IMAGE_SHARE = 0.38

function resolvePdfExtractionConcurrency(totalPages) {
  const configuredText = Number(process.env.BOOKY_TEXT_EXTRACTION_CONCURRENCY)
  const configuredImage = Number(process.env.BOOKY_IMAGE_EXTRACTION_CONCURRENCY)
  if (Number.isFinite(configuredText) && configuredText > 0) {
    return {
      text: configuredText,
      image:
        Number.isFinite(configuredImage) && configuredImage > 0
          ? configuredImage
          : PDF_IMAGE_EXTRACTION_CONCURRENCY,
    }
  }

  // Large illustrated PDFs on Render free tier (512MB): high concurrency OOMs mid-extract.
  if (totalPages > 900) {
    return { text: 4, image: 2 }
  }

  if (totalPages > 400) {
    return { text: 6, image: 3 }
  }

  return {
    text: PDF_TEXT_EXTRACTION_CONCURRENCY,
    image: PDF_PAGE_EXTRACTION_CONCURRENCY,
  }
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
      const imageBase =
        prev?.extractSubphase === "images"
          ? counters.pages
          : { current: 0, total: patch?.total ?? counters.pages.total }
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

  if (
    phaseChanged ||
    structureStepChanged ||
    extractSubphaseChanged ||
    pageChanged ||
    illustrationChanged ||
    ocrChanged ||
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

export {
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
}
