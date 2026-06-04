import "dotenv/config"
import path from "node:path"
import { fileURLToPath } from "node:url"
import express from "express"
import cors from "cors"
import multer from "multer"
import { clerkMiddleware, getAuth } from "@clerk/express"
import { createClient } from "@supabase/supabase-js"
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"

const PARSER_VERSION = 33

const MAX_PROSE_BLOCK_WORDS = 80
const MAX_PROSE_BLOCK_CHARS = 500
const SHORT_PROSE_CONTINUATION_MAX_WORDS = 20

const PARSE_STATUS = {
  PENDING: "pending",
  READY: "ready",
  ERROR: "error",
}

const backgroundParseInFlight = new Set()
const documentParseProgress = new Map()
const PDF_PAGE_EXTRACTION_CONCURRENCY = 6

const PARSE_PROGRESS_EXTRACT_MAX_PERCENT = 70
const PARSE_PROGRESS_STRUCTURE_PERCENT = 85
const PARSE_PROGRESS_SAVE_PERCENT = 95

function setDocumentParseProgress(documentId, progress) {
  documentParseProgress.set(documentId, progress)
}

function getDocumentParseProgress(documentId) {
  return documentParseProgress.get(documentId) ?? null
}

function clearDocumentParseProgress(documentId) {
  documentParseProgress.delete(documentId)
}

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

