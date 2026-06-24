import { useCallback, useEffect, useRef, useState } from "react"
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
  getCombinedProcessingPercent,
  getParsePipelineStepStates,
  getParseProgressDetail,
  getParseProgressDeadHint,
  getParseProgressHeadline,
  getParseProgressStaleHint,
  mergePollProgressUpdate,
} from "../utils/parseProgress"
import { registerPendingDocumentParse } from "../utils/bookCache"
import "./Home.css"

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000"

const LARGE_FILE_BYTES = 15 * 1024 * 1024
const PARSE_POLL_INTERVAL_MS = 500
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
    return getCombinedProcessingPercent(parseProgress, UPLOAD_PROGRESS_WEIGHT)
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

async function pollDocumentParseStatus(
  documentId,
  getToken,
  onProgress,
  onStale,
  { shouldContinue } = {}
) {
  const startedAt = Date.now()
  let lastProgress = null
  let lastProgressFingerprint = null
  let lastUpdatedAtChangeAt = Date.now()
  let consecutiveAuthFailures = 0
  const MAX_CONSECUTIVE_AUTH_FAILURES = 6

  while (Date.now() - startedAt < PARSE_POLL_TIMEOUT_MS) {
    if (shouldContinue && !shouldContinue()) {
      return documentId
    }

    // Force a fresh token after a rejection. A single 401 here is almost always
    // a momentarily expired or unverifiable token while the server is busy
    // parsing a large book or cold starting, not a real auth problem. The parse
    // continues server side, so retry instead of aborting the whole upload.
    const token = await getToken(
      consecutiveAuthFailures > 0 ? { skipCache: true } : undefined
    )
    if (!token) {
      consecutiveAuthFailures += 1
      if (consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
        throw new Error("Unauthorized")
      }
      await new Promise((resolve) => setTimeout(resolve, PARSE_POLL_INTERVAL_MS))
      continue
    }

    let response
    try {
      response = await fetchWithRetry(
        `${API_URL}/documents/${encodeURIComponent(documentId)}/status`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      )
    } catch {
      // Network blip. Keep polling; the parse is unaffected.
      await new Promise((resolve) => setTimeout(resolve, PARSE_POLL_INTERVAL_MS))
      continue
    }

    if (response.status === 401 || response.status === 403) {
      consecutiveAuthFailures += 1
      if (consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
        throw new Error("Unauthorized")
      }
      await new Promise((resolve) => setTimeout(resolve, PARSE_POLL_INTERVAL_MS))
      continue
    }

    consecutiveAuthFailures = 0

    if (!response.ok) {
      throw new Error("Failed to check processing status")
    }

    const data = await response.json()
    if (!data.success) {
      throw new Error(data.error ?? "Failed to check processing status")
    }

    if (data.parse_progress) {
      lastProgress = mergePollProgressUpdate(lastProgress, data.parse_progress)
    } else if (typeof data.parse_percent === "number") {
      lastProgress = mergePollProgressUpdate(lastProgress, {
        percent: data.parse_percent,
      })
    }

    if (lastProgress) {
      onProgress(lastProgress)

      const progressFingerprint = [
        lastProgress.updatedAt ?? null,
        lastProgress.imageBufferCurrent ?? null,
        lastProgress.pageCurrent ?? lastProgress.current ?? null,
        lastProgress.phase,
        lastProgress.extractSubphase ?? null,
      ].join(":")

      if (progressFingerprint !== lastProgressFingerprint) {
        lastProgressFingerprint = progressFingerprint
        lastUpdatedAtChangeAt = Date.now()
      } else {
        onStale?.(Date.now() - lastUpdatedAtChangeAt)
      }
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

  if (shouldContinue && !shouldContinue()) {
    return documentId
  }

  throw new Error("Processing timed out. Try again in a few minutes.")
}

const UPLOAD_RETRIES = 3
const UPLOAD_RETRY_DELAY_MS = 4000
const RENDER_WAKE_MESSAGE =
  "Could not reach the server. Wait ~30 seconds for Render to wake up, then try again."

function uploadPdfOnce(file, token, setUploadState) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const formData = new FormData()
    formData.append("file", file)

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        const pct = Math.round((event.loaded / event.total) * 100)
        setUploadState((state) => ({ ...state, progress: pct }))
      }
    })

    xhr.addEventListener("load", () => {
      resolve(xhr)
    })

    xhr.addEventListener("error", () => {
      reject(new Error("network"))
    })

    xhr.addEventListener("timeout", () => {
      reject(new Error("timeout"))
    })

    xhr.timeout = 120000
    xhr.open("POST", `${API_URL}/upload`)
    xhr.setRequestHeader("Authorization", `Bearer ${token}`)
    xhr.send(formData)
  })
}

