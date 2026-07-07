import { useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { useAuth } from "@clerk/clerk-react"
import BookViewer from "../components/BookViewer"
import "./Reader.css"

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000"

export default function Reader() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { getToken } = useAuth()
  const savedPage = parseInt(localStorage.getItem(`booky-progress-${id}`) ?? "1", 10)
  const [initialPage] = useState(() =>
    Number.isFinite(savedPage) && savedPage > 0 ? savedPage : 1
  )
  const [bookDocument, setBookDocument] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function loadDocument() {
      setLoading(true)
      setError(null)

      // Clerk session tokens are short-lived, so every request (especially
      // during the multi-minute parse poll) fetches a fresh one instead of
      // reusing the token from the initial load.
      const authHeaders = async () => {
        const token = await getToken()
        if (!token) {
          throw new Error("Unauthorized")
        }
        return {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        }
      }

      try {
        const response = await fetch(`${API_URL}/documents/${id}`, {
          headers: await authHeaders(),
        })
        const data = await response.json()

        if (!response.ok || !data.success) {
          throw new Error(data.error || "Could not load document.")
        }

        if (cancelled) return

        if (data.document?.parse_status === "pending") {
          const startedAt = Date.now()
          const pollTimeoutMs = 5 * 60 * 1000

          while (Date.now() - startedAt < pollTimeoutMs) {
            await new Promise((resolve) => setTimeout(resolve, 3000))
            if (cancelled) return

            // A transient network blip mid-poll should retry on the next
            // tick, not surface an error screen for a book that is still
            // parsing fine.
            let statusData
            try {
              const statusResponse = await fetch(
                `${API_URL}/documents/${encodeURIComponent(id)}/status`,
                { headers: await authHeaders() }
              )
              statusData = await statusResponse.json()
            } catch {
              continue
            }

            if (statusData.parse_status === "error") {
              throw new Error("Processing failed. Try uploading again.")
            }

            if (statusData.parse_status === "ready") {
              break
            }
          }

          const retryResponse = await fetch(`${API_URL}/documents/${id}`, {
            headers: await authHeaders(),
          })
          const retryData = await retryResponse.json()

          if (!retryResponse.ok || !retryData.success) {
            throw new Error(retryData.error || "Could not load document.")
          }

          if (cancelled) return

          setBookDocument({
            id: retryData.document.id,
            title: retryData.document.name,
            chapters: retryData.document.chapters ?? [],
            content: retryData.document.content ?? [],
            parserVersion: retryData.document.parser_version,
          })
          return
        }

        setBookDocument({
          id: data.document.id,
          title: data.document.name,
          chapters: data.document.chapters ?? [],
          content: data.document.content ?? [],
          parserVersion: data.document.parser_version,
        })
      } catch (fetchError) {
        if (!cancelled) {
          setError(
            fetchError instanceof Error ? fetchError.message : "Could not load document."
          )
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadDocument()

    return () => {
      cancelled = true
    }
  }, [getToken, id])

  if (loading) {
    return (
      <div className="reader-screen">
        <div className="reader-screen__content">
          <p className="reader-screen__logo">BOOKY</p>
          <p className="reader-screen__subtext">
            Opening your book… (first open after an update may take a moment)
          </p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="reader-screen">
        <div className="reader-screen__content">
          <p className="reader-screen__message">{error}</p>
          <button
            type="button"
            className="reader-screen__link"
            onClick={() => navigate("/")}
          >
            Go back to library
          </button>
        </div>
      </div>
    )
  }

  return <BookViewer document={bookDocument} initialPage={initialPage} />
}
