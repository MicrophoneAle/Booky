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
  "#3a1a1a",
  "#1c2e24",
  "#2a2418",
  "#1a2438",
  "#3a2a1a",
  "#2e1a3a",
  "#1a2e2e",
  "#3a2818",
  "#24241a",
  "#1a1f3a",
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
      const response = await fetch(`${API_URL}/documents/${document.id}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      const data = await response.json()

      if (!response.ok || !data.success) {
        throw new Error("Delete failed")
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

      const link = window.document.createElement("a")
      link.href = data.url
      link.download = `${document.name}.pdf`
      link.rel = "noopener"
      link.target = "_blank"
      window.document.body.appendChild(link)
      link.click()
      link.remove()
    } catch {
      setDownloadError(true)
    } finally {
      setDownloading(false)
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
                aria-label={`Download ${document.name}`}
                disabled={downloading}
                title="Download PDF"
              >
                {downloading ? "…" : <DownloadIcon />}
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
                  <p className="library-card__delete-error">Delete failed. Try again.</p>
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
  const { getToken, isSignedIn } = useAuth()
  const { openSignIn } = useClerk()
  const [documents, setDocuments] = useState([])
  const [searchQuery, setSearchQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)

  const fetchDocuments = useCallback(async () => {
    setLoading(true)
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

      setDocuments(data.documents ?? [])
    } catch (fetchError) {
      setError(
        fetchError instanceof Error ? fetchError.message : "Failed to fetch documents"
      )
      setDocuments([])
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => {
    if (!isSignedIn) {
      setLoading(false)
      setError(null)
      setDocuments([])
      return
    }
    fetchDocuments()
  }, [fetchDocuments, isSignedIn, reloadKey])

  const handleDocumentDeleted = useCallback((documentId) => {
    setDocuments((current) => current.filter((doc) => doc.id !== documentId))
  }, [])

  const handleDocumentRenamed = useCallback((documentId, newName) => {
    setDocuments((current) =>
      current.map((doc) => (doc.id === documentId ? { ...doc, name: newName } : doc))
    )
  }, [])

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