function doUpload(file, getToken, setUploadState, navigate, setParseStaleSinceMs, isMountedRef) {
  return (async () => {
    const token = await getToken()
    if (!token) {
      if (isMountedRef.current) {
        setUploadState((state) => ({
          ...state,
          phase: "error",
          errorMessage: "Unauthorized",
        }))
      }
      return
    }

    setUploadState((state) => ({ ...state, phase: "uploading", progress: 0 }))

    let xhr = null
    for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt += 1) {
      try {
        xhr = await uploadPdfOnce(file, token, setUploadState)
        break
      } catch (error) {
        const reason = error instanceof Error ? error.message : "network"
        if (attempt < UPLOAD_RETRIES && (reason === "network" || reason === "timeout")) {
          setUploadState((state) => ({
            ...state,
            phase: "uploading",
            progress: 0,
          }))
          await new Promise((resolve) => setTimeout(resolve, UPLOAD_RETRY_DELAY_MS))
          continue
        }

        if (isMountedRef.current) {
          setUploadState((state) => ({
            ...state,
            phase: "error",
            errorMessage:
              reason === "timeout" ? "Request timed out" : RENDER_WAKE_MESSAGE,
          }))
        }
        return
      }
    }

    if (!xhr) {
      return
    }

    try {
      const data = JSON.parse(xhr.responseText)
      if (xhr.status >= 200 && xhr.status < 300 && data.success) {
        const documentId = data.document?.id
        const isPending = data.document?.status === "pending"

        if (isPending && documentId) {
          registerPendingDocumentParse(documentId)

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

          void (async () => {
            try {
              await pollDocumentParseStatus(
                documentId,
                getToken,
                (parseProgress) => {
                  if (!isMountedRef.current) {
                    return
                  }
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
                },
                (staleSinceMs) => {
                  if (isMountedRef.current) {
                    setParseStaleSinceMs(staleSinceMs)
                  }
                },
                { shouldContinue: () => isMountedRef.current }
              )

              if (!isMountedRef.current) {
                return
              }

              setUploadState((state) => ({
                ...state,
                phase: "done",
                progress: 100,
                parseProgress: { phase: "ready", current: 0, total: 0, percent: 100 },
              }))
              setTimeout(() => navigate(`/read/${documentId}`), 600)
            } catch (pollError) {
              if (!isMountedRef.current) {
                return
              }
              const message =
                pollError instanceof Error ? pollError.message : "Processing failed"
              setUploadState((state) => ({
                ...state,
                phase: "error",
                errorMessage:
                  message === "Failed to fetch" ? RENDER_WAKE_MESSAGE : message,
              }))
            }
          })()

          return
        }

        if (documentId) {
          setUploadState((state) => ({ ...state, phase: "done" }))
          setTimeout(() => navigate(`/read/${documentId}`), 600)
        }
        return
      }

      if (isMountedRef.current) {
        setUploadState((state) => ({
          ...state,
          phase: "error",
          errorMessage: data.error ?? "Upload failed",
        }))
      }
    } catch {
      if (isMountedRef.current) {
        setUploadState((state) => ({
          ...state,
          phase: "error",
          errorMessage: "Unexpected server response",
        }))
      }
    }
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
  const [showStaleParseHint, setShowStaleParseHint] = useState(false)
  const [parseStaleSinceMs, setParseStaleSinceMs] = useState(0)
  const [retryingParse, setRetryingParse] = useState(false)
  const autoRetryParseAttemptedRef = useRef(false)
  const parseProgressRef = useRef({ key: "", at: Date.now() })
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (uploadState.phase !== "processing") {
      setShowStaleParseHint(false)
      return undefined
    }

    const progress = uploadState.parseProgress
    const progressKey = [
      progress?.phase,
      progress?.extractSubphase,
      progress?.imageBufferCurrent ?? progress?.pageCurrent ?? progress?.current,
    ].join(":")

    if (progressKey !== parseProgressRef.current.key) {
      parseProgressRef.current = { key: progressKey, at: Date.now() }
      setShowStaleParseHint(false)
    }

    const timer = window.setTimeout(() => {
      setShowStaleParseHint(true)
    }, 20000)

    return () => window.clearTimeout(timer)
  }, [uploadState.phase, uploadState.parseProgress])

  const startUpload = useCallback(async (selectedFile) => {
    setFile(selectedFile)
    setParseStaleSinceMs(0)
    setRetryingParse(false)
    autoRetryParseAttemptedRef.current = false
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

    await doUpload(
      selectedFile,
      getToken,
      setUploadState,
      navigate,
      setParseStaleSinceMs,
      isMountedRef
    )
  }, [getToken, navigate])

  const handleRetryParse = useCallback(async () => {
    const documentId = uploadState.documentId
    if (!documentId || retryingParse) {
      return
    }

    setRetryingParse(true)
    setParseStaleSinceMs(0)

    try {
      const token = await getToken()
      if (!token) {
        throw new Error("Unauthorized")
      }

      const response = await fetchWithRetry(
        `${API_URL}/documents/${encodeURIComponent(documentId)}/retry-parse`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      )
      const data = await response.json()

      if (!response.ok || !data.success) {
        throw new Error(data.error ?? "Retry failed")
      }

      registerPendingDocumentParse(documentId)

      await pollDocumentParseStatus(
        documentId,
        getToken,
        (parseProgress) => {
          if (!isMountedRef.current) {
            return
          }
          setUploadState((state) => ({
            ...state,
            phase: "processing",
            parseProgress,
            progress: overallUploadProgress("processing", 100, parseProgress),
          }))
        },
        (staleSinceMs) => {
          if (isMountedRef.current) {
            setParseStaleSinceMs(staleSinceMs)
          }
        },
        { shouldContinue: () => isMountedRef.current }
      )

      if (!isMountedRef.current) {
        return
      }

      setUploadState((state) => ({
        ...state,
        phase: "done",
        progress: 100,
        parseProgress: { phase: "ready", current: 0, total: 0, percent: 100 },
      }))
      setTimeout(() => navigate(`/read/${documentId}`), 600)
    } catch (retryError) {
      if (!isMountedRef.current) {
        return
      }
      const message =
        retryError instanceof Error ? retryError.message : "Retry failed"
      setUploadState((state) => ({
        ...state,
        phase: "error",
        errorMessage: message,
      }))
    } finally {
      setRetryingParse(false)
    }
  }, [getToken, navigate, retryingParse, uploadState.documentId])

  useEffect(() => {
    if (uploadState.phase !== "processing" || retryingParse || autoRetryParseAttemptedRef.current) {
      return undefined
    }

    if (parseStaleSinceMs < 120_000) {
      return undefined
    }

    autoRetryParseAttemptedRef.current = true
    void handleRetryParse()

    return undefined
  }, [
    uploadState.phase,
    uploadState.parseProgress,
    parseStaleSinceMs,
    retryingParse,
    handleRetryParse,
  ])

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
                    {showStaleParseHint && getParseProgressStaleHint(uploadState.parseProgress) ? (
                      <p className="home__upload-sublabel home__upload-sublabel--stale">
                        {getParseProgressStaleHint(uploadState.parseProgress)}
                      </p>
                    ) : null}
                    {getParseProgressDeadHint(parseStaleSinceMs, uploadState.parseProgress) ? (
                      <>
                        <p className="home__upload-sublabel home__upload-sublabel--stale">
                          {getParseProgressDeadHint(parseStaleSinceMs, uploadState.parseProgress)}
                        </p>
                        <button
                          type="button"
                          className="home__upload-retry"
                          onClick={handleRetryParse}
                          disabled={retryingParse}
                        >
                          {retryingParse ? "Retrying…" : "Retry processing"}
                        </button>
                      </>
                    ) : null}
                  </>
                ) : (
                  PHASE_SUBLABELS[uploadState.phase] && (
                    <p className="home__upload-sublabel">
                      {PHASE_SUBLABELS[uploadState.phase]}
                    </p>
                  )
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