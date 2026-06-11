import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import "./Library.css"

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000"
const PARSE_STATUS_POLL_MS = 5000

async function fetchWithRetry(url, options, retries = 3) {
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

function formatUploadDate(dateString) {
  const date = new Date(dateString)
  return date
    .toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    })
    .replace(",", "")
}

function formatPageCount(totalPages) {
  const count = totalPages ?? 0
  return `${count} ${count === 1 ? "page" : "pages"}`
}

function formatWordCount(document) {
  const count = Number(document?.word_count ?? document?.wordCount) || 0
  if (count < 1000) {
    return `${count.toLocaleString()} ${count === 1 ? "word" : "words"}`
  }
  return `${(count / 1000).toFixed(1)}k words`
}

const SPINE_COLORS = [
  "#a83232",
  "#2d8a5e",
  "#c9782a",
  "#3a62b8",
  "#8e44ad",
  "#c45c2a",
  "#1f8a8a",
  "#6b4226",
  "#4a8c3a",
  "#b83d6b",
  "#2563a8",
  "#8a7a28",
  "#5c3d8a",
  "#2a6b4a",
  "#c43a5a",
]

function getSpineColor(documentId) {
  let hash = 0
  for (let index = 0; index < documentId.length; index += 1) {
    hash = documentId.charCodeAt(index) + ((hash << 5) - hash)
  }
  return SPINE_COLORS[Math.abs(hash) % SPINE_COLORS.length]
}

function EditTitleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  )
}

function ReformattedDownloadIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h8" />
    </svg>
  )
}

