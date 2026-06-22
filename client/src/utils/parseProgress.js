/** Pipeline steps shown during PDF processing (order matters). */
export const PARSE_PIPELINE_STEPS = [
  { phase: "starting", label: "Open PDF" },
  { phase: "extracting", label: "Read pages" },
  { phase: "structuring", label: "Layout" },
  { phase: "classifying_illustrations", label: "Classify art" },
  { phase: "ocr_illustrations", label: "Read headers" },
  { phase: "uploading_assets", label: "Upload art" },
  { phase: "finalizing", label: "Chapters" },
  { phase: "saving", label: "Save" },
]

const STARTING_LABEL_HEADLINES = {
  "Waiting to start": "Waiting for the parser…",
  "Downloading PDF": "Downloading your PDF…",
  "Opening PDF": "Opening your PDF…",
}

const STARTING_LABEL_DETAILS = {
  "Waiting to start":
    "Another book is being processed. Your upload will start automatically.",
  "Downloading PDF": "Fetching the file from storage.",
  "Opening PDF": "Loading the file and preparing the page scanner.",
}

const PHASE_HEADLINES = {
  starting: "Opening your PDF…",
  extracting: "Reading PDF pages…",
  structuring: "Building book structure…",
  classifying_illustrations: "Classifying artwork…",
  ocr_illustrations: "Reading chapter headers…",
  uploading_assets: "Uploading illustrations…",
  finalizing: "Detecting chapters…",
  saving: "Saving to your library…",
  ready: "Done!",
  error: "Processing failed",
}

function pipelinePhaseForDisplay(phase) {
  return phase
}

/** Raw phase including structuring (before pipeline mapping). */
export function getRawProcessingPhase(parseProgress) {
  if (!parseProgress?.phase) {
    return "starting"
  }

  const pages = resolveCounters(parseProgress).pages
  if (
    parseProgress.phase === "extracting" &&
    parseProgress.extractSubphase === "filtering" &&
    pages.total > 0 &&
    pages.current >= pages.total
  ) {
    return "structuring"
  }

  return parseProgress.phase
}

/** Phase used for pipeline step highlighting. */
export function getEffectiveDisplayPhase(parseProgress) {
  return pipelinePhaseForDisplay(getRawProcessingPhase(parseProgress))
}

function phaseRank(phase) {
  if (phase === "starting") {
    return 0
  }
  const normalized = pipelinePhaseForDisplay(phase)
  const index = PARSE_PIPELINE_STEPS.findIndex((step) => step.phase === normalized)
  return index >= 0 ? index + 1 : -1
}

function progressPhaseRank(phase) {
  return phaseRank(phase)
}

function emptyCounters() {
  return {
    pages: { current: 0, total: 0 },
    illustrations: { current: 0, total: 0 },
    ocr: { current: 0, total: 0 },
    uploads: { current: 0, total: 0 },
  }
}

function bumpCounter(counter, current, total) {
  const next = { ...(counter ?? { current: 0, total: 0 }) }
  if (typeof current === "number") {
    next.current = Math.max(next.current ?? 0, current)
  }
  if (typeof total === "number" && total > 0) {
    next.total = total
  }
  return next
}

function legacyCountersFromProgress(raw) {
  const counters = emptyCounters()

  if (typeof raw.pageCurrent === "number" || typeof raw.pageTotal === "number") {
    counters.pages = bumpCounter(counters.pages, raw.pageCurrent, raw.pageTotal)
  } else if (raw.phase === "extracting") {
    counters.pages = bumpCounter(counters.pages, raw.current, raw.total)
  }

  if (typeof raw.illustrationCurrent === "number" || raw.illustrationTotal > 0) {
    counters.illustrations = bumpCounter(
      counters.illustrations,
      raw.illustrationCurrent,
      raw.illustrationTotal
    )
  } else if (raw.phase === "classifying_illustrations") {
    if (raw.total > 0 && (raw.current ?? 0) <= raw.total) {
      counters.illustrations = bumpCounter(counters.illustrations, raw.current, raw.total)
    }
  }

  if (typeof raw.ocrCurrent === "number" || raw.ocrTotal > 0) {
    counters.ocr = bumpCounter(counters.ocr, raw.ocrCurrent, raw.ocrTotal)
  } else if (raw.phase === "ocr_illustrations") {
    counters.ocr = bumpCounter(counters.ocr, raw.current, raw.total)
  }

  if (typeof raw.uploadCurrent === "number" || raw.uploadTotal > 0) {
    counters.uploads = bumpCounter(counters.uploads, raw.uploadCurrent, raw.uploadTotal)
  } else if (raw.phase === "uploading_assets") {
    counters.uploads = bumpCounter(counters.uploads, raw.current, raw.total)
  }

  return counters
}

