import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { flattenDocument } from "../utils/paginator"
import { FullscreenIcon } from "./FullscreenButton"
import "../pages/Reader.css"
import "./BookViewer.css"

const NAVBAR_HEIGHT_PX = 44
const PAGE_WIDTH_PX = 400
const PAGE_HEIGHT_PX = 600
const MOBILE_FULLSCREEN_PAGE_HEIGHT_PX = 780
const SPINE_PX = 1
const PAGE_NUMBER_RESERVED_PX = 32
const CONTENT_HEIGHT_SAFETY_BUFFER_PX = 8
const TRIVIAL_LAST_PAGE_CHAR_LIMIT = 50
const GREEDY_PAGE_SAFETY_MARGIN_PX = 10

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

const IMPLIED_LIST_LINE_REGEX = /^(Add|Test|Explore|Verify|Ensure|Click)\b/i
const TRIVIAL_LIST_PAGE_CHAR_LIMIT = 30
const STANDALONE_URL_REGEX = /^https?:\/\/\S+$/i

const LEVEL_0_NUMBER_REGEX = /^(\d+[\.\)])\s*(.*)$/
const LEVEL_0_BULLET_REGEX = /^([•·\-])\s*(.*)$/
const LEVEL_1_LETTERED_REGEX = /^([a-z][\.\)])\s+(.+)$/i
const CHAPTER_LABEL_REGEX =
  /^(Chapter|Part|Section|Prologue|Epilogue)\s+(\d+|[IVXLCDM]+|[A-Za-z]+)$/i
const LEVEL_2_MARKER_REGEX = /^((?:[ivxlcdm]+|\([a-z]\))[\.\)])\s*(.*)$/i
const EMBEDDED_LIST_MARKER_REGEX = /\s+(\d+[\.\)]|[a-z][\.\)])\s+/gi
let listGroupCounter = 0

function isHeadingVisualItem(item) {
  // subtitle intentionally excluded
  return item?.type === "title" || item?.type === "heading"
}

