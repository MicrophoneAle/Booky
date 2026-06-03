import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import {
  buildChapterPageMap,
  buildFrontMatterPack,
  flattenDocument,
  groupFrontMatterPlacementUnits,
  inferBlockIsChapterStart,
  isChapterBoundaryText,
  isFrontMatterVisualType,
  isTitlePageVisualItems,
  resolveHeadingVisualType,
  shouldCenterTitlePage,
  isShortDialogueLine,
  proseShouldBeCentered,
} from "../utils/paginator"
import { FullscreenIcon } from "./FullscreenButton"
import "../pages/Reader.css"
import "./BookViewer.css"

const NAVBAR_HEIGHT_PX = 44
const PAGE_WIDTH_PX = 400
const PAGE_HEIGHT_PX = 600
const MOBILE_FULLSCREEN_PAGE_HEIGHT_PX = 780
const SPINE_PX = 1
const PAGE_FOOTER_RESERVE_PX = 20
const PAGE_NUMBER_RESERVED_PX = PAGE_FOOTER_RESERVE_PX
const BODY_DESCENDER_PAD_PX = 6
const PAGE_CONTENT_FIT_BUFFER_PX = 2
const PAGE_FIT_OVERFLOW_TOLERANCE_PX = 1
const MOBILE_BROWSER_UI_PX = 40
const MOBILE_PAGE_NUMBER_GAP_PX = 3
const MOBILE_PAGE_NUMBER_RESERVED_PX =
  PAGE_NUMBER_RESERVED_PX + MOBILE_BROWSER_UI_PX + MOBILE_PAGE_NUMBER_GAP_PX
const CONTENT_HEIGHT_SAFETY_BUFFER_PX = 0
const BODY_BOTTOM_PADDING_PX = 3
const TRIVIAL_LAST_PAGE_CHAR_LIMIT = 50

/**
 * Text area budget from typesetting: available height, line height, and max prose lines.
 */
function getPageTextCapacity(contentMaxHeight, font, line) {
  const lineHeightPx = font.body * line.body
  const reserved = BODY_DESCENDER_PAD_PX + PAGE_CONTENT_FIT_BUFFER_PX
  const usableHeight = Math.max(0, contentMaxHeight - reserved)
  const maxLines = Math.max(1, Math.floor(usableHeight / lineHeightPx))

  return {
    lineHeightPx,
    usableHeight,
    maxLines,
    fitHeight: usableHeight,
  }
}

function bodyContentFitsPage(bodyEl, fitHeight) {
  const limit = Math.floor(fitHeight) + PAGE_FIT_OVERFLOW_TOLERANCE_PX
  const lastChild = bodyEl.lastElementChild

  if (!lastChild) {
    return true
  }

  const bottom = lastChild.offsetTop + lastChild.offsetHeight
  return bottom <= limit
}

function getPageNumberReservedPx(isMobileViewport) {
  return isMobileViewport ? MOBILE_PAGE_NUMBER_RESERVED_PX : PAGE_NUMBER_RESERVED_PX
}

const DEFAULT_SETTINGS = {
  theme: "parchment",
  fontSize: "medium",
  fontStyle: "lora",
  lineSpacing: "normal",
  margins: "normal",
}

const FONT_SIZE_MAP = {
  small: { body: 9, heading: 13, title: 19 },
  medium: { body: 10, heading: 15, title: 22 },
  large: { body: 12, heading: 17, title: 24 },
  xlarge: { body: 14, heading: 19, title: 26 },
}

const FONT_FAMILY_MAP = {
  lora: { body: "'Lora', Georgia, serif", heading: "'EB Garamond', Georgia, serif" },
  garamond: { body: "'EB Garamond', Georgia, serif", heading: "'EB Garamond', Georgia, serif" },
  georgia: { body: "Georgia, serif", heading: "Georgia, serif" },
  palatino: { body: "'Palatino Linotype', Palatino, serif", heading: "'Palatino Linotype', Palatino, serif" },
}

const LINE_HEIGHT_MAP = {
  compact: { body: 1.1, heading: 1.1 },
  normal: { body: 1.15, heading: 1.2 },
  relaxed: { body: 1.4, heading: 1.3 },
  airy: { body: 1.65, heading: 1.4 },
}

const MARGIN_MAP = {
  none: "0px",
  narrow: "0.35rem",
  normal: "0.75rem",
  wide: "1.25rem",
}

function getPagePaddingStyle(marginSetting) {
  const pad = MARGIN_MAP[marginSetting ?? "normal"] ?? MARGIN_MAP.normal
  if (pad === "0px") {
    return { padding: 0 }
  }
  return {
    paddingTop: pad,
    paddingRight: pad,
    paddingLeft: pad,
    paddingBottom: 0,
  }
}

const IMPLIED_LIST_LINE_REGEX = /^(Add|Test|Explore|Verify|Ensure|Click)\b/i
const TRIVIAL_LIST_PAGE_CHAR_LIMIT = 30
const STANDALONE_URL_REGEX = /^https?:\/\/\S+$/i

const LEVEL_0_NUMBER_REGEX = /^(\d+[\.\)])\s*(.*)$/
const LEVEL_0_BULLET_REGEX = /^([•·])\s*(.*)$/
const LEVEL_1_LETTERED_REGEX = /^([a-z][\.\)])\s+(.+)$/i
const CHAPTER_LABEL_REGEX =
  /^(Chapter|Part|Section|Prologue|Epilogue)\s+(\d+|[IVXLCDM]+|[A-Za-z]+)$/i
const LEVEL_2_MARKER_REGEX = /^((?:[ivxlcdm]+|\([a-z]\))[\.\)])\s*(.*)$/i
const EMBEDDED_LIST_MARKER_REGEX = /\s+(\d+[\.\)]|[a-z][\.\)])\s+/gi
let listGroupCounter = 0

function isHeadingVisualItem(item) {
  // subtitle intentionally excluded
  return item?.type === "title" || item?.type === "heading" || item?.type === "chapter"
}

function isChapterBoundaryItem(item) {
  return (
    item?.type === "chapter" ||
    Boolean(item?.isChapterStart) ||
    isChapterBoundaryText(item?.text)
  )
}

