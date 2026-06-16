import { Fragment } from "react"
import { isChapterBoundaryText, proseShouldBeCentered } from "../../utils/paginator.js"
import { visualItemPlainText } from "./readingAnchor.js"
import { highlightTextContent } from "./highlight.jsx"
export const IMPLIED_LIST_LINE_REGEX = /^(Add|Test|Explore|Verify|Ensure|Click)\b/i
export const TRIVIAL_LIST_PAGE_CHAR_LIMIT = 30
export const STANDALONE_URL_REGEX = /^https?:\/\/\S+$/i

export const LEVEL_0_NUMBER_REGEX = /^(\d+[\.\)])\s*(.*)$/
export const LEVEL_0_BULLET_REGEX = /^([•·])\s*(.*)$/
export const LEVEL_1_LETTERED_REGEX = /^([a-z][\.\)])\s+(.+)$/i
export const CHAPTER_LABEL_REGEX =
  /^(Chapter|Part|Section|Prologue|Epilogue)\s+(\d+|[IVXLCDM]+|[A-Za-z]+)$/i
export const LEVEL_2_MARKER_REGEX = /^((?:[ivxlcdm]+|\([a-z]\))[\.\)])\s*(.*)$/i
export const EMBEDDED_LIST_MARKER_REGEX = /\s+(\d+[\.\)]|[a-z][\.\)])\s+/gi
let listGroupCounter = 0

export function isHeadingVisualItem(item) {
  // subtitle intentionally excluded
  return item?.type === "title" || item?.type === "heading" || item?.type === "chapter"
}

export function isChapterBoundaryItem(item) {
  return (
    item?.type === "chapter" ||
    Boolean(item?.isChapterStart) ||
    isChapterBoundaryText(item?.text)
  )
}

export function proseParagraphClassName(previousItem, proseItem = null) {
  const classes = ["book-page__text"]

  if (proseItem?.isContinuation) {
    classes.push("book-page__text--continuation")
  } else if (proseItem?.isIndented) {
    // default indent only
  } else {
    const noIndentAfter =
      isHeadingVisualItem(previousItem) ||
      previousItem?.type === "subtitle" ||
      previousItem?.type === "author" ||
      previousItem?.type === "image"

    if (noIndentAfter) {
      classes.push("book-page__text--first")
    }
  }

  if (proseShouldBeCentered(proseItem)) {
    classes.push("book-page__text--center")
  }
  if (proseItem?.bold) {
    classes.push("book-page__text--bold")
  }
  if (proseItem?.italic) {
    classes.push("book-page__text--italic")
  }

  return classes.join(" ")
}

export function proseRunClassName(run) {
  const classes = []
  if (run?.bold) {
    classes.push("book-page__run--bold")
  }
  if (run?.italic) {
    classes.push("book-page__run--italic")
  }
  return classes.length > 0 ? classes.join(" ") : undefined
}

export function wrapResumeSentenceHighlight(content, sentenceText) {
  if (!sentenceText || typeof content !== "string") {
    return content
  }

  const start = content.indexOf(sentenceText)
  if (start < 0) {
    return content
  }

  const end = start + sentenceText.length
  return (
    <>
      {content.slice(0, start)}
      <mark className="book-page__resume-anchor">{content.slice(start, end)}</mark>
      {content.slice(end)}
    </>
  )
}

export function getItemRenderablePlain(item) {
  if (item?.runs?.length > 1) {
    return item.runs.map((run) => run.text).join(" ")
  }
  return item.text ?? visualItemPlainText(item)
}

export function renderProseContent(
  item,
  searchQuery,
  highlightTracker,
  activeSearchOccurrence,
  resumeSentenceText = null
) {
  if (resumeSentenceText) {
    const plain = getItemRenderablePlain(item)
    if (plain.includes(resumeSentenceText)) {
      return wrapResumeSentenceHighlight(plain, resumeSentenceText)
    }
  }

  if (item?.runs?.length > 1) {
    return item.runs.map((run, runIndex) => (
      <Fragment key={`run-${runIndex}`}>
        {runIndex > 0 ? " " : null}
        <span className={proseRunClassName(run)}>
          {highlightTextContent(
            run.text,
            searchQuery,
            highlightTracker,
            activeSearchOccurrence
          )}
        </span>
      </Fragment>
    ))
  }

  return highlightTextContent(
    item.text,
    searchQuery,
    highlightTracker,
    activeSearchOccurrence
  )
}

export function isStandaloneUrl(text) {
  return STANDALONE_URL_REGEX.test(text.trim())
}

export function isImpliedListLine(text) {
  return IMPLIED_LIST_LINE_REGEX.test(text.trim())
}

export function isListMarkerLine(text, pendingListItems = []) {
  return (
    parseListLine(text, pendingListItems) !== null ||
    parseLoneMarker(text, pendingListItems) !== null
  )
}

export function buildNumberedListText(marker, body) {
  const trimmedBody = body.trim()
  return trimmedBody ? `${marker} ${trimmedBody}`.replace(/\s+/g, " ").trim() : marker
}

