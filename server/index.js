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

      res.json({
        success: true,
        document: {
          title,
          totalPages: pdf.numPages,
          content,
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