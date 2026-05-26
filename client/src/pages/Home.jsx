import { useCallback, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import "./Home.css"

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

export default function Home() {
  const navigate = useNavigate()
  const fileInputRef = useRef(null)
  const uploadIntervalRef = useRef(null)

  const [file, setFile] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const [uploadStatus, setUploadStatus] = useState(UploadStatus.IDLE)
  const [progress, setProgress] = useState(0)

  const resetUploadTimer = useCallback(() => {
    if (uploadIntervalRef.current) {
      window.clearInterval(uploadIntervalRef.current)
      uploadIntervalRef.current = null
    }
  }, [])

  const startFakeUpload = useCallback(
    (selectedFile) => {
      resetUploadTimer()
      setFile(selectedFile)
      setUploadStatus(UploadStatus.UPLOADING)
      setProgress(0)

      const startTime = Date.now()
      const durationMs = 2000

      uploadIntervalRef.current = window.setInterval(() => {
        const elapsed = Date.now() - startTime
        const nextProgress = Math.min(100, Math.round((elapsed / durationMs) * 100))
        setProgress(nextProgress)

        if (nextProgress >= 100) {
          resetUploadTimer()
          setUploadStatus(UploadStatus.SUCCESS)
        }
      }, 40)
    },
    [resetUploadTimer]
  )

  const handleInvalidFile = useCallback(() => {
    resetUploadTimer()
    setFile(null)
    setProgress(0)
    setUploadStatus(UploadStatus.ERROR)
  }, [resetUploadTimer])

  const handleFileSelection = useCallback(
    (selectedFile) => {
      if (!selectedFile) return
      if (!isPdfFile(selectedFile)) {
        handleInvalidFile()
        return
      }
      startFakeUpload(selectedFile)
    },
    [handleInvalidFile, startFakeUpload]
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
    navigate("/read/preview")
  }, [navigate])

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
            <p className="upload-error">Only PDF files are supported.</p>
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
                  <button type="button" className="open-book-btn" onClick={onOpenBook}>
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