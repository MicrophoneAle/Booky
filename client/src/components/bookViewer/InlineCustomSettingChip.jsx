export function InlineCustomSettingChip({
  field,
  editingField,
  editInputRef,
  isActive,
  displayLabel,
  draft,
  staticPrefix = "Custom",
  staticSuffix = "",
  onStartEdit,
  onDraftChange,
  onCommit,
  onBlurCommit,
  onCancel,
}) {
  if (editingField === field) {
    return (
      <span className="book-viewer__settings-chip book-viewer__settings-chip--active book-viewer__settings-chip--edit">
        <span className="book-viewer__settings-chip-static">{staticPrefix}</span>
        <input
          ref={editInputRef}
          type="text"
          inputMode="decimal"
          className="book-viewer__settings-chip-input"
          value={draft}
          aria-label={`${staticPrefix} value`}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              onCommit()
            }
            if (event.key === "Escape") {
              event.preventDefault()
              onCancel()
            }
          }}
          onBlur={onBlurCommit}
        />
        {staticSuffix ? (
          <span className="book-viewer__settings-chip-static">{staticSuffix}</span>
        ) : null}
      </span>
    )
  }

  return (
    <button
      type="button"
      className={`book-viewer__settings-chip ${
        isActive ? "book-viewer__settings-chip--active" : ""
      }`}
      onClick={onStartEdit}
    >
      {displayLabel}
    </button>
  )
}
