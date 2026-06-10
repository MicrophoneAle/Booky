import "dotenv/config"
import path from "node:path"
import zlib from "node:zlib"
import { fileURLToPath } from "node:url"
import express from "express"
import multer from "multer"
import { clerkMiddleware, getAuth } from "@clerk/express"
import { createClient } from "@supabase/supabase-js"
import crypto from "node:crypto"
import { getDocument, OPS, ImageKind } from "pdfjs-dist/legacy/build/pdf.mjs"
import { createCanvas } from "@napi-rs/canvas/node-canvas.js"
import { analyzeChapterGraphicFromContext } from "./chapterGraphicService.js"
import {
  countInterludeNamesInDivider,
  ocrIllustrationMetadata,
} from "./imageOcrService.js"
import { extractPrintedTocLookup } from "./printedTocService.js"

const PARSER_VERSION = 51
const PDF_IMAGE_JPEG_CONTENT_TYPE = "image/jpeg"

const PDF_IMAGE_PAINT_OPS = new Set(
  [OPS.paintImageXObject, OPS.paintInlineImageXObject].filter((op) => op != null)
)
const PDF_IMAGE_RESOLVE_TIMEOUT_MS = 8000
const ILLUSTRATION_VISION_CONCURRENCY = 4
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
const documentParseProgress = new Map()
const PDF_PAGE_EXTRACTION_CONCURRENCY = 6

const PARSE_PROGRESS_EXTRACT_MAX_PERCENT = 60
const PARSE_PROGRESS_STRUCTURE_PERCENT = 68
const PARSE_PROGRESS_CLASSIFY_PERCENT = 74
const PARSE_PROGRESS_UPLOAD_MAX_PERCENT = 90
const PARSE_PROGRESS_FINALIZE_PERCENT = 94
const PARSE_PROGRESS_SAVE_PERCENT = 97

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

    backgroundParseInFlight.delete(id)
    clearDocumentParseProgress(id)

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

function extractToUnicodeCMapTextsFromPdfBuffer(buffer) {
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

function buildDefaultPuaReplacementMap(buffer = null) {
  const replacementByPua = buffer
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

function isPrintedTocHeading(text) {
  const trimmed = (text ?? "").trim()
  return /^(?:contents|table of contents)$/i.test(trimmed)
}

function isPrintedTocEntryLine(text) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return false
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

    return block
  })
}

