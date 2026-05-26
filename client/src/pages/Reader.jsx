import { useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import BookViewer from "../components/BookViewer"
import "./Reader.css"

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000"

export default function Reader() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [bookDocument, setBookDocument] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function loadDocument() {
      setLoading(true)
      setError(null)

      try {
        const response = await fetch(`${API_URL}/documents/${id}`)
        const data = await response.json()

        if (!response.ok || !data.success) {
          throw new Error(data.error || "Could not load document.")
        }

        if (cancelled) return

        setBookDocument({
          title: data.document.name,
          chapters: data.document.chapters ?? [],
          content: data.document.content ?? [],
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
  }, [id])

  if (loading) {
    return (
      <div className="reader-screen">
        <div className="reader-screen__content">
          <p className="reader-screen__logo">BOOKY</p>
          <p className="reader-screen__subtext">Opening your book...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="reader-screen">
        <div className="reader-screen__content">
          <p className="reader-screen__message">Could not load document.</p>
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

  return (
    <BookViewer
      document={bookDocument}
      initialPage={1}
      onPageChange={(pageNumber) => {
        console.log(pageNumber)
      }}
    />
  )
}
