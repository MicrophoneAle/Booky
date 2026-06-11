import { useCallback, useRef, useState } from "react"
import { NavLink, useNavigate } from "react-router-dom"
import {
  SignedIn,
  SignedOut,
  SignInButton,
  useAuth,
  useClerk,
  UserButton,
} from "@clerk/clerk-react"
import FullscreenButton from "../components/FullscreenButton"
import {
  getParsePipelineStepStates,
  getParseProgressDetail,
  getParseProgressHeadline,
} from "../utils/parseProgress"
import "./Home.css"

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000"

const LARGE_FILE_BYTES = 15 * 1024 * 1024
const PARSE_POLL_INTERVAL_MS = 1000
const PARSE_POLL_TIMEOUT_MS = 20 * 60 * 1000
const UPLOAD_PROGRESS_WEIGHT = 0.12

const EMPTY_UPLOAD_STATE = {
  phase: "idle", // idle | waking | uploading | processing | done | error
  progress: 0,
  fileName: null,
  fileSize: null,
  errorMessage: null,
  slowWake: false,
  documentId: null,
  parseProgress: null,
}

const PHASE_LABELS = {
  waking: "Connecting to server...",
  uploading: "Uploading PDF...",
  processing: "Processing your book...",
  done: "Done!",
}

const PHASE_SUBLABELS = {
  waking: "Server is waking up, this takes ~15 seconds after a period of inactivity",
  uploading: "Sending your PDF to the server",
  processing: null,
  done: null,
}

function getProcessingHeadline(phase, parseProgress) {
  if (phase === "processing") {
    return getParseProgressHeadline(parseProgress)
  }
  return PHASE_LABELS[phase] ?? "Working…"
}

function overallUploadProgress(phase, uploadPercent, parseProgress) {
  if (phase === "uploading") {
    return Math.round(uploadPercent * UPLOAD_PROGRESS_WEIGHT)
  }

  if (phase === "processing") {
    const parsePercent = parseProgress?.percent ?? 0
    const processingShare = 1 - UPLOAD_PROGRESS_WEIGHT
    return Math.round(
      100 * UPLOAD_PROGRESS_WEIGHT + parsePercent * processingShare
    )
  }

  if (phase === "done") {
    return 100
  }

  return 0
}

function isPdfFile(file) {
  if (!file) return false
  const hasPdfMime = file.type === "application/pdf"
  const hasPdfExtension = file.name.toLowerCase().endsWith(".pdf")
  return hasPdfMime || hasPdfExtension
}

async function fetchWithRetry(url, options, retries = 4) {
  let lastError = null

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await fetch(url, options)
    } catch (error) {
      lastError = error
      if (attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to fetch")
}

async function pollDocumentParseStatus(documentId, getToken, onProgress) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < PARSE_POLL_TIMEOUT_MS) {
    const token = await getToken()
    if (!token) {
      throw new Error("Unauthorized")
    }

    const response = await fetchWithRetry(
      `${API_URL}/documents/${encodeURIComponent(documentId)}/status`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    )

    if (response.status === 401 || response.status === 403) {
      throw new Error("Unauthorized")
    }

    if (!response.ok) {
      throw new Error("Failed to check processing status")
    }

    const data = await response.json()
    if (!data.success) {
      throw new Error(data.error ?? "Failed to check processing status")
    }

    if (data.parse_progress) {
      onProgress(data.parse_progress)
    } else if (typeof data.parse_percent === "number") {
      onProgress({
        phase: "extracting",
        label: "Reading PDF pages",
        current: 0,
        total: 0,
        percent: data.parse_percent,
      })
    }

    if (data.parse_status === "ready") {
      onProgress({ phase: "ready", current: 0, total: 0, percent: 100 })
      return documentId
    }

    if (data.parse_status === "error") {
      throw new Error(
        data.parse_progress?.label ??
          data.error ??
          "Processing failed. Try uploading again."
      )
    }

    await new Promise((resolve) => setTimeout(resolve, PARSE_POLL_INTERVAL_MS))
  }

  throw new Error("Processing timed out. Try again in a few minutes.")
}

