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

function phaseRank(phase) {
  if (phase === "starting") {
    return 0
  }
  const index = PARSE_PIPELINE_STEPS.findIndex((step) => step.phase === phase)
  return index >= 0 ? index + 1 : -1
}

/**
 * @param {object|null|undefined} parseProgress
 * @returns {string}
 */
export function getParseProgressHeadline(parseProgress) {
  if (!parseProgress?.phase) {
    return "Preparing your book…"
  }

  if (parseProgress.phase === "classifying_illustrations" && parseProgress.usingPrintedToc) {
    return "Applying printed table of contents…"
  }

  if (parseProgress.phase === "ocr_illustrations" && parseProgress.usingPrintedToc) {
    return "Reading part and interlude dividers…"
  }

  if (parseProgress.label && parseProgress.phase !== "error") {
    const mapped = PHASE_HEADLINES[parseProgress.phase]
    if (mapped) {
      return mapped
    }
  }

  return PHASE_HEADLINES[parseProgress.phase] ?? "Processing your book…"
}

/**
 * @param {object|null|undefined} parseProgress
 * @returns {string}
 */
export function getParseProgressDetail(parseProgress) {
  if (!parseProgress) {
    return "Large illustrated books can take several minutes — especially when uploading artwork."
  }

  const { phase, current = 0, total = 0, label } = parseProgress

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
    if (parseProgress.usingPrintedToc && total > 0) {
      return `Applying printed table of contents (${current} of ${total} illustrations).`
    }
    if (total > 0) {
      return `Classifying illustration ${current} of ${total} (chapter headers and full-page art).`
    }
    return "Identifying full-page art and chapter heading banners."
  }

  if (phase === "ocr_illustrations") {
    if (parseProgress.usingPrintedToc && total > 0) {
      return `Reading part and interlude dividers from artwork (${current} of ${total}).`
    }
    if (total > 0) {
      return `Reading text from illustration ${current} of ${total} (chapter titles, parts, interludes).`
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
  const activePhase = parseProgress?.phase ?? "starting"
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