function proseParagraphClassName(previousItem, proseItem = null) {
  const classes = ["book-page__text"]

  if (proseItem?.isContinuation) {
    classes.push("book-page__text--continuation")
  } else if (proseItem?.isIndented) {
    // default indent only
  } else {
    const noIndentAfter =
      isHeadingVisualItem(previousItem) ||
      previousItem?.type === "subtitle" ||
      previousItem?.type === "author"

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

function proseRunClassName(run) {
  const classes = []
  if (run?.bold) {
    classes.push("book-page__run--bold")
  }
  if (run?.italic) {
    classes.push("book-page__run--italic")
  }
  return classes.length > 0 ? classes.join(" ") : undefined
}

function renderProseContent(item, searchQuery, highlightTracker, activeSearchOccurrence) {
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

function isStandaloneUrl(text) {
  return STANDALONE_URL_REGEX.test(text.trim())
}

function isImpliedListLine(text) {
  return IMPLIED_LIST_LINE_REGEX.test(text.trim())
}

function isListMarkerLine(text, pendingListItems = []) {
  return (
    parseListLine(text, pendingListItems) !== null ||
    parseLoneMarker(text, pendingListItems) !== null
  )
}

function buildNumberedListText(marker, body) {
  const trimmedBody = body.trim()
  return trimmedBody ? `${marker} ${trimmedBody}`.replace(/\s+/g, " ").trim() : marker
}

function parseListLine(text, pendingListItems = []) {
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

function parseLoneMarker(text, pendingListItems = []) {
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

function createListNode(item) {
  return {
    text: item.text,
    level: item.level,
    marker: item.marker ?? "",
    hasBullet: Boolean(item.hasBullet),
    children: [],
  }
}

function toFlatListItem(parsed) {
  return {
    text: parsed.text,
    level: parsed.level,
    marker: parsed.marker,
    hasBullet: parsed.hasBullet,
  }
}

function buildNestedListTree(flatItems) {
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

function flattenListTree(nodes, result = []) {
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

function getListItemKind(node) {
  const marker = (node.marker ?? "").trim()

  if (!node.hasBullet && /^\d+[\.\)]$/.test(marker) && node.level === 0) {
    return "numbered"
  }

  if (!node.hasBullet && /^[a-z][\.\)]$/i.test(marker) && node.level === 1) {
    return "lettered"
  }

  return "bullet"
}

function getMarkerNumber(node) {
  const marker = (node.marker ?? "").trim()
  const match = marker.match(/^(\d+)[\.\)]$/)
  if (!match) {
    return null
  }

  return Number.parseInt(match[1], 10)
}

function getMarkerLetterPosition(node) {
  const marker = (node.marker ?? "").trim().toLowerCase()
  const match = marker.match(/^([a-z])[\.\)]$/)
  if (!match) {
    return null
  }

  return match[1].charCodeAt(0) - 96
}

function stripMarkerPrefix(text, marker) {
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

function getListItemDisplayText(node) {
  const kind = getListItemKind(node)
  const marker = (node.marker ?? "").trim()

  if (kind === "numbered" || kind === "lettered") {
    return stripMarkerPrefix(node.text, marker)
  }

  return node.text
}

function listItemClassName(node) {
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

function createListElement(kind) {
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

function getLayoutHeights(
  pageHeightOverride,
  marginSetting,
  pageNumberReservedPx = PAGE_NUMBER_RESERVED_PX
) {
  const remPx =
    parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const rawMargin = MARGIN_MAP[marginSetting ?? "normal"] ?? MARGIN_MAP.normal
  const marginPx = rawMargin === "0px" ? 0 : parseFloat(rawMargin) * remPx
  const pageHeight = pageHeightOverride ?? PAGE_HEIGHT_PX
  const contentMaxHeight =
    pageHeight -
    marginPx -
    pageNumberReservedPx -
    BODY_BOTTOM_PADDING_PX -
    CONTENT_HEIGHT_SAFETY_BUFFER_PX

  return { pageOuterHeight: pageHeight, contentMaxHeight }
}

function createMeasureElements() {
  const root = document.createElement("div")
  root.className = "book-viewer__measure"

  const page = document.createElement("div")
  page.className = "book-page"
  page.style.overflow = "visible"
  page.style.height = "auto"

  const body = document.createElement("div")
  body.className = "book-page__body"
  body.style.flex = "1 1 auto"
  body.style.minHeight = "0"
  body.style.height = "auto"
  body.style.boxSizing = "border-box"

  const footer = document.createElement("div")
  footer.className = "book-viewer__measure-footer"
  footer.setAttribute("aria-hidden", "true")

  page.appendChild(body)
  page.appendChild(footer)
  root.appendChild(page)
  document.body.appendChild(root)

  return { root, page, body, footer }
}

function splitTextAtEmbeddedListMarkers(text) {
  const trimmed = text.trim()
  if (!trimmed) {
    return []
  }

  const regex = new RegExp(EMBEDDED_LIST_MARKER_REGEX.source, "gi")
  let match = null
  let firstSplitIndex = -1

  while ((match = regex.exec(trimmed)) !== null) {
    if (match.index > 0) {
      firstSplitIndex = match.index
      break
    }
  }

  if (firstSplitIndex < 0) {
    return [trimmed]
  }

  const left = trimmed.slice(0, firstSplitIndex).trim()
  const right = trimmed.slice(firstSplitIndex).trim()

  return [
    ...splitTextAtEmbeddedListMarkers(left),
    ...splitTextAtEmbeddedListMarkers(right),
  ].filter(Boolean)
}

function expandBlocksForEmbeddedListMarkers(blocks) {
  const expanded = []

  for (const block of blocks) {
    const text = (block.text ?? "").trim()

    if (block.isHeading || !text) {
      expanded.push(block)
      continue
    }

    const segments = splitTextAtEmbeddedListMarkers(text)

    if (segments.length <= 1) {
      expanded.push(block)
      continue
    }

    for (const segment of segments) {
      expanded.push({ ...block, text: segment })
    }
  }

  return expanded
}

/**
 * Stage 1 (client): turn flat API blocks into grouped visual layout items.
 */
function groupBlocksForDisplay(blocks) {
  const expandedBlocks = expandBlocksForEmbeddedListMarkers(blocks)
  const visualItems = []

  const shouldMergeWithPreviousProse = (newText, isIndented = false, formatting = {}) => {
    if (isIndented) return false
    if (proseShouldBeCentered({ textAlign: formatting.textAlign, text: newText })) {
      return false
    }

    const last = visualItems[visualItems.length - 1]
    if (!last || last.type !== "prose") return false
    if (proseShouldBeCentered(last)) return false
    if (last.bold || last.italic || (last.runs?.length ?? 0) > 1) return false

    const prev = last.text
    const startsLowercase = /^[a-z]/.test(newText)
    const prevEndsWithContinuation = /[,;—–-]$/.test(prev.trim())
    const prevLacksTerminator = !/[.!?"'\)»]$/.test(prev.trim())

    return startsLowercase || prevEndsWithContinuation || prevLacksTerminator
  }

  const pushProse = (proseText, formatting = {}) => {
    const trimmed = proseText.trim()
    if (!trimmed) return

    const isIndented = Boolean(formatting.isIndented)
    const hasDistinctFormatting =
      proseShouldBeCentered({ textAlign: formatting.textAlign, text: trimmed }) ||
      formatting.bold ||
      formatting.italic ||
      (formatting.runs?.length ?? 0) > 1

    if (
      !hasDistinctFormatting &&
      shouldMergeWithPreviousProse(trimmed, isIndented, formatting)
    ) {
      const last = visualItems[visualItems.length - 1]
      last.text = (last.text + " " + trimmed).replace(/\s+/g, " ").trim()
    } else {
      visualItems.push({
        type: "prose",
        text: trimmed,
        ...(isIndented ? { isIndented: true } : {}),
        ...(proseShouldBeCentered({ textAlign: formatting.textAlign, text: trimmed })
          ? { textAlign: "center" }
          : {}),
        ...(formatting.bold ? { bold: true } : {}),
        ...(formatting.italic ? { italic: true } : {}),
        ...(formatting.runs?.length ? { runs: formatting.runs } : {}),
      })
    }
  }

  for (let index = 0; index < expandedBlocks.length; index += 1) {
    const block = expandedBlocks[index]
    const text = (block.text ?? "").trim()

    if (!text) {
      continue
    }

    if (block.isHeading) {
      const headingFontSize = block.fontSize ?? 16
      const isChapterStart = inferBlockIsChapterStart(block)
      let headingText = text
      const nextBlock = expandedBlocks[index + 1]
      const nextText = (nextBlock?.text ?? "").trim()

      if (
        !isChapterStart &&
        !isChapterBoundaryText(text) &&
        !isChapterBoundaryText(nextText)
      ) {
        const headingType = resolveHeadingVisualType(headingFontSize, text)
        const nextLooksLikeSplitLabel =
          nextBlock?.isHeading &&
          nextText &&
          (/^chapter$/i.test(text) && /^(\d+|[ivxlcdm]+|one|two|three|four|five|six)$/i.test(nextText))

        if (
          (headingType === "heading" || headingType === "title") &&
          nextBlock?.isHeading &&
          nextText &&
          (CHAPTER_LABEL_REGEX.test(text) || nextLooksLikeSplitLabel)
        ) {
          headingText = nextLooksLikeSplitLabel
            ? `${text} ${nextText}`
            : `${text}: ${nextText}`
          index += 1
        }
      }

      const itemType = isChapterStart
        ? "chapter"
        : resolveHeadingVisualType(headingFontSize, headingText)

      visualItems.push({
        type: itemType,
        text: headingText,
        fontSize: headingFontSize,
        chapterId: block.chapterId ?? null,
        chapterTitle: block.chapterTitle ?? headingText,
        isChapterStart,
      })
      continue
    }

    if (isStandaloneUrl(text)) {
      pushProse(text)
      continue
    }

    const formatting = {
      isIndented: Boolean(block.isIndented),
      textAlign: block.textAlign,
      bold: block.bold,
      italic: block.italic,
      runs: block.runs,
    }
    if (isShortDialogueLine(text)) {
      formatting.textAlign = undefined
    }
    pushProse(text, formatting)
  }

  return visualItems
}

function appendSingleListNode(listEl, node) {
  const listEntry = document.createElement("li")
  listEntry.className = listItemClassName(node)
  listEntry.textContent = getListItemDisplayText(node)

  const markerNumber = getMarkerNumber(node)
  if (markerNumber !== null) {
    listEntry.value = markerNumber
  }

  if (node.children.length > 0) {
    appendGroupedListNodes(listEntry, node.children)
  }

  listEl.appendChild(listEntry)
}

function appendGroupedListNodes(parentEl, nodes) {
  let index = 0

  while (index < nodes.length) {
    const kind = getListItemKind(nodes[index])
    const listEl = createListElement(kind)
    const firstNode = nodes[index]

    if (kind === "lettered") {
      const letterStart = getMarkerLetterPosition(firstNode)
      if (letterStart !== null) {
        listEl.setAttribute("start", String(letterStart))
      }
    }

    while (index < nodes.length && getListItemKind(nodes[index]) === kind) {
      appendSingleListNode(listEl, nodes[index])
      index += 1
    }

    parentEl.appendChild(listEl)
  }
}

function appendVisualItem(body, item, previousItem = null) {
  if (item.type === "title") {
    const title = document.createElement("h1")
    title.className = "book-page__title"
    title.textContent = item.text
    body.appendChild(title)
    return
  }

  if (item.type === "heading") {
    const heading = document.createElement("h2")
    heading.className = "book-page__heading"
    heading.textContent = item.text
    body.appendChild(heading)
    return
  }

  if (item.type === "chapter") {
    const chapterHeading = document.createElement("h2")
    chapterHeading.className = "book-page__chapter-heading"
    chapterHeading.textContent = item.text
    body.appendChild(chapterHeading)
    return
  }

  if (item.type === "subtitle") {
    const subtitle = document.createElement("p")
    subtitle.className = "book-page__subtitle"
    subtitle.textContent = item.text
    body.appendChild(subtitle)
    return
  }

  if (item.type === "author") {
    const author = document.createElement("p")
    author.className = "book-page__author"
    author.textContent = item.text
    body.appendChild(author)
    return
  }

  if (item.type === "list") {
    appendGroupedListNodes(body, item.items)
    return
  }

  if (item.type === "prose") {
    const paragraph = document.createElement("p")
    paragraph.className = proseParagraphClassName(previousItem, item)

    if (item.runs?.length > 1) {
      for (const [runIndex, run] of item.runs.entries()) {
        if (runIndex > 0) {
          paragraph.appendChild(document.createTextNode(" "))
        }
        const span = document.createElement("span")
        const runClass = proseRunClassName(run)
        if (runClass) {
          span.className = runClass
        }
        span.textContent = run.text
        paragraph.appendChild(span)
      }
    } else {
      paragraph.textContent = item.text
    }

    body.appendChild(paragraph)
  }
}

function renderMeasureBody(body, visualItems, { centerTitlePage = false } = {}) {
  body.replaceChildren()
  body.className = centerTitlePage
    ? "book-page__body book-page__body--title-spread"
    : "book-page__body book-page__body--measure"

  for (let index = 0; index < visualItems.length; index += 1) {
    appendVisualItem(body, visualItems[index], visualItems[index - 1])
  }
}

function applyChapterContextFromItem(item, chapterState) {
  if (item.type !== "title" && item.type !== "heading" && item.type !== "chapter") {
    return
  }

  if (isChapterBoundaryItem(item) || item.type === "title") {
    chapterState.pageChapterTitle = item.chapterTitle ?? item.text
    chapterState.pageIsChapterStart = true
    return
  }

  if (!chapterState.pageChapterTitle) {
    chapterState.pageChapterTitle = item.chapterTitle ?? item.text
  }
}

function pageContentOverflows(bodyEl, fitHeight) {
  return !bodyContentFitsPage(bodyEl, fitHeight)
}

function countListItemsInTree(nodes) {
  let count = 0

  for (const node of nodes) {
    count += 1
    if (node.children.length > 0) {
      count += countListItemsInTree(node.children)
    }
  }

  return count
}

function getListTextLength(nodes) {
  return flattenListTree(nodes).reduce((total, item) => total + item.text.length, 0)
}

function isTrivialListPage(page) {
  if (page.visualItems.length !== 1) {
    return false
  }

  const onlyItem = page.visualItems[0]
  if (onlyItem.type !== "list") {
    return false
  }

  const itemCount = countListItemsInTree(onlyItem.items)
  const textLength = getListTextLength(onlyItem.items)

  return itemCount <= 1 && textLength < TRIVIAL_LIST_PAGE_CHAR_LIMIT
}

function cleanupPages(pages, bodyEl, pageLayout) {
  let cleaned = pages.filter(
    (page) => page.visualItems.length > 0 && !isTrivialListPage(page)
  )

  if (cleaned.length >= 2) {
    const lastPage = cleaned[cleaned.length - 1]
    const previousPage = cleaned[cleaned.length - 2]

    if (lastPage.visualItems.length === 1) {
      const onlyItem = lastPage.visualItems[0]

      if (onlyItem.type === "prose" && onlyItem.text.length < TRIVIAL_LAST_PAGE_CHAR_LIMIT) {
        const mergedItems = [...previousPage.visualItems, ...lastPage.visualItems]
        renderMeasureBody(bodyEl, mergedItems)

        const { fitHeight } = getPageTextCapacity(
          pageLayout.contentMaxHeight,
          pageLayout.font,
          pageLayout.line
        )

        if (!pageContentOverflows(bodyEl, fitHeight)) {
          previousPage.visualItems = mergedItems
          cleaned = cleaned.slice(0, -1)
        }
      }
    }
  }

  return cleaned.map((page, index) => ({
    ...page,
    pageNumber: index + 1,
  }))
}

/**
 * Stage 3: paginate pre-grouped visual items so measurement matches rendered DOM.
 */
function flattenVisualItemsToPlaceables(visualItems) {
  listGroupCounter = 0
  const placeables = []

  for (const item of visualItems) {
    if (item.type === "list") {
      const listGroupId = `list-${(listGroupCounter += 1)}`
      const flatNodes = flattenListTree(item.items)

      for (const node of flatNodes) {
        placeables.push({
          type: "list-item",
          text: node.text,
          level: node.level,
          marker: node.marker ?? "",
          hasBullet: node.hasBullet,
          listKind: getListItemKind(node),
          listGroupId,
          children: node.children ?? [],
        })
      }
      continue
    }

    placeables.push({
      type: item.type,
      item,
    })
  }

  return placeables
}

function placeablesToVisualItems(placeables) {
  const visualItems = []
  let index = 0

  while (index < placeables.length) {
    const placeable = placeables[index]

    if (placeable.type === "list-item") {
      const listGroupId = placeable.listGroupId
      const group = []

      while (
        index < placeables.length &&
        placeables[index].type === "list-item" &&
        placeables[index].listGroupId === listGroupId
      ) {
        group.push(placeables[index])
        index += 1
      }

      const flatNodes = group.map((entry) => ({
        text: entry.text,
        level: entry.level,
        marker: entry.marker,
        hasBullet: entry.hasBullet,
        children: entry.children ?? [],
      }))

      visualItems.push({
        type: "list",
        items: buildNestedListTree(flatNodes),
      })
      continue
    }

    visualItems.push(placeable.item)
    index += 1
  }

  return visualItems
}

function isHeadingPlaceable(placeable) {
  return (
    placeable.type === "title" ||
    placeable.type === "heading" ||
    placeable.type === "chapter"
  )
}

function isChapterBoundaryPlaceable(placeable) {
  return (
    placeable.type === "chapter" || Boolean(placeable.item?.isChapterStart)
  )
}

function isFrontMatterPlaceable(placeable) {
  return isFrontMatterVisualType(placeable.item?.type ?? placeable.type)
}

function pageOnlyFrontMatter(placeables) {
  const items = placeablesToVisualItems(placeables)
  return isTitlePageVisualItems(items)
}

function getChapterItemFromPlaceable(placeable) {
  if (isHeadingPlaceable(placeable)) {
    return placeable.item
  }

  return null
}

function proseFormattingFields(proseItem) {
  return {
    ...(proseItem.isIndented ? { isIndented: true } : {}),
    ...(proseItem.isContinuation ? { isContinuation: true } : {}),
    ...(proseShouldBeCentered(proseItem) ? { textAlign: "center" } : {}),
    ...(proseItem.bold ? { bold: true } : {}),
    ...(proseItem.italic ? { italic: true } : {}),
    ...(proseItem.runs?.length ? { runs: proseItem.runs } : {}),
  }
}

function prosePlaceableFromItem(proseItem) {
  return { type: "prose", item: proseItem }
}

function pagePlaceablesFit(bodyEl, pagePlaceables, pageLayout) {
  const trialVisualItems = placeablesToVisualItems(pagePlaceables)
  renderMeasureBody(bodyEl, trialVisualItems, {
    centerTitlePage: shouldCenterTitlePage(trialVisualItems),
  })
  const { fitHeight } = getPageTextCapacity(
    pageLayout.contentMaxHeight,
    pageLayout.font,
    pageLayout.line
  )
  return bodyContentFitsPage(bodyEl, fitHeight)
}

function splitProseAcrossPages(proseItem, bodyEl, pageLayout, alreadyOnPage) {
  if (proseShouldBeCentered(proseItem)) {
    return null
  }

  const words = (proseItem.text ?? "").trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return null
  }

  if (words.length > 500) {
    console.warn(
      `splitProseAcrossPages: prose block has ${words.length} words — possible runaway merge`
    )
  }

  const singleWordItem = {
    type: "prose",
    text: words[0],
    ...proseFormattingFields(proseItem),
  }

  if (
    !pagePlaceablesFit(bodyEl, [prosePlaceableFromItem(singleWordItem)], pageLayout)
  ) {
    return null
  }

  let low = 1
  let high = words.length
  let best = 0

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const fittingItem = {
      type: "prose",
      text: words.slice(0, mid).join(" "),
      ...proseFormattingFields(proseItem),
    }
    const trialPlaceables = [...alreadyOnPage, prosePlaceableFromItem(fittingItem)]

    if (pagePlaceablesFit(bodyEl, trialPlaceables, pageLayout)) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  if (best === 0 || best >= words.length) {
    return null
  }

  return {
    fitting: {
      type: "prose",
      text: words.slice(0, best).join(" "),
      ...proseFormattingFields(proseItem),
    },
    overflow: {
      type: "prose",
      text: words.slice(best).join(" "),
      ...proseFormattingFields({ ...proseItem, isContinuation: true }),
    },
  }
}

function paginateBlocksByDom(flatBlocks, bodyEl, pageLayout) {
  const { contentMaxHeight } = pageLayout
  const visualItems = groupBlocksForDisplay(flatBlocks)
  const placeables = flattenVisualItemsToPlaceables(visualItems)
  const pages = []
  let currentPagePlaceables = []
  let currentActiveChapter = null
  let chapterAtPageStart = null
  const chapterState = {
    pageChapterTitle: null,
    pageIsChapterStart: false,
  }

  const updateCurrentActiveChapter = (item) => {
    if (!isHeadingVisualItem(item)) {
      return
    }

    if (isChapterBoundaryItem(item) || item.type === "title") {
      currentActiveChapter = item.chapterTitle ?? item.text
      return
    }

    if (!currentActiveChapter) {
      currentActiveChapter = item.chapterTitle ?? item.text
    }
  }

  const buildChaptersOnPage = (pageItems) => {
    const chaptersOnPage = []

    if (chapterAtPageStart) {
      chaptersOnPage.push(chapterAtPageStart)
    }

    for (const pageItem of pageItems) {
      if (
        isHeadingVisualItem(pageItem) &&
        (isChapterBoundaryItem(pageItem) || pageItem.type === "title")
      ) {
        const title = pageItem.chapterTitle ?? pageItem.text
        if (title && !chaptersOnPage.includes(title)) {
          chaptersOnPage.push(title)
        }
      }
    }

    if (chaptersOnPage.length === 0 && currentActiveChapter) {
      chaptersOnPage.push(currentActiveChapter)
    }

    return chaptersOnPage
  }

  const markPageStartIfEmpty = () => {
    if (currentPagePlaceables.length === 0) {
      chapterAtPageStart = currentActiveChapter
    }
  }

  const pageItemsFit = (pageItems) => {
    renderMeasureBody(bodyEl, pageItems, {
      centerTitlePage: shouldCenterTitlePage(pageItems),
    })
    const { fitHeight } = getPageTextCapacity(
      contentMaxHeight,
      pageLayout.font,
      pageLayout.line
    )
    return bodyContentFitsPage(bodyEl, fitHeight)
  }

  const flushPage = () => {
    if (currentPagePlaceables.length === 0) {
      return
    }

    const pageVisualItems = placeablesToVisualItems(currentPagePlaceables)

    pages.push({
      pageNumber: pages.length + 1,
      visualItems: pageVisualItems,
      chapterTitle: chapterState.pageChapterTitle,
      activeChapterTitle: currentActiveChapter,
      chaptersOnPage: buildChaptersOnPage(pageVisualItems),
      isChapterStart: chapterState.pageIsChapterStart,
      isTitlePage: isTitlePageVisualItems(pageVisualItems),
      centerTitlePage: shouldCenterTitlePage(pageVisualItems),
    })

    currentPagePlaceables = []
    chapterAtPageStart = null
    chapterState.pageChapterTitle = null
    chapterState.pageIsChapterStart = false
  }

  const tryAddPlaceables = (toAdd) => {
    const trialPlaceables = [...currentPagePlaceables, ...toAdd]
    const trialVisualItems = placeablesToVisualItems(trialPlaceables)

    if (!pageItemsFit(trialVisualItems)) {
      return false
    }

    for (const placeable of toAdd) {
      const chapterItem = getChapterItemFromPlaceable(placeable)
      if (chapterItem) {
        applyChapterContextFromItem(chapterItem, chapterState)
        updateCurrentActiveChapter(chapterItem)
      }
    }

    if (currentPagePlaceables.length === 0) {
      markPageStartIfEmpty()
    }

    currentPagePlaceables = trialPlaceables
    return true
  }

  const placePlaceable = (placeable) => {
    const chapterItem = getChapterItemFromPlaceable(placeable)
    if (chapterItem) {
      applyChapterContextFromItem(chapterItem, chapterState)
      updateCurrentActiveChapter(chapterItem)
    }

    if (tryAddPlaceables([placeable])) {
      return
    }

    if (currentPagePlaceables.length > 0 && placeable.type === "prose" && placeable.item) {
      const split = splitProseAcrossPages(
        placeable.item,
        bodyEl,
        pageLayout,
        currentPagePlaceables
      )

      if (split) {
        const fittingPlaceable = prosePlaceableFromItem(split.fitting)

        if (tryAddPlaceables([fittingPlaceable])) {
          flushPage()
          markPageStartIfEmpty()
          placePlaceable(prosePlaceableFromItem(split.overflow))
          return
        }
      }
    }

    if (currentPagePlaceables.length > 0) {
      flushPage()
    }

    markPageStartIfEmpty()

    if (chapterItem) {
      applyChapterContextFromItem(chapterItem, chapterState)
      updateCurrentActiveChapter(chapterItem)
    }

    currentPagePlaceables = [placeable]
  }

  const placeHeadingWithFollowing = (heading, following) => {
    if (tryAddPlaceables([heading, following])) {
      return
    }

    if (currentPagePlaceables.length > 0) {
      flushPage()
    }

    markPageStartIfEmpty()

    if (tryAddPlaceables([heading, following])) {
      return
    }

    placePlaceable(heading)
    placePlaceable(following)
  }

  const ensureChapterStartsOnNewPage = (placeable) => {
    if (isFrontMatterPlaceable(placeable)) {
      return
    }

    if (!isChapterBoundaryPlaceable(placeable)) {
      return
    }

    if (currentPagePlaceables.length > 0) {
      flushPage()
    }

    markPageStartIfEmpty()
  }

  const placeFrontMatterPack = (pack) => {
    if (pack.length === 0) {
      return
    }

    const placeEntirePack = () => tryAddPlaceables(pack)

    if (placeEntirePack()) {
      return
    }

    if (currentPagePlaceables.length > 0) {
      flushPage()
    }

    markPageStartIfEmpty()

    if (placeEntirePack()) {
      return
    }

    const units = groupFrontMatterPlacementUnits(pack)

    for (const unit of units) {
      if (currentPagePlaceables.length > 0) {
        flushPage()
      }

      markPageStartIfEmpty()

      if (tryAddPlaceables(unit)) {
        continue
      }

      let batch = []
      for (const placeable of unit) {
        const trial = [...batch, placeable]
        if (
          pagePlaceablesFit(bodyEl, trial, pageLayout)
        ) {
          batch = trial
          continue
        }

        if (batch.length > 0) {
          tryAddPlaceables(batch)
          flushPage()
          markPageStartIfEmpty()
          batch = []
        }

        if (!tryAddPlaceables([placeable])) {
          flushPage()
          markPageStartIfEmpty()
          currentPagePlaceables = [placeable]
          const chapterItem = getChapterItemFromPlaceable(placeable)
          if (chapterItem) {
            applyChapterContextFromItem(chapterItem, chapterState)
            updateCurrentActiveChapter(chapterItem)
          }
        }
      }

      if (batch.length > 0) {
        tryAddPlaceables(batch)
      }
    }
  }

  const { frontMatterPack, remainder } = buildFrontMatterPack(placeables)

  placeFrontMatterPack(frontMatterPack)

  if (currentPagePlaceables.length > 0) {
    flushPage()
  }

  for (let placeableIndex = 0; placeableIndex < remainder.length; placeableIndex += 1) {
    const placeable = remainder[placeableIndex]

    if (isChapterBoundaryPlaceable(placeable)) {
      ensureChapterStartsOnNewPage(placeable)
      const followingPlaceable = remainder[placeableIndex + 1]

      if (
        followingPlaceable &&
        !isChapterBoundaryPlaceable(followingPlaceable) &&
        !isFrontMatterPlaceable(followingPlaceable)
      ) {
        placeHeadingWithFollowing(placeable, followingPlaceable)
        placeableIndex += 1
        continue
      }

      placePlaceable(placeable)
      continue
    }

    ensureChapterStartsOnNewPage(placeable)

    if (isFrontMatterPlaceable(placeable)) {
      const run = [placeable]
      while (
        placeableIndex + 1 < remainder.length &&
        isFrontMatterPlaceable(remainder[placeableIndex + 1])
      ) {
        placeableIndex += 1
        run.push(remainder[placeableIndex])
      }

      if (!tryAddPlaceables(run)) {
        for (const runPlaceable of run) {
          placePlaceable(runPlaceable)
        }
      }
      continue
    }

    if (isHeadingPlaceable(placeable)) {
      const followingPlaceable = remainder[placeableIndex + 1]

      if (
        followingPlaceable &&
        !isHeadingPlaceable(followingPlaceable) &&
        !isFrontMatterPlaceable(followingPlaceable)
      ) {
        placeHeadingWithFollowing(placeable, followingPlaceable)
        placeableIndex += 1
        continue
      }
    }

    placePlaceable(placeable)
  }

  if (currentPagePlaceables.length > 0) {
    flushPage()
  }

  return cleanupPages(pages, bodyEl, pageLayout)
}

function renderListNodeReact(
  node,
  itemKey,
  highlightQuery = "",
  highlightTracker = null,
  activeOccurrence = null
) {
  const markerNumber = getMarkerNumber(node)

  return (
    <li
      key={itemKey}
      className={listItemClassName(node)}
      {...(markerNumber !== null ? { value: markerNumber } : {})}
    >
      {highlightTextContent(
        getListItemDisplayText(node),
        highlightQuery,
        highlightTracker,
        activeOccurrence
      )}
      {node.children.length > 0 &&
        renderGroupedListItemsReact(
          node.children,
          itemKey,
          highlightQuery,
          highlightTracker,
          activeOccurrence
        )}
    </li>
  )
}

function renderGroupedListItemsReact(
  nodes,
  keyPrefix,
  highlightQuery = "",
  highlightTracker = null,
  activeOccurrence = null
) {
  const elements = []
  let index = 0
  let groupIndex = 0

  while (index < nodes.length) {
    const kind = getListItemKind(nodes[index])
    const groupNodes = []

    while (index < nodes.length && getListItemKind(nodes[index]) === kind) {
      groupNodes.push(nodes[index])
      index += 1
    }

    const listKey = `${keyPrefix}-g${groupIndex}`
    groupIndex += 1

    if (kind === "numbered" || kind === "lettered") {
      const listStart =
        kind === "lettered"
          ? getMarkerLetterPosition(groupNodes[0])
          : getMarkerNumber(groupNodes[0])

      elements.push(
        <ol
          key={listKey}
          className="book-page__list"
          {...(kind === "lettered" ? { type: "a" } : {})}
          {...(listStart !== null ? { start: listStart } : {})}
        >
          {groupNodes.map((node, nodeIndex) =>
            renderListNodeReact(
              node,
              `${listKey}-${nodeIndex}`,
              highlightQuery,
              highlightTracker,
              activeOccurrence
            )
          )}
        </ol>
      )
    } else {
      elements.push(
        <ul key={listKey} className="book-page__list">
          {groupNodes.map((node, nodeIndex) =>
            renderListNodeReact(
              node,
              `${listKey}-${nodeIndex}`,
              highlightQuery,
              highlightTracker,
              activeOccurrence
            )
          )}
        </ul>
      )
    }
  }

  return elements
}

function highlightTextContent(text, query, tracker = null, activeOccurrence = null) {
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

function BookPageContent({
  page,
  isMobileFullscreen = false,
  settings,
  searchQuery = "",
  activeSearchOccurrence = null,
}) {
  const themeId = settings?.theme ?? DEFAULT_SETTINGS.theme
  const pageClassName = [
    "book-page",
    `book-page--theme-${themeId}`,
    isMobileFullscreen ? "book-page--mobile-fs" : "",
  ]
    .filter(Boolean)
    .join(" ")

  const pageStyle = {
    ...getPagePaddingStyle(settings?.margins ?? DEFAULT_SETTINGS.margins),
    "--page-footer-reserve": `${PAGE_FOOTER_RESERVE_PX}px`,
  }

  if (!page) {
    return <div className={`${pageClassName} book-page--empty`} style={pageStyle} />
  }

  const visualItems = page.visualItems ?? []
  const highlightTracker = { count: 0 }

  return (
    <div className={pageClassName} style={pageStyle}>
      <div
        className={
          page.centerTitlePage
            ? "book-page__body book-page__body--title-spread"
            : "book-page__body"
        }
      >
        {visualItems.map((item, index) => {
          if (item.type === "title") {
            return (
              <h1 key={index} className="book-page__title">
                {highlightTextContent(
                  item.text,
                  searchQuery,
                  highlightTracker,
                  activeSearchOccurrence
                )}
              </h1>
            )
          }

          if (item.type === "heading") {
            return (
              <h2 key={index} className="book-page__heading">
                {highlightTextContent(
                  item.text,
                  searchQuery,
                  highlightTracker,
                  activeSearchOccurrence
                )}
              </h2>
            )
          }

          if (item.type === "chapter") {
            return (
              <h2 key={index} className="book-page__chapter-heading">
                {highlightTextContent(
                  item.text,
                  searchQuery,
                  highlightTracker,
                  activeSearchOccurrence
                )}
              </h2>
            )
          }

          if (item.type === "subtitle") {
            return (
              <p key={index} className="book-page__subtitle">
                {highlightTextContent(
                  item.text,
                  searchQuery,
                  highlightTracker,
                  activeSearchOccurrence
                )}
              </p>
            )
          }

          if (item.type === "author") {
            return (
              <p key={index} className="book-page__author">
                {highlightTextContent(
                  item.text,
                  searchQuery,
                  highlightTracker,
                  activeSearchOccurrence
                )}
              </p>
            )
          }

          if (item.type === "list") {
            return (
              <Fragment key={index}>
                {renderGroupedListItemsReact(
                  item.items,
                  `list-${index}`,
                  searchQuery,
                  highlightTracker,
                  activeSearchOccurrence
                )}
              </Fragment>
            )
          }

          const previousItem = index > 0 ? visualItems[index - 1] : null

          return (
            <p key={index} className={proseParagraphClassName(previousItem, item)}>
              {renderProseContent(
                item,
                searchQuery,
                highlightTracker,
                activeSearchOccurrence
              )}
            </p>
          )
        })}
      </div>

      <p className="book-page__number">— {page.pageNumber} —</p>
    </div>
  )
}

function collectChapterTitlesForPage(page) {
  if (!page || page.isTitlePage) {
    return []
  }

  if (page.chaptersOnPage?.length > 0) {
    return page.chaptersOnPage
  }

  if (page.activeChapterTitle) {
    return [page.activeChapterTitle]
  }

  if (page.chapterTitle) {
    return [page.chapterTitle]
  }

  return []
}

function resolveNavChapterTitlesForPageIndex(pages, pageIndex) {
  for (let index = pageIndex; index >= 0; index -= 1) {
    const page = pages[index]
    if (!page || page.isTitlePage) {
      continue
    }

    const titles = collectChapterTitlesForPage(page)
    if (titles.length > 0) {
      return titles
    }
  }

  return []
}

function formatNavChapterTitle(pages, currentPage, isSpreadView) {
  const pageIndices = [currentPage - 1]

  if (isSpreadView && currentPage < pages.length) {
    pageIndices.push(currentPage)
  }

  const titles = []

  for (const pageIndex of pageIndices) {
    const pageTitles = resolveNavChapterTitlesForPageIndex(pages, pageIndex)

    for (const title of pageTitles) {
      if (title && !titles.includes(title)) {
        titles.push(title)
      }
    }
  }

  const result = titles.join(" · ").trim()
  if (!result) {
    return ""
  }
  if (/^(and|or|but|the|a|an)$/i.test(result)) {
    return ""
  }

  return result
}

function PageCounterControl({
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

function LayoutModeIcon({ isSpreadView }) {
  if (isSpreadView) {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="8" height="16" rx="1" />
        <rect x="13" y="4" width="8" height="16" rx="1" />
      </svg>
    )
  }

  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="6" y="4" width="12" height="16" rx="1" />
    </svg>
  )
}

function NibIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2 L20 10 L12 22 L4 10 Z" />
      <path d="M12 22 L12 14" />
      <path d="M8 12 L12 14 L16 12" />
      <path d="M12 2 L12 8" />
    </svg>
  )
}

function TocIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="14" y2="18" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function flattenListText(nodes = []) {
  return nodes.flatMap((node) => [node.text, ...flattenListText(node.children ?? [])])
}

export default function BookViewer({
  document: bookDocument,
  initialPage = 1,
  onPageChange,
}) {
  const navigate = useNavigate()
  const progressKey = `booky-progress-${bookDocument?.id ?? ""}`
  const [pages, setPages] = useState([])
  const [isPaginating, setIsPaginating] = useState(true)
  const [currentPage, setCurrentPage] = useState(1)
  const [isMobile, setIsMobile] = useState(false)
  const [layoutMode, setLayoutMode] = useState("spread")
  const [isMobileFullscreen, setIsMobileFullscreen] = useState(false)
  const [showFsTip, setShowFsTip] = useState(false)
  const stageRef = useRef(null)
  const tapCountRef = useRef(0)
  const tapTimerRef = useRef(null)
  const [scale, setScale] = useState(1)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem("booky-settings")
      return saved
        ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) }
        : DEFAULT_SETTINGS
    } catch {
      return DEFAULT_SETTINGS
    }
  })

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tocOpen, setTocOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState([])
  const [searchResultIndex, setSearchResultIndex] = useState(0)
  const searchInputRef = useRef(null)
  const viewerRef = useRef(null)
  const [chapterPageMap, setChapterPageMap] = useState({})
  const [pageTextMap, setPageTextMap] = useState({})
  const [resumeToast, setResumeToast] = useState(null)
  const [toastFading, setToastFading] = useState(false)
  const [restoredPage, setRestoredPage] = useState(null)
  const [bookmarkPage, setBookmarkPage] = useState(null)
  const [bookmarkDismissed, setBookmarkDismissed] = useState(false)
  const [bookmarkHidden, setBookmarkHidden] = useState(false)
  const [bookmarkPosition, setBookmarkPosition] = useState(null)
  const leftPageFaceRef = useRef(null)
  const rightPageFaceRef = useRef(null)
  const bookmarkRef = useRef(null)
  const currentPageRef = useRef(currentPage)
  const hasShownResumeToastRef = useRef(false)
  const hasShownFsTipRef = useRef(false)

  const normalizeBookmarkPage = useCallback((page, total, desktopSpreadBehavior) => {
    if (!Number.isFinite(page)) return 1
    const clamped = Math.min(Math.max(1, Number(page)), Math.max(1, total))
    if (desktopSpreadBehavior && clamped % 2 === 0) return Math.max(1, clamped - 1)
    return clamped
  }, [])

  useEffect(() => {
    currentPageRef.current = currentPage
  }, [currentPage])

  useEffect(() => {
    try {
      localStorage.setItem("booky-settings", JSON.stringify(settings))
    } catch {
      // Ignore storage write errors (private mode, quota, etc.)
    }
  }, [settings])

  useEffect(() => {
    document.body.style.overflow = "hidden"
    document.documentElement.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = ""
      document.documentElement.style.overflow = ""
    }
  }, [])

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange)
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange)
  }, [])

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        const target = viewerRef.current ?? document.documentElement
        await target.requestFullscreen()
      }
    } catch {
      // Fullscreen may be blocked by the browser.
    }
  }, [])

  useEffect(() => {
    if (!bookDocument) {
      setPages([])
      setIsPaginating(false)
      return
    }

    let measureRoot = null
    let cancelled = false

    setIsPaginating(true)
    setPages([])

    const runMeasurement = () => {
      const flatBlocks = flattenDocument(bookDocument)
      const mobileFS = isMobile && isMobileFullscreen
      const pageHeightToUse = mobileFS ? MOBILE_FULLSCREEN_PAGE_HEIGHT_PX : undefined
      const pageNumberReservedPx = getPageNumberReservedPx(isMobile)
      const { pageOuterHeight, contentMaxHeight } = getLayoutHeights(
        pageHeightToUse,
        settings.margins,
        pageNumberReservedPx
      )
      const measureElements = createMeasureElements()

      measureRoot = measureElements.root
      measureElements.page.style.height = `${pageOuterHeight}px`
      measureElements.page.style.display = "flex"
      measureElements.page.style.flexDirection = "column"
      measureElements.page.style.boxSizing = "border-box"
      measureElements.page.style.setProperty(
        "--page-footer-reserve",
        `${PAGE_FOOTER_RESERVE_PX}px`
      )
      const pagePad = getPagePaddingStyle(settings.margins)
      measureElements.page.style.paddingTop = pagePad.paddingTop ?? "0"
      measureElements.page.style.paddingRight = pagePad.paddingRight ?? "0"
      measureElements.page.style.paddingLeft = pagePad.paddingLeft ?? "0"
      measureElements.page.style.paddingBottom = pagePad.paddingBottom ?? "0"
      measureElements.body.style.padding = "0"
      measureElements.body.style.paddingBottom = `${BODY_BOTTOM_PADDING_PX}px`
      measureElements.body.style.height = `${contentMaxHeight}px`
      measureElements.body.style.maxHeight = `${contentMaxHeight}px`
      measureElements.body.style.minHeight = `${contentMaxHeight}px`
      measureElements.body.style.overflow = "hidden"
      measureElements.footer.style.display = "none"

      const font = FONT_SIZE_MAP[settings.fontSize] ?? FONT_SIZE_MAP.medium
      const line = LINE_HEIGHT_MAP[settings.lineSpacing] ?? LINE_HEIGHT_MAP.normal
      const family = FONT_FAMILY_MAP[settings.fontStyle] ?? FONT_FAMILY_MAP.lora
      const pageLayout = {
        contentMaxHeight,
        font,
        line,
        ...getPageTextCapacity(contentMaxHeight, font, line),
      }

      measureElements.page.style.setProperty("--fs-body", `${font.body}px`)
      measureElements.page.style.setProperty("--fs-heading", `${font.heading}px`)
      measureElements.page.style.setProperty("--fs-title", `${font.title}px`)
      measureElements.page.style.setProperty("--ff-body", family.body)
      measureElements.page.style.setProperty("--ff-heading", family.heading)
      measureElements.page.style.setProperty("--lh-body", line.body)
      measureElements.page.style.setProperty("--lh-heading", line.heading)

      measureElements.page.classList.add(`book-page--theme-${settings.theme}`)

      const measuredPages = paginateBlocksByDom(
        flatBlocks,
        measureElements.body,
        pageLayout
      )

      measureRoot.remove()
      measureRoot = null

      if (!cancelled) {
        const totalMeasuredPages = measuredPages.length
        const chapterMap = buildChapterPageMap(
          measuredPages,
          bookDocument?.chapters ?? []
        )
        const textMap = {}

        for (const page of measuredPages) {
          const pageText = (page.visualItems ?? [])
            .map((item) => {
              if (
                item.type === "prose" ||
                item.type === "heading" ||
                item.type === "chapter" ||
                item.type === "title" ||
                item.type === "subtitle" ||
                item.type === "author"
              ) {
                return item.text
              }
              if (item.type === "list") {
                return flattenListText(item.items).join(" ")
              }
              return ""
            })
            .filter(Boolean)
            .join(" ")

          textMap[page.pageNumber] = pageText.toLowerCase()
        }

        setPages(measuredPages)
        setChapterPageMap(chapterMap)
        setPageTextMap(textMap)
        setCurrentPage((previousPage) => {
          const maxPage = Math.max(1, totalMeasuredPages)
          if (totalMeasuredPages === 0) return 1
          const target = bookmarkPage !== null && bookmarkPage !== undefined ? bookmarkPage : previousPage
          return normalizeBookmarkPage(target, maxPage, !isMobile)
        })
        if (!hasShownResumeToastRef.current && bookmarkPage && bookmarkPage > 1) {
          setRestoredPage(bookmarkPage)
          hasShownResumeToastRef.current = true
        }
        setIsPaginating(false)
      }
    }

    requestAnimationFrame(runMeasurement)

    return () => {
      cancelled = true
      measureRoot?.remove()
    }
  }, [
    bookDocument,
    initialPage,
    isMobileFullscreen,
    isMobile,
    settings,
    bookmarkPage,
    normalizeBookmarkPage,
  ])

  const activePageHeight =
    isMobile && isMobileFullscreen ? MOBILE_FULLSCREEN_PAGE_HEIGHT_PX : PAGE_HEIGHT_PX
  const mobileFullscreenActive = isMobile && isMobileFullscreen

  const isSpreadView = !isMobile && layoutMode === "spread"
  const totalPages = pages.length
  const pageStep = isSpreadView ? 2 : 1
  const maxPageIndex = Math.max(1, totalPages)

  const leftPage = pages[currentPage - 1] ?? null
  const rightPage = isSpreadView ? pages[currentPage] ?? null : null

  const font = FONT_SIZE_MAP[settings.fontSize] ?? FONT_SIZE_MAP.medium
  const family = FONT_FAMILY_MAP[settings.fontStyle] ?? FONT_FAMILY_MAP.lora
  const line = LINE_HEIGHT_MAP[settings.lineSpacing] ?? LINE_HEIGHT_MAP.normal

  const isFinalOddSpreadSingle =
    isSpreadView && totalPages % 2 === 1 && Boolean(leftPage) && !rightPage
  const showSpreadLayout = isSpreadView && !isFinalOddSpreadSingle
  const navChapterTitle = formatNavChapterTitle(pages, currentPage, showSpreadLayout)
  const progressPercent = totalPages > 0 ? (currentPage / totalPages) * 100 : 0

  const jumpToPage = useCallback(
    (rawPage) => {
      const parsed = Number.parseInt(String(rawPage).trim(), 10)
      if (!Number.isFinite(parsed)) {
        return
      }
      const target = normalizeBookmarkPage(parsed, totalPages, showSpreadLayout)
      setCurrentPage(target)
      onPageChange?.(target)
    },
    [normalizeBookmarkPage, onPageChange, showSpreadLayout, totalPages]
  )

  const activeChapterId = useMemo(() => {
    const entries = Object.entries(chapterPageMap)
      .map(([id, pg]) => ({ id, pg }))
      .sort((a, b) => a.pg - b.pg)

    let active = entries[0]?.id ?? null
    for (const entry of entries) {
      if (currentPage >= entry.pg) active = entry.id
    }
    return active
  }, [currentPage, chapterPageMap])

  useEffect(() => {
    const recomputeScale = () => {
      const stage = stageRef.current
      if (!stage) return
      const cs = getComputedStyle(stage)
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      const availW = stage.clientWidth - padX
      const availH = stage.clientHeight - padY
      const naturalW = showSpreadLayout
        ? PAGE_WIDTH_PX * 2 + SPINE_PX
        : PAGE_WIDTH_PX
      const naturalH = activePageHeight
      const fitScale = Math.min(availW / naturalW, availH / naturalH)
      const fillScale = Math.max(availW / naturalW, availH / naturalH)
      const next =
        isFullscreen || (isMobile && isMobileFullscreen) ? fillScale : fitScale
      setScale(next > 0 && Number.isFinite(next) ? next : 1)
    }

    recomputeScale()
    window.addEventListener("resize", recomputeScale)
    document.addEventListener("fullscreenchange", recomputeScale)
    return () => {
      window.removeEventListener("resize", recomputeScale)
      document.removeEventListener("fullscreenchange", recomputeScale)
    }
  }, [showSpreadLayout, isMobile, isMobileFullscreen, isFullscreen, activePageHeight, pages.length, isPaginating])

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)")
    const updateLayout = () => setIsMobile(mediaQuery.matches)

    updateLayout()
    mediaQuery.addEventListener("change", updateLayout)
    return () => mediaQuery.removeEventListener("change", updateLayout)
  }, [])

  useEffect(() => {
    if (!bookDocument?.id) return
    try {
      const saved = Number(localStorage.getItem(progressKey))
      if (Number.isFinite(saved) && saved > 0) {
        setBookmarkPage(saved)
      } else {
        setBookmarkPage(initialPage)
      }
    } catch {
      setBookmarkPage(initialPage)
    }
  }, [bookDocument?.id, initialPage, progressKey])

  useEffect(() => {
    if (isPaginating || totalPages === 0) return
    if (currentPage > maxPageIndex) {
      setCurrentPage(maxPageIndex)
    }
  }, [currentPage, maxPageIndex, isPaginating, totalPages])

  useEffect(() => {
    if (!isPaginating && pages.length > 0) {
      viewerRef.current?.focus({ preventScroll: true })
    }
  }, [isPaginating, pages.length])

  useEffect(() => {
    if (isMobile && isMobileFullscreen) {
      if (hasShownFsTipRef.current) return undefined
      hasShownFsTipRef.current = true
      setShowFsTip(true)
      const tipTimer = setTimeout(() => setShowFsTip(false), 2000)
      return () => clearTimeout(tipTimer)
    }
    setShowFsTip(false)
  }, [isMobile, isMobileFullscreen])

  useEffect(() => {
    return () => clearTimeout(tapTimerRef.current)
  }, [])

  const handleStageTap = useCallback(() => {
    if (!isMobile) return
    tapCountRef.current += 1
    clearTimeout(tapTimerRef.current)
    tapTimerRef.current = setTimeout(() => {
      if (tapCountRef.current >= 3) {
        setIsMobileFullscreen((previous) => !previous)
      }
      tapCountRef.current = 0
    }, 400)
  }, [isMobile])

  const toggleLayoutMode = useCallback(() => {
    setLayoutMode((mode) => (mode === "spread" ? "single" : "spread"))
  }, [])

  const canGoBack = currentPage - pageStep >= 1
  const canGoForward = currentPage + pageStep <= maxPageIndex

  const goBack = useCallback(() => {
    if (!canGoBack) return

    const nextPage = currentPage - pageStep
    setCurrentPage(nextPage)
    onPageChange?.(nextPage)
  }, [canGoBack, currentPage, onPageChange, pageStep])

  const goForward = useCallback(() => {
    if (!canGoForward) return

    const nextPage = currentPage + pageStep
    setCurrentPage(nextPage)
    onPageChange?.(nextPage)
  }, [canGoForward, currentPage, onPageChange, pageStep])

  const runSearch = useCallback(
    (query) => {
      if (!query.trim()) {
        setSearchResults([])
        setSearchResultIndex(0)
        return
      }

      const q = query.toLowerCase().trim()
      const results = []

      const escapedQuery = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const matcher = new RegExp(escapedQuery, "gi")

      for (const [pageNum, text] of Object.entries(pageTextMap)) {
        matcher.lastIndex = 0
        let match = matcher.exec(text)
        let occurrenceOnPage = 0

        while (match !== null) {
          occurrenceOnPage += 1
          results.push({
            pageNumber: Number(pageNum),
            occurrenceOnPage,
          })
          match = matcher.exec(text)
        }
      }

      results.sort((a, b) => a.pageNumber - b.pageNumber)
      setSearchResults(results)
      setSearchResultIndex(0)
      if (results.length > 0) {
        setCurrentPage(results[0].pageNumber)
        onPageChange?.(results[0].pageNumber)
      }
    },
    [pageTextMap, onPageChange]
  )

  const goToNextResult = useCallback(() => {
    if (searchResults.length === 0) return
    const next = (searchResultIndex + 1) % searchResults.length
    setSearchResultIndex(next)
    setCurrentPage(searchResults[next].pageNumber)
    onPageChange?.(searchResults[next].pageNumber)
  }, [searchResultIndex, searchResults, onPageChange])

  const goToPrevResult = useCallback(() => {
    if (searchResults.length === 0) return
    const prev = (searchResultIndex - 1 + searchResults.length) % searchResults.length
    setSearchResultIndex(prev)
    setCurrentPage(searchResults[prev].pageNumber)
    onPageChange?.(searchResults[prev].pageNumber)
  }, [searchResultIndex, searchResults, onPageChange])

  const persistReadingPosition = useCallback(() => {
    if (!bookDocument?.id) return
    const total = Math.max(1, pages.length)
    const toStore = normalizeBookmarkPage(currentPageRef.current, total, !isMobile)
    localStorage.setItem(progressKey, String(toStore))
  }, [bookDocument?.id, pages.length, isMobile, progressKey, normalizeBookmarkPage])

  useEffect(() => {
    if (!bookDocument?.id || isPaginating) return
    persistReadingPosition()
  }, [bookDocument?.id, currentPage, isPaginating, persistReadingPosition])

  useEffect(() => {
    if (!bookDocument?.id) return undefined

    const handleBeforeUnload = () => {
      persistReadingPosition()
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => {
      persistReadingPosition()
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }, [bookDocument?.id, persistReadingPosition])

  useEffect(() => {
    hasShownResumeToastRef.current = false
    hasShownFsTipRef.current = false
  }, [bookDocument?.id])

  useEffect(() => {
    if (!isPaginating && restoredPage > 1) {
      setResumeToast(restoredPage)
      setToastFading(false)
      setRestoredPage(null)
    }
    return undefined
  }, [isPaginating, restoredPage])

  useEffect(() => {
    if (!resumeToast) return undefined

    const fadeTimerId = setTimeout(() => setToastFading(true), 2500)
    const removeTimerId = setTimeout(() => {
      setResumeToast(null)
      setToastFading(false)
    }, 3100)

    return () => {
      clearTimeout(fadeTimerId)
      clearTimeout(removeTimerId)
    }
  }, [resumeToast])

  useEffect(() => {
    setBookmarkDismissed(false)
    setBookmarkHidden(false)
  }, [bookDocument?.id])

  useEffect(() => {
    const updateBookmarkPosition = () => {
      if (bookmarkHidden) return
      const anchorElement =
        leftPage?.pageNumber === bookmarkPage
          ? leftPageFaceRef.current
          : rightPage?.pageNumber === bookmarkPage
            ? rightPageFaceRef.current
            : null
      if (!anchorElement) {
        setBookmarkPosition(null)
        return
      }

      const rect = anchorElement.getBoundingClientRect()
      setBookmarkPosition({
        top: rect.top - 1,
        left: rect.right - 14 - 20,
      })
    }

    updateBookmarkPosition()
    window.addEventListener("resize", updateBookmarkPosition)
    window.addEventListener("scroll", updateBookmarkPosition, true)
    return () => {
      window.removeEventListener("resize", updateBookmarkPosition)
      window.removeEventListener("scroll", updateBookmarkPosition, true)
    }
  }, [bookmarkPage, bookmarkHidden, leftPage?.pageNumber, rightPage?.pageNumber, pages.length, scale])

  const handleDismissBookmark = useCallback(() => {
    if (bookmarkDismissed || bookmarkHidden) return
    setBookmarkDismissed(true)
    const element = bookmarkRef.current
    if (!element) {
      setBookmarkHidden(true)
      return
    }

    const randomAngle = Math.random() * Math.PI * 2
    const minExitDistance = Math.hypot(window.innerWidth, window.innerHeight) * 0.7
    const randomDistance = minExitDistance + Math.random() * minExitDistance
    const randomX = Math.round(Math.cos(randomAngle) * randomDistance)
    const randomY = Math.round(Math.sin(randomAngle) * randomDistance)
    const rotationMagnitude = 300 + Math.floor(Math.random() * 221)
    const rotationSign = Math.random() > 0.5 ? 1 : -1
    const randomRot = rotationMagnitude * rotationSign

    const animation = element.animate(
      [
        { transform: "translate(0px, 0px) rotate(0deg)" },
        {
          offset: 0.4,
          transform: `translate(${Math.round(randomX * 0.35)}px, ${Math.round(
            randomY * 0.35
          )}px) rotate(${Math.round(randomRot * 0.3)}deg)`,
        },
        {
          offset: 0.78,
          transform: `translate(${Math.round(randomX * 0.82)}px, ${Math.round(
            randomY * 0.82
          )}px) rotate(${Math.round(randomRot * 0.78)}deg)`,
        },
        {
          transform: `translate(${randomX}px, ${randomY}px) rotate(${randomRot}deg)`,
        },
      ],
      {
        duration: 1800,
        easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
        fill: "forwards",
      }
    )

    animation.onfinish = () => {
      setBookmarkHidden(true)
    }
  }, [bookmarkDismissed, bookmarkHidden])

  useEffect(() => {
    if (!searchOpen) {
      setSearchQuery("")
      setSearchResults([])
      searchInputRef.current?.blur()
      return undefined
    }

    const timerId = setTimeout(() => runSearch(searchQuery), 300)
    return () => clearTimeout(timerId)
  }, [searchQuery, runSearch, searchOpen])

  useEffect(() => {
    if (!searchOpen) return undefined
    const timerId = setTimeout(() => searchInputRef.current?.focus(), 50)
    return () => clearTimeout(timerId)
  }, [searchOpen])

  useEffect(() => {
    const handleKey = (event) => {
      const tag = document.activeElement?.tagName?.toLowerCase()
      if (tag === "input" || tag === "textarea" || tag === "select") return
      if (document.activeElement?.isContentEditable) return

      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          event.preventDefault()
          if (!searchOpen) goForward()
          break

        case "ArrowLeft":
        case "ArrowUp":
          event.preventDefault()
          if (!searchOpen) goBack()
          break

        case "f":
        case "F":
          if (!event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault()
            event.stopPropagation()
            if (isMobile) {
              setIsMobileFullscreen((prev) => !prev)
            } else {
              void toggleFullscreen()
            }
          }
          break

        case "Escape":
          if (searchOpen) {
            setSearchOpen(false)
            setSearchQuery("")
            setSearchResults([])
          } else if (tocOpen) {
            setTocOpen(false)
          } else if (settingsOpen) {
            setSettingsOpen(false)
          } else if (isMobileFullscreen) {
            setIsMobileFullscreen(false)
          } else if (isFullscreen) {
            document.exitFullscreen().catch(() => {})
          }
          break

        case "s":
        case "S":
          if (!event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault()
            setSearchOpen((previous) => {
              if (previous) {
                setSearchQuery("")
                setSearchResults([])
              }
              return !previous
            })
            setTocOpen(false)
            setSettingsOpen(false)
          }
          break

        case "t":
        case "T":
          if (!event.metaKey && !event.ctrlKey) {
            event.preventDefault()
            setTocOpen((prev) => !prev)
            setSearchOpen(false)
            setSettingsOpen(false)
          }
          break

        default:
          break
      }
    }

    window.addEventListener("keydown", handleKey, true)
    return () => window.removeEventListener("keydown", handleKey, true)
  }, [
    goForward,
    goBack,
    searchOpen,
    tocOpen,
    settingsOpen,
    isFullscreen,
    isMobile,
    isMobileFullscreen,
    toggleFullscreen,
    setSearchOpen,
    setTocOpen,
    setSettingsOpen,
    setIsMobileFullscreen,
    setSearchQuery,
    setSearchResults,
  ])

  if (isPaginating) {
    return (
      <div className="reader-screen">
        <div className="reader-screen__content">
          <p className="reader-screen__logo">BOOKY</p>
          <p className="reader-screen__subtext">Opening your book...</p>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={viewerRef}
      className={`book-viewer${mobileFullscreenActive ? " book-viewer--mobile-fs" : ""}`}
      tabIndex={-1}
    >
      {showFsTip && <div className="book-viewer__fs-tip">Triple tap to exit</div>}
      {resumeToast && (
        <div className={`book-viewer__toast${toastFading ? " book-viewer__toast--fading" : ""}`}>
          Resuming from Page {resumeToast}
        </div>
      )}

      <header className="book-viewer__nav">
        <div className="book-viewer__nav-left">
          <button
            type="button"
            className="book-viewer__back"
            onClick={() => {
              persistReadingPosition()
              navigate("/library")
            }}
          >
            ← Library
          </button>
          <button
            type="button"
            className="book-viewer__toc-btn"
            onClick={() => {
              setTocOpen((previous) => !previous)
              setSearchOpen(false)
              setSettingsOpen(false)
            }}
            title="Table of Contents"
            aria-label="Table of Contents"
            aria-expanded={tocOpen}
          >
            <TocIcon />
          </button>
          <button
            type="button"
            className="book-viewer__search-btn"
            onClick={() => {
              setSearchOpen((previous) => {
                if (previous) {
                  setSearchQuery("")
                  setSearchResults([])
                }
                return !previous
              })
              setTocOpen(false)
              setSettingsOpen(false)
            }}
            title="Search"
            aria-label="Search"
            aria-expanded={searchOpen}
          >
            <SearchIcon />
          </button>
        </div>
        <p className="book-viewer__chapter">{navChapterTitle}</p>
        <div className="book-viewer__nav-right">
          <PageCounterControl
            leftPageNumber={leftPage?.pageNumber}
            rightPageNumber={showSpreadLayout ? rightPage?.pageNumber : null}
            totalPages={totalPages}
            isSpreadView={showSpreadLayout}
            onJump={jumpToPage}
            disabled={isPaginating || totalPages === 0}
          />
          {!isMobile && (
            <button
              type="button"
              className="book-viewer__layout-toggle"
              onClick={toggleLayoutMode}
              title={isSpreadView ? "Switch to single page" : "Switch to spread"}
              aria-label={isSpreadView ? "Switch to single page" : "Switch to spread"}
              aria-pressed={isSpreadView}
            >
              <LayoutModeIcon isSpreadView={isSpreadView} />
            </button>
          )}

          {!(isMobile && isMobileFullscreen) && (
            <button
              type="button"
              className="book-viewer__typesetting-btn"
              onClick={() => {
                setSettingsOpen((prev) => !prev)
                setTocOpen(false)
                setSearchOpen(false)
              }}
              title="Typesetting"
              aria-label="Typesetting"
              aria-expanded={settingsOpen}
            >
              <NibIcon />
              <span className="book-viewer__typesetting-label">Typesetting</span>
            </button>
          )}

          {!(isMobile && isMobileFullscreen) && (
            <button
              type="button"
              className="book-viewer__fullscreen"
              onClick={isMobile ? () => setIsMobileFullscreen(true) : toggleFullscreen}
              title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            >
              <FullscreenIcon />
            </button>
          )}
        </div>
        <div className="book-viewer__progress-bar">
          <div
            className="book-viewer__progress-fill"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </header>

      <div
        ref={stageRef}
        className="book-viewer__stage"
        onPointerDown={() => viewerRef.current?.focus({ preventScroll: true })}
        onClick={handleStageTap}
      >
        <button
          type="button"
          className="book-viewer__zone book-viewer__zone--left"
          onClick={(event) => {
            event.stopPropagation()
            goBack()
          }}
          disabled={!canGoBack}
          aria-label="Previous page"
        />
        <button
          type="button"
          className="book-viewer__zone book-viewer__zone--right"
          onClick={(event) => {
            event.stopPropagation()
            goForward()
          }}
          disabled={!canGoForward}
          aria-label="Next page"
        />

        {!isMobile && (
          <>
            <span className="book-viewer__arrow book-viewer__arrow--left" aria-hidden="true">
              ‹
            </span>
            <span className="book-viewer__arrow book-viewer__arrow--right" aria-hidden="true">
              ›
            </span>
          </>
        )}

        <div
          className="book-viewer__scale-wrapper"
          style={{
            transform: `scale(${scale})`,
            transformOrigin: "center center",
            "--fs-body": `${font.body}px`,
            "--fs-heading": `${font.heading}px`,
            "--fs-title": `${font.title}px`,
            "--ff-body": family.body,
            "--ff-heading": family.heading,
            "--lh-body": line.body,
            "--lh-heading": line.heading,
          }}
        >
          <div
            className={`book-viewer__spread ${
              !showSpreadLayout ? "book-viewer__spread--single" : ""
            }`}
            style={{ height: activePageHeight }}
          >
            <div
              className={`book-viewer__page-slot book-viewer__page-slot--left ${
                !showSpreadLayout ? "book-viewer__page-slot--single" : ""
              }`}
              style={{ height: activePageHeight }}
            >
              <div className="book-viewer__page-face" ref={leftPageFaceRef}>
                <BookPageContent
                  page={leftPage}
                  isMobileFullscreen={mobileFullscreenActive}
                  settings={settings}
                  searchQuery={searchOpen ? searchQuery : ""}
                  activeSearchOccurrence={
                    searchOpen &&
                    searchResults[searchResultIndex]?.pageNumber === leftPage?.pageNumber
                      ? searchResults[searchResultIndex]?.occurrenceOnPage ?? null
                      : null
                  }
                />
              </div>
            </div>

            {showSpreadLayout && (
              <>
                <div className="book-viewer__spine" aria-hidden="true" />

                <div
                  className="book-viewer__page-slot book-viewer__page-slot--right"
                  style={{ height: activePageHeight }}
                >
                  <div className="book-viewer__page-face" ref={rightPageFaceRef}>
                    {rightPage ? (
                      <BookPageContent
                        page={rightPage}
                        isMobileFullscreen={mobileFullscreenActive}
                        settings={settings}
                        searchQuery={searchOpen ? searchQuery : ""}
                        activeSearchOccurrence={
                          searchOpen &&
                          searchResults[searchResultIndex]?.pageNumber === rightPage?.pageNumber
                            ? searchResults[searchResultIndex]?.occurrenceOnPage ?? null
                            : null
                        }
                      />
                    ) : (
                      <BookPageContent
                        page={null}
                        isMobileFullscreen={mobileFullscreenActive}
                        settings={settings}
                        searchQuery={searchOpen ? searchQuery : ""}
                        activeSearchOccurrence={null}
                      />
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div
        className={`book-viewer__search-panel ${
          searchOpen ? "book-viewer__search-panel--open" : ""
        }`}
        aria-hidden={!searchOpen}
      >
        <div className="book-viewer__search-inner">
          {searchOpen && (
          <input
            ref={searchInputRef}
            type="text"
            className="book-viewer__search-input"
            placeholder="Search in book..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") goToNextResult()
              if (event.key === "Escape") {
                setSearchOpen(false)
              }
            }}
            aria-label="Search in book"
          />
          )}
          {searchResults.length > 0 && (
            <span className="book-viewer__search-count">
              {searchResultIndex + 1} / {searchResults.length}
            </span>
          )}
          {searchQuery && searchResults.length === 0 && (
            <span className="book-viewer__search-count book-viewer__search-count--none">
              No results
            </span>
          )}
          <button
            type="button"
            className="book-viewer__search-nav"
            onClick={goToPrevResult}
            disabled={searchResults.length === 0}
            aria-label="Previous result"
          >
            ‹
          </button>
          <button
            type="button"
            className="book-viewer__search-nav"
            onClick={goToNextResult}
            disabled={searchResults.length === 0}
            aria-label="Next result"
          >
            ›
          </button>
          <button
            type="button"
            className="book-viewer__search-close"
            onClick={() => {
              setSearchOpen(false)
              setSearchQuery("")
              setSearchResults([])
            }}
            aria-label="Close search"
          >
            ✕
          </button>
        </div>
      </div>

      {bookmarkPage &&
        !bookmarkHidden &&
        bookmarkPosition &&
        createPortal(
          <button
            ref={bookmarkRef}
            type="button"
            className="book-page__bookmark"
            style={{
              top: `${bookmarkPosition.top}px`,
              left: `${bookmarkPosition.left}px`,
              zIndex: 9999,
            }}
            onClick={handleDismissBookmark}
            aria-label="Dismiss bookmark"
          />,
          document.body
        )}

      <div
        className={`book-viewer__toc-panel ${
          tocOpen ? "book-viewer__toc-panel--open" : ""
        }`}
        role="dialog"
        aria-label="Table of Contents"
      >
        <div className="book-viewer__settings-header">
          <span className="book-viewer__settings-title">Contents</span>
          <button
            className="book-viewer__settings-close"
            onClick={() => setTocOpen(false)}
            aria-label="Close contents"
            type="button"
          >
            ✕
          </button>
        </div>

        {bookDocument?.chapters?.length > 0 ? (
          <nav className="book-viewer__toc-list">
            {bookDocument.chapters.map((chapter) => {
              const pageNum = chapterPageMap[chapter.id]
              const isCurrent = chapter.id === activeChapterId
              return (
                <button
                  key={chapter.id}
                  type="button"
                  className={`book-viewer__toc-item ${
                    isCurrent ? "book-viewer__toc-item--active" : ""
                  }`}
                  onClick={() => {
                    if (pageNum) {
                      jumpToPage(pageNum)
                    }
                    setTocOpen(false)
                  }}
                >
                  <span className="book-viewer__toc-title">{chapter.title}</span>
                  {pageNum && (
                    <span className="book-viewer__toc-page">p. {pageNum}</span>
                  )}
                </button>
              )
            })}
          </nav>
        ) : (
          <p className="book-viewer__toc-empty">No chapters detected in this document.</p>
        )}
      </div>

        <div
          className={`book-viewer__settings-panel ${
            settingsOpen ? "book-viewer__settings-panel--open" : ""
          }`}
          role="dialog"
          aria-label="Typesetting settings"
        >
          <div className="book-viewer__settings-header">
            <span className="book-viewer__settings-title">Typesetting</span>
            <button
              className="book-viewer__settings-close"
              onClick={() => setSettingsOpen(false)}
              aria-label="Close settings"
              type="button"
            >
              ✕
            </button>
          </div>

          <div className="book-viewer__settings-section">
            <p className="book-viewer__settings-label">Page Theme</p>
            <div className="book-viewer__theme-grid">
              {[
                { id: "parchment", bg: "#FFFFFF", ink: "#1C1917", label: "Parchment" },
                { id: "warm", bg: "#F5ECD7", ink: "#2C1810", label: "Warm" },
                { id: "sepia", bg: "#E8D5B0", ink: "#3B2A1A", label: "Sepia" },
                { id: "dusk", bg: "#2C2B3C", ink: "#D4CFC7", label: "Dusk" },
                { id: "midnight", bg: "#1A1A2E", ink: "#E8E4DD", label: "Midnight" },
                { id: "obsidian", bg: "#1C1917", ink: "#C8C0B4", label: "Obsidian" },
              ].map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  className={`book-viewer__theme-swatch ${
                    settings.theme === theme.id
                      ? "book-viewer__theme-swatch--active"
                      : ""
                  }`}
                  style={{
                    background: theme.bg,
                    color: theme.ink,
                    border:
                      settings.theme === theme.id
                        ? "2px solid #d4af37"
                        : "2px solid transparent",
                  }}
                  onClick={() => setSettings((s) => ({ ...s, theme: theme.id }))}
                  title={theme.label}
                  aria-label={theme.label}
                  aria-pressed={settings.theme === theme.id}
                >
                  <span style={{ fontSize: 9, fontFamily: "Georgia, serif" }}>Aa</span>
                  <span style={{ fontSize: 8 }}>{theme.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="book-viewer__settings-section">
            <p className="book-viewer__settings-label">Font Size</p>
            <div className="book-viewer__settings-row">
              {["small", "medium", "large", "xlarge"].map((size) => (
                <button
                  key={size}
                  type="button"
                  className={`book-viewer__settings-chip ${
                    settings.fontSize === size
                      ? "book-viewer__settings-chip--active"
                      : ""
                  }`}
                  onClick={() =>
                    setSettings((s) => ({
                      ...s,
                      fontSize: size,
                    }))
                  }
                >
                  {size === "xlarge"
                    ? "XL"
                    : size.charAt(0).toUpperCase() + size.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="book-viewer__settings-section">
            <p className="book-viewer__settings-label">Typeface</p>
            <div className="book-viewer__settings-row">
              {[
                { id: "lora", label: "Lora" },
                { id: "garamond", label: "Garamond" },
                { id: "georgia", label: "Georgia" },
                { id: "palatino", label: "Palatino" },
              ].map((fontOption) => (
                <button
                  key={fontOption.id}
                  type="button"
                  className={`book-viewer__settings-chip ${
                    settings.fontStyle === fontOption.id
                      ? "book-viewer__settings-chip--active"
                      : ""
                  }`}
                  onClick={() =>
                    setSettings((s) => ({
                      ...s,
                      fontStyle: fontOption.id,
                    }))
                  }
                >
                  {fontOption.label}
                </button>
              ))}
            </div>
          </div>

          <div className="book-viewer__settings-section">
            <p className="book-viewer__settings-label">Line Spacing</p>
            <div className="book-viewer__settings-row">
              {["compact", "normal", "relaxed", "airy"].map((sp) => (
                <button
                  key={sp}
                  type="button"
                  className={`book-viewer__settings-chip ${
                    settings.lineSpacing === sp
                      ? "book-viewer__settings-chip--active"
                      : ""
                  }`}
                  onClick={() =>
                    setSettings((s) => ({
                      ...s,
                      lineSpacing: sp,
                    }))
                  }
                >
                  {sp.charAt(0).toUpperCase() + sp.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="book-viewer__settings-section">
            <p className="book-viewer__settings-label">Margins</p>
            <div className="book-viewer__settings-row">
              {["none", "narrow", "normal", "wide"].map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`book-viewer__settings-chip ${
                    settings.margins === m
                      ? "book-viewer__settings-chip--active"
                      : ""
                  }`}
                  onClick={() =>
                    setSettings((s) => ({
                      ...s,
                      margins: m,
                    }))
                  }
                >
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="book-viewer__settings-section">
            <button
              type="button"
              className="book-viewer__settings-reset"
              onClick={() => setSettings(DEFAULT_SETTINGS)}
            >
              Reset to defaults
            </button>
          </div>

          <div className="book-viewer__settings-section book-viewer__kb-hints">
            <p className="book-viewer__settings-label">Keyboard Shortcuts</p>
            <div className="book-viewer__kb-list">
              {[
                { keys: ["←", "→"], label: "Turn page" },
                { keys: ["F"], label: "Fullscreen" },
                { keys: ["T"], label: "Contents" },
                { keys: ["S"], label: "Search" },
                { keys: ["Esc"], label: "Close / Exit" },
              ].map(({ keys, label }) => (
                <div key={label} className="book-viewer__kb-row">
                  <span className="book-viewer__kb-label">{label}</span>
                  <span className="book-viewer__kb-keys">
                    {keys.map((key) => (
                      <kbd key={key} className="book-viewer__kbd">
                        {key}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
    </div>
  )
}