function resolveCounters(raw) {
  if (!raw) {
    return emptyCounters()
  }

  if (raw.counters) {
    return {
      pages: { ...emptyCounters().pages, ...raw.counters.pages },
      illustrations: { ...emptyCounters().illustrations, ...raw.counters.illustrations },
      ocr: { ...emptyCounters().ocr, ...raw.counters.ocr },
      uploads: { ...emptyCounters().uploads, ...raw.counters.uploads },
    }
  }

  return legacyCountersFromProgress(raw)
}

function activeCountersForPhase(phase, counters) {
  if (phase === "extracting" || phase === "structuring") {
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

function mergeCounterSnapshot(previous, update) {
  const prevCounters = resolveCounters(previous)
  const nextCounters = resolveCounters(update)
  const effectivePhase = update?.phase ?? previous?.phase

  const counters = {
    pages: bumpCounter(prevCounters.pages, nextCounters.pages.current, nextCounters.pages.total),
    illustrations: bumpCounter(
      prevCounters.illustrations,
      nextCounters.illustrations.current,
      nextCounters.illustrations.total
    ),
    ocr: bumpCounter(prevCounters.ocr, nextCounters.ocr.current, nextCounters.ocr.total),
    uploads: bumpCounter(
      prevCounters.uploads,
      nextCounters.uploads.current,
      nextCounters.uploads.total
    ),
  }

  if (effectivePhase === "extracting") {
    const subphase = update?.extractSubphase ?? previous?.extractSubphase
    if (subphase === "images") {
      const imageBase =
        previous?.extractSubphase === "images"
          ? prevCounters.pages
          : { current: 0, total: update?.total ?? prevCounters.pages.total }
      counters.pages = bumpCounter(imageBase, update?.current, update?.total)
    } else if (subphase === "resolve_buffers") {
      counters.pages = bumpCounter(
        previous?.extractSubphase === "resolve_buffers"
          ? prevCounters.pages
          : { current: 0, total: update?.total ?? prevCounters.pages.total },
        update?.current,
        update?.total
      )
    } else if (subphase === "filtering") {
      counters.pages = bumpCounter(
        previous?.extractSubphase === "filtering"
          ? prevCounters.pages
          : { current: 0, total: update?.total ?? prevCounters.pages.total },
        update?.current,
        update?.total
      )
    } else {
      counters.pages = bumpCounter(
        { current: 0, total: update?.total ?? prevCounters.pages.total },
        update?.current,
        update?.total
      )
    }
  } else if (effectivePhase === "structuring") {
    counters.pages = bumpCounter(counters.pages, update?.current, update?.total)
  }
  if (effectivePhase === "classifying_illustrations") {
    counters.illustrations = bumpCounter(
      counters.illustrations,
      update?.illustrationCurrent ?? update?.current,
      update?.illustrationTotal ?? update?.total
    )
  }
  if (effectivePhase === "ocr_illustrations") {
    counters.ocr = bumpCounter(
      counters.ocr,
      update?.ocrCurrent ?? update?.current,
      update?.ocrTotal ?? update?.total
    )
    counters.illustrations = bumpCounter(
      counters.illustrations,
      update?.illustrationCurrent,
      update?.illustrationTotal
    )
  }
  if (effectivePhase === "uploading_assets") {
    counters.uploads = bumpCounter(counters.uploads, update?.current, update?.total)
  }

  return counters
}

function isPartialProgressUpdate(update) {
  if (!update || update.phase === "ready" || update.phase === "error") {
    return false
  }

  const keys = Object.keys(update)
  return keys.length > 0 && keys.every((key) => key === "percent" || key === "label")
}

/**
 * Counters for the active pipeline phase only (never page numbers during illustration work).
 * @param {object|null|undefined} parseProgress
 */
export function getPhaseCounters(parseProgress) {
  if (!parseProgress?.phase) {
    return { current: 0, total: 0 }
  }

  const counters = resolveCounters(parseProgress)
  const phase = parseProgress.phase
  if (phase === "extracting" || phase === "structuring") {
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

/**
 * Merge status poll payloads without mixing counters across phases.
 * @param {object|null|undefined} previous
 * @param {object|null|undefined} update
 */
export function mergePollProgressUpdate(previous, update) {
  if (!update) {
    return previous ?? null
  }

  if (update.phase === "ready" || update.phase === "error") {
    return update
  }

  if (!previous) {
    const counters = resolveCounters(update)
    const phase = update.phase ?? "starting"
    const active = activeCountersForPhase(phase, counters)
    return {
      ...update,
      counters,
      current: active.current,
      total: active.total,
    }
  }

  if (isPartialProgressUpdate(update)) {
    return {
      ...previous,
      percent: Math.max(previous.percent ?? 0, update.percent ?? 0),
      label: update.label ?? previous.label,
    }
  }

  const prevRank = progressPhaseRank(previous.phase)
  const updateRank = progressPhaseRank(update.phase ?? previous.phase)

  if (update.phase && updateRank < prevRank) {
    return {
      ...previous,
      percent: Math.max(previous.percent ?? 0, update.percent ?? 0),
    }
  }

  const phase =
    update.phase && updateRank >= prevRank ? update.phase : previous.phase ?? update.phase

  const counters = mergeCounterSnapshot(previous, { ...update, phase })
  const active = activeCountersForPhase(phase, counters)

  return {
    ...previous,
    ...update,
    phase,
    counters,
    current: active.current,
    total: active.total,
    percent:
      update.extractSubphase === "images" && update.current === 0
        ? Math.max(previous.percent ?? 0, update.percent ?? 0)
        : Math.max(previous.percent ?? 0, update.percent ?? previous.percent ?? 0),
    extractSubphase:
      phase === "extracting"
        ? update.extractSubphase ?? previous.extractSubphase
        : undefined,
    structureStep:
      phase === "structuring" ||
      phase === "classifying_illustrations" ||
      previous.structureStep
        ? update.structureStep ?? previous.structureStep
        : undefined,
    usingPrintedToc:
      update.usingPrintedToc == null ? previous.usingPrintedToc : update.usingPrintedToc,
    pageCurrent: counters.pages.current,
    pageTotal: counters.pages.total,
    illustrationCurrent: counters.illustrations.current,
    illustrationTotal: counters.illustrations.total,
    ocrCurrent: counters.ocr.current,
    ocrTotal: counters.ocr.total,
    uploadCurrent: counters.uploads.current,
    uploadTotal: counters.uploads.total,
    updatedAt: update.updatedAt ?? previous.updatedAt ?? Date.now(),
  }
}

/**
 * @param {object|null|undefined} parseProgress
 * @returns {string}
 */
const STRUCTURE_STEP_HEADLINES = {
  lines: "Organizing book text…",
  transform: "Merging chapters and paragraphs…",
  outline: "Reading chapter outline…",
  interleave: "Placing illustrations in layout…",
}

const STRUCTURE_STEP_DETAILS = {
  lines: (current, total) =>
    total > 0
      ? `Organizing text from page ${current} of ${total}.`
      : "Organizing extracted text into paragraphs and headings.",
  transform: () => "Merging chapter titles, dialogue, and section breaks.",
  outline: () => "Reading the book outline from the table of contents.",
  interleave: (current, total) =>
    total > 0
      ? `Placing illustrations on page ${current} of ${total}.`
      : "Weaving illustrations into the page layout.",
}

export function getParseProgressHeadline(parseProgress) {
  if (!parseProgress?.phase) {
    return "Preparing your book…"
  }

  const rawPhase = getRawProcessingPhase(parseProgress)

  if (rawPhase === "structuring") {
    const step = parseProgress.structureStep ?? "lines"
    return STRUCTURE_STEP_HEADLINES[step] ?? "Preparing chapter headers…"
  }

  const phase = getEffectiveDisplayPhase(parseProgress)

  if (phase === "extracting") {
    const subphase = parseProgress.extractSubphase ?? "text"
    if (subphase === "filtering") {
      return "Cleaning extracted text…"
    }
    if (subphase === "text_complete" || (subphase === "images" && (parseProgress.current ?? 0) === 0)) {
      return "Starting artwork scan…"
    }
    if (subphase === "resolve_buffers") {
      return "Loading illustration data…"
    }
    if (subphase === "images" && parseProgress.label === "Loading illustration data") {
      return "Loading illustration data…"
    }
    if (subphase === "images") {
      return "Scanning page artwork…"
    }
    return "Reading PDF pages…"
  }

  if (phase === "classifying_illustrations" && (parseProgress.total ?? 0) === 0) {
    return "Preparing chapter headers…"
  }

  if (phase === "starting" && parseProgress.label) {
    return STARTING_LABEL_HEADLINES[parseProgress.label] ?? PHASE_HEADLINES.starting
  }

  return PHASE_HEADLINES[phase] ?? PHASE_HEADLINES[parseProgress.phase] ?? "Processing your book…"
}

/**
 * @param {object|null|undefined} parseProgress
 * @returns {string}
 */
export function getParseProgressDetail(parseProgress) {
  if (!parseProgress) {
    return "Large illustrated books can take several minutes — especially when uploading artwork."
  }

  const rawPhase = getRawProcessingPhase(parseProgress)
  const phase = getEffectiveDisplayPhase(parseProgress)
  const { current, total } = getPhaseCounters(parseProgress)
  const { label } = parseProgress

  if (phase === "error") {
    return label ?? "Something went wrong while parsing this PDF."
  }

  if (phase === "starting") {
    if (label && STARTING_LABEL_DETAILS[label]) {
      return STARTING_LABEL_DETAILS[label]
    }
    return "Loading the file and preparing the parser."
  }

  if (rawPhase === "structuring") {
    const step = parseProgress.structureStep ?? "lines"
    const detailFn = STRUCTURE_STEP_DETAILS[step]
    return detailFn ? detailFn(current, total) : "Preparing the book layout."
  }

  if (phase === "extracting") {
    const subphase = parseProgress.extractSubphase ?? "text"
    const { current, total } = getPhaseCounters(parseProgress)

    if (subphase === "filtering" && total > 0) {
      const pct = Math.round((current / total) * 100)
      return `Cleaning extracted text — page ${current} of ${total} (${pct}%).`
    }

    if (subphase === "text_complete" || (subphase === "images" && current === 0)) {
      return `Text scan complete — starting artwork scan (${total} pages).`
    }

    if (total > 0) {
      const pct =
        current >= total
          ? 100
          : Math.min(99, Math.round((current / total) * 100))
      if (subphase === "resolve_buffers") {
        const pageMatch = /page\s+(\d+)/i.exec(label ?? "")
        const pageNote = pageMatch ? ` (PDF page ${pageMatch[1]})` : ""
        return `Loading illustration data — ${current} of ${total} pages with artwork${pageNote} (${pct}%).`
      }
      if (subphase === "images") {
        if (label === "Loading illustration data") {
          return `Loading illustration data — page ${current} of ${total} (${pct}%).`
        }
        return `Scanning artwork page ${current} of ${total} (${pct}%).`
      }
      return `Reading page ${current} of ${total} (${pct}%).`
    }
    return "Opening PDF and preparing the page scanner…"
  }

  if (phase === "classifying_illustrations") {
    const { current, total } = getPhaseCounters(parseProgress)
    if (total > 0) {
      const pct = Math.round((current / total) * 100)
      return `Classifying artwork ${current} of ${total} (${pct}%).`
    }
    return "Identifying chapter headers and illustrations."
  }

  if (phase === "ocr_illustrations") {
    const { current, total } = getPhaseCounters(parseProgress)
    if (total > 0) {
      const pct = Math.round((current / total) * 100)
      return `Reading chapter header ${current} of ${total} (${pct}%).`
    }
    return "Extracting chapter numbers and titles from header artwork."
  }

  if (phase === "uploading_assets") {
    if (total > 0) {
      const pct = Math.round((current / total) * 100)
      return `Uploading illustration ${current} of ${total} (${pct}%).`
    }
    if (label) {
      return label
    }
    return "Uploading book illustrations — this is often the slowest step for illustrated books."
  }

  if (phase === "finalizing") {
    return "Assigning chapter boundaries and preparing the reader layout."
  }

  if (phase === "saving") {
    return "Writing parsed content to your library."
  }

  if (phase === "ready") {
    return "Opening the reader…"
  }

  return label ?? "Working…"
}

/**
 * @param {object|null|undefined} parseProgress
 * @returns {Array<{ phase: string, label: string, status: 'done'|'active'|'pending' }>}
 */
export function getParsePipelineStepStates(parseProgress) {
  const activePhase = getEffectiveDisplayPhase(parseProgress)
  const activeRank = phaseRank(activePhase)

  return PARSE_PIPELINE_STEPS.map((step) => {
    const rank = phaseRank(step.phase)
    let status = "pending"

    if (activePhase === "ready" || activePhase === "saving") {
      status = rank <= phaseRank("saving") ? "done" : "pending"
    } else if (activePhase === "error") {
      status = rank < activeRank ? "done" : rank === activeRank ? "active" : "pending"
    } else if (rank < activeRank) {
      status = "done"
    } else if (rank === activeRank) {
      status = "active"
    }

    return { ...step, status }
  })
}

/**
 * @param {object|null|undefined} parseProgress
 * @returns {number|null}
 */
export function getParseProgressPercent(parseProgress) {
  if (!parseProgress || typeof parseProgress.percent !== "number") {
    return null
  }
  return Math.max(0, Math.min(100, Math.round(parseProgress.percent)))
}

/** Combined upload weight + parse percent for the main progress bar. */
export function getCombinedProcessingPercent(
  parseProgress,
  uploadWeight = 0.12
) {
  const processingShare = 1 - uploadWeight
  const base = 100 * uploadWeight

  if (!parseProgress) {
    return Math.round(base)
  }

  const { current, total } = getPhaseCounters(parseProgress)
  const rawPhase = getRawProcessingPhase(parseProgress)
  const displayPhase = getEffectiveDisplayPhase(parseProgress)

  if (displayPhase === "extracting") {
    if (typeof parseProgress.percent === "number") {
      return Math.round(base + parseProgress.percent * processingShare)
    }
    if (total > 0) {
      const fraction = current / total
      const extractMax = 58
      return Math.round(base + fraction * extractMax * processingShare)
    }
  }

  if (rawPhase === "structuring" && total > 0) {
    const structureMax = 62
    const structureMin = 58
    const fraction = current / total
    const band =
      structureMin + fraction * (structureMax - structureMin)
    return Math.round(base + band * processingShare)
  }

  const itemPhases = {
    structuring: { start: 58, end: 63 },
    classifying_illustrations: { start: 63, end: 80 },
    ocr_illustrations: { start: 63, end: 80 },
    uploading_assets: { start: 80, end: 93 },
  }
  const itemBand = itemPhases[rawPhase] ?? itemPhases[displayPhase]

  if (itemBand && total > 0 && current <= total) {
    const fraction = current / total
    const bandPercent = itemBand.start + fraction * (itemBand.end - itemBand.start)
    return Math.round(base + bandPercent * processingShare)
  }

  return Math.round(base + (parseProgress.percent ?? 0) * processingShare)
}

/**
 * @param {object|null|undefined} parseProgress
 * @returns {string|null}
 */
export function getParseProgressStaleHint(parseProgress) {
  if (!parseProgress) {
    return null
  }

  if (parseProgress.phase === "starting") {
    return "Large PDFs can take a minute to open. Still working…"
  }

  if (parseProgress.phase === "ocr_illustrations") {
    return "Header OCR can be slow on large illustrated books. Still working…"
  }

  if (parseProgress.phase !== "extracting") {
    return null
  }

  const subphase = parseProgress.extractSubphase ?? "text"
  const total = parseProgress.pageTotal ?? parseProgress.total ?? 0
  const current = parseProgress.pageCurrent ?? parseProgress.current ?? 0

  if (total < 100 || current <= 0) {
    return null
  }

  if (subphase === "images") {
    return `Artwork scanning can take several minutes on illustrated books. Still working on page ${current} of ${total}.`
  }

  if (subphase === "resolve_buffers") {
    return `Decoding illustration data can take a minute on the last pages. Still working (${current} of ${total} pages with artwork).`
  }

  if (subphase === "filtering" || subphase === "text_complete") {
    return "Finishing the text pass before scanning artwork…"
  }

  if (current >= 30 && total >= 120) {
    return `Page ${current} of ${total} can take a while on large illustrated books. Still reading…`
  }

  return `Large books take several minutes. Progress updates after each page finishes — still working on page ${current} of ${total}.`
}

/**
 * Shown when server progress timestamps stop advancing (likely OOM restart on Render).
 * @param {number} staleSinceMs - milliseconds since last updatedAt change
 */
export function getParseProgressDeadHint(staleSinceMs) {
  if (staleSinceMs < 60_000) {
    return null
  }

  return "Processing may have stopped (the server can restart on large books). Use Retry below or upload again."
}
