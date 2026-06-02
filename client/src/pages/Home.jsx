import { useCallback, useRef, useState } from "react"
import { NavLink, useNavigate } from "react-router-dom"
import FullscreenButton from "../components/FullscreenButton"
import "./Home.css"

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000"

const EMPTY_UPLOAD_STATE = {
  phase: "idle", // idle | waking | uploading | parsing | storing | done | error
  progress: 0,
  fileName: null,
  fileSize: null,
  errorMessage: null,
  slowWake: false,
}

const PHASE_LABELS = {
  waking: "Connecting to server...",
  uploading: "Uploading PDF...",
  parsing: "Reading your PDF...",
  storing: "Saving to library...",
  done: "Done!",
}

const PHASE_SUBLABELS = {
  waking: "Server is waking up, this takes ~15 seconds after a period of inactivity",
  uploading: null,
  parsing: "Extracting text, detecting chapters and headings",
  storing: "Almost there",
  done: null,
}

function isPdfFile(file) {
  if (!file) return false
  const hasPdfMime = file.type === "application/pdf"
  const hasPdfExtension = file.name.toLowerCase().endsWith(".pdf")
  return hasPdfMime || hasPdfExtension
}

function doUpload(file, setUploadState, navigate) {
  setUploadState((state) => ({ ...state, phase: "uploading", progress: 0 }))

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    const formData = new FormData()
    formData.append("file", file)

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        const pct = Math.round((event.loaded / event.total) * 100)
        setUploadState((state) => ({ ...state, progress: pct }))
      }
    })

    xhr.upload.addEventListener("load", () => {
      setUploadState((state) => ({ ...state, phase: "parsing", progress: 100 }))
    })

    xhr.addEventListener("load", () => {
      try {
        const data = JSON.parse(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300 && data.success) {
          setUploadState((state) => ({ ...state, phase: "storing" }))
          setTimeout(() => {
            setUploadState((state) => ({ ...state, phase: "done" }))
            navigate(`/read/${data.document.id}`)
          }, 600)
          resolve()
          return
        }
        setUploadState((state) => ({
          ...state,
          phase: "error",
          errorMessage: data.error ?? "Upload failed",
        }))
        resolve()
      } catch {
        setUploadState((state) => ({
          ...state,
          phase: "error",
          errorMessage: "Unexpected server response",
        }))
        resolve()
      }
    })

    xhr.addEventListener("error", () => {
      setUploadState((state) => ({
        ...state,
        phase: "error",
        errorMessage: "Network error — check your connection",
      }))
      resolve()
    })

    xhr.addEventListener("timeout", () => {
      setUploadState((state) => ({
        ...state,
        phase: "error",
        errorMessage: "Request timed out",
      }))
      resolve()
    })

    xhr.timeout = 120000
    xhr.open("POST", `${API_URL}/upload`)
    xhr.send(formData)
  })
}

export default function Home() {
  const navigate = useNavigate()
  const fileInputRef = useRef(null)

  const [file, setFile] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const [uploadState, setUploadState] = useState(EMPTY_UPLOAD_STATE)

  const startUpload = useCallback(async (selectedFile) => {
    setFile(selectedFile)
    setUploadState({
      phase: "waking",
      progress: 0,
      fileName: selectedFile.name,
      fileSize: selectedFile.size,
      errorMessage: null,
      slowWake: false,
    })

    const wakeTimer = setTimeout(() => {
      setUploadState((state) =>
        state.phase === "waking" ? { ...state, slowWake: true } : state
      )
    }, 2000)

    try {
      await fetch(`${API_URL}/`)
    } catch {
      // server unreachable — will fail on upload too
    } finally {
      clearTimeout(wakeTimer)
    }

    await doUpload(selectedFile, setUploadState, navigate)
  }, [navigate])

  const handleInvalidFile = useCallback(() => {
    setFile(null)
    setUploadState({
      phase: "error",
      progress: 0,
      fileName: null,
      fileSize: null,
      errorMessage: "Only PDF files are supported.",
      slowWake: false,
    })
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

  return (
    <div className="home-page">
      <FullscreenButton className="home-page__fullscreen" />
      <nav className="home-nav" aria-label="Primary">
        <div className="home-logo">BOOKY</div>
        <div className="home-nav-links">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `home-nav-link${isActive ? " home-nav-link--active" : ""}`
            }
          >
            Upload
          </NavLink>
          <NavLink
            to="/library"
            className={({ isActive }) =>
              `home-nav-link${isActive ? " home-nav-link--active" : ""}`
            }
          >
            Library
          </NavLink>
        </div>
      </nav>

      <main className="home-main">
        <header className="home-hero">
          <h1>Read with Clarity</h1>
          <p>Transform any PDF into an accessible reading experience</p>
        </header>

        <section className="upload-section">
          <div
            className={`upload-zone ${isDragging ? "dragging" : ""}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => {
              if (uploadState.phase === "idle" || uploadState.phase === "error") {
                onBrowseClick()
              }
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                if (uploadState.phase === "idle" || uploadState.phase === "error") {
                  onBrowseClick()
                }
              }
            }}
            aria-label="Upload PDF file"
          >
            {uploadState.phase !== "idle" && uploadState.phase !== "error" ? (
              <div className="home__upload-progress">
                <p className="home__upload-phase">{PHASE_LABELS[uploadState.phase]}</p>

                {uploadState.phase === "uploading" && (
                  <div className="home__progress-bar-wrap">
                    <div
                      className="home__progress-bar-fill"
                      style={{ width: `${uploadState.progress}%` }}
                    />
                  </div>
                )}

                {(uploadState.phase === "parsing" ||
                  uploadState.phase === "storing" ||
                  uploadState.phase === "waking") && (
                  <div className="home__progress-bar-wrap">
                    <div className="home__progress-bar-fill home__progress-bar-fill--indeterminate" />
                  </div>
                )}

                {PHASE_SUBLABELS[uploadState.phase] && (
                  <p className="home__upload-sublabel">
                    {PHASE_SUBLABELS[uploadState.phase]}
                  </p>
                )}

                {uploadState.fileName && (
                  <p className="home__upload-filename">{uploadState.fileName}</p>
                )}
              </div>
            ) : (
              <>
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
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              className="hidden-input"
              onChange={onInputChange}
            />
          </div>

          {uploadState.phase === "error" && (
            <div className="home__upload-error">
              <p className="home__upload-error-msg">
                {uploadState.errorMessage}
              </p>
              <button
                className="home__upload-retry"
                type="button"
                onClick={() => {
                  setUploadState(EMPTY_UPLOAD_STATE)
                  setFile(null)
                }}
              >
                Try again
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}