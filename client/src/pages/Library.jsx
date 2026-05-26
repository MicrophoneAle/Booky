import { useCallback, useEffect, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
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

  return (
    <div className="library-page">
      <nav className="library-nav" aria-label="Primary">
        <div className="library-logo">BOOKY</div>
        <div className="library-nav-links">
          <Link to="/library" className="library-nav-link">
            Library
          </Link>
          <Link to="/" className="library-nav-link">
            Upload
          </Link>
          <Link to="/" className="library-nav-link">
            Settings
          </Link>
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
              <article key={document.id} className="library-card">
                <div className="library-card__spine" aria-hidden="true" />
                <div className="library-card__content">
                  <h2 className="library-card__title">{document.name}</h2>
                  <p className="library-card__pages">
                    {formatPageCount(document.total_pages)}
                  </p>
                  <p className="library-card__date">
                    {formatUploadDate(document.created_at)}
                  </p>
                  <button
                    type="button"
                    className="library-card__button"
                    onClick={() => navigate(`/read/${document.id}`)}
                  >
                    Open Book →
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
