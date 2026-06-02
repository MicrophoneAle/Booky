import "dotenv/config"
import express from "express"
import cors from "cors"
import multer from "multer"
import { createClient } from "@supabase/supabase-js"
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import pdfParse from "pdf-parse/lib/pdf-parse.js"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const app = express()

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://booky-lemon.vercel.app",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
)

app.use(express.json())

app.get("/", (req, res) => res.json({ message: "Booky API running" }))

app.get("/documents", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("documents")
      .select("id, name, total_pages, word_count, created_at, content")
      .order("created_at", { ascending: false })

    if (error) {
      res.status(500).json({ success: false, error: "Failed to fetch documents" })
      return
    }

    const documents = await Promise.all(
      (data ?? []).map(async (documentRow) => {
        const wordCount = await resolveWordCountForDocument(documentRow)
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

app.delete("/documents/:id", async (req, res) => {
  try {
    const { id } = req.params

    const { data: document, error: fetchError } = await supabase
      .from("documents")
      .select("storage_path")
      .eq("id", id)
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

    if (deleteError) {
      res.status(500).json({ success: false, error: "Delete failed" })
      return
    }

    res.json({ success: true })
  } catch {
    res.status(500).json({ success: false, error: "Delete failed" })
  }
})

app.patch("/documents/:id", async (req, res) => {
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

app.get("/documents/:id", async (req, res) => {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from("documents")
      .select("id, name, total_pages, chapters, content")
      .eq("id", id)
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

const Y_LINE_BREAK_DELTA = 2
const Y_SAME_LINE_TOLERANCE = 2

async function extractLinesByPosition(buffer) {
  const sameLineTolerance = 0.5
  const loadingTask = getDocument({ data: new Uint8Array(buffer) })
  const pdf = await loadingTask.promise
  const pageSections = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const textContent = await page.getTextContent()

    const pageLines = []
    let currentLine = ""
    let previousY = null

    for (const item of textContent.items) {
      const fragment = item.str ?? ""
      if (!fragment) {
        continue
      }

      const currentY = getItemY(item)

      if (previousY !== null) {
        const prevY = previousY
        const yDelta = currentY - prevY
        const isSameLine = Math.abs(currentY - prevY) <= sameLineTolerance

        if (yDelta < -Y_LINE_BREAK_DELTA) {
          if (currentLine.trim()) {
            pageLines.push(currentLine.trim())
          }
          currentLine = fragment
        } else if (isSameLine) {
          currentLine = currentLine ? `${currentLine} ${fragment}` : fragment
        } else {
          currentLine = currentLine ? `${currentLine} ${fragment}` : fragment
        }
      } else {
        currentLine = fragment
      }

      previousY = currentY
    }

    if (currentLine.trim()) {
      pageLines.push(currentLine.trim())
    }

    pageSections.push(pageLines.join("\n"))
  }

  return pageSections.join("\n\n")
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

function isChapterHeading(block) {
  const text = block.text.trim()

  if (block.fontSize > 14) return true
  if (CHAPTER_PATTERN.test(text)) return true
  if (text.length < 60 && block.fontSize > 13) return true

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

function linesFromPdfText(text) {
  return (text ?? "").split("\n").map((line) => line.trim())
}

function isStructuralLine(text, index, allLines) {
  const trimmed = text.trim()
  if (!trimmed) return false

  // "by Author Name" / "written by" / "translated by"
  if (/^(by|written by|translated by)\s+[A-Z]/i.test(trimmed)) return true

  // "A Novel in..." / "A Story of..." etc
  if (/^A (Novel|Story|Tale|Memoir|Chronicle|History|Collection|Journey|Record)\b/i.test(trimmed)) {
    return true
  }

  // Chapter subtitle: short line immediately after a bare chapter label
  const prevNonEmpty = allLines.slice(0, index).filter((l) => l.trim()).slice(-1)[0] ?? ""
  const isAfterChapterLabel =
    /^(Chapter|Part|Section|Prologue|Epilogue)\s+(\d+|[IVXLCDM]+|[A-Za-z]+)$/i.test(
      prevNonEmpty.trim()
    )
  if (isAfterChapterLabel && trimmed.length > 3 && trimmed.length < 80) return true

  // Short line near top of document (positions 1-5 among non-empty lines) = title page subtitle
  const nonEmptyLines = allLines.filter((l) => l.trim())
  const docPosition = nonEmptyLines.findIndex((l) => l.trim() === trimmed)
  if (
    docPosition >= 1 &&
    docPosition <= 5 &&
    trimmed.length >= 8 &&
    trimmed.length <= 70 &&
    !/^(Chapter|Part|Section|Prologue|Epilogue)/i.test(trimmed) &&
    !/^https?:\/\//.test(trimmed) &&
    !/^[•·\-—*\d]/.test(trimmed)
  ) {
    return true
  }

  return false
}

function buildBlocksFromLines(lines, headingStrings) {
  const blocks = []
  const bulletCharsRegex = /^([•·\-*])\s*$/
  const inlineBulletRegex = /^([•·\-*])\s*(.*)$/
  const subBulletLineRegex = /^[o*]\s+/i

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index]

    if (!currentLine) {
      blocks.push({ text: "", isHeading: false, fontSize: 12, chapterId: null })
      continue
    }

    const trimmedLine = currentLine.trim()

    // 1. Known heading by font size
    if (headingStrings.has(currentLine)) {
      blocks.push({ text: currentLine, isHeading: true, fontSize: 16, chapterId: null })
      continue
    }

    // 2. Structural line (subtitle, author, chapter subtitle) — checked BEFORE merge
    if (isStructuralLine(trimmedLine, index, lines)) {
      blocks.push({ text: trimmedLine, isHeading: true, fontSize: 13, chapterId: null })
      continue
    }

    // 3. Lone bullet char — merge with next line
    if (bulletCharsRegex.test(currentLine) && index + 1 < lines.length) {
      let nextLine = lines[index + 1]
      if (inlineBulletRegex.test(nextLine)) {
        nextLine = nextLine.replace(inlineBulletRegex, "$2").trim()
      }
      blocks.push({
        text: `${currentLine} ${nextLine}`.replace(/\s+/g, " ").trim(),
        isHeading: false,
        fontSize: 12,
        chapterId: null,
      })
      index += 1
      continue
    }

    // 4. Inline bullet
    if (inlineBulletRegex.test(currentLine)) {
      const marker = currentLine.match(inlineBulletRegex)[1]
      const restOfText = currentLine.match(inlineBulletRegex)[2].trim()
      blocks.push({
        text: `${marker} ${restOfText}`,
        isHeading: false,
        fontSize: 12,
        chapterId: null,
      })
      continue
    }

    // 5. Merge continuation lines
    if (blocks.length > 0) {
      const previousBlock = blocks[blocks.length - 1]
      const prevText = previousBlock?.text ?? ""

      const shouldMerge =
        previousBlock &&
        !previousBlock.isHeading &&
        !prevText.includes("http://") &&
        !prevText.includes("https://") &&
        !/[:.\)\/"']$/.test(prevText.trim()) &&
        !/^[•·\-—*]\s/.test(trimmedLine) &&
        !subBulletLineRegex.test(trimmedLine) &&
        !/^\d+[\.\)]/.test(trimmedLine) &&
        !/^[a-z][\.\)]/i.test(trimmedLine) &&
        !trimmedLine.endsWith(":") &&
        trimmedLine.length > 0 &&
        /[a-z]$/.test(prevText.trim())

      if (shouldMerge) {
        previousBlock.text = (prevText + " " + trimmedLine).replace(/\s+/g, " ").trim()
        continue
      }
    }

    // 6. Plain block
    blocks.push({ text: trimmedLine, isHeading: false, fontSize: 12, chapterId: null })
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

async function resolveWordCountForDocument(documentRow) {
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

app.post("/upload", (req, res) => {
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

      const [parsedText, headingStrings, positionedText] = await Promise.all([
        pdfParse(uploadedFile.buffer),
        extractHeadingLines(uploadedFile.buffer),
        extractLinesByPosition(uploadedFile.buffer),
      ])

      const lines = linesFromPdfText(positionedText)
      const blocks = buildBlocksFromLines(lines, headingStrings)
      const content = blocksToContent(blocks)

      const hasImages = false
      const title = uploadedFile.originalname.replace(/\.pdf$/i, "")
      const { chapters, content: contentWithChapters } = detectChapters(content)
      const wordCount = Math.max(
        countWordsInPlainText(parsedText.text),
        countWordsFromBlocks(blocks),
        countWordsFromContent(contentWithChapters)
      )

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

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Server on port ${PORT}`))
