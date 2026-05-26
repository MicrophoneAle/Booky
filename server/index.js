import 'dotenv/config'
import express from "express"
import cors from "cors"
import multer from "multer"
import { createClient } from "@supabase/supabase-js"
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs"

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

function joinLineItemStrings(items) {
  let joinedText = ""

  for (const item of items) {
    const piece = item.str ?? ""
    if (!piece) continue

    if (joinedText.length === 0) {
      joinedText = piece
      continue
    }

    const prevEndsWithSpace = /\s$/.test(joinedText)
    const nextStartsWithSpace = /^\s/.test(piece)

    if (prevEndsWithSpace || nextStartsWithSpace) {
      joinedText += piece
    } else {
      joinedText += ` ${piece}`
    }
  }

  return joinedText.replace(/\s+/g, " ").trim()
}

function isOrphanLine(text) {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (trimmed.length === 1) return true
  if (/^[\p{P}\p{S}]+$/u.test(trimmed)) return true
  if (/^[a-zA-Z0-9]\.?$/u.test(trimmed)) return true

  return false
}

function mergeOrphanLinesWithNext(lines) {
  const merged = []

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index]

    if (isOrphanLine(current.text) && index + 1 < lines.length) {
      const next = lines[index + 1]
      merged.push({
        text: `${current.text.trim()} ${next.text}`.replace(/\s+/g, " ").trim(),
        fontSize: next.fontSize,
      })
      index += 1
      continue
    }

    merged.push(current)
  }

  return merged
}

function groupTextItemsIntoLines(items) {
  const lineGroups = []

  for (const item of items) {
    const text = item.str ?? ""
    if (!text.trim()) continue

    const y = getItemY(item)
    let lineGroup = lineGroups.find((group) => Math.abs(group.y - y) <= 5)

    if (!lineGroup) {
      lineGroup = { y, items: [] }
      lineGroups.push(lineGroup)
    }

    lineGroup.items.push(item)
  }

  lineGroups.sort((a, b) => b.y - a.y)

  const lines = lineGroups
    .map((lineGroup) => {
      const sortedItems = [...lineGroup.items].sort((a, b) => getItemX(a) - getItemX(b))
      const joinedText = joinLineItemStrings(sortedItems)

      return {
        text: joinedText,
        fontSize: getItemFontSize(sortedItems[0]),
      }
    })
    .filter((block) => block.text.length > 0)

  return mergeOrphanLinesWithNext(lines)
}

function isChapterHeading(block) {
  const text = block.text.trim()

  if (block.fontSize > 16) return true
  if (CHAPTER_PATTERN.test(text)) return true
  if (text.length < 60 && block.fontSize > 14) return true

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

      const loadingTask = getDocument({ data: new Uint8Array(uploadedFile.buffer) })
      const pdf = await loadingTask.promise

      const content = []
      let hasImages = false

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber)
        const textContent = await page.getTextContent()
        const blocks = groupTextItemsIntoLines(textContent.items).map((block) => ({
          text: block.text,
          isHeading: block.fontSize > 14,
          fontSize: block.fontSize,
        }))

        const operatorList = await page.getOperatorList()
        if (operatorList.fnArray.includes(OPS.paintImageXObject)) {
          hasImages = true
        }

        content.push({
          pageIndex: pageNumber - 1,
          blocks,
        })
      }

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
          total_pages: pdf.numPages,
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
          totalPages: pdf.numPages,
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