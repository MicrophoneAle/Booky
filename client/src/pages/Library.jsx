import { useCallback, useEffect, useRef, useState } from "react"
import { NavLink, useNavigate } from "react-router-dom"
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
  return `${count} ${count === 1 ? "PDF page" : "PDF pages"}`
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

function LibraryBookCard({ document, onDelete, onRename }) {
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

  const cancelTitleEdit = () => {
    cancelingEditRef.current = true
    setEditValue(document.name)
    setIsEditingTitle(false)
    setRenameError(false)
  }

  const saveTitleEdit = async () => {
    const trimmed = editValue.trim()

    if (!trimmed || trimmed === document.name) {
      cancelTitleEdit()
      return
    }

    setSavingTitle(true)
    setRenameError(false)

    try {
      const response = await fetch(`${API_URL}/documents/${document.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      })
      const data = await response.json()

      if (!response.ok || !data.success) {
        throw new Error("Rename failed")
      }

      onRename(document.id, trimmed)
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
      const response = await fetch(`${API_URL}/documents/${document.id}`, {
        method: "DELETE",
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

  return (
    <article className="library-card">
      <div className="library-card__spine" aria-hidden="true" />
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
            </>
          )}
        </div>
        {renameError && (
          <p className="library-card__rename-error">Rename failed. Try again.</p>
        )}
        <p className="library-card__pages">{formatPageCount(document.total_pages)}</p>
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
  const [documents, setDocuments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)

  const fetchDocuments = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch(`${API_URL}/documents`)
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
  }, [])

  useEffect(() => {
    fetchDocuments()
  }, [fetchDocuments, reloadKey])

  const handleDocumentDeleted = useCallback((documentId) => {
    setDocuments((current) => current.filter((doc) => doc.id !== documentId))
  }, [])

  const handleDocumentRenamed = useCallback((documentId, newName) => {
    setDocuments((current) =>
      current.map((doc) => (doc.id === documentId ? { ...doc, name: newName } : doc))
    )
  }, [])

  return (
    <div className="library-page">
      <FullscreenButton className="library-page__fullscreen" />
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
        <header className="library-header">
          <h1>Your Library</h1>
          <p>Your uploaded books</p>
        </header>

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

        {!loading && !error && documents.length > 0 && (
          <div className="library-grid">
            {documents.map((document) => (
              <LibraryBookCard
                key={document.id}
                document={document}
                onDelete={handleDocumentDeleted}
                onRename={handleDocumentRenamed}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