function proseParagraphClassName(previousItem, proseItem = null) {
  if (proseItem?.isContinuation) {
    return "book-page__text book-page__text--continuation"
  }

  return isHeadingVisualItem(previousItem)
    ? "book-page__text book-page__text--first"
    : "book-page__text"
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

function getLayoutHeights(pageHeightOverride, marginSetting) {
  const remPx =
    parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const rawMargin = MARGIN_MAP[marginSetting ?? "normal"] ?? MARGIN_MAP.normal
  const marginPx = rawMargin === "0px" ? 0 : parseFloat(rawMargin) * remPx
  const pagePaddingY = marginPx * 2
  const pageHeight = pageHeightOverride ?? PAGE_HEIGHT_PX
  const contentMaxHeight =
    pageHeight -
    pagePaddingY -
    PAGE_NUMBER_RESERVED_PX -
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
  body.style.flex = "none"
  body.style.height = "auto"
  body.style.maxHeight = "none"
  body.style.overflow = "visible"

  const footer = document.createElement("div")
  footer.className = "book-viewer__measure-footer"
  footer.setAttribute("aria-hidden", "true")

  page.appendChild(body)
  page.appendChild(footer)
  root.appendChild(page)
  document.body.appendChild(root)

  return { root, page, body }
}

function resolveHeadingType(fontSize) {
  if (fontSize > 18) return "title"
  if (fontSize >= 14) return "heading"
  if (fontSize >= 13) return "subtitle"
  return "subtitle"
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
  let pendingListItems = []

  const shouldMergeWithPreviousProse = (newText) => {
    const last = visualItems[visualItems.length - 1]
    if (!last || last.type !== "prose") return false

    const prev = last.text
    const startsLowercase = /^[a-z]/.test(newText)
    const prevEndsWithContinuation = /[,;—–-]$/.test(prev.trim())
    const prevLacksTerminator = !/[.!?"'\)»]$/.test(prev.trim())

    return startsLowercase || prevEndsWithContinuation || prevLacksTerminator
  }

  const pushProse = (proseText) => {
    const trimmed = proseText.trim()
    if (!trimmed) return

    if (shouldMergeWithPreviousProse(trimmed)) {
      const last = visualItems[visualItems.length - 1]
      last.text = (last.text + " " + trimmed).replace(/\s+/g, " ").trim()
    } else {
      visualItems.push({ type: "prose", text: trimmed })
    }
  }

  const flushPendingList = () => {
    if (pendingListItems.length === 0) return

    visualItems.push({
      type: "list",
      items: buildNestedListTree(pendingListItems),
    })
    pendingListItems = []
  }

  const pushListItem = (listItem) => {
    const trimmed = listItem.text?.trim()
    if (trimmed) {
      pendingListItems.push({
        text: trimmed,
        level: listItem.level ?? 0,
        marker: listItem.marker ?? "",
        hasBullet: Boolean(listItem.hasBullet),
      })
    }
  }

  for (let index = 0; index < expandedBlocks.length; index += 1) {
    const block = expandedBlocks[index]
    const text = (block.text ?? "").trim()

    if (!text) {
      flushPendingList()
      continue
    }

    if (block.isHeading) {
      flushPendingList()

      const headingFontSize = block.fontSize ?? 16
      const headingType = resolveHeadingType(headingFontSize)
      let headingText = text
      const nextBlock = expandedBlocks[index + 1]
      const nextText = (nextBlock?.text ?? "").trim()

      if (
        (headingType === "heading" || headingType === "title") &&
        nextBlock?.isHeading &&
        nextText &&
        CHAPTER_LABEL_REGEX.test(text)
      ) {
        headingText = `${text}: ${nextText}`
        index += 1
      }

      visualItems.push({
        type: headingType,
        text: headingText,
        fontSize: headingFontSize,
        chapterId: block.chapterId ?? null,
        chapterTitle: block.chapterTitle ?? headingText,
        isChapterStart: Boolean(block.isChapterStart),
      })
      continue
    }

    if (isStandaloneUrl(text)) {
      if (pendingListItems.length > 0) {
        const lastListItem = pendingListItems[pendingListItems.length - 1]
        lastListItem.text = `${lastListItem.text} ${text}`.replace(/\s+/g, " ").trim()
        continue
      }

      flushPendingList()
      pushProse(text)
      continue
    }

    const loneMarker = parseLoneMarker(text, pendingListItems)
    if (loneMarker) {
      const nextBlock = expandedBlocks[index + 1]
      const nextText = (nextBlock?.text ?? "").trim()
      const canConsumeNextLine =
        nextBlock &&
        !nextBlock.isHeading &&
        nextText &&
        !isListMarkerLine(nextText, pendingListItems)

      if (canConsumeNextLine) {
        const parsedNext = parseListLine(nextText, pendingListItems)
        if (parsedNext && !parsedNext.markerOnly) {
          pushListItem(toFlatListItem(parsedNext))
        } else if (!parsedNext) {
          pushListItem({
            text: nextText,
            level: loneMarker.level,
            marker: "",
            hasBullet: false,
          })
        }
        index += 1
      }

      continue
    }

    const parsedList = parseListLine(text, pendingListItems)
    if (parsedList && !parsedList.markerOnly) {
      pushListItem(toFlatListItem(parsedList))
      continue
    }

    if (isImpliedListLine(text) && pendingListItems.length > 0) {
      const previousItem = pendingListItems[pendingListItems.length - 1]
      pushListItem({
        text,
        level: previousItem.level,
        marker: "",
        hasBullet: false,
      })
      continue
    }

    if (pendingListItems.length > 0) {
      const lastListItem = pendingListItems[pendingListItems.length - 1]
      lastListItem.text = `${lastListItem.text} ${text}`.replace(/\s+/g, " ").trim()
      continue
    }

    flushPendingList()
    pushProse(text)
  }

  flushPendingList()

  return visualItems
}

function appendChapterLabel(body, title) {
  const label = document.createElement("p")
  label.className = "book-page__chapter-label"
  label.textContent = title
  body.appendChild(label)
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

  if (item.type === "subtitle") {
    const subtitle = document.createElement("p")
    subtitle.className = "book-page__subtitle"
    subtitle.textContent = item.text
    body.appendChild(subtitle)
    return
  }

  if (item.type === "list") {
    appendGroupedListNodes(body, item.items)
    return
  }

  if (item.type === "prose") {
    const paragraph = document.createElement("p")
    paragraph.className = proseParagraphClassName(previousItem, item)
    paragraph.textContent = item.text
    body.appendChild(paragraph)
  }
}

function renderMeasureBody(body, visualItems, showChapterLabel, chapterTitle) {
  body.replaceChildren()

  if (showChapterLabel && chapterTitle) {
    appendChapterLabel(body, chapterTitle)
  }

  for (let index = 0; index < visualItems.length; index += 1) {
    appendVisualItem(body, visualItems[index], visualItems[index - 1])
  }
}

function applyChapterContextFromItem(item, chapterState) {
  if (item.type !== "title" && item.type !== "heading") {
    return
  }

  if (item.isChapterStart || item.type === "title") {
    chapterState.pageChapterTitle = item.chapterTitle ?? item.text
    chapterState.pageIsChapterStart = true
    return
  }

  if (!chapterState.pageChapterTitle) {
    chapterState.pageChapterTitle = item.chapterTitle ?? item.text
  }
}

function pageContentOverflows(bodyEl, contentMaxHeight) {
  if (bodyEl.scrollHeight > contentMaxHeight) {
    return true
  }

  const lastChild = bodyEl.lastElementChild
  if (!lastChild) {
    return false
  }

  const bottom = lastChild.offsetTop + lastChild.offsetHeight
  return bottom > contentMaxHeight
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

function cleanupPages(pages, bodyEl, contentMaxHeight) {
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

        renderMeasureBody(
          bodyEl,
          mergedItems,
          Boolean(previousPage.isChapterStart && previousPage.chapterTitle),
          previousPage.chapterTitle
        )

        if (!pageContentOverflows(bodyEl, contentMaxHeight)) {
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
  return placeable.type === "title" || placeable.type === "heading"
}

function getChapterItemFromPlaceable(placeable) {
  if (isHeadingPlaceable(placeable)) {
    return placeable.item
  }

  return null
}

function prosePlaceableFromItem(proseItem) {
  return { type: "prose", item: proseItem }
}

function pagePlaceablesFit(bodyEl, pagePlaceables, contentMaxHeight, showLabel, labelTitle) {
  const trialVisualItems = placeablesToVisualItems(pagePlaceables)
  renderMeasureBody(bodyEl, trialVisualItems, showLabel, labelTitle)
  return bodyEl.scrollHeight + GREEDY_PAGE_SAFETY_MARGIN_PX < contentMaxHeight
}

function splitProseAcrossPages(
  proseItem,
  bodyEl,
  contentMaxHeight,
  alreadyOnPage,
  showLabel,
  labelTitle
) {
  const words = (proseItem.text ?? "").trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return null
  }

  const singleWordItem = {
    type: "prose",
    text: words[0],
    ...(proseItem.isContinuation ? { isContinuation: true } : {}),
  }

  if (
    !pagePlaceablesFit(
      bodyEl,
      [prosePlaceableFromItem(singleWordItem)],
      contentMaxHeight,
      showLabel,
      labelTitle
    )
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
      ...(proseItem.isContinuation ? { isContinuation: true } : {}),
    }
    const trialPlaceables = [...alreadyOnPage, prosePlaceableFromItem(fittingItem)]

    if (pagePlaceablesFit(bodyEl, trialPlaceables, contentMaxHeight, showLabel, labelTitle)) {
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
      ...(proseItem.isContinuation ? { isContinuation: true } : {}),
    },
    overflow: {
      type: "prose",
      text: words.slice(best).join(" "),
      isContinuation: true,
    },
  }
}

function paginateBlocksByDom(flatBlocks, bodyEl, contentMaxHeight) {
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

  const showChapterLabel = () =>
    chapterState.pageIsChapterStart &&
    Boolean(chapterState.pageChapterTitle) &&
    currentPagePlaceables.length === 0

  const updateCurrentActiveChapter = (item) => {
    if (!isHeadingVisualItem(item)) {
      return
    }

    if (item.isChapterStart || item.type === "title") {
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
        (pageItem.isChapterStart || pageItem.type === "title")
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

  const pageItemsFit = (pageItems, showLabel, labelTitle) => {
    renderMeasureBody(bodyEl, pageItems, showLabel, labelTitle)
    return bodyEl.scrollHeight + GREEDY_PAGE_SAFETY_MARGIN_PX < contentMaxHeight
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
    })

    currentPagePlaceables = []
    chapterAtPageStart = null
    chapterState.pageChapterTitle = null
    chapterState.pageIsChapterStart = false
  }

  const tryAddPlaceables = (toAdd) => {
    const trialPlaceables = [...currentPagePlaceables, ...toAdd]
    const trialVisualItems = placeablesToVisualItems(trialPlaceables)

    if (!pageItemsFit(trialVisualItems, showChapterLabel(), chapterState.pageChapterTitle)) {
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
        contentMaxHeight,
        currentPagePlaceables,
        showChapterLabel(),
        chapterState.pageChapterTitle
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
    const chapterItem = getChapterItemFromPlaceable(placeable)

    if (!chapterItem?.isChapterStart) {
      return
    }

    if (currentPagePlaceables.length > 0) {
      flushPage()
    }

    markPageStartIfEmpty()
  }

  for (let placeableIndex = 0; placeableIndex < placeables.length; placeableIndex += 1) {
    const placeable = placeables[placeableIndex]

    ensureChapterStartsOnNewPage(placeable)

    if (isHeadingPlaceable(placeable)) {
      const followingPlaceable = placeables[placeableIndex + 1]

      if (followingPlaceable && !isHeadingPlaceable(followingPlaceable)) {
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

  return cleanupPages(pages, bodyEl, contentMaxHeight)
}

function renderListNodeReact(node, itemKey, highlightQuery = "") {
  const markerNumber = getMarkerNumber(node)

  return (
    <li
      key={itemKey}
      className={listItemClassName(node)}
      {...(markerNumber !== null ? { value: markerNumber } : {})}
    >
      {highlightTextContent(getListItemDisplayText(node), highlightQuery)}
      {node.children.length > 0 &&
        renderGroupedListItemsReact(node.children, itemKey, highlightQuery)}
    </li>
  )
}

function renderGroupedListItemsReact(nodes, keyPrefix, highlightQuery = "") {
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
            renderListNodeReact(node, `${listKey}-${nodeIndex}`, highlightQuery)
          )}
        </ol>
      )
    } else {
      elements.push(
        <ul key={listKey} className="book-page__list">
          {groupNodes.map((node, nodeIndex) =>
            renderListNodeReact(node, `${listKey}-${nodeIndex}`, highlightQuery)
          )}
        </ul>
      )
    }
  }

  return elements
}

function highlightTextContent(text, query) {
  const source = String(text ?? "")
  const normalizedQuery = String(query ?? "").trim()
  if (!normalizedQuery) return source

  const escaped = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const regex = new RegExp(`(${escaped})`, "gi")
  const parts = source.split(regex)

  if (parts.length <= 1) return source

  const queryLower = normalizedQuery.toLowerCase()
  return parts.map((part, index) =>
    part.toLowerCase() === queryLower ? (
      <mark key={`${part}-${index}`} className="book-page__highlight">
        {part}
      </mark>
    ) : (
      <Fragment key={`${part}-${index}`}>{part}</Fragment>
    )
  )
}

function BookPageContent({
  page,
  isMobileFullscreen = false,
  settings,
  searchQuery = "",
}) {
  const themeId = settings?.theme ?? DEFAULT_SETTINGS.theme
  const pageClassName = [
    "book-page",
    `book-page--theme-${themeId}`,
    isMobileFullscreen ? "book-page--mobile-fs" : "",
  ]
    .filter(Boolean)
    .join(" ")

  const padding = MARGIN_MAP[settings?.margins ?? DEFAULT_SETTINGS.margins] ?? "0px"
  const pageStyle = { padding }

  if (!page) {
    return <div className={`${pageClassName} book-page--empty`} style={pageStyle} />
  }

  const visualItems = page.visualItems ?? []

  return (
    <div className={pageClassName} style={pageStyle}>
      {page.chapterTitle && (
        <p className="book-page__chapter-label">
          {highlightTextContent(page.chapterTitle, searchQuery)}
        </p>
      )}

      <div className="book-page__body">
        {visualItems.map((item, index) => {
          if (item.type === "title") {
            return (
              <h1 key={index} className="book-page__title">
                {highlightTextContent(item.text, searchQuery)}
              </h1>
            )
          }

          if (item.type === "heading") {
            return (
              <h2 key={index} className="book-page__heading">
                {highlightTextContent(item.text, searchQuery)}
              </h2>
            )
          }

          if (item.type === "subtitle") {
            return (
              <p key={index} className="book-page__subtitle">
                {highlightTextContent(item.text, searchQuery)}
              </p>
            )
          }

          if (item.type === "list") {
            return (
              <Fragment key={index}>
                {renderGroupedListItemsReact(item.items, `list-${index}`, searchQuery)}
              </Fragment>
            )
          }

          const previousItem = index > 0 ? visualItems[index - 1] : null

          return (
            <p key={index} className={proseParagraphClassName(previousItem, item)}>
              {highlightTextContent(item.text, searchQuery)}
            </p>
          )
        })}
      </div>

      <p className="book-page__number">— {page.pageNumber} —</p>
    </div>
  )
}

function collectChapterTitlesForPage(page) {
  if (!page) {
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

function formatNavChapterTitle(pages, currentPage, isSpreadView) {
  const pageIndices = [currentPage - 1]

  if (isSpreadView && currentPage < pages.length) {
    pageIndices.push(currentPage)
  }

  const titles = []

  for (const pageIndex of pageIndices) {
    const page = pages[pageIndex]
    const pageTitles = collectChapterTitlesForPage(page)

    for (const title of pageTitles) {
      if (title && !titles.includes(title)) {
        titles.push(title)
      }
    }
  }

  return titles.join(" · ")
}

function formatPageCounter(leftPage, rightPage, totalPages, isSpreadView) {
  if (!leftPage || totalPages === 0) return ""

  const leftNumber = leftPage.pageNumber

  if (isSpreadView && rightPage?.pageNumber) {
    return `Pages ${leftNumber}–${rightPage.pageNumber} of ${totalPages}`
  }

  return `Page ${leftNumber} of ${totalPages}`
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
  const [pages, setPages] = useState([])
  const [isPaginating, setIsPaginating] = useState(true)
  const [currentPage, setCurrentPage] = useState(initialPage)
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
  const [chapterPageMap, setChapterPageMap] = useState({})
  const [pageTextMap, setPageTextMap] = useState({})
  const [resumeToast, setResumeToast] = useState(null)

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
        await document.documentElement.requestFullscreen()
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
      const { pageOuterHeight, contentMaxHeight } = getLayoutHeights(
        pageHeightToUse,
        settings.margins
      )
      const measureElements = createMeasureElements()

      measureRoot = measureElements.root
      measureElements.page.style.height = `${pageOuterHeight}px`
      measureElements.body.style.padding = MARGIN_MAP[settings.margins]

      const font = FONT_SIZE_MAP[settings.fontSize] ?? FONT_SIZE_MAP.medium
      const line = LINE_HEIGHT_MAP[settings.lineSpacing] ?? LINE_HEIGHT_MAP.normal
      const family = FONT_FAMILY_MAP[settings.fontStyle] ?? FONT_FAMILY_MAP.lora

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
        contentMaxHeight
      )

      measureRoot.remove()
      measureRoot = null

      if (!cancelled) {
        const totalMeasuredPages = measuredPages.length
        const chapterMap = {}
        const textMap = {}

        for (const page of measuredPages) {
          for (const item of page.visualItems ?? []) {
            if (
              (item.type === "heading" || item.type === "title") &&
              item.chapterId &&
              !chapterMap[item.chapterId]
            ) {
              chapterMap[item.chapterId] = page.pageNumber
            }
          }

          const pageText = (page.visualItems ?? [])
            .map((item) => {
              if (
                item.type === "prose" ||
                item.type === "heading" ||
                item.type === "title" ||
                item.type === "subtitle"
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
          return Math.min(Math.max(1, previousPage), maxPage)
        })
        setIsPaginating(false)
      }
    }

    requestAnimationFrame(runMeasurement)

    return () => {
      cancelled = true
      measureRoot?.remove()
    }
  }, [bookDocument, initialPage, isMobileFullscreen, isMobile, settings])

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
  const pageCounterText = formatPageCounter(leftPage, rightPage, totalPages, showSpreadLayout)
  const progressPercent = totalPages > 0 ? (currentPage / totalPages) * 100 : 0

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
        isMobile && isMobileFullscreen ? fillScale : fitScale
      setScale(next > 0 && Number.isFinite(next) ? next : 1)
    }

    recomputeScale()
    window.addEventListener("resize", recomputeScale)
    document.addEventListener("fullscreenchange", recomputeScale)
    return () => {
      window.removeEventListener("resize", recomputeScale)
      document.removeEventListener("fullscreenchange", recomputeScale)
    }
  }, [showSpreadLayout, isMobile, isMobileFullscreen, activePageHeight, pages.length, isPaginating])

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)")
    const updateLayout = () => setIsMobile(mediaQuery.matches)

    updateLayout()
    mediaQuery.addEventListener("change", updateLayout)
    return () => mediaQuery.removeEventListener("change", updateLayout)
  }, [])

  useEffect(() => {
    setCurrentPage(initialPage)
  }, [initialPage])

  useEffect(() => {
    if (currentPage > maxPageIndex) {
      setCurrentPage(maxPageIndex)
    }
  }, [currentPage, maxPageIndex])

  useEffect(() => {
    if (isMobile && isMobileFullscreen) {
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

  useEffect(() => {
    if (!bookDocument?.id || isPaginating) return

    if (currentPage >= totalPages && totalPages > 0) {
      localStorage.removeItem(`booky-progress-${bookDocument.id}`)
      return
    }

    localStorage.setItem(`booky-progress-${bookDocument.id}`, String(currentPage))
  }, [currentPage, bookDocument?.id, isPaginating, totalPages])

  useEffect(() => {
    if (!isPaginating && initialPage > 1) {
      setResumeToast(initialPage)
      const timerId = setTimeout(() => setResumeToast(null), 2500)
      return () => clearTimeout(timerId)
    }
    return undefined
  }, [isPaginating, initialPage])

  useEffect(() => {
    const timerId = setTimeout(() => runSearch(searchQuery), 300)
    return () => clearTimeout(timerId)
  }, [searchQuery, runSearch])

  useEffect(() => {
    if (searchOpen) {
      const timerId = setTimeout(() => searchInputRef.current?.focus(), 50)
      return () => clearTimeout(timerId)
    }
    return undefined
  }, [searchOpen])

  useEffect(() => {
    const handleKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault()
        setSearchOpen(true)
        setTocOpen(false)
        setSettingsOpen(false)
        return
      }

      if (event.key === "Escape") {
        setSearchOpen(false)
        setTocOpen(false)
        setSettingsOpen(false)
        setSearchQuery("")
        setSearchResults([])
        return
      }

      if (searchOpen) return
      if (event.key === "ArrowRight") goForward()
      if (event.key === "ArrowLeft") goBack()
    }

    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [goForward, goBack, searchOpen])

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
      className={`book-viewer${mobileFullscreenActive ? " book-viewer--mobile-fs" : ""}`}
    >
      {showFsTip && <div className="book-viewer__fs-tip">Triple tap to exit</div>}
      {resumeToast && (
        <div className="book-viewer__toast">Resuming from page {resumeToast}</div>
      )}

      <header className="book-viewer__nav">
        <div className="book-viewer__nav-left">
          <button
            type="button"
            className="book-viewer__back"
            onClick={() => navigate("/library")}
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
              setSearchOpen((previous) => !previous)
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
          <p className="book-viewer__counter">{pageCounterText}</p>
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
              <div className="book-viewer__page-face">
                <BookPageContent
                  page={leftPage}
                  isMobileFullscreen={mobileFullscreenActive}
                  settings={settings}
                  searchQuery={searchQuery}
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
                  <div className="book-viewer__page-face">
                    {rightPage ? (
                      <BookPageContent
                        page={rightPage}
                        isMobileFullscreen={mobileFullscreenActive}
                        settings={settings}
                        searchQuery={searchQuery}
                      />
                    ) : (
                      <BookPageContent
                        page={null}
                        isMobileFullscreen={mobileFullscreenActive}
                        settings={settings}
                        searchQuery={searchQuery}
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
      >
        <div className="book-viewer__search-inner">
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
                setSearchQuery("")
                setSearchResults([])
              }
            }}
            aria-label="Search in book"
          />
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
                      setCurrentPage(pageNum)
                      onPageChange?.(pageNum)
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
        </div>
    </div>
  )
}