function LibraryBookCard({ document, onDelete, onRename, getToken }) {
  const navigate = useNavigate()
  const titleInputRef = useRef(null)
  const cancelingEditRef = useRef(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(false)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editValue, setEditValue] = useState(document.name)
  const [savingTitle, setSavingTitle] = useState(false)
  const [renameError, setRenameError] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadingReformatted, setDownloadingReformatted] = useState(false)
  const [downloadError, setDownloadError] = useState(false)

  const handleDeleteClick = () => {
    setDeleteError(false)
    setConfirming(true)
  }

  const handleCancel = () => {
    if (deleting) return
    setConfirming(false)
    setDeleteError(false)
  }

  useEffect(() => {
    if (!isEditingTitle) {
      setEditValue(document.name)
    }
  }, [document.name, isEditingTitle])

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
    }
  }, [isEditingTitle])

  useEffect(() => {
    if (!renameError) return undefined

    const timeoutId = window.setTimeout(() => {
      setRenameError(false)
    }, 3000)

    return () => window.clearTimeout(timeoutId)
  }, [renameError])

  useEffect(() => {
    if (!downloadError) return undefined

    const timeoutId = window.setTimeout(() => {
      setDownloadError(false)
    }, 3000)

    return () => window.clearTimeout(timeoutId)
  }, [downloadError])

  const cancelTitleEdit = () => {
    cancelingEditRef.current = true
    setEditValue(document.name)
    setIsEditingTitle(false)
    setRenameError(false)
  }

  const saveTitleEdit = async () => {
    const name = String(editValue ?? "").trim()

    if (!name || name === document.name) {
      cancelTitleEdit()
      return
    }

    setSavingTitle(true)
    setRenameError(false)

    try {
      const token = await getToken()
      if (!token) throw new Error("Unauthorized")
      const payload = { name }
      const response = await fetch(
        `${API_URL}/documents/${encodeURIComponent(document.id)}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
        }
      )
      const data = await response.json()

      if (!response.ok || !data.success) {
        throw new Error("Rename failed")
      }

      onRename(document.id, name)
      setIsEditingTitle(false)
    } catch {
      setEditValue(document.name)
      setIsEditingTitle(false)
      setRenameError(true)
    } finally {
      setSavingTitle(false)
    }
  }

  const handleTitleBlur = () => {
    if (cancelingEditRef.current) {
      cancelingEditRef.current = false
      return
    }

    saveTitleEdit()
  }

  const handleConfirmDelete = async () => {
    setDeleting(true)
    setDeleteError(false)

    try {
      const token = await getToken()
      if (!token) throw new Error("Unauthorized")

      const response = await fetchWithRetry(
        `${API_URL}/documents/${encodeURIComponent(document.id)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      )

      let data = null
      try {
        data = await response.json()
      } catch {
        throw new Error("Unexpected server response")
      }

      if (!response.ok || !data?.success) {
        throw new Error(data?.error ?? "Delete failed")
      }

      onDelete(document.id)
    } catch {
      setDeleteError(true)
    } finally {
      setDeleting(false)
    }
  }

  const handleDownload = async () => {
    setDownloading(true)
    setDownloadError(false)

    try {
      const token = await getToken()
      if (!token) throw new Error("Unauthorized")

      const response = await fetch(`${API_URL}/documents/${encodeURIComponent(document.id)}/download`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      })
      const data = await response.json()

      if (!response.ok || !data.url) {
        throw new Error(data.error || "Download failed")
      }

      const fileResponse = await fetch(data.url)
      if (!fileResponse.ok) {
        throw new Error("Failed to download file")
      }
      const blob = await fileResponse.blob()
      const objectUrl = URL.createObjectURL(blob)

      const link = window.document.createElement("a")
      link.href = objectUrl
      link.download = `${document.name}.pdf`
      window.document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(objectUrl)
    } catch {
      setDownloadError(true)
    } finally {
      setDownloading(false)
    }
  }

  const handleDownloadReformatted = async () => {
    setDownloadingReformatted(true)
    setDownloadError(false)

    try {
      const token = await getToken()
      if (!token) throw new Error("Unauthorized")

      const response = await fetch(
        `${API_URL}/documents/${encodeURIComponent(document.id)}/download/reformatted`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      )

      if (!response.ok) {
        let message = "Download failed"
        try {
          const data = await response.json()
          message = data.error || message
        } catch {
          // non-JSON error body
        }
        throw new Error(message)
      }

      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)

      const link = window.document.createElement("a")
      link.href = objectUrl
      link.download = `${document.name} (reformatted).html`
      window.document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(objectUrl)
    } catch {
      setDownloadError(true)
    } finally {
      setDownloadingReformatted(false)
    }
  }

  return (
    <article className="library-card">
      <div
        className="library-card__spine"
        style={{ "--spine-color": getSpineColor(document.id) }}
        aria-hidden="true"
      />
      <div className="library-card__content">
        <div className="library-card__title-row">
          {isEditingTitle ? (
            <input
              ref={titleInputRef}
              type="text"
              className="library-card__title-input"
              value={editValue}
              onChange={(event) => setEditValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  saveTitleEdit()
                } else if (event.key === "Escape") {
                  event.preventDefault()
                  cancelTitleEdit()
                }
              }}
              onBlur={handleTitleBlur}
              disabled={savingTitle}
              aria-label="Edit book name"
            />
          ) : (
            <>
              <h2 className="library-card__title">{document.name}</h2>
              <button
                type="button"
                className="library-card__edit"
                onClick={() => setIsEditingTitle(true)}
                aria-label={`Rename ${document.name}`}
              >
                <EditTitleIcon />
              </button>
              <button
                type="button"
                className="library-card__download"
                onClick={handleDownload}
                aria-label={`Download original PDF of ${document.name}`}
                disabled={downloading}
                title="Download original PDF"
              >
                {downloading ? "…" : <DownloadIcon />}
              </button>
              <button
                type="button"
                className="library-card__download"
                onClick={handleDownloadReformatted}
                aria-label={`Download reformatted ${document.name}`}
                disabled={downloadingReformatted}
                title="Download reformatted (HTML)"
              >
                {downloadingReformatted ? "…" : <ReformattedDownloadIcon />}
              </button>
            </>
          )}
        </div>
        {renameError && (
          <p className="library-card__rename-error">Rename failed. Try again.</p>
        )}
        {downloadError && (
          <p className="library-card__rename-error">Download failed. Try again.</p>
        )}
        {document.parse_status === "pending" && (
          <span className="library-card__processing-badge">Processing...</span>
        )}
        <p className="library-card__pages">{formatPageCount(document.total_pages)}</p>
        <p className="library-card__words">{formatWordCount(document)}</p>
        <p className="library-card__date">{formatUploadDate(document.created_at)}</p>

        {confirming ? (
          <div className="library-card__confirm">
            {deleting ? (
              <p className="library-card__deleting">Deleting...</p>
            ) : (
              <>
                <p className="library-card__confirm-text">Are you sure?</p>
                {deleteError && (
                  <p className="library-card__delete-error">
                    Delete failed. The server may be waking up — wait a moment and try again.
                  </p>
                )}
                <div className="library-card__confirm-actions">
                  <button
                    type="button"
                    className="library-card__confirm-delete"
                    onClick={handleConfirmDelete}
                    disabled={deleting}
                  >
                    Yes, delete
                  </button>
                  <button
                    type="button"
                    className="library-card__confirm-cancel"
                    onClick={handleCancel}
                    disabled={deleting}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="library-card__footer">
            <button
              type="button"
              className="library-card__button"
              onClick={() => navigate(`/read/${document.id}`)}
            >
              Open Book →
            </button>
            <button
              type="button"
              className="library-card__delete"
              onClick={handleDeleteClick}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </article>
  )
}

export default function Library() {
  const navigate = useNavigate()
  const { getToken, isSignedIn, userId } = useAuth()
  const { openSignIn } = useClerk()
  const [documents, setDocuments] = useState([])
  const [searchQuery, setSearchQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const getTokenRef = useRef(getToken)
  getTokenRef.current = getToken

  const libraryCacheKey = userId ? `booky-library-${userId}` : null

  const readCachedDocuments = useCallback(() => {
    if (!libraryCacheKey) return null
    try {
      const raw = localStorage.getItem(libraryCacheKey)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }, [libraryCacheKey])

  const writeCachedDocuments = useCallback(
    (docs) => {
      if (!libraryCacheKey) return
      try {
        localStorage.setItem(libraryCacheKey, JSON.stringify(docs))
      } catch {
        // Ignore storage write errors (quota, private mode, etc.).
      }
    },
    [libraryCacheKey]
  )

  const fetchDocuments = useCallback(
    async ({ background = false } = {}) => {
      if (!background) {
        setLoading(true)
      }
      setError(null)

      try {
        const token = await getToken()
        if (!token) throw new Error("Unauthorized")
        const response = await fetch(`${API_URL}/documents`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        })
        const data = await response.json()

        if (!response.ok || !data.success) {
          throw new Error(data.error || "Failed to fetch documents")
        }

        const docs = data.documents ?? []
        setDocuments(docs)
        writeCachedDocuments(docs)
      } catch (fetchError) {
        // Keep showing cached documents on a background refresh failure.
        if (!background) {
          setError(
            fetchError instanceof Error
              ? fetchError.message
              : "Failed to fetch documents"
          )
          setDocuments([])
        }
      } finally {
        if (!background) {
          setLoading(false)
        }
      }
    },
    [getToken, writeCachedDocuments]
  )

  useEffect(() => {
    if (!isSignedIn) {
      setLoading(false)
      setError(null)
      setDocuments([])
      return
    }

    // Show cached documents instantly (stale-while-revalidate), then refresh.
    const cached = readCachedDocuments()
    if (cached && cached.length > 0) {
      setDocuments(cached)
      setLoading(false)
      fetchDocuments({ background: true })
    } else {
      fetchDocuments()
    }
  }, [fetchDocuments, isSignedIn, reloadKey, readCachedDocuments])

  const handleParseReady = useCallback((documentId) => {
    setReloadKey((key) => key + 1)
  }, [])

  useEffect(() => {
    if (!isSignedIn) {
      return undefined
    }

    const pendingIds = documents
      .filter((doc) => doc.parse_status === "pending")
      .map((doc) => doc.id)

    if (pendingIds.length === 0) {
      return undefined
    }

    let cancelled = false

    const pollPending = async () => {
      const token = await getTokenRef.current()
      if (!token || cancelled) {
        return
      }

      for (const documentId of pendingIds) {
        if (cancelled) {
          return
        }

        try {
          const response = await fetch(
            `${API_URL}/documents/${encodeURIComponent(documentId)}/status`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
            }
          )
          const data = await response.json()

          if (response.ok && data.success && data.parse_status === "ready") {
            handleParseReady(documentId)
          }
        } catch {
          // keep polling on transient errors
        }
      }
    }

    void pollPending()
    const intervalId = window.setInterval(() => {
      void pollPending()
    }, PARSE_STATUS_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [documents, handleParseReady, isSignedIn])

  const handleDocumentDeleted = useCallback((documentId) => {
    setDocuments((current) => current.filter((doc) => doc.id !== documentId))
  }, [])

  const handleDocumentRenamed = useCallback((documentId, newName) => {
    setDocuments((current) =>
      current.map((doc) => (doc.id === documentId ? { ...doc, name: newName } : doc))
    )
  }, [])

  // Keep the offline/instant cache in sync after local edits (delete, rename).
  useEffect(() => {
    if (!isSignedIn || loading || error) {
      return
    }
    writeCachedDocuments(documents)
  }, [documents, isSignedIn, loading, error, writeCachedDocuments])

  const filteredDocuments = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return documents
    return documents.filter((document) => document.name.toLowerCase().includes(query))
  }, [documents, searchQuery])

  return (
    <div className="library-page">
      <div className="library-page__fullscreen">
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
      <nav className="library-nav" aria-label="Primary">
        <div className="library-logo">BOOKY</div>
        <div className="library-nav-links">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `library-nav-link${isActive ? " library-nav-link--active" : ""}`
            }
          >
            Upload
          </NavLink>
          <NavLink
            to="/library"
            className={({ isActive }) =>
              `library-nav-link${isActive ? " library-nav-link--active" : ""}`
            }
          >
            Library
          </NavLink>
        </div>
      </nav>

      <main className="library-main">
        {!isSignedIn ? (
          <div className="library__signin-prompt">
            <p className="library__signin-heading">Your Library</p>
            <p className="library__signin-sub">Sign in to view your uploaded books</p>
            <button className="library__signin-cta" onClick={() => openSignIn()}>
              Sign in to continue
            </button>
          </div>
        ) : (
          <>
            <header className="library-header">
              <h1>Library</h1>
              <p>Your uploaded books</p>
            </header>

            <div className="library-search">
              <input
                type="text"
                className="library-search__input"
                placeholder="Search by title..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                aria-label="Search books by title"
              />
            </div>

            {loading && (
              <div className="library-grid" aria-busy="true" aria-label="Loading library">
                {Array.from({ length: 6 }, (_, index) => (
                  <div key={index} className="library-card library-card--skeleton">
                    <div className="skeleton-line skeleton-line--title" />
                    <div className="skeleton-line skeleton-line--meta" />
                    <div className="skeleton-line skeleton-line--date" />
                    <div className="skeleton-line skeleton-line--button" />
                  </div>
                ))}
              </div>
            )}

            {!loading && error && (
              <div className="library-state">
                <p className="library-state__message">Could not load library.</p>
                <button
                  type="button"
                  className="library-state__link"
                  onClick={() => setReloadKey((key) => key + 1)}
                >
                  Try again
                </button>
              </div>
            )}

            {!loading && !error && documents.length === 0 && (
              <div className="library-state">
                <p className="library-state__empty">No books yet.</p>
                <button
                  type="button"
                  className="library-state__button"
                  onClick={() => navigate("/")}
                >
                  Upload your first book
                </button>
              </div>
            )}

            {!loading && !error && documents.length > 0 && filteredDocuments.length === 0 && (
              <div className="library-state">
                <p className="library-state__empty">No books match your search.</p>
              </div>
            )}

            {!loading && !error && filteredDocuments.length > 0 && (
              <div className="library-grid">
                {filteredDocuments.map((document) => (
                  <LibraryBookCard
                    key={document.id}
                    document={document}
                    onDelete={handleDocumentDeleted}
                    onRename={handleDocumentRenamed}
                    getToken={getToken}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
