/** Pipeline steps shown during PDF processing (order matters). */
export const PARSE_PIPELINE_STEPS = [
  { phase: "starting", label: "Open PDF" },
  { phase: "extracting", label: "Read pages" },
  { phase: "structuring", label: "Structure text" },
  { phase: "classifying_illustrations", label: "Classify art" },
  { phase: "ocr_illustrations", label: "Read headers" },
  { phase: "uploading_assets", label: "Upload art" },
  { phase: "finalizing", label: "Chapters" },
  { phase: "saving", label: "Save" },
]

const PHASE_HEADLINES = {
  starting: "Opening your PDF…",
  extracting: "Reading PDF pages…",
  structuring: "Building book structure…",
  classifying_illustrations: "Analyzing illustrations…",
  ocr_illustrations: "Reading chapter headers…",
  uploading_assets: "Uploading illustrations…",
  finalizing: "Detecting chapters…",
  saving: "Saving to your library…",
  ready: "Done!",
  error: "Processing failed",
}

/** Mirrors server-side parse percent bands (server/index.js). */
const PARSE_PERCENT_PHASE_THRESHOLDS = [
  { min: 98, phase: "saving" },
  { min: 96, phase: "finalizing" },
  { min: 80, phase: "uploading_assets" },
  { min: 63, phase: "classifying_illustrations" },
  { min: 62, phase: "structuring" },
  { min: 1, phase: "extracting" },
]

const KNOWN_PARSE_PHASES = new Set([
  ...PARSE_PIPELINE_STEPS.map((step) => step.phase),
  "ready",
  "error",
])

function inferPhaseFromPercent(percent = 0) {
  for (const { min, phase } of PARSE_PERCENT_PHASE_THRESHOLDS) {
    if (percent >= min) {
      return phase
    }
  }

  return "starting"
}

function phaseRank(phase) {
  const index = PARSE_PIPELINE_STEPS.findIndex((step) => step.phase === phase)
  return index >= 0 ? index + 1 : 0
}

/**
 * Coerce legacy/unknown poll payloads into a known pipeline phase.
 * @param {object|null|undefined} parseProgress
 */
export function normalizeParseProgress(parseProgress) {
  if (!parseProgress) {
    return null
  }

  const phase = parseProgress.phase
  if (phase && phase !== "processing" && KNOWN_PARSE_PHASES.has(phase)) {
    return parseProgress
  }

  return {
    ...parseProgress,
    phase: inferPhaseFromPercent(parseProgress.percent ?? 0),
  }
}

/**
 * Merge a status poll update without clobbering detailed progress.
 * @param {object|null|undefined} previous
 * @param {object|null|undefined} update
 */
export function mergeParseProgressUpdate(previous, update) {
  if (!update) {
    return previous ?? null
  }

  if (update.phase === "ready" || update.phase === "error") {
    return update
  }

  const base = previous ?? {
    phase: "starting",
    current: 0,
    total: 0,
    percent: 0,
  }

  if (update.phase && update.phase !== "processing" && KNOWN_PARSE_PHASES.has(update.phase)) {
    return { ...base, ...update }
  }

  const merged = {
    ...base,
    ...update,
    phase: base.phase,
  }

  if (!base.phase || base.phase === "processing") {
    merged.phase = inferPhaseFromPercent(update.percent ?? base.percent ?? 0)
  }

  return merged
}

/**
 * @param {object|null|undefined} parseProgress
 * @returns {string}
 */
export function getParseProgressHeadline(parseProgress) {
  const progress = normalizeParseProgress(parseProgress)

  if (!progress?.phase) {
    return "Preparing your book…"
  }

  if (progress.phase === "classifying_illustrations" && progress.usingPrintedToc) {
    return "Applying printed table of contents…"
  }

  if (progress.phase === "ocr_illustrations" && progress.usingPrintedToc) {
    return "Reading part and interlude dividers…"
  }

  return PHASE_HEADLINES[progress.phase] ?? "Processing your book…"
}

/**
 * @param {object|null|undefined} parseProgress
 * @returns {string}
 */
export function getParseProgressDetail(parseProgress) {
  const progress = normalizeParseProgress(parseProgress)

  if (!progress) {
    return "Large illustrated books can take several minutes — especially when uploading artwork."
  }

  const { phase, current = 0, total = 0, label } = progress

  if (phase === "error") {
    return label ?? "Something went wrong while parsing this PDF."
  }

  if (phase === "starting") {
    return "Loading the file and preparing the parser."
  }

  if (phase === "extracting") {
    if (total > 0) {
      const pct = Math.round((current / total) * 100)
      return `Reading page ${current} of ${total} (${pct}% of PDF scan).`
    }
    return "Scanning pages for text, headings, and embedded artwork."
  }

  if (phase === "structuring") {
    return "Merging paragraphs, chapter titles, and dialogue blocks."
  }

  if (phase === "classifying_illustrations") {
    if (progress.usingPrintedToc && total > 0) {
      return `Applying printed table of contents (${current} of ${total} illustrations).`
    }
    if (total > 0) {
      return `Classifying illustration ${current} of ${total} (chapter headers and full-page art).`
    }
    return "Identifying full-page art and chapter heading banners."
  }

  if (phase === "ocr_illustrations") {
    if (progress.usingPrintedToc && total > 0) {
      return `Reading part and interlude dividers from artwork (${current} of ${total}).`
    }
    if (total > 0) {
      return `Reading text from illustration ${current} of ${total} (chapter titles, parts, interludes).`
    }
    if (progress.illustrationTotal > 0) {
      return `Classified ${progress.illustrationCurrent ?? 0} of ${progress.illustrationTotal} illustrations — no OCR needed for remaining headers.`
    }
    return "Extracting chapter numbers and titles from header artwork."
  }

  if (phase === "uploading_assets") {
    if (total > 0) {
      const remaining = Math.max(0, total - current)
      if (remaining > 0 && current > 0) {
        return `Uploading illustration ${current} of ${total} (${remaining} remaining, 5 at a time).`
      }
      return `Uploading illustration ${current} of ${total} to storage.`
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
  const progress = normalizeParseProgress(parseProgress)
  const activePhase = progress?.phase ?? "starting"
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
