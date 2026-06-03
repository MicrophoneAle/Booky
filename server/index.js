import "dotenv/config"
import express from "express"
import cors from "cors"
import multer from "multer"
import { clerkMiddleware, getAuth } from "@clerk/express"
import { createClient } from "@supabase/supabase-js"
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import pdfParse from "pdf-parse/lib/pdf-parse.js"

const PARSER_VERSION = 3

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

    const { data, error } = await supabase
      .from("documents")
      .select("id, name, total_pages, chapters, content")
      .eq("id", id)
      .eq("user_id", req.userId)
      .single()

    if (error || !data) {
      res.status(404).json({ success: false, error: "Document not found" })
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
  /^(chapter\s+(\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)|part\s+(\d+|one|two|three)|prologue|epilogue|introduction|conclusion)\.?$/i

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

const Y_LINE_BREAK_DELTA = 2
const Y_SAME_LINE_TOLERANCE = 2

const PAGE_NUMBER_DECORATOR_REGEX = /^-\s*\d+\s*-$/
const INLINE_TOC_HEADER_REGEX = /^-\s*\d+\s*-\s*.+$/
const PURE_URL_LINE_REGEX = /^(https?:\/\/\S+|www\.\S+)$/i
const RUNNING_HEADER_MIN_PAGES = 3
const INDENT_THRESHOLD_PX = 15

const INLINE_PAGE_DECORATOR_REGEX = /\s*-\s*\d+\s*-\s*/g
const FOOTNOTE_REFERENCE_REGEX = /\[\d+\]/g

function stripInlineArtifacts(text) {
  if (!text) {
    return ""
  }

  return text
    .replace(INLINE_PAGE_DECORATOR_REGEX, " ")
    .replace(FOOTNOTE_REFERENCE_REGEX, "")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizePdfLine(line) {
  if (line && typeof line === "object" && "text" in line) {
    return {
      text: (line.text ?? "").trim(),
      indented: Boolean(line.indented),
    }
  }

  const text = typeof line === "string" ? line : String(line ?? "")
  const trimmed = text.trim()
  const indented = /^[\s\t]{2,}/.test(text) || text.startsWith("\t")

  return { text: trimmed, indented }
}

function lineText(line) {
  return normalizePdfLine(line).text
}

function lineIndented(line) {
  return normalizePdfLine(line).indented
}

function isPageNumberDecoratorLine(text) {
  return PAGE_NUMBER_DECORATOR_REGEX.test((text ?? "").trim())
}

function isInlineTocHeaderLine(text) {
  return INLINE_TOC_HEADER_REGEX.test((text ?? "").trim())
}

function isPureUrlLine(text) {
  return PURE_URL_LINE_REGEX.test((text ?? "").trim())
}

function shouldDropExtractedLine(text, occurrenceCount) {
  const trimmed = (text ?? "").trim()
  if (!trimmed) {
    return true
  }
  if (isPageNumberDecoratorLine(trimmed)) {
    return true
  }
  if (isInlineTocHeaderLine(trimmed)) {
    return true
  }
  if (isPureUrlLine(trimmed)) {
    return true
  }
  if (occurrenceCount >= RUNNING_HEADER_MIN_PAGES) {
    return true
  }
  return false
}

function medianValue(values) {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function extractLinesByPosition(buffer) {
  const sameLineTolerance = 0.5
  const loadingTask = getDocument({ data: new Uint8Array(buffer) })
  const pdf = await loadingTask.promise
  const pageLineArrays = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const textContent = await page.getTextContent()

    const pageLines = []
    let currentLine = ""
    let currentStartX = null
    let previousY = null

    const flushLine = () => {
      const trimmed = currentLine.trim()
      if (trimmed) {
        pageLines.push({ text: trimmed, startX: currentStartX ?? 0 })
      }
      currentLine = ""
      currentStartX = null
    }

    for (const item of textContent.items) {
      const fragment = item.str ?? ""
      if (!fragment) {
        continue
      }

      const currentY = getItemY(item)
      const itemX = getItemX(item)

      if (previousY !== null) {
        const yDelta = currentY - previousY

        if (yDelta < -Y_LINE_BREAK_DELTA) {
          flushLine()
          currentLine = fragment
          currentStartX = itemX
        } else {
          currentLine = currentLine ? `${currentLine} ${fragment}` : fragment
          if (currentStartX === null) {
            currentStartX = itemX
          }
        }
      } else {
        currentLine = fragment
        currentStartX = itemX
      }

      previousY = currentY
    }

    flushLine()

    const medianStartX = medianValue(pageLines.map((line) => line.startX))
    for (const line of pageLines) {
      line.indented = line.startX > medianStartX + INDENT_THRESHOLD_PX
    }

    pageLineArrays.push(pageLines)
  }

  const lineOccurrences = new Map()
  for (const pageLines of pageLineArrays) {
    for (const line of pageLines) {
      lineOccurrences.set(line.text, (lineOccurrences.get(line.text) ?? 0) + 1)
    }
  }

  const filteredLines = []
  for (const pageLines of pageLineArrays) {
    for (const line of pageLines) {
      const count = lineOccurrences.get(line.text) ?? 0
      if (shouldDropExtractedLine(line.text, count)) {
        continue
      }

      const cleanedText = stripInlineArtifacts(line.text)
      if (!cleanedText) {
        continue
      }

      filteredLines.push({ text: cleanedText, indented: Boolean(line.indented) })
    }
  }

  return filteredLines
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

const CHAPTER_TITLE_BLOCKLIST = new Set([
  "and",
  "or",
  "but",
  "the",
  "a",
  "an",
  "to",
  "by",
])

function isChapterHeading(block) {
  const text = block.text.trim()

  if (CHAPTER_TITLE_BLOCKLIST.has(text.toLowerCase())) return false
  if (block.isHeading && block.fontSize === 13) return false
  if (/^To\s+[A-Z]/.test(text)) return false
  if (/^(by|written by|translated by)\s+/i.test(text)) return false

  if (CHAPTER_PATTERN.test(text)) return true
  if (text.length < 60 && block.fontSize > 13 && /^\d+[\.\)]\s/.test(text)) {
    return true
  }

  return false
}

function detectChapters(content) {
  const chapters = []
  let currentChapterId = null

  const updatedContent = content.map((page) => ({
    ...page,
    blocks: page.blocks.map((block, blockIndex) => {
      let chapterId = currentChapterId

      if (isChapterHeading(block)) {
        const title = block.text.trim()
        const id = slugify(title)

        chapters.push({
          id,
          title,
          pageIndex: page.pageIndex,
          blockIndex,
        })

        currentChapterId = id
        chapterId = id
      }

      return {
        ...block,
        chapterId,
      }
    }),
  }))

  return { chapters, content: updatedContent }
}

function linesFromPdfText(input) {
  if (Array.isArray(input)) {
    return input.map(normalizePdfLine)
  }

  return (input ?? "")
    .split("\n")
    .map((line) => normalizePdfLine(line))
    .filter((line) => line.text)
}

function isStructuralLine(text, index, allLines) {
  const trimmed = text.trim()
  if (!trimmed) return false

  const nonEmptyLines = allLines
    .map((line) => lineText(line))
    .filter((line) => line)

  const docPosition = nonEmptyLines.findIndex((line) => line === trimmed)

  // Dedication lines near the start of the book (e.g. "To Charlie Shribner...")
  if (docPosition >= 0 && docPosition < 15 && /^To\s+[A-Z]/.test(trimmed)) {
    return true
  }

  // "by Author Name" / "written by" / "translated by"
  if (/^(by|written by|translated by)\s+[A-Z]/i.test(trimmed)) return true

  // "A Novel in..." / "A Story of..." etc
  if (/^A (Novel|Story|Tale|Memoir|Chronicle|History|Collection|Journey|Record)\b/i.test(trimmed)) {
    return true
  }

  // Chapter subtitle: short line immediately after a bare chapter label
  const prevNonEmpty = nonEmptyLines
    .slice(0, docPosition >= 0 ? docPosition : nonEmptyLines.length)
    .slice(-1)[0] ?? ""
  const isAfterChapterLabel =
    /^(Chapter|Part|Section|Prologue|Epilogue)\s+(\d+|[IVXLCDM]+|[A-Za-z]+)$/i.test(
      prevNonEmpty
    )
  if (isAfterChapterLabel && trimmed.length > 3 && trimmed.length < 80) return true

  // Short line near top of document (positions 1-5 among non-empty lines) = title page subtitle
  if (
    docPosition >= 1 &&
    docPosition <= 5 &&
    trimmed.length >= 8 &&
    trimmed.length <= 70 &&
    !/^(Chapter|Part|Section|Prologue|Epilogue)/i.test(trimmed) &&
    !/^https?:\/\//.test(trimmed) &&
    !/^[•·—*\d]/.test(trimmed)
  ) {
    return true
  }

  return false
}

function buildBlocksFromLines(lines, headingStrings) {
  const blocks = []
  const bulletCharsRegex = /^([•·])\s*$/
  const inlineBulletRegex = /^([•·])\s*(.*)$/
  const subBulletLineRegex = /^[o*]\s+/i

  for (let index = 0; index < lines.length; index += 1) {
    const normalizedLine = normalizePdfLine(lines[index])
    const trimmedLine = stripInlineArtifacts(normalizedLine.text)
    const isIndented = normalizedLine.indented

    if (!trimmedLine) {
      blocks.push({ text: "", isHeading: false, fontSize: 12, chapterId: null })
      continue
    }

    // 1. Structural line (subtitle, author, dedication) — before font-size headings
    if (isStructuralLine(trimmedLine, index, lines)) {
      blocks.push({ text: trimmedLine, isHeading: true, fontSize: 13, chapterId: null })
      continue
    }

    // 2. Known heading by font size
    if (headingStrings.has(trimmedLine)) {
      blocks.push({ text: trimmedLine, isHeading: true, fontSize: 16, chapterId: null })
      continue
    }

    // 3. Lone bullet char — merge with next line
    if (bulletCharsRegex.test(trimmedLine) && index + 1 < lines.length) {
      let nextText = lineText(lines[index + 1])
      if (inlineBulletRegex.test(nextText)) {
        nextText = nextText.replace(inlineBulletRegex, "$2").trim()
      }
      blocks.push({
        text: `${trimmedLine} ${nextText}`.replace(/\s+/g, " ").trim(),
        isHeading: false,
        fontSize: 12,
        chapterId: null,
      })
      index += 1
      continue
    }

    // 4. Inline bullet
    if (inlineBulletRegex.test(trimmedLine)) {
      const marker = trimmedLine.match(inlineBulletRegex)[1]
      const restOfText = trimmedLine.match(inlineBulletRegex)[2].trim()
      blocks.push({
        text: `${marker} ${restOfText}`,
        isHeading: false,
        fontSize: 12,
        chapterId: null,
      })
      continue
    }

    // 5. Merge continuation lines (wrapped lines of the same paragraph)
    if (blocks.length > 0 && !isIndented) {
      const previousBlock = blocks[blocks.length - 1]
      const prevText = previousBlock?.text ?? ""
      const prevTrim = prevText.trim()

      const startsCapital = /^[A-Z]/.test(trimmedLine)
      const prevEndsSentence = /[.!?]["”'']?$/.test(prevTrim)
      const startsQuoteCapital = /^["“'']\s*[A-Z]/.test(trimmedLine)

      const shouldMerge =
        previousBlock &&
        !previousBlock.isHeading &&
        !previousBlock.isIndented &&
        !prevText.includes("http://") &&
        !prevText.includes("https://") &&
        !/[:\)\/]$/.test(prevTrim) &&
        !/^[•·]\s/.test(trimmedLine) &&
        !subBulletLineRegex.test(trimmedLine) &&
        !/^\d+[\.\)]/.test(trimmedLine) &&
        !/^[a-z][\.\)]/i.test(trimmedLine) &&
        !trimmedLine.endsWith(":") &&
        !(startsCapital && prevEndsSentence) &&
        !startsQuoteCapital &&
        trimmedLine.length > 0

      if (shouldMerge) {
        previousBlock.text = (prevText + " " + trimmedLine).replace(/\s+/g, " ").trim()
        continue
      }
    }

    // 6. Plain block
    blocks.push({
      text: trimmedLine,
      isHeading: false,
      fontSize: 12,
      chapterId: null,
      ...(isIndented ? { isIndented: true } : {}),
    })
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

function hasDetectedTitleBlock(blocks) {
  return blocks.slice(0, 20).some((block) => block.isHeading && (block.fontSize ?? 0) > 14)
}

function titleFromFilename(fileName) {
  if (!fileName || typeof fileName !== "string") {
    return ""
  }

  return fileName
    .replace(/\.pdf$/i, "")
    .replace(/[-_]+/g, " ")
    .trim()
}

function prependSyntheticTitleBlocks(blocks, parsedText, fileName) {
  if (hasDetectedTitleBlock(blocks)) {
    return blocks
  }

  let titleText = (parsedText?.info?.Title ?? "").trim()
  let authorText = (parsedText?.info?.Author ?? "").trim()

  if (!titleText) {
    titleText = titleFromFilename(fileName)
  }

  if (!titleText) {
    return blocks
  }

  const synthetic = [
    { text: titleText, isHeading: true, fontSize: 20, chapterId: null },
  ]

  if (authorText) {
    const authorLine = /^by\s/i.test(authorText) ? authorText : `By ${authorText}`
    synthetic.push({
      text: authorLine,
      isHeading: true,
      fontSize: 13,
      chapterId: null,
    })
  }

  return [...synthetic, ...blocks]
}

async function parsePdfBuffer(buffer, fileName = "") {
  const [parsedText, headingStrings, positionedLines] = await Promise.all([
    pdfParse(buffer),
    extractHeadingLines(buffer),
    extractLinesByPosition(buffer),
  ])

  const lines = linesFromPdfText(positionedLines)
  let blocks = buildBlocksFromLines(lines, headingStrings)
  blocks = prependSyntheticTitleBlocks(blocks, parsedText, fileName)
  const content = blocksToContent(blocks)
  const { chapters, content: contentWithChapters } = detectChapters(content)
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

async function reparseOutdatedDocuments() {
  const summary = {
    reparsed: 0,
    failed: [],
    skipped: 0,
  }

  const { data: documents, error: fetchError } = await supabase
    .from("documents")
    .select("id, storage_path, name")
    .or(`parser_version.lt.${PARSER_VERSION},parser_version.is.null`)
    .order("created_at", { ascending: true })

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

      summary.reparsed += 1
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

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`)

  setTimeout(async () => {
    try {
      const summary = await reparseOutdatedDocuments()
      console.log(`Re-parse complete: ${summary.reparsed} updated`)
    } catch (error) {
      console.error(
        "Background re-parse failed:",
        error instanceof Error ? error.message : "Unknown error"
      )
    }
  }, 30_000)
})
