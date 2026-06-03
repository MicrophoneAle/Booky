import "dotenv/config"
import path from "node:path"
import { fileURLToPath } from "node:url"
import express from "express"
import cors from "cors"
import multer from "multer"
import { clerkMiddleware, getAuth } from "@clerk/express"
import { createClient } from "@supabase/supabase-js"
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import pdfParse from "pdf-parse/lib/pdf-parse.js"

const PARSER_VERSION = 20

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const app = express()

// 1. CORS first — must be before everything else
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://booky-lemon.vercel.app",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
)

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

app.get("/documents", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("documents")
      .select("id, name, total_pages, word_count, created_at, content")
      .eq("user_id", req.userId)
      .order("created_at", { ascending: false })

    if (error) {
      res.status(500).json({ success: false, error: "Failed to fetch documents" })
      return
    }

    const documents = await Promise.all(
      (data ?? []).map(async (documentRow) => {
        const wordCount = await resolveWordCountForDocument(documentRow, req.userId)
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

app.delete("/documents/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params

    const { data: document, error: fetchError } = await supabase
      .from("documents")
      .select("storage_path")
      .eq("id", id)
      .eq("user_id", req.userId)
      .single()

    if (fetchError || !document) {
      res.status(500).json({ success: false, error: "Delete failed" })
      return
    }

    if (document.storage_path) {
      const { error: storageError } = await supabase.storage
        .from("pdfs")
        .remove([document.storage_path])

      if (storageError) {
        res.status(500).json({ success: false, error: "Delete failed" })
        return
      }
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
  } catch {
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

app.get("/documents/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params

    let { data, error } = await supabase
      .from("documents")
      .select(
        "id, name, total_pages, chapters, content, parser_version, storage_path"
      )
      .eq("id", id)
      .eq("user_id", req.userId)
      .single()

    if (error || !data) {
      res.status(404).json({ success: false, error: "Document not found" })
      return
    }

    const reparsed = await reparseDocumentIfOutdated(data)
    if (reparsed.updated) {
      const refreshed = await supabase
        .from("documents")
        .select("id, name, total_pages, chapters, content, parser_version")
        .eq("id", id)
        .eq("user_id", req.userId)
        .single()

      if (!refreshed.error && refreshed.data) {
        data = refreshed.data
      }
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

const CHAPTER_PATTERN =
  /^(?:(?:chapter|letter|part|section|book|volume|preface|introduction|prologue|epilogue|conclusion|appendix|stave)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)|(?:preface|introduction|prologue|epilogue|conclusion|dedication|contents))\.?$/i

const STRUCTURAL_HEADING_PREFIX_REGEX =
  /^(chapter|letter|part|section|book|volume|preface|introduction|prologue|epilogue|conclusion|appendix|stave)\s+/i

const PART_HEADING_PATTERN =
  /^part\s+(\d+|[ivxlcdm]+|one|two|three|four|five|six)\.?$/i

const VOLUME_HEADING_PATTERN =
  /^volume\s+(\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\.?$/i

const STRUCTURAL_HEADING_MAX_CHARS = 80
const STRUCTURAL_HEADING_MAX_WORDS = 12

const TOC_CHAPTER_LISTING_REGEX =
  /^Chapter\s+(\d+|[IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)\s*:\s+\S/i

const EARLY_TOC_SCAN_LINE_LIMIT = 80

const CHAPTER_NUMBER_REGEX =
  /^(\d{1,2}|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\.?$/i

const CHAPTER_HEADING_MIN_FONT_SIZE = 12.5

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

function applyProseFormattingToBlock(block, line) {
  if (line.centered) {
    block.textAlign = "center"
  }

  const runs = line.runs ?? []
  if (runs.length > 1) {
    block.runs = runs.map((run) => ({
      text: run.text,
      ...(run.bold ? { bold: true } : {}),
      ...(run.italic ? { italic: true } : {}),
    }))
    return
  }

  if (runs.length === 1) {
    if (runs[0].bold) {
      block.bold = true
    }
    if (runs[0].italic) {
      block.italic = true
    }
  }
}

function proseFormattingDiffers(line, previousBlock) {
  if (!previousBlock) {
    return false
  }

  const lineCentered = Boolean(line.centered)
  const prevCentered = previousBlock.textAlign === "center"
  if (lineCentered !== prevCentered) {
    return true
  }

  const lineRuns = line.runs ?? []
  const prevRuns = previousBlock.runs ?? []

  if (lineRuns.length > 1 || prevRuns.length > 1) {
    return true
  }

  const lineBold = lineRuns.length === 1 ? Boolean(lineRuns[0].bold) : false
  const lineItalic = lineRuns.length === 1 ? Boolean(lineRuns[0].italic) : false

  return lineBold !== Boolean(previousBlock.bold) || lineItalic !== Boolean(previousBlock.italic)
}

const Y_LINE_GROUP_TOLERANCE_PX = 3
const INDENT_THRESHOLD_PX = 12
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
const TOC_HEADER_LINE_REGEX = /^-\s*\d+\s*-\s*.+$/

const MARGIN_CALLOUT_MAX_WORDS = 9
const MARGIN_CALLOUT_MAX_CHARS = 52
const MARGIN_CALLOUT_FRAGMENT_MAX_WORDS = 7
const MARGIN_CALLOUT_MIN_LONG_LINES = 5
const MARGIN_CALLOUT_LONG_LINE_CHARS = 65
const MARGIN_CALLOUT_SUBSTRING_PARENT_GAP = 12

const PROSE_BLOCKLIST_WORD_REGEX = /^(and|or|but|the|a|an)$/i

function medianValue(values) {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function normalizeExtractedText(text) {
  if (!text) {
    return ""
  }

  return stripInlineArtifacts(
    text
      .replace(/\u00AD/g, "")
      .replace(/\bfi\s+(?=[a-z])/gi, "fi")
      .replace(/\bfl\s+(?=[a-z])/gi, "fl")
      .replace(/\b([a-z]{4,})\s+(ed|ing|ly|es|er|est)\b/gi, "$1$2")
      .replace(/\bout-\s+/gi, "out-")
  )
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
    .replace(ROMAN_PREFIX_BEFORE_HEADING_REGEX, "")
    .replace(EMBEDDED_PREFACE_PAGE_MARKER_REGEX, "")
    .replace(FOOTNOTE_REFERENCE_REGEX, "")
    .replace(/\s+/g, " ")
    .trim()
}

function dropMarginCalloutLines(lines) {
  const entries = lines
    .map((line) => ({ line, text: (line.text ?? "").trim() }))
    .filter((entry) => entry.text)

  if (entries.length === 0) {
    return lines
  }

  const texts = entries.map((entry) => entry.text)
  const longLineCount = texts.filter((text) => text.length >= MARGIN_CALLOUT_LONG_LINE_CHARS)
    .length

  return entries
    .filter((entry) => {
      const { text, line } = entry

      if (line.centered) {
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

      const words = text.split(/\s+/).filter(Boolean)

      for (const other of texts) {
        if (other.length <= text.length || other === text) {
          continue
        }
        if (
          other.includes(text) &&
          other.length - text.length >= MARGIN_CALLOUT_SUBSTRING_PARENT_GAP
        ) {
          return false
        }
      }

      if (text.length > MARGIN_CALLOUT_MAX_CHARS || words.length > MARGIN_CALLOUT_MAX_WORDS) {
        return true
      }

      if (longLineCount < MARGIN_CALLOUT_MIN_LONG_LINES) {
        return true
      }

      if (
        words.length <= MARGIN_CALLOUT_FRAGMENT_MAX_WORDS &&
        /^[a-z]/.test(text) &&
        /[.!?]["'»]?$/.test(text)
      ) {
        return false
      }

      if (text.length <= 14 && /[.!?]$/.test(text)) {
        return false
      }

      if (isLikelyDialogueContinuationLine(text)) {
        return true
      }

      if (
        words.length <= MARGIN_CALLOUT_MAX_WORDS &&
        text.length <= 42 &&
        longLineCount >= MARGIN_CALLOUT_MIN_LONG_LINES &&
        /^[a-z]/.test(text)
      ) {
        return false
      }

      return true
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
  if (isTocPageReferenceLine(trimmed)) {
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
  if (STRUCTURAL_HEADING_PREFIX_REGEX.test(trimmed)) {
    const fontSize = line?.fontSize ?? 0
    if (fontSize >= CHAPTER_HEADING_MIN_FONT_SIZE || words.length <= 4) {
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
  return isCleanStructuralHeadingText(trimmed, line)
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
  const lineGroups = []

  for (const item of items) {
    let matchedGroup = null

    for (const group of lineGroups) {
      if (Math.abs(group.y - item.y) <= Y_LINE_GROUP_TOLERANCE_PX) {
        matchedGroup = group
        break
      }
    }

    if (!matchedGroup) {
      matchedGroup = { y: item.y, items: [] }
      lineGroups.push(matchedGroup)
    }

    matchedGroup.items.push(item)
    const itemCount = matchedGroup.items.length
    matchedGroup.y =
      matchedGroup.items.reduce((sum, entry) => sum + entry.y, 0) / itemCount
  }

  const lines = []

  for (const group of lineGroups) {
    group.items.sort((a, b) => a.x - b.x)
    const leftmost = group.items[0]
    const rightmost = group.items[group.items.length - 1]
    const text = group.items
      .map((entry) => entry.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()

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

  for (const line of lines) {
    const trimmed = (line.text ?? "").trim()
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
      (lineCountsOnPage.get(trimmed) ?? 0) >= CENTERED_REPEATED_LINE_MIN_COUNT

    line.centered = symmetricMargins || nearColumnCenter || repeatedDisplayLine
  }
}

async function extractLinesByPosition(buffer) {
  const loadingTask = getDocument({ data: new Uint8Array(buffer) })
  const pdf = await loadingTask.promise
  const pagesBeforeFilter = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const textContent = await page.getTextContent()
    const items = []

    for (const item of textContent.items) {
      const str = (item.str ?? "").trim()
      if (!str) {
        continue
      }

      items.push({
        str,
        x: getItemX(item),
        y: getItemY(item),
        fontSize: getItemFontSize(item),
        fontName: item.fontName ?? "",
        transform: item.transform,
      })
    }

    const rawLines = groupTextItemsIntoLines(items)
    const medianX = medianValue(rawLines.map((line) => line.x))

    for (const line of rawLines) {
      line.indented = line.x > medianX + INDENT_THRESHOLD_PX
    }

    annotateLinesCentered(rawLines)
    const filteredLines = dropMarginCalloutLines(rawLines)
    pagesBeforeFilter.push({ lines: filteredLines })
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
  }

  const pageData = []

  for (let pageIndex = 0; pageIndex < pagesBeforeFilter.length; pageIndex += 1) {
    const page = pagesBeforeFilter[pageIndex]
    const lines = []

    for (const line of page.lines) {
      const distinctPageCount = lineDistinctPages.get(line.text)?.size ?? 0
      const occurrencesOnThisPage =
        lineOccurrencesPerPage.get(line.text)?.get(pageIndex) ?? 1
      if (
        shouldDropExtractedLine(
          line.text,
          distinctPageCount,
          occurrencesOnThisPage,
          Boolean(line.centered),
          pageIndex,
          lineFirstPageIndex
        )
      ) {
        continue
      }

      const cleanedText = normalizeExtractedText(line.text)
      if (!cleanedText) {
        continue
      }

      lines.push({
        text: cleanedText,
        indented: Boolean(line.indented),
        centered: Boolean(line.centered),
        fontSize: line.fontSize,
        runs: line.runs ?? [],
        x: line.x,
        y: line.y,
      })
    }

    pageData.push({ lines })
  }

  return pageData
}

async function extractHeadingLines(buffer) {
  const headingStrings = new Set()
  const loadingTask = getDocument({ data: new Uint8Array(buffer) })
  const pdf = await loadingTask.promise

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const textContent = await page.getTextContent()

    for (const item of textContent.items) {
      const fontSize = getItemFontSize(item)

      if (fontSize > 14) {
        const trimmed = (item.str ?? "").trim()
        if (trimmed) {
          headingStrings.add(trimmed)
        }
      }
    }
  }

  return headingStrings
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

function isLikelyChapterNumberLine(text, line) {
  const chapterNumberRegex =
    /^(\d{1,2}|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\.?$/i
  const trimmed = (text ?? "").trim()
  if (!chapterNumberRegex.test(trimmed)) {
    return false
  }
  return (line.fontSize ?? 0) >= CHAPTER_HEADING_MIN_FONT_SIZE
}

function isChapterHeading(block) {
  const text = block.text.trim()

  if (isCleanStructuralHeadingText(text, { fontSize: block.fontSize ?? 0 })) {
    return true
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

function detectChapters(content, bookTitle = "") {
  const trimmedBookTitle = (bookTitle ?? "").trim()

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
      let chapterId = currentChapterId
      let isChapterStart = false

      if (isChapterHeading(block)) {
        const rawTitle = block.text.trim()
        const canonicalTitle = normalizeHeadingCandidate(rawTitle) || rawTitle
        let id = slugify(canonicalTitle)
        let chapterTitle = canonicalTitle

        if (
          PART_HEADING_PATTERN.test(canonicalTitle) ||
          VOLUME_HEADING_PATTERN.test(canonicalTitle)
        ) {
          currentPartId = id
          currentPartTitle = canonicalTitle
        } else if (
          currentPartId &&
          (CHAPTER_NUMBER_REGEX.test(canonicalTitle) ||
            /^(chapter|letter)\s+/i.test(canonicalTitle))
        ) {
          id = `${currentPartId}-${slugify(canonicalTitle)}`
          chapterTitle = `${currentPartTitle ?? currentPartId} — ${canonicalTitle}`
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
          isChapterStart = true
        } else {
          chapterId = currentChapterId
        }
      }

      return {
        ...block,
        chapterId,
        isChapterStart,
      }
    }),
  }))

  return { chapters, content: updatedContent }
}

function isAuthorStructuralLine(text) {
  if (!/^(by|written by|translated by)\s+[A-Z]/i.test(text)) {
    return false
  }
  if (text.length >= 50) {
    return false
  }
  if (/[.!?]/.test(text)) {
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

function isHeadingLine(text, line, headingStrings) {
  if (PROSE_BLOCKLIST_WORD_REGEX.test(text)) {
    return false
  }

  if (!text.includes(" ") && text.length < 5) {
    return false
  }

  if (headingStrings.has(text)) {
    return true
  }

  if (isCleanStructuralHeadingText(text, line)) {
    return true
  }

  if (
    headingStrings.has(text) &&
    text.length < 60 &&
    !isTocDenseListingLine(text) &&
    !isRunningHeaderMergedLine(text)
  ) {
    return true
  }

  if (
    text.length < 60 &&
    line.fontSize >= CHAPTER_HEADING_MIN_FONT_SIZE &&
    !isTocDenseListingLine(text) &&
    !isRunningHeaderMergedLine(text)
  ) {
    return true
  }

  return false
}

function shouldStartNewProseBlock(line, previousBlock) {
  if (line.indented) {
    return true
  }

  if (line.centered) {
    return true
  }

  if (!previousBlock) {
    return true
  }

  if (previousBlock.isHeading || previousBlock.textAlign === "center") {
    return true
  }

  if (proseFormattingDiffers(line, previousBlock)) {
    return true
  }

  const text = line.text.trim()
  const prevTrim = (previousBlock.text ?? "").trim()

  if (/^[A-Z]/.test(text) && /[.!?]$/.test(prevTrim)) {
    return true
  }

  if (/^["“”'']\s*[A-Z]/.test(text)) {
    return true
  }

  return false
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

function isTocHeadingCandidate(text, line, headingStrings, lineIndex) {
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
  return isHeadingLine(text, line, headingStrings)
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

    if (!isTocHeadingCandidate(entry.text, entry.line, headingStrings, lineIndex)) {
      break
    }

    run.push(entry)
    index += 1
  }

  return { run, nextIndex: index }
}

function buildBlocksFromLines(pageData, headingStrings) {
  const blocks = []
  const allLines = []

  for (const page of pageData) {
    for (const line of page.lines ?? []) {
      const text = (line.text ?? "").trim()
      if (text) {
        allLines.push({ line, text })
      }
    }
  }

  let pendingConnective = null
  let nonEmptyLineIndex = 0
  let index = 0
  const sectionLabelState = { lastRepeatedSectionLabel: null }

  while (index < allLines.length) {
    const entry = allLines[index]
    const { line, text } = entry
    const lineIndex = nonEmptyLineIndex
    nonEmptyLineIndex += 1

    if (PROSE_BLOCKLIST_WORD_REGEX.test(text)) {
      const previousBlock = blocks[blocks.length - 1] ?? null

      if (isDedicationStructuralBlock(previousBlock)) {
        blocks.push({
          text,
          isHeading: true,
          fontSize: 13,
          chapterId: null,
        })
        index += 1
        continue
      }

      pendingConnective = text
      index += 1
      continue
    }

    if (isStructuralLine(text, lineIndex)) {
      pendingConnective = null
      blocks.push({
        text,
        isHeading: true,
        fontSize: 13,
        chapterId: null,
      })
      index += 1
      continue
    }

    if (
      isTocDenseListingLine(text) ||
      isTocPageReferenceLine(text) ||
      isRunningHeaderMergedLine(text)
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

    if (lineIndex >= EARLY_TOC_SCAN_LINE_LIMIT && isTocChapterListingLine(text)) {
      pendingConnective = null
      blocks.push({
        text,
        isHeading: true,
        fontSize: 15,
        isChapterStart: true,
        chapterId: null,
      })
      index += 1
      continue
    }

    if (isLikelyChapterNumberLine(text, line)) {
      pendingConnective = null
      blocks.push({
        text: text.trim(),
        isHeading: true,
        fontSize: 15,
        isChapterStart: true,
        chapterId: null,
      })
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

      blocks.push({
        text: canonical,
        isHeading: true,
        fontSize: 15,
        isChapterStart: true,
        chapterId: null,
      })
      index += 1
      continue
    }

    if (isTocHeadingCandidate(text, line, headingStrings, lineIndex)) {
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
        blocks.push({
          text: canonical,
          isHeading: true,
          fontSize: isListing || isBoundary
            ? 15
            : Math.max(14, Math.round(runEntry.line.fontSize ?? 16)),
          isChapterStart: isStructuralStart,
          chapterId: null,
        })
      }
      nonEmptyLineIndex += run.length - 1
      index = nextIndex
      continue
    }

    let proseText = text
    if (pendingConnective) {
      proseText = `${pendingConnective} ${proseText}`.replace(/\s+/g, " ").trim()
      pendingConnective = null
    }

    const previousBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null

    if (shouldStartNewProseBlock(line, previousBlock)) {
      const proseBlock = {
        text: proseText,
        isHeading: false,
        fontSize: 12,
        chapterId: null,
      }
      if (line.indented) {
        proseBlock.isIndented = true
      }
      applyProseFormattingToBlock(proseBlock, line)
      blocks.push(proseBlock)
      index += 1
      continue
    }

    const previous = blocks[blocks.length - 1]
    if (proseFormattingDiffers(line, previous)) {
      const splitBlock = {
        text: proseText,
        isHeading: false,
        fontSize: 12,
        chapterId: null,
      }
      if (line.indented) {
        splitBlock.isIndented = true
      }
      applyProseFormattingToBlock(splitBlock, line)
      blocks.push(splitBlock)
      index += 1
      continue
    }

    previous.text = `${previous.text} ${proseText}`.replace(/\s+/g, " ").trim()
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
      total += countWordsInPlainText(block.text)
    }
  }

  return total
}

function countWordsFromBlocks(blocks) {
  if (!Array.isArray(blocks)) {
    return 0
  }

  return blocks.reduce((total, block) => total + countWordsInPlainText(block.text), 0)
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
  }
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

async function parsePdfBuffer(buffer, fileName = "") {
  const [parsedText, headingStrings, pageData] = await Promise.all([
    pdfParse(buffer),
    extractHeadingLines(buffer),
    extractLinesByPosition(buffer),
  ])

  let blocks = buildBlocksFromLines(pageData, headingStrings)

  const hasTitleHeading = blocks
    .slice(0, 10)
    .some((block) => block.isHeading && (block.fontSize ?? 0) > 14)

  if (!hasTitleHeading) {
    const titleText = (parsedText?.info?.Title ?? "").trim()
    const authorText = (parsedText?.info?.Author ?? "").trim()
    const synthetic = []

    if (titleText) {
      synthetic.push({
        text: titleText,
        isHeading: true,
        fontSize: 20,
        chapterId: null,
      })
    }

    if (authorText) {
      const authorLine = /^by\s/i.test(authorText) ? authorText : `By ${authorText}`
      synthetic.push({
        text: authorLine,
        isHeading: true,
        fontSize: 13,
        chapterId: null,
      })
    }

    if (synthetic.length > 0) {
      blocks = [...synthetic, ...blocks]
    }
  }

  const content = blocksToContent(blocks)

  let bookTitle = (parsedText?.info?.Title ?? "").trim()
  if (!bookTitle && fileName) {
    bookTitle = fileName.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").trim()
  }

  const { chapters, content: contentWithChapters } = detectChapters(content, bookTitle)
  const wordCount = Math.max(
    countWordsInPlainText(parsedText.text),
    countWordsFromBlocks(blocks),
    countWordsFromContent(contentWithChapters)
  )

  return {
    parsedText,
    chapters,
    contentWithChapters,
    wordCount,
  }
}

function isValidAdminSecret(secret) {
  return Boolean(process.env.ADMIN_SECRET) && secret === process.env.ADMIN_SECRET
}

async function reparseDocumentIfOutdated(documentRow) {
  const currentVersion = documentRow.parser_version ?? 0
  if (currentVersion >= PARSER_VERSION || !documentRow.storage_path) {
    return { updated: false }
  }

  const { data: storageFile, error: downloadError } = await supabase.storage
    .from("pdfs")
    .download(documentRow.storage_path)

  if (downloadError || !storageFile) {
    throw new Error("Failed to download source PDF")
  }

  const fileBuffer = Buffer.from(await storageFile.arrayBuffer())
  const { parsedText, chapters, contentWithChapters, wordCount } =
    await parsePdfBuffer(fileBuffer, documentRow.name ?? "")

  const { error: updateError } = await supabase
    .from("documents")
    .update({
      total_pages: parsedText.numpages,
      chapters,
      content: contentWithChapters,
      word_count: wordCount,
      parser_version: PARSER_VERSION,
    })
    .eq("id", documentRow.id)

  if (updateError) {
    throw new Error("Failed to update document with re-parsed content")
  }

  return { updated: true }
}

async function reparseOutdatedDocuments({ limit = 5 } = {}) {
  const summary = {
    reparsed: 0,
    failed: [],
    skipped: 0,
  }

  const { data: documents, error: fetchError } = await supabase
    .from("documents")
    .select("id, storage_path, name, parser_version")
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
      const result = await reparseDocumentIfOutdated(documentRow)
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

      const hasImages = false
      const title = uploadedFile.originalname.replace(/\.pdf$/i, "")
      const { parsedText, chapters, contentWithChapters, wordCount } =
        await parsePdfBuffer(uploadedFile.buffer, uploadedFile.originalname)

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
          total_pages: parsedText.numpages,
          word_count: wordCount,
          chapters,
          content: contentWithChapters,
          parser_version: PARSER_VERSION,
          user_id: req.userId,
        })
        .select("id, word_count")
        .single()

      if (insertError) {
        res.status(500).json({ success: false, error: "Database insert failed" })
        return
      }

      res.json({
        success: true,
        document: {
          id: insertedDocument.id,
          title,
          totalPages: parsedText.numpages,
          wordCount,
          chapters,
          content: contentWithChapters,
          hasImages,
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

export { parsePdfBuffer, PARSER_VERSION }

const isServerEntryPoint =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])

if (isServerEntryPoint) {
  const PORT = process.env.PORT || 3000
  app.listen(PORT, () => {
    console.log(`Server on port ${PORT}`)

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
  })
}
