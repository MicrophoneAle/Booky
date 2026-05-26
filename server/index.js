import "dotenv/config"
import express from "express"
import cors from "cors"
import multer from "multer"
import { createClient } from "@supabase/supabase-js"
import { spawn } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { randomUUID } from "crypto"

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, "..")
const MARKER_SCRIPT = path.join(REPO_ROOT, "pipeline", "parse_marker.py")
const PYTHON_EXECUTABLE = process.env.PYTHON_PATH || "python3"
const MARKER_TIMEOUT_MS = Number(process.env.MARKER_TIMEOUT_MS || 600_000)
const UPLOAD_TMP_DIR =
  process.env.BOOKY_UPLOAD_TMP_DIR || path.join(os.tmpdir(), "uploads")

const app = express()

app.use(
  cors({
    origin: ["http://localhost:5173", "https://booky-lemon.vercel.app"],
  })
)

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

const LIST_LINE_PATTERN = /^([-*+]\s+|\d+\.\s+)/
const BOOKY_PAGES_PATTERN = /BOOKY_PAGES:(\d+)/

function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
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

/**
 * Translate Marker Markdown into Booky content blocks.
 */
function markdownToBlocks(markdown) {
  const blocks = []
  const normalized = markdown.replace(/\r\n/g, "\n").trim()

  if (!normalized) {
    return blocks
  }

  const paragraphs = normalized.split(/\n\n+/).map((part) => part.trim()).filter(Boolean)

  for (const paragraph of paragraphs) {
    if (paragraph.startsWith("# ") && !paragraph.startsWith("## ")) {
      blocks.push({
        text: paragraph.replace(/^#\s+/, "").trim(),
        isHeading: true,
        fontSize: 20,
        chapterId: null,
      })
      continue
    }

    if (paragraph.startsWith("## ")) {
      blocks.push({
        text: paragraph.replace(/^##\s+/, "").trim(),
        isHeading: true,
        fontSize: 16,
        chapterId: null,
      })
      continue
    }

    if (/^#{3,6}\s+/.test(paragraph)) {
      blocks.push({
        text: paragraph.replace(/^#{3,6}\s+/, "").trim(),
        isHeading: true,
        fontSize: 16,
        chapterId: null,
      })
      continue
    }

    const lines = paragraph.split("\n").map((line) => line.trim()).filter(Boolean)

    if (lines.length === 0) {
      continue
    }

    const isListParagraph = lines.every((line) => LIST_LINE_PATTERN.test(line))

    if (isListParagraph) {
      for (const line of lines) {
        blocks.push({
          text: line,
          isHeading: false,
          fontSize: 12,
          chapterId: null,
        })
      }
      continue
    }

    if (lines.length === 1 && LIST_LINE_PATTERN.test(lines[0])) {
      blocks.push({
        text: lines[0],
        isHeading: false,
        fontSize: 12,
        chapterId: null,
      })
      continue
    }

    for (const line of lines) {
      if (LIST_LINE_PATTERN.test(line)) {
        blocks.push({
          text: line,
          isHeading: false,
          fontSize: 12,
          chapterId: null,
        })
      } else {
        blocks.push({
          text: line,
          isHeading: false,
          fontSize: 12,
          chapterId: null,
        })
      }
    }
  }

  return blocks
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

function parseMarkerPageCount(stderr) {
  const match = stderr.match(BOOKY_PAGES_PATTERN)
  if (!match) {
    return null
  }

  const pageCount = Number.parseInt(match[1], 10)
  return Number.isFinite(pageCount) && pageCount > 0 ? pageCount : null
}

async function ensureUploadDirectory() {
  await fs.mkdir(UPLOAD_TMP_DIR, { recursive: true, mode: 0o700 })
}

async function writeTemporaryPdf(buffer, originalName) {
  await ensureUploadDirectory()

  const safeBaseName = path
    .basename(originalName, path.extname(originalName))
    .replace(/[^a-zA-Z0-9._-]/g, "_")
  const tempFileName = `${Date.now()}-${randomUUID()}-${safeBaseName}.pdf`
  const tempFilePath = path.join(UPLOAD_TMP_DIR, tempFileName)

  await fs.writeFile(tempFilePath, buffer, { mode: 0o600 })
  return tempFilePath
}

async function removeTemporaryPdf(tempFilePath) {
  try {
    await fs.unlink(tempFilePath)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
      console.warn(`Failed to remove temporary PDF: ${tempFilePath}`, error)
    }
  }
}

function runMarkerPipeline(tempFilePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_EXECUTABLE, [MARKER_SCRIPT, tempFilePath], {
      cwd: REPO_ROOT,
      windowsHide: true,
    })

    let stdout = ""
    let stderr = ""
    let settled = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGTERM")
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL")
        }
      }, 5_000)
      reject(
        new Error(
          `Marker layout analysis timed out after ${Math.round(MARKER_TIMEOUT_MS / 1000)} seconds.`
        )
      )
    }, MARKER_TIMEOUT_MS)

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
    })

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8")
    })

    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)

      if (error.code === "ENOENT") {
        reject(
          new Error(
            `Python executable not found (${PYTHON_EXECUTABLE}). Install Python 3.10+ and marker-pdf.`
          )
        )
        return
      }

      reject(error)
    })

    child.on("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)

      if (signal) {
        reject(new Error(`Marker process stopped by signal: ${signal}`))
        return
      }

      if (code !== 0) {
        const details = stderr.trim() || stdout.trim() || `exit code ${code}`
        reject(new Error(`Marker layout analysis failed: ${details}`))
        return
      }

      const markdown = stdout.trim()
      if (!markdown) {
        reject(new Error("Marker returned empty Markdown output."))
        return
      }

      resolve({
        markdown,
        pageCount: parseMarkerPageCount(stderr),
        stderr,
      })
    })
  })
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

    let tempFilePath = null

    try {
      const uploadedFile = req.file

      if (!uploadedFile) {
        res.status(500).json({ success: false, error: "No file uploaded." })
        return
      }

      tempFilePath = await writeTemporaryPdf(
        uploadedFile.buffer,
        uploadedFile.originalname
      )

      const { markdown, pageCount } = await runMarkerPipeline(tempFilePath)
      await removeTemporaryPdf(tempFilePath)
      tempFilePath = null

      const blocks = markdownToBlocks(markdown)
      const content = blocksToContent(blocks)
      const totalPages = pageCount ?? Math.max(1, content.length)
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
          total_pages: totalPages,
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
          totalPages,
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
    } finally {
      if (tempFilePath) {
        await removeTemporaryPdf(tempFilePath)
      }
    }
  })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Server on port ${PORT}`))
