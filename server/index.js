import 'dotenv/config'
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

app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://booky-lemon.vercel.app"
  ]
}))

app.use(express.json())

app.get("/", (req, res) => res.json({ message: "Booky API running" }))

app.get("/documents", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("documents")
      .select("id, name, total_pages, created_at")
      .order("created_at", { ascending: false })

    if (error) {
      res.status(500).json({ success: false, error: "Failed to fetch documents" })
      return
    }

    res.json({
      success: true,
      documents: data ?? [],
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

function getItemX(item) {
  const matrix = Array.isArray(item.transform) ? item.transform : []
  return Number.isFinite(matrix[4]) ? matrix[4] : 0
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

      const [parsedText, headingStrings] = await Promise.all([
        pdfParse(uploadedFile.buffer),
        extractHeadingLines(uploadedFile.buffer),
      ])

      const rawLines = parsedText.text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      const blocks = []

      for (let i = 0; i < rawLines.length; i++) {
        let currentLine = rawLines[i]

        // 1. Identify headings early
        if (headingStrings.has(currentLine)) {
          blocks.push({
            text: currentLine,
            isHeading: true,
            fontSize: 16,
            chapterId: null,
          })
          continue
        }

        // Define regex matches for clean list extraction
        const bulletCharsRegex = /^([•o\-—])\s*$/
        const inlineBulletRegex = /^([•o\-—])\s*(.*)$/

        // 2. Look-Ahead Fix: Handle lone standalone bullet characters
        if (bulletCharsRegex.test(currentLine) && i + 1 < rawLines.length) {
          let nextLine = rawLines[i + 1].trim()

          // Clean up any duplicated bullet character at the start of the next line
          if (inlineBulletRegex.test(nextLine)) {
            nextLine = nextLine.replace(inlineBulletRegex, "$2").trim()
          }

          blocks.push({
            text: `${currentLine} ${nextLine}`,
            isHeading: false,
            fontSize: 12,
            chapterId: null,
          })
          i++ // Advance past the merged line
          continue
        }

        // 3. Clean up inline bullets for lines that already have them
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

        // 4. Look-Behind Fix: Append trailing broken text lines ONLY if it's not a link or new list item
        if (blocks.length > 0 && !currentLine.startsWith("http")) {
          const prevBlock = blocks[blocks.length - 1]

          // Only append if the previous item wasn't a heading and the current line isn't a new list start
          if (
            !prevBlock.isHeading &&
            !bulletCharsRegex.test(currentLine) &&
            !inlineBulletRegex.test(currentLine)
          ) {
            // Check if it's a short floating text chunk that was broken mid-sentence
            if (prevBlock.text.length < 140 && !prevBlock.text.endsWith(".")) {
              prevBlock.text += ` ${currentLine}`
              continue
            }
          }
        }

        // 5. Default catch-all fallback
        blocks.push({
          text: currentLine,
          isHeading: false,
          fontSize: 12,
          chapterId: null,
        })
      }

      const content = []
      const linesPerPage = 40

      for (let index = 0; index < blocks.length; index += linesPerPage) {
        content.push({
          pageIndex: content.length,
          blocks: blocks.slice(index, index + linesPerPage),
        })
      }

      const hasImages = false
      const title = uploadedFile.originalname.replace(/\.pdf$/i, "")
      const { chapters, content: contentWithChapters } = detectChapters(content)

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
          chapters,
          content: contentWithChapters,
        })
        .select("id")
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