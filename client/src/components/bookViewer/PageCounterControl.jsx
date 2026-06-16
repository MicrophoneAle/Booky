import { useEffect, useRef, useState } from "react"
export function PageCounterControl({
  leftPageNumber,
  rightPageNumber,
  totalPages,
  isSpreadView,
  onJump,
  disabled = false,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const inputRef = useRef(null)

  const startEdit = () => {
    if (disabled || !leftPageNumber) {
      return
    }
    setDraft(String(leftPageNumber))
    setEditing(true)
  }

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const cancelEdit = () => {
    setEditing(false)
    setDraft("")
  }

  const commitEdit = () => {
    if (!draft.trim()) {
      cancelEdit()
      return
    }
    onJump(draft)
    setEditing(false)
    setDraft("")
  }

  if (!leftPageNumber || totalPages === 0) {
    return null
  }

  if (editing) {
    return (
      <div className="book-viewer__counter book-viewer__counter--editing">
        <span className="book-viewer__counter-label">Page</span>
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          className="book-viewer__counter-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value.replace(/\D/g, ""))}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              commitEdit()
            }
            if (event.key === "Escape") {
              event.preventDefault()
              cancelEdit()
            }
          }}
          onBlur={commitEdit}
          aria-label={`Go to page, 1 to ${totalPages}`}
        />
        <span className="book-viewer__counter-suffix">of {totalPages}</span>
      </div>
    )
  }

  if (isSpreadView && rightPageNumber) {
    return (
      <p className="book-viewer__counter">
        Pages{" "}
        <button
          type="button"
          className="book-viewer__counter-page-btn"
          onClick={startEdit}
          title="Go to page"
          aria-label={`Page ${leftPageNumber}, click to go to a different page`}
        >
          {leftPageNumber}
        </button>
        –{rightPageNumber} of {totalPages}
      </p>
    )
  }

  return (
    <p className="book-viewer__counter">
      Page{" "}
      <button
        type="button"
        className="book-viewer__counter-page-btn"
        onClick={startEdit}
        title="Go to page"
        aria-label={`Page ${leftPageNumber}, click to go to a different page`}
      >
        {leftPageNumber}
      </button>{" "}
      of {totalPages}
    </p>
  )
}
