import { useCallback, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import "./Home.css"

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000"

const UploadStatus = {
  IDLE: "idle",
  UPLOADING: "uploading",
  SUCCESS: "success",
  ERROR: "error",
}

function formatBytes(bytes) {
  if (!bytes) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function isPdfFile(file) {
  if (!file) return false
  const hasPdfMime = file.type === "application/pdf"
  const hasPdfExtension = file.name.toLowerCase().endsWith(".pdf")
  return hasPdfMime || hasPdfExtension
}

function uploadPdf(selectedFile, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const formData = new FormData()
    formData.append("file", selectedFile)

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100))
      }
    })

    xhr.addEventListener("load", () => {
      try {
        const data = JSON.parse(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300 && data.success) {
          resolve(data)
          return
        }
        reject(new Error(data.error || "Upload failed."))
      } catch {
        reject(new Error("Upload failed."))
      }
    })

    xhr.addEventListener("error", () => {
      reject(new Error("Upload failed."))
    })

    xhr.open("POST", `${API_URL}/upload`)
    xhr.send(formData)
  })
}

export default function Home() {
  const navigate = useNavigate()
  const fileInputRef = useRef(null)

  const [file, setFile] = useState(null)
  const [documentId, setDocumentId] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const [uploadStatus, setUploadStatus] = useState(UploadStatus.IDLE)
  const [progress, setProgress] = useState(0)
  const [uploadError, setUploadError] = useState(null)

  const startUpload = useCallback(async (selectedFile) => {
    setFile(selectedFile)
    setDocumentId(null)
    setUploadError(null)
    setUploadStatus(UploadStatus.UPLOADING)
    setProgress(0)

    try {
      const data = await uploadPdf(selectedFile, setProgress)
      setProgress(100)
      setDocumentId(data.document.id)
      setUploadStatus(UploadStatus.SUCCESS)
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Upload failed.")
      setUploadStatus(UploadStatus.ERROR)
      setProgress(0)
    }
  }, [])

  const handleInvalidFile = useCallback(() => {
    setFile(null)
    setDocumentId(null)
    setProgress(0)
    setUploadError(null)
    setUploadStatus(UploadStatus.ERROR)
  }, [])

  const handleFileSelection = useCallback(
    (selectedFile) => {
      if (!selectedFile) return
      if (!isPdfFile(selectedFile)) {
        handleInvalidFile()
        return
      }
      startUpload(selectedFile)
    },
    [handleInvalidFile, startUpload]
  )

  const onDragOver = useCallback((event) => {
    event.preventDefault()
    setIsDragging(true)
  }, [])

  const onDragLeave = useCallback((event) => {
    event.preventDefault()
    setIsDragging(false)
  }, [])

  const onDrop = useCallback(
    (event) => {
      event.preventDefault()
      setIsDragging(false)
      const droppedFile = event.dataTransfer?.files?.[0]
      handleFileSelection(droppedFile)
    },
    [handleFileSelection]
  )

  const onBrowseClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const onInputChange = useCallback(
    (event) => {
      const selectedFile = event.target.files?.[0]
      handleFileSelection(selectedFile)
      event.target.value = ""
    },
    [handleFileSelection]
  )

  const onOpenBook = useCallback(() => {
    if (documentId) {
      navigate(`/read/${documentId}`)
    }
  }, [documentId, navigate])

  return (
    <div className="home-page">
      <nav className="home-nav" aria-label="Primary">
        <div className="home-logo">BOOKY</div>
        <div className="home-nav-links">
          <a href="#" className="home-nav-link">
            Library
          </a>
          <a href="#" className="home-nav-link">
            Upload
          </a>
          <a href="#" className="home-nav-link">
            Settings
          </a>
        </div>
      </nav>

      <main className="home-main">
        <header className="home-hero">
          <h1>Your Library Awaits</h1>
          <p>Upload any PDF and read it like a real book.</p>
        </header>

        <section className="upload-section">
          <div
            className={`upload-zone ${isDragging ? "dragging" : ""}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={onBrowseClick}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onBrowseClick()
              }
            }}
            aria-label="Upload PDF file"
          >
            <div className="upload-icon" aria-hidden="true">
              📖
            </div>
            <p className="upload-text">Drop your PDF here</p>
            <button
              type="button"
              className="browse-link"
              onClick={(event) => {
                event.stopPropagation()
                onBrowseClick()
              }}
            >
              or browse files
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              className="hidden-input"
              onChange={onInputChange}
            />
          </div>

          {uploadStatus === UploadStatus.ERROR && (
            <p className="upload-error">
              {uploadError ?? "Only PDF files are supported."}
            </p>
          )}

          {file && uploadStatus !== UploadStatus.ERROR && (
            <div className="upload-meta">
              <p className="file-name">{file.name}</p>
              <p className="file-size">{formatBytes(file.size)}</p>

              {uploadStatus === UploadStatus.UPLOADING && (
                <>
                  <div className="progress-track" aria-hidden="true">
                    <div className="progress-fill" style={{ width: `${progress}%` }} />
                  </div>
                  <p className="upload-note">Parsing your book…</p>
                </>
              )}

              {uploadStatus === UploadStatus.SUCCESS && (
                <div className="upload-success">
                  <p className="success-message">
                    <span aria-hidden="true">✓</span> Ready to read
                  </p>
                  <button
                    type="button"
                    className="open-book-btn"
                    onClick={onOpenBook}
                    disabled={!documentId}
                  >
                    Open Book →
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}