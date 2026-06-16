import { Fragment } from "react"
export function highlightTextContent(text, query, tracker = null, activeOccurrence = null) {
  const source = String(text ?? "")
  const normalizedQuery = String(query ?? "").trim()
  if (!normalizedQuery) return source

  const escaped = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const regex = new RegExp(`(${escaped})`, "gi")
  const parts = source.split(regex)

  if (parts.length <= 1) return source

  const queryLower = normalizedQuery.toLowerCase()
  return parts.map((part, index) => {
    if (part.toLowerCase() !== queryLower) {
      return <Fragment key={`${part}-${index}`}>{part}</Fragment>
    }

    if (tracker && typeof tracker.count === "number") {
      tracker.count += 1
    }

    const isActive =
      tracker &&
      typeof tracker.count === "number" &&
      activeOccurrence !== null &&
      tracker.count === activeOccurrence

    return (
      <mark
        key={`${part}-${index}`}
        className={`book-page__highlight${
          isActive ? " book-page__highlight--active" : ""
        }`}
      >
        {part}
      </mark>
    )
  })
}