app.get("/documents/:id/status", requireAuth, async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from("documents")
      .select("id, parse_status")
      .eq("id", id)
      .eq("user_id", req.userId)
      .single()

    if (error || !data) {
      res.status(404).json({ success: false, error: "Document not found" })
      return
    }

    const parseStatus = data.parse_status ?? PARSE_STATUS.READY
    const liveProgress = getDocumentParseProgress(data.id)

    res.json({
      success: true,
      id: data.id,
      parse_status: parseStatus,
      parse_progress: liveProgress,
      parse_percent:
        parseStatus === PARSE_STATUS.READY
          ? 100
          : (liveProgress?.percent ?? 0),
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

function escapeHtmlText(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function renderBlockInlineHtml(block) {
  if (Array.isArray(block.runs) && block.runs.length > 1) {
    return block.runs
      .map((run) => {
        let html = escapeHtmlText(run.text ?? "")
        if (run.bold) html = `<strong>${html}</strong>`
        if (run.italic) html = `<em>${html}</em>`
        return html
      })
      .join("")
  }

  let html = escapeHtmlText(block.text ?? "")
  if (block.bold) html = `<strong>${html}</strong>`
  if (block.italic) html = `<em>${html}</em>`
  return html
}

function buildReformattedHtml(name, content) {
  const safeTitle = escapeHtmlText(name || "Document")
  const parts = []
  let previousWasHeading = false
  let lastProseIndex = -1

  const pages = Array.isArray(content) ? content : []

  for (const page of pages) {
    for (const block of page.blocks ?? []) {
      const text = (block.text ?? "").trim()
      if (!text) {
        continue
      }

      const isCentered =
        block.textAlign === "center" || block.centered === true

      if (block.isHeading) {
        const tag = (block.fontSize ?? 0) >= 18 ? "h1" : "h2"
        parts.push(`<${tag}>${renderBlockInlineHtml(block)}</${tag}>`)
        previousWasHeading = true
        lastProseIndex = -1
        continue
      }

      if (isCentered) {
        parts.push(`<p class="center">${renderBlockInlineHtml(block)}</p>`)
        previousWasHeading = false
        lastProseIndex = -1
        continue
      }

      if (block.isContinuation && lastProseIndex >= 0) {
        parts[lastProseIndex] = parts[lastProseIndex].replace(
          /<\/p>$/,
          ` ${renderBlockInlineHtml(block)}</p>`
        )
        continue
      }

      const className = previousWasHeading ? "first" : "body"
      parts.push(`<p class="${className}">${renderBlockInlineHtml(block)}</p>`)
      lastProseIndex = parts.length - 1
      previousWasHeading = false
    }
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    background: #f4efe6;
    color: #1c1917;
    font-family: "Georgia", "Times New Roman", serif;
    line-height: 1.6;
  }
  main {
    max-width: 40rem;
    margin: 0 auto;
    padding: 3rem 1.5rem 5rem;
  }
  h1 {
    font-size: 1.9rem;
    margin: 2.5rem 0 1rem;
    line-height: 1.2;
  }
  h2 {
    font-size: 1.35rem;
    margin: 2rem 0 0.75rem;
    line-height: 1.25;
  }
  p {
    margin: 0;
    text-align: justify;
    hyphens: auto;
  }
  p.body { text-indent: 1.5em; }
  p.first { text-indent: 0; }
  p.center {
    text-align: center;
    text-indent: 0;
    margin: 0.6rem 0;
    letter-spacing: 0.04em;
  }
</style>
</head>
<body>
<main>
${parts.join("\n")}
</main>
</body>
</html>`
}

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

    const html = buildReformattedHtml(data.name, data.content)
    const safeFileName = (data.name || "document").replace(/[^\w.\- ]+/g, "_")

    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFileName} (reformatted).html"`
    )
    res.send(html)
  } catch {
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
      const cachedWhileStale = readParsedCache(data)
      const hasServingContent =
        Boolean(cachedWhileStale) ||
        (Array.isArray(data.content) && data.content.length > 0)

      // Do not block the open request on a full PDF re-parse (Monte Cristo can take minutes).
      // Return existing content immediately and refresh parser output in the background.
      if (hasServingContent) {
        void reparseDocumentInBackgroundFromRow(data)

        if (cachedWhileStale) {
          res.json({
            success: true,
            document: buildOpenDocumentPayload(data, cachedWhileStale),
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
        return
      }

      await reparseDocumentIfOutdated(data)

      const { data: refreshed, error: refreshError } = await supabase
        .from("documents")
        .select(
          "id, name, total_pages, chapters, content, parser_version, parsed_cache, parsed_cache_version"
        )
        .eq("id", id)
        .eq("user_id", req.userId)
        .single()

      if (refreshError || !refreshed) {
        res.status(500).json({ success: false, error: "Failed to load document." })
        return
      }

      const refreshedCache = readParsedCache(refreshed)
      if (refreshedCache) {
        res.json({
          success: true,
          document: buildOpenDocumentPayload(refreshed, refreshedCache),
        })
        return
      }

      res.json({
        success: true,
        document: {
          id: refreshed.id,
          name: refreshed.name,
          total_pages: refreshed.total_pages,
          chapters: refreshed.chapters,
          content: refreshed.content,
          parser_version: refreshed.parser_version ?? PARSER_VERSION,
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
  if (line.centered && !isShortDialogueLine(lineText)) {
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
  if (previousBlock.textAlign === "center") {
    return false
  }
  if (isAllCapsCalloutLine(trimmed)) {
    return false
  }
  if (/[.!?]["'\u201d]?\s*$/.test(prevTrim)) {
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

function isProminentDisplayTitleLine(text, line, entry = null) {
  const trimmed = (text ?? "").trim()
  if (!trimmed || isScannerWatermarkLine(trimmed)) {
    return false
  }
  if (CHAPTER_PATTERN.test(trimmed) || isAuthorStructuralLine(trimmed)) {
    return false
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 2 || words.length > 12) {
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

function normalizeExtractedText(text) {
  if (!text) {
    return ""
  }

  return stripInlineArtifacts(
    joinSplitWordFragments(
      repairEpistolaryPdfArtifacts(text)
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
  return upperCount / letters.length >= 0.85
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
    .replace(ROMAN_PREFIX_BEFORE_HEADING_REGEX, "")
    .replace(EMBEDDED_PREFACE_PAGE_MARKER_REGEX, "")
    .replace(FOOTNOTE_REFERENCE_REGEX, "")
    .replace(/\s+/g, " ")
    .trim()
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
  if (isScannerWatermarkLine(trimmed)) {
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
    if (isShortDialogueLine(trimmed) || isDialogueAttributionFragment(trimmed)) {
      line.centered = false
      continue
    }

    if (isAllCapsCalloutLine(trimmed)) {
      line.centered = true
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

    line.centered = symmetricMargins || nearColumnCenter || repeatedDisplayLine
  }
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

async function extractPdfPageLines(pdf, pageNumber, headingStrings) {
  const page = await pdf.getPage(pageNumber)
  const textContent = await page.getTextContent()
  const pageItems = []

  try {
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
    const medianX = medianValue(rawLines.map((line) => line.x))

    for (const line of rawLines) {
      line.indented = line.x > medianX + INDENT_THRESHOLD_PX
    }

    annotateLinesCentered(rawLines)
    return dropMarginCalloutLines(rawLines)
  } finally {
    if (typeof page.cleanup === "function") {
      page.cleanup()
    }
  }
}

async function extractPdfStructure(buffer, { onPageProcessed } = {}) {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
  })
  const pdf = await loadingTask.promise
  const headingStrings = new Set()
  const pdfInfo = await readPdfInfo(pdf)
  const totalPages = pdf.numPages

  const pagesBeforeFilter = new Array(totalPages)

  try {
    for (
      let batchStart = 1;
      batchStart <= totalPages;
      batchStart += PDF_PAGE_EXTRACTION_CONCURRENCY
    ) {
      const batchEnd = Math.min(
        batchStart + PDF_PAGE_EXTRACTION_CONCURRENCY - 1,
        totalPages
      )
      const batchPageNumbers = []

      for (let pageNumber = batchStart; pageNumber <= batchEnd; pageNumber += 1) {
        batchPageNumbers.push(pageNumber)
      }

      const batchLines = await Promise.all(
        batchPageNumbers.map((pageNumber) =>
          extractPdfPageLines(pdf, pageNumber, headingStrings)
        )
      )

      for (let index = 0; index < batchPageNumbers.length; index += 1) {
        const pageNumber = batchPageNumbers[index]
        pagesBeforeFilter[pageNumber - 1] = { lines: batchLines[index] }

        if (onPageProcessed) {
          onPageProcessed(pageNumber, totalPages)
        }
      }
    }
  } finally {
    if (typeof pdf.destroy === "function") {
      await pdf.destroy()
    }
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
        y: line.y,
        runs: line.runs ?? [],
      })
    }

    pageData.push({ lines })
  }

  return {
    pageData,
    headingStrings,
    numPages: pdf.numPages,
    pdfInfo,
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

function qualifiesAsEmittedHeading(text) {
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
    return false
  }

  return true
}

function logHeadingPromotion(text, reasonLabel) {
  if (process.env.BOOKY_HEADING_DEBUG === "1") {
    console.log("[heading]", JSON.stringify(text), "via", reasonLabel)
  }
}

function pushHeadingBlock(blocks, payload, reasonLabel) {
  const text = (payload.text ?? "").trim()
  if (!qualifiesAsEmittedHeading(text)) {
    return false
  }

  logHeadingPromotion(text, reasonLabel)
  blocks.push(payload)
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
  if (isScannerWatermarkLine(text)) {
    return false
  }

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

  if (isProminentDisplayTitleLine(text, line, entry)) {
    return true
  }

  if (PROSE_BLOCKLIST_WORD_REGEX.test(text)) {
    return false
  }

  if (/^[a-z(\u201c]/.test((text ?? "").trim())) {
    return false
  }

  if (isNarrativeSentenceLine(text)) {
    return false
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

  if (line.indented && !/^[a-z(\u201c]/.test(text)) {
    return true
  }

  if (!previousBlock) {
    return true
  }

  if (previousBlock.isHeading || previousBlock.textAlign === "center") {
    return true
  }

  if (isProseLineContinuation(text, previousBlock)) {
    return false
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

function buildBlocksFromLines(pageData, headingStrings) {
  const blocks = []
  const allLines = []

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

    if (isScannerWatermarkLine(text)) {
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
          "dedicationConnective"
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
        "structuralLine"
      )
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
      pushHeadingBlock(
        blocks,
        {
          text,
          isHeading: true,
          fontSize: 15,
          isChapterStart: true,
          chapterId: null,
        },
        "tocChapterListing"
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
          "likelyChapterNumber"
        )
      ) {
        index += 1
        continue
      }
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
        "narrativeBoundary"
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
              : "tocHeadingRun"
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
      blocks.push(proseBlock)
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
      blocks.push(splitBlock)
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
      blocks.push(proseBlock)
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
    parse_status: documentRow.parse_status ?? PARSE_STATUS.READY,
  }
}

function hasValidParsedCache(documentRow) {
  if (Number(documentRow?.parsed_cache_version) !== PARSER_VERSION) {
    return false
  }

  if (Array.isArray(documentRow?.content) && documentRow.content.length > 0) {
    return true
  }

  return Boolean(documentRow?.parsed_cache)
}

function readParsedCache(documentRow) {
  if (!hasValidParsedCache(documentRow)) {
    return null
  }

  if (Array.isArray(documentRow.content) && documentRow.content.length > 0) {
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
      typeof documentRow.parsed_cache === "string"
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

function buildOpenDocumentPayload(documentRow, cached) {
  return {
    id: documentRow.id,
    name: documentRow.name,
    total_pages: cached.parsedText?.numpages ?? documentRow.total_pages,
    chapters: cached.chapters,
    content: cached.contentWithChapters,
    parser_version: PARSER_VERSION,
  }
}

async function parseDocumentInBackground(documentId, userId, buffer, fileName) {
  if (backgroundParseInFlight.has(documentId)) {
    return
  }

  backgroundParseInFlight.add(documentId)
  setDocumentParseProgress(documentId, {
    phase: "starting",
    current: 0,
    total: 0,
    percent: 0,
  })

  const parseStartedAt = Date.now()

  try {
    const { parsedText, chapters, contentWithChapters, wordCount, bookTitle } =
      await parsePdfBuffer(buffer, fileName, {
        onPageProcessed(pageNumber, totalPages) {
          if (pageNumber % 100 === 0 || pageNumber === totalPages) {
            console.log(
              `Parsed ${pageNumber}/${totalPages} pages for document ${documentId}`
            )
          }
        },
        onProgress(progress) {
          setDocumentParseProgress(documentId, progress)
        },
      })

    setDocumentParseProgress(documentId, {
      phase: "saving",
      current: 0,
      total: 0,
      percent: PARSE_PROGRESS_SAVE_PERCENT,
    })

    console.log(
      `Background parse finished for ${documentId} (${parsedText.numpages} PDF pages, ${wordCount.toLocaleString()} words) in ${((Date.now() - parseStartedAt) / 1000).toFixed(1)}s`
    )

    const parseResult = { parsedText, chapters, contentWithChapters, wordCount, bookTitle }

    const documentUpdate = {
      total_pages: parsedText.numpages,
      chapters,
      content: contentWithChapters,
      word_count: wordCount,
      parser_version: PARSER_VERSION,
      parse_status: PARSE_STATUS.READY,
      ...buildParsedCacheFields(),
    }

    if (bookTitle) {
      documentUpdate.name = bookTitle
    }

    const { error: updateError } = await supabase
      .from("documents")
      .update(documentUpdate)
      .eq("id", documentId)
      .eq("user_id", userId)

    if (updateError) {
      throw new Error("Failed to save parsed document")
    }

    clearDocumentParseProgress(documentId)
  } catch (error) {
    console.error(
      `Background parse failed for document ${documentId}:`,
      error instanceof Error ? error.message : error
    )

    await supabase
      .from("documents")
      .update({ parse_status: PARSE_STATUS.ERROR })
      .eq("id", documentId)
      .eq("user_id", userId)
  } finally {
    backgroundParseInFlight.delete(documentId)
    clearDocumentParseProgress(documentId)
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

async function parsePdfBuffer(
  buffer,
  fileName = "",
  { onPageProcessed, onProgress } = {}
) {
  const reportProgress = (progress) => {
    onProgress?.(progress)
  }

  reportProgress({
    phase: "extracting",
    current: 0,
    total: 0,
    percent: 0,
  })

  const { pageData, headingStrings, numPages, pdfInfo } =
    await extractPdfStructure(buffer, {
      onPageProcessed(pageNumber, totalPages) {
        onPageProcessed?.(pageNumber, totalPages)

        const extractPercent =
          totalPages > 0
            ? Math.round(
                (pageNumber / totalPages) * PARSE_PROGRESS_EXTRACT_MAX_PERCENT
              )
            : 0

        reportProgress({
          phase: "extracting",
          current: pageNumber,
          total: totalPages,
          percent: extractPercent,
        })
      },
    })

  const parsedText = {
    numpages: numPages,
    info: pdfInfo,
    text: "",
  }

  reportProgress({
    phase: "structuring",
    current: 0,
    total: 0,
    percent: PARSE_PROGRESS_EXTRACT_MAX_PERCENT + 2,
  })

  let blocks = splitDialogueHeavyBlocks(buildBlocksFromLines(pageData, headingStrings))

  reportProgress({
    phase: "structuring",
    current: 0,
    total: 0,
    percent: PARSE_PROGRESS_STRUCTURE_PERCENT,
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
        })
      }
    }

    if (synthetic.length > 0) {
      blocks = [...synthetic, ...blocks]
    }
  }

  const content = blocksToContent(blocks)

  const { chapters, content: contentWithChapters } = detectChapters(content, bookTitle)
  const wordCount = countWordsFromBlocks(blocks)

  reportProgress({
    phase: "finalizing",
    current: 0,
    total: 0,
    percent: PARSE_PROGRESS_SAVE_PERCENT - 2,
  })

  return {
    parsedText,
    chapters,
    contentWithChapters,
    wordCount,
    bookTitle,
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
  if ((documentRow.parser_version ?? 0) < PARSER_VERSION) {
    return true
  }
  return contentLooksStale(documentRow.content)
}

async function reparseDocumentInBackgroundFromRow(documentRow) {
  const documentId = documentRow?.id
  if (!documentId || backgroundParseInFlight.has(documentId)) {
    return
  }

  backgroundParseInFlight.add(documentId)
  try {
    await reparseDocumentIfOutdated(documentRow)
  } catch (error) {
    console.error(`Background re-parse failed for ${documentId}:`, error)
  } finally {
    backgroundParseInFlight.delete(documentId)
  }
}

async function reparseDocumentIfOutdated(documentRow, options = {}) {
  if (!documentNeedsReparse(documentRow, options)) {
    return { updated: false }
  }

  const { data: storageFile, error: downloadError } = await supabase.storage
    .from("pdfs")
    .download(documentRow.storage_path)

  if (downloadError || !storageFile) {
    throw new Error("Failed to download source PDF")
  }

  const fileBuffer = Buffer.from(await storageFile.arrayBuffer())
  const parseResult = await parsePdfBuffer(fileBuffer, documentRow.name ?? "")
  const { parsedText, chapters, contentWithChapters, wordCount } = parseResult

  const { error: updateError } = await supabase
    .from("documents")
    .update({
      total_pages: parsedText.numpages,
      chapters,
      content: contentWithChapters,
      word_count: wordCount,
      parser_version: PARSER_VERSION,
      parse_status: PARSE_STATUS.READY,
      ...buildParsedCacheFields(),
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

      const pdfBuffer = uploadedFile.buffer
      const documentId = insertedDocument.id
      const userId = req.userId
      const originalName = uploadedFile.originalname

      setImmediate(() => {
        void parseDocumentInBackground(documentId, userId, pdfBuffer, originalName)
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
  PARSER_VERSION,
}

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