function excludePrintedTocBlocks(blocks) {
  const dropIndices = new Set()
  let inPrintedTocSection = false
  const firstChapterIndex = findFirstChapterBlockIndex(blocks)

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
  if (!text || !block?.isHeading) {
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

function mergeMultilineChapterTitleBlocks(blocks) {
  const merged = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
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
  if (!text || !block?.isHeading) {
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

function normalizeExtractedText(text, options = {}) {
  if (!text) {
    return ""
  }

  const puaNormalized = translatePuaCharacters(
    text,
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
    .filter((entry, entryIndex) => {
      const { text, line } = entry
      const previousText = entryIndex > 0 ? entries[entryIndex - 1].text : ""

      if (
        parseChapterOnlyHeading(previousText) &&
        isLikelyChapterSubtitleText(text)
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

const PDF_IMAGE_ROLE = Object.freeze({
  FULL_PAGE_ILLUSTRATION: "full_page_illustration",
  CHAPTER_HEADING: "chapter_heading",
})

/** Minimum rendered height (px) for a wide banner to count as a chapter heading graphic. */
const CHAPTER_HEADING_MIN_HEIGHT_PX = 36

/**
 * Classify extracted PDF images into illustration roles.
 * Full-page art and wide chapter-heading banners (e.g. Stormlight arch headers) are kept;
 * small decorations and narrow clips are dropped.
 *
 * @returns {"full_page_illustration"|"chapter_heading"|null}
 */
function classifyPdfImageRole(metrics) {
  const { width, height, pageHeight, pageWidth } = metrics ?? {}
  if (!pageHeight || !pageWidth || !width || !height) {
    return null
  }

  const widthRatio = width / pageWidth
  const heightRatio = height / pageHeight

  if (widthRatio < 0.35) {
    return null
  }

  if (heightRatio >= 0.35) {
    return PDF_IMAGE_ROLE.FULL_PAGE_ILLUSTRATION
  }

  if (
    height >= CHAPTER_HEADING_MIN_HEIGHT_PX &&
    heightRatio >= 0.06 &&
    heightRatio < 0.35 &&
    width / height >= 1.2
  ) {
    return PDF_IMAGE_ROLE.CHAPTER_HEADING
  }

  return null
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

async function resolvePdfImageObject(page, imageRefId) {
  if (!imageRefId) {
    return null
  }

  return Promise.race([
    page.objs.get(imageRefId),
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("Image resolve timed out")),
        PDF_IMAGE_RESOLVE_TIMEOUT_MS
      )
    }),
  ])
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
    if (isJpegImageBuffer(buffer)) {
      return buffer
    }
  }

  if (typeof imageObject.src === "string" && imageObject.src.startsWith("data:image/jpeg")) {
    const buffer = bufferFromByteSource(imageObject.src)
    if (buffer?.length) {
      return buffer
    }
  }

  const dataBuffer = bufferFromByteSource(imageObject.data)
  if (isJpegImageBuffer(dataBuffer)) {
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

function resolvePdfImageBuffer(imageObject) {
  const compressedBuffer = extractCompressedPdfImageBytes(imageObject)
  if (compressedBuffer?.length) {
    return compressedBuffer
  }

  return rawPdfPixelsToJpegBuffer(imageObject)
}

function pdfImageDataToBase64(imageObject) {
  const buffer = resolvePdfImageBuffer(imageObject)
  return buffer?.length ? buffer.toString("base64") : null
}

async function extractPdfPageImageCandidates(page, pageNumber) {
  const viewport = page.getViewport({ scale: 1 })
  const pageWidth = viewport.width
  const pageHeight = viewport.height
  const operatorList = await page.getOperatorList({ intent: "display" })
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

    let buffer = null

    try {
      if (op === OPS.paintInlineImageXObject) {
        buffer = pdfImageDataToBase64(args?.[0])
      } else {
        const imageObject = await resolvePdfImageObject(page, args?.[0])
        buffer = pdfImageDataToBase64(imageObject)
      }
    } catch {
      buffer = null
    }

    const imageRole = classifyPdfImageRole(metrics)

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
      },
      imageRole,
      isCandidate: imageRole != null,
      buffer,
    })
  }

  return candidates
}

async function extractPdfPageImages(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber)

  try {
    return await extractPdfPageImageCandidates(page, pageNumber)
  } finally {
    if (typeof page.cleanup === "function") {
      page.cleanup()
    }
  }
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

function interleaveImageCandidateBlocks(textBlocks, pageImageCandidates, pageData) {
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

  for (let pageIndex = 0; pageIndex <= maxPageIndex; pageIndex += 1) {
    const pageImages = [...(imagesByPage.get(pageIndex) ?? [])].sort(
      (left, right) =>
        (right.coordinates?.y ?? 0) - (left.coordinates?.y ?? 0) ||
        (left.streamIndex ?? 0) - (right.streamIndex ?? 0)
    )
    const pageTextBlocks = textBlocksByPage.get(pageIndex) ?? []

    interleaved.push(...pageImages, ...pageTextBlocks)
  }

  return interleaved
}

function extractImageBlockPayload(block) {
  return block?.buffer ?? block?.imgData ?? ""
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
  const includeInToc = visionResult?.includeInToc !== false

  return {
    ...rest,
    type: "image",
    imageRole: block.imageRole ?? null,
    isChapterBoundary: Boolean(visionResult?.isChapterBoundary),
    chapterMetadata: {
      boundaryKind: visionResult?.boundaryKind ?? null,
      title: visionResult?.title ?? null,
      number: visionResult?.number ?? null,
      rawText: visionResult?.rawText ?? null,
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

function countSamePageTextCharsForImage(blocks, imageBlock) {
  const pageIndex = Math.max(0, (imageBlock?.pageNumber ?? 1) - 1)
  let total = 0

  for (const block of blocks) {
    if (block?.type === "image" || block?.type === "image_candidate") {
      continue
    }

    if ((block?.sourcePdfPageIndex ?? -1) === pageIndex) {
      total += (block?.text ?? "").length
    }
  }

  return total
}

async function finalizeIllustrationBlocks(blocks, { onProgress, printedToc = null } = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return blocks
  }

  const candidateEntries = blocks
    .map((block, index) => ({ block, index }))
    .filter(
      ({ block }) =>
        block?.type === "image_candidate" &&
        block.isCandidate === true &&
        Boolean(extractImageBlockPayload(block))
    )

  const ocrEntries = candidateEntries.filter(({ block, index }) => {
    if (block.imageRole === "chapter_heading") {
      return true
    }

    return (
      block.imageRole === "full_page_illustration" &&
      countSamePageTextCharsForImage(blocks, block) <= 80
    )
  })

  let chapterSequence = 0
  let interludeSequence = 0
  let pendingInterludes = 0
  let ocrCompleted = 0

  const finalizedByIndex = new Map()

  for (const { block, index } of candidateEntries) {
    const imageBuffer = base64PayloadToImageBuffer(extractImageBlockPayload(block))
    let ocrMetadata = null

    const sparseIllustrationPage =
      block.imageRole === "full_page_illustration" &&
      countSamePageTextCharsForImage(blocks, block) <= 80
    const shouldRunOcr =
      block.imageRole === "chapter_heading" || sparseIllustrationPage

    if (imageBuffer?.length && shouldRunOcr) {
      ocrMetadata = await ocrIllustrationMetadata(imageBuffer, block.imageRole ?? null)
      ocrCompleted += 1
      onProgress?.({
        phase: "ocr_illustrations",
        label: "Reading text from illustrations",
        current: ocrCompleted,
        total: ocrEntries.length,
      })
    }

    const forceInterludeBoundary =
      pendingInterludes > 0 && block.imageRole === "chapter_heading"

    const analysisResult = analyzeChapterGraphicFromContext({
      imageBlock: block,
      blocks,
      blockIndex: index,
      chapterSequence: chapterSequence + 1,
      interludeSequence: interludeSequence + 1,
      ocrMetadata,
      printedToc,
      forceInterludeBoundary,
    })

    if (analysisResult.boundaryKind === "interlude_divider") {
      pendingInterludes = countInterludeNamesInDivider(ocrMetadata) || 3
    } else if (analysisResult.boundaryKind === "interlude") {
      interludeSequence += 1
      pendingInterludes = Math.max(0, pendingInterludes - 1)
    } else if (analysisResult.boundaryKind === "chapter") {
      chapterSequence += 1
      pendingInterludes = 0
    } else if (analysisResult.boundaryKind === "part") {
      pendingInterludes = 0
    }

    finalizedByIndex.set(index, finalizeVisionImageBlock(block, analysisResult))
  }

  return blocks.flatMap((block, index) => {
    if (block?.type !== "image_candidate") {
      return [block]
    }

    if (block.isCandidate !== true || !extractImageBlockPayload(block)) {
      return []
    }

    return [finalizedByIndex.get(index)]
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

function base64PayloadToImageBuffer(base64Payload) {
  const trimmed = (base64Payload ?? "").trim()
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

async function uploadImageAssetBuffer(bookId, blockId, imageBuffer) {
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

  for (const index of uploadableIndices) {
    const block = nextBlocks[index]
    const blockId = block.id ?? `image-${index + 1}`
    const imageBuffer = base64PayloadToImageBuffer(extractImageBase64Payload(block))

    if (!imageBuffer || imageBuffer.length === 0) {
      console.warn("[uploadBookAssets]", {
        bookId,
        blockId,
        index,
        message: "Skipping image block with no uploadable binary data",
      })
      nextBlocks[index] = stripImageBinaryFields(block)
      continue
    }

    let publicUrl
    try {
      publicUrl = await uploadImageAssetBuffer(bookId, blockId, imageBuffer)
    } catch (error) {
      console.error("[uploadBookAssets]", {
        bookId,
        blockId,
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
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
  }

  for (let index = 0; index < nextBlocks.length; index += 1) {
    const block = nextBlocks[index]
    if (block?.type !== "image") {
      continue
    }

    if (block.src && !extractImageBase64Payload(block)) {
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

    for (const line of rawLines) {
      if (isSceneBreakOrnamentLine(line.text) && line.centered) {
        line.isSceneBreakOrnament = true
      }
    }

    return dropMarginCalloutLines(rawLines)
  } finally {
    if (typeof page.cleanup === "function") {
      page.cleanup()
    }
  }
}

async function extractPdfStructure(buffer, { onPageProcessed, puaReplacementMap } = {}) {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
  })
  const pdf = await loadingTask.promise
  const puaMap = puaReplacementMap ?? buildDefaultPuaReplacementMap(buffer)
  const headingStrings = new Set()
  const pdfInfo = await readPdfInfo(pdf)
  const totalPages = pdf.numPages

  const pagesBeforeFilter = new Array(totalPages)
  const pageImageCandidates = new Array(totalPages)

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

      const batchResults = await Promise.all(
        batchPageNumbers.map(async (pageNumber) => ({
          lines: await extractPdfPageLines(pdf, pageNumber, headingStrings),
          images: await extractPdfPageImages(pdf, pageNumber),
        }))
      )

      for (let index = 0; index < batchPageNumbers.length; index += 1) {
        const pageNumber = batchPageNumbers[index]
        pagesBeforeFilter[pageNumber - 1] = { lines: batchResults[index].lines }
        pageImageCandidates[pageNumber - 1] = batchResults[index].images

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

  return {
    pageData,
    headingStrings,
    numPages: pdf.numPages,
    pdfInfo,
    pageImageCandidates,
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

function pushHeadingBlock(blocks, payload, reasonLabel, pageIndex) {
  const text = (payload.text ?? "").trim()
  if (!qualifiesAsEmittedHeading(text, { fontSize: payload.fontSize ?? 0 })) {
    return false
  }

  logHeadingPromotion(text, reasonLabel)
  blocks.push(withSourcePdfPage(payload, pageIndex))
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
  if (block?.type === "image" || typeof block?.text !== "string") {
    return false
  }

  const text = block.text.trim()

  if (CHAPTER_WITH_SUBTITLE_REGEX.test(text)) {
    return true
  }

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

const CHAPTER_ONLY_HEADING_REGEX =
  /^(chapter|letter)\s+(\d{1,3}|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\.?\s*$/i

const CHAPTER_WITH_SUBTITLE_REGEX =
  /^(chapter|letter)\s+(\d{1,3}|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\s*-\s+\S/i

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
  if (trimmed.length > 72) {
    return false
  }

  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length < 1 || words.length > 12) {
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

  return words.length <= 10 && trimmed.length <= 60
}

function isLikelyChapterSubtitleBlock(block) {
  const text = (block?.text ?? "").trim()
  if (!text) {
    return false
  }
  if (block?.isHeading && !isLikelyChapterSubtitleText(text)) {
    return false
  }
  if (!isLikelyChapterSubtitleText(text)) {
    return false
  }

  const centered = block.textAlign === "center"
  if (centered) {
    return true
  }

  return (block?.text ?? "").length <= 48
}

function mergeChapterSubtitleBlocks(blocks) {
  const merged = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const text = (block.text ?? "").trim()
    const parts = block.isHeading ? parseChapterOnlyHeading(text) : null

    if (parts && index + 1 < blocks.length) {
      const nextBlock = blocks[index + 1]
      if (isLikelyChapterSubtitleBlock(nextBlock)) {
        const displayTitle = formatChapterLabel(
          parts.kind,
          parts.number,
          nextBlock.text ?? ""
        )
        merged.push({
          ...block,
          text: displayTitle,
          chapterTitle: displayTitle,
        })
        index += 1
        continue
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
        const canonicalTitle = normalizeHeadingCandidate(rawTitle) || rawTitle
        let id = slugify(canonicalTitle)
        let chapterTitle = block.chapterTitle ?? rawTitle

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
          const chapterLabel = block.chapterTitle ?? rawTitle
          chapterTitle = `${currentPartTitle ?? currentPartId} — ${chapterLabel}`
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
        entry.pageIndex
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
          entry.pageIndex
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
        entry.pageIndex
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
        "tocChapterListing",
        entry.pageIndex
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
          entry.pageIndex
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
        "narrativeBoundary",
        entry.pageIndex
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
          runEntry.pageIndex
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
        documentId,
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
      label: "Saving to your library",
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
    backgroundParseInFlight.delete(documentId)
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
  { onPageProcessed, onProgress, documentId } = {}
) {
  const reportProgress = (progress) => {
    onProgress?.(progress)
  }

  reportProgress({
    phase: "extracting",
    label: "Reading PDF pages",
    current: 0,
    total: 0,
    percent: 0,
  })

  const puaReplacementMap = buildDefaultPuaReplacementMap(buffer)

  const { pageData, headingStrings, numPages, pdfInfo, pageImageCandidates } =
    await extractPdfStructure(buffer, {
      puaReplacementMap,
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
          label: "Reading PDF pages",
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
    label: "Building book structure",
    current: 0,
    total: 0,
    percent: PARSE_PROGRESS_EXTRACT_MAX_PERCENT + 2,
  })

  let blocks = splitDialogueHeavyBlocks(buildBlocksFromLines(pageData, headingStrings))
  blocks = mergeMultilineChapterTitleBlocks(blocks)
  blocks = mergeChapterSubtitleBlocks(blocks)
  blocks = mergeInlineChapterLabelTitles(blocks)
  blocks = mergeTrailingChapterTitleFragments(blocks)
  blocks = mergeEndOfPartBlocks(blocks)
  blocks = promoteStructuralSectionHeadings(blocks)

  reportProgress({
    phase: "structuring",
    label: "Building book structure",
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
  const printedToc = extractPrintedTocLookup(blocks)
  blocks = excludePrintedTocBlocks(blocks)

  blocks = interleaveImageCandidateBlocks(blocks, pageImageCandidates, pageData)

  const illustrationCandidateCount = blocks.filter(
    (block) => block?.type === "image_candidate" && block.isCandidate
  ).length

  reportProgress({
    phase: "classifying_illustrations",
    label: "Analyzing illustrations",
    current: 0,
    total: illustrationCandidateCount,
    percent: PARSE_PROGRESS_CLASSIFY_PERCENT,
  })

  blocks = await finalizeIllustrationBlocks(blocks, {
    onProgress: reportProgress,
    printedToc,
  })

  const imageBlockCount = blocks.filter((block) => block?.type === "image").length
  if (documentId && imageBlockCount > 0) {
    reportProgress({
      phase: "uploading_assets",
      label: "Uploading book illustrations",
      current: 0,
      total: imageBlockCount,
      percent: PARSE_PROGRESS_CLASSIFY_PERCENT + 2,
    })

    blocks = await uploadBookAssets(documentId, blocks, {
      onProgress({ current, total }) {
        const uploadSpan =
          PARSE_PROGRESS_UPLOAD_MAX_PERCENT -
          (PARSE_PROGRESS_CLASSIFY_PERCENT + 2)
        const uploadPercent =
          total > 0
            ? Math.round((current / total) * uploadSpan)
            : uploadSpan
        reportProgress({
          phase: "uploading_assets",
          label: "Uploading book illustrations",
          current,
          total,
          percent: PARSE_PROGRESS_CLASSIFY_PERCENT + 2 + uploadPercent,
        })
      },
    })
  }

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
  const parseResult = await parsePdfBuffer(fileBuffer, documentRow.name ?? "", {
    documentId: documentRow.id,
  })
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

      const fileBuffer = uploadedFile.buffer
      const documentId = insertedDocument.id
      const userId = req.userId
      const originalName = uploadedFile.originalname

      setImmediate(() => {
        void parseDocumentInBackground(documentId, userId, fileBuffer, originalName)
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