function doUpload(file, getToken, setUploadState, navigate) {
  return (async () => {
    const token = await getToken()
    if (!token) {
      setUploadState((state) => ({
        ...state,
        phase: "error",
        errorMessage: "Unauthorized",
      }))
      return
    }

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

    xhr.addEventListener("load", async () => {
      try {
        const data = JSON.parse(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300 && data.success) {
          const documentId = data.document?.id
          const isPending = data.document?.status === "pending"

          if (isPending && documentId) {
            setUploadState((state) => ({
              ...state,
              phase: "processing",
              progress: Math.round(100 * UPLOAD_PROGRESS_WEIGHT),
              documentId,
              parseProgress: {
                phase: "starting",
                current: 0,
                total: 0,
                percent: 0,
              },
            }))

            try {
              await pollDocumentParseStatus(documentId, getToken, (parseProgress) => {
                setUploadState((state) => ({
                  ...state,
                  phase: "processing",
                  parseProgress,
                  progress: overallUploadProgress(
                    "processing",
                    100,
                    parseProgress
                  ),
                }))
              })

              setUploadState((state) => ({
                ...state,
                phase: "done",
                progress: 100,
                parseProgress: { phase: "ready", current: 0, total: 0, percent: 100 },
              }))
              setTimeout(() => navigate(`/read/${documentId}`), 600)
            } catch (pollError) {
              const message =
                pollError instanceof Error ? pollError.message : "Processing failed"
              setUploadState((state) => ({
                ...state,
                phase: "error",
                errorMessage:
                  message === "Failed to fetch"
                    ? "Could not reach the server. Wait ~30 seconds for Render to wake up, then try again."
                    : message,
              }))
            }

            resolve()
            return
          }

          if (documentId) {
            setUploadState((state) => ({ ...state, phase: "done" }))
            setTimeout(() => navigate(`/read/${documentId}`), 600)
          }
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
    xhr.setRequestHeader("Authorization", `Bearer ${token}`)
    xhr.send(formData)
  })
  })()
}

export default function Home() {
  const navigate = useNavigate()
  const { getToken, isSignedIn } = useAuth()
  const { openSignIn } = useClerk()
  const fileInputRef = useRef(null)

  const [file, setFile] = useState(null)
  const [largeFileWarning, setLargeFileWarning] = useState(false)
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
      parseProgress: null,
    })

    const wakeTimer = setTimeout(() => {
      setUploadState((state) =>
        state.phase === "waking" ? { ...state, slowWake: true } : state
      )
    }, 2000)

    const token = await getToken()
    if (!token) {
      setUploadState((state) => ({
        ...state,
        phase: "error",
        errorMessage: "Unauthorized",
      }))
      return
    }

    try {
      await fetchWithRetry(`${API_URL}/`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
    } catch {
      // server may still be waking — upload will retry via xhr
    } finally {
      clearTimeout(wakeTimer)
    }

    await doUpload(selectedFile, getToken, setUploadState, navigate)
  }, [getToken, navigate])

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
      if (!isSignedIn) {
        openSignIn()
        return
      }
      if (!isPdfFile(selectedFile)) {
        handleInvalidFile()
        return
      }
      setLargeFileWarning(selectedFile.size > LARGE_FILE_BYTES)
      startUpload(selectedFile)
    },
    [handleInvalidFile, isSignedIn, openSignIn, startUpload]
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
      <div className="home-page__fullscreen">
        <SignedOut>
          <SignInButton mode="modal">
            <button className="nav__signin-btn">Sign in</button>
          </SignInButton>
        </SignedOut>
        <SignedIn>
          <UserButton
            appearance={{
              elements: { avatarBox: { width: 26, height: 26 } },
            }}
          />
        </SignedIn>
        <FullscreenButton />
      </div>
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
                <p className="home__upload-phase">
                  {getProcessingHeadline(uploadState.phase, uploadState.parseProgress)}
                </p>

                {(uploadState.phase === "uploading" ||
                  uploadState.phase === "processing" ||
                  uploadState.phase === "done") && (
                  <div className="home__progress-bar-wrap">
                    <div
                      className="home__progress-bar-fill"
                      style={{ width: `${uploadState.progress}%` }}
                    />
                  </div>
                )}

                {uploadState.phase === "waking" && (
                  <div className="home__progress-bar-wrap">
                    <div className="home__progress-bar-fill home__progress-bar-fill--indeterminate" />
                  </div>
                )}

                {uploadState.phase === "processing" ? (
                  <>
                    <ol className="home__parse-steps" aria-label="Processing steps">
                      {getParsePipelineStepStates(uploadState.parseProgress).map((step) => (
                        <li
                          key={step.phase}
                          className={`home__parse-step home__parse-step--${step.status}`}
                        >
                          <span className="home__parse-step-marker" aria-hidden="true" />
                          <span className="home__parse-step-label">{step.label}</span>
                        </li>
                      ))}
                    </ol>
                    <p className="home__upload-sublabel">
                      {getParseProgressDetail(uploadState.parseProgress)}
                    </p>
                  </>
                ) : (
                  PHASE_SUBLABELS[uploadState.phase] && (
                    <p className="home__upload-sublabel">
                      {PHASE_SUBLABELS[uploadState.phase]}
                    </p>
                  )
                )}

                {(uploadState.phase === "uploading" || uploadState.phase === "processing") && (
                  <p className="home__upload-percent">{uploadState.progress}%</p>
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
                {largeFileWarning && (
                  <p className="home__large-file-warning">
                    Large file — processing may take a few minutes
                  </p>
                )}
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
                  setLargeFileWarning(false)
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