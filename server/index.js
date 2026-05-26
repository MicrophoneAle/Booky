import express from "express"
import cors from "cors"
import multer from "multer"
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs"

const app = express()

app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://booky-lemon.vercel.app/"
  ]
}))

app.use(express.json())

app.get("/", (req, res) => res.json({ message: "Booky API running" }))

const CHAPTER_PATTERN =
  /^(chapter\s+(\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)|part\s+(\d+|one|two|three)|prologue|epilogue|introduction|conclusion)\.?$/i

function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
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
        const blocks = textContent.items
          .map((item) => {
            const matrix = Array.isArray(item.transform) ? item.transform : []
            const scaleX = Number.isFinite(matrix[0]) ? Math.abs(matrix[0]) : 0
            const scaleY = Number.isFinite(matrix[3]) ? Math.abs(matrix[3]) : 0
            const fontSize = Number(Math.max(scaleX, scaleY).toFixed(2))
            return {
              text: item.str ?? "",
              isHeading: fontSize > 14,
              fontSize,
            }
          })
          .filter((block) => block.text.trim().length > 0)

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

      res.json({
        success: true,
        document: {
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