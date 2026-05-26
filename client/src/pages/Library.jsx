import { useCallback, useEffect, useState } from "react"
import { NavLink, useNavigate } from "react-router-dom"
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

function LibraryBookCard({ document, onDelete }) {
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(false)

  const handleDeleteClick = () => {
    setDeleteError(false)
    setConfirming(true)
  }

  const handleCancel = () => {
    if (deleting) return
    setConfirming(false)
    setDeleteError(false)
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
        <h2 className="library-card__title">{document.name}</h2>
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

  return (
    <div className="library-page">
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
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