export function parseListLine(text, pendingListItems = []) {
  const trimmed = text.trim()
  if (!trimmed) return null

  let match = trimmed.match(LEVEL_0_NUMBER_REGEX)
  if (match) {
    const marker = match[1]
    const body = match[2].trim()
    return {
      level: 0,
      marker,
      hasBullet: false,
      text: buildNumberedListText(marker, body),
      markerOnly: !body,
    }
  }

  match = trimmed.match(LEVEL_0_BULLET_REGEX)
  if (match) {
    const marker = match[1]
    const body = match[2].trim()
    return {
      level: 0,
      marker,
      hasBullet: true,
      text: body,
      markerOnly: !body,
    }
  }

  match = trimmed.match(LEVEL_2_MARKER_REGEX)
  if (match) {
    const marker = match[1]
    const body = match[2].trim()
    return {
      level: 2,
      marker,
      hasBullet: false,
      text: buildNumberedListText(marker, body),
      markerOnly: !body,
    }
  }

  match = trimmed.match(LEVEL_1_LETTERED_REGEX)
  if (match) {
    const marker = match[1]
    const body = match[2].trim()
    return {
      level: 1,
      marker,
      hasBullet: false,
      text: buildNumberedListText(marker, body),
      markerOnly: !body,
    }
  }

  return null
}

export function parseLoneMarker(text, pendingListItems = []) {
  const trimmed = text.trim()
  if (!trimmed) return null

  if (/^\d+[\.\)]$/.test(trimmed)) {
    return { level: 0, markerOnly: true, text: "" }
  }

  if (/^[•·\-—]$/.test(trimmed)) {
    return { level: 0, markerOnly: true, text: "" }
  }

  if (/^[a-z][\.\)]$/i.test(trimmed)) {
    return { level: 1, markerOnly: true, text: "" }
  }

  if (/^(?:[ivxlcdm]+|\([a-z]\))[\.\)]$/i.test(trimmed)) {
    return { level: 2, markerOnly: true, text: "" }
  }

  return null
}

export function createListNode(item) {
  return {
    text: item.text,
    level: item.level,
    marker: item.marker ?? "",
    hasBullet: Boolean(item.hasBullet),
    children: [],
  }
}

export function toFlatListItem(parsed) {
  return {
    text: parsed.text,
    level: parsed.level,
    marker: parsed.marker,
    hasBullet: parsed.hasBullet,
  }
}

export function buildNestedListTree(flatItems) {
  const root = []
  const stack = [{ level: -1, children: root }]

  for (const item of flatItems) {
    const node = createListNode(item)

    while (stack.length > 1 && stack[stack.length - 1].level >= item.level) {
      stack.pop()
    }

    stack[stack.length - 1].children.push(node)
    stack.push({ level: item.level, children: node.children })
  }

  return root
}

export function flattenListTree(nodes, result = []) {
  for (const node of nodes) {
    result.push({
      text: node.text,
      level: node.level,
      marker: node.marker,
      hasBullet: node.hasBullet,
    })
    if (node.children.length > 0) {
      flattenListTree(node.children, result)
    }
  }
  return result
}

export function getListItemKind(node) {
  const marker = (node.marker ?? "").trim()

  if (!node.hasBullet && /^\d+[\.\)]$/.test(marker) && node.level === 0) {
    return "numbered"
  }

  if (!node.hasBullet && /^[a-z][\.\)]$/i.test(marker) && node.level === 1) {
    return "lettered"
  }

  return "bullet"
}

export function getMarkerNumber(node) {
  const marker = (node.marker ?? "").trim()
  const match = marker.match(/^(\d+)[\.\)]$/)
  if (!match) {
    return null
  }

  return Number.parseInt(match[1], 10)
}

export function getMarkerLetterPosition(node) {
  const marker = (node.marker ?? "").trim().toLowerCase()
  const match = marker.match(/^([a-z])[\.\)]$/)
  if (!match) {
    return null
  }

  return match[1].charCodeAt(0) - 96
}

export function stripMarkerPrefix(text, marker) {
  const trimmedMarker = marker.trim()
  const markerPrefix = `${trimmedMarker} `

  if (text.startsWith(markerPrefix)) {
    return text.slice(markerPrefix.length).trim()
  }

  if (text === trimmedMarker) {
    return ""
  }

  return text
}

export function getListItemDisplayText(node) {
  const kind = getListItemKind(node)
  const marker = (node.marker ?? "").trim()

  if (kind === "numbered" || kind === "lettered") {
    return stripMarkerPrefix(node.text, marker)
  }

  return node.text
}

export function listItemClassName(node) {
  const classes = ["book-page__list-item"]
  const kind = getListItemKind(node)

  if (kind === "numbered") {
    classes.push("book-page__list-item--numbered")
  } else if (kind === "lettered") {
    classes.push("book-page__list-item--lettered")
  } else {
    if (node.level === 1) {
      classes.push("book-page__list-item--level-1")
    } else if (node.level === 2) {
      classes.push("book-page__list-item--level-2")
    }

    if (!node.hasBullet) {
      classes.push("book-page__list-item--no-bullet")
    }
  }

  return classes.join(" ")
}

export function createListElement(kind) {
  if (kind === "numbered" || kind === "lettered") {
    const orderedList = document.createElement("ol")
    orderedList.className = "book-page__list"
    if (kind === "lettered") {
      orderedList.setAttribute("type", "a")
    }
    return orderedList
  }

  const unorderedList = document.createElement("ul")
  unorderedList.className = "book-page__list"
  return unorderedList
}


export function flattenListText(nodes = []) {
  return nodes.flatMap((node) => [node.text, ...flattenListText(node.children ?? [])])
}
