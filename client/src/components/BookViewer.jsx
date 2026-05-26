import { Fragment, useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { motion, useReducedMotion } from "framer-motion"
import { flattenDocument } from "../utils/paginator"
import "../pages/Reader.css"
import "./BookViewer.css"

const NAVBAR_HEIGHT_PX = 48
const PAGE_NUMBER_RESERVED_PX = 32
const CONTENT_HEIGHT_SAFETY_BUFFER_PX = 8
const TRIVIAL_LAST_PAGE_CHAR_LIMIT = 50
const GREEDY_PAGE_SAFETY_MARGIN_PX = 10

const IMPLIED_LIST_LINE_REGEX = /^(Add|Test|Explore|Verify|Ensure|Click)\b/i
const TRIVIAL_LIST_PAGE_CHAR_LIMIT = 30
const STANDALONE_URL_REGEX = /^https?:\/\/\S+$/i

const LEVEL_0_NUMBER_REGEX = /^(\d+[\.\)])\s*(.*)$/
const LEVEL_0_BULLET_REGEX = /^([•·\-—])\s*(.*)$/
const LEVEL_1_LETTERED_REGEX = /^([a-z][\.\)])\s+(.+)$/i
const CHAPTER_LABEL_REGEX =
  /^(Chapter|Part|Section|Prologue|Epilogue)\s+(\d+|[IVXLCDM]+|[A-Za-z]+)$/i
const LEVEL_2_MARKER_REGEX = /^((?:[ivxlcdm]+|\([a-z]\))[\.\)])\s*(.*)$/i
const EMBEDDED_LIST_MARKER_REGEX = /\s+(\d+[\.\)]|[a-z][\.\)])\s+/gi
let listGroupCounter = 0

function isHeadingVisualItem(item) {
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

function getLayoutHeights() {
  const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const stagePaddingY = 1.5 * remPx * 2
  const pagePaddingY = 1.5 * remPx * 2
  const pageOuterHeight = window.innerHeight - NAVBAR_HEIGHT_PX - stagePaddingY
  const contentMaxHeight =
    pageOuterHeight -
    pagePaddingY -
    PAGE_NUMBER_RESERVED_PX -
    CONTENT_HEIGHT_SAFETY_BUFFER_PX

  return { pageOuterHeight, contentMaxHeight }
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
  return "heading"
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
      let headingText = text
      const nextBlock = expandedBlocks[index + 1]
      const nextText = (nextBlock?.text ?? "").trim()

      if (nextBlock?.isHeading && nextText && CHAPTER_LABEL_REGEX.test(text)) {
        headingText = `${text}: ${nextText}`
        index += 1
      }

      visualItems.push({
        type: resolveHeadingType(headingFontSize),
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

function renderListNodeReact(node, itemKey) {
  const markerNumber = getMarkerNumber(node)

  return (
    <li
      key={itemKey}
      className={listItemClassName(node)}
      {...(markerNumber !== null ? { value: markerNumber } : {})}
    >
      {getListItemDisplayText(node)}
      {node.children.length > 0 && renderGroupedListItemsReact(node.children, itemKey)}
    </li>
  )
}

function renderGroupedListItemsReact(nodes, keyPrefix) {
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
            renderListNodeReact(node, `${listKey}-${nodeIndex}`)
          )}
        </ol>
      )
    } else {
      elements.push(
        <ul key={listKey} className="book-page__list">
          {groupNodes.map((node, nodeIndex) =>
            renderListNodeReact(node, `${listKey}-${nodeIndex}`)
          )}
        </ul>
      )
    }
  }

  return elements
}

function BookPageContent({ page }) {
  if (!page) {
    return <div className="book-page book-page--empty" />
  }

  const visualItems = page.visualItems ?? []

  return (
    <div className="book-page">
      {page.chapterTitle && (
        <p className="book-page__chapter-label">{page.chapterTitle}</p>
      )}

      <div className="book-page__body">
        {visualItems.map((item, index) => {
          if (item.type === "title") {
            return (
              <h1 key={index} className="book-page__title">
                {item.text}
              </h1>
            )
          }

          if (item.type === "heading") {
            return (
              <h2 key={index} className="book-page__heading">
                {item.text}
              </h2>
            )
          }

          if (item.type === "list") {
            return (
              <Fragment key={index}>
                {renderGroupedListItemsReact(item.items, `list-${index}`)}
              </Fragment>
            )
          }

          const previousItem = index > 0 ? visualItems[index - 1] : null

          return (
            <p key={index} className={proseParagraphClassName(previousItem, item)}>
              {item.text}
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

function FullscreenIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
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

export default function BookViewer({
  document: bookDocument,
  initialPage = 1,
  onPageChange,
}) {
  const navigate = useNavigate()
  const prefersReducedMotion = useReducedMotion()
  const [pages, setPages] = useState([])
  const [isPaginating, setIsPaginating] = useState(true)
  const [currentPage, setCurrentPage] = useState(initialPage)
  const [flipDirection, setFlipDirection] = useState(null)
  const [isMobile, setIsMobile] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [layoutMode, setLayoutMode] = useState("spread")

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
      const { pageOuterHeight, contentMaxHeight } = getLayoutHeights()
      const measureElements = createMeasureElements()

      measureRoot = measureElements.root
      measureElements.page.style.height = `${pageOuterHeight}px`

      const measuredPages = paginateBlocksByDom(
        flatBlocks,
        measureElements.body,
        contentMaxHeight
      )

      measureRoot.remove()
      measureRoot = null

      if (!cancelled) {
        const totalMeasuredPages = measuredPages.length
        setPages(measuredPages)
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
  }, [bookDocument, initialPage])

  const isSpreadView = !isMobile && layoutMode === "spread"
  const totalPages = pages.length
  const pageStep = isSpreadView ? 2 : 1
  const maxPageIndex = Math.max(1, totalPages)

  const leftPage = pages[currentPage - 1] ?? null
  const rightPage = isSpreadView ? pages[currentPage] ?? null : null
  const isFinalOddSpreadSingle =
    isSpreadView && totalPages % 2 === 1 && Boolean(leftPage) && !rightPage
  const showSpreadLayout = isSpreadView && !isFinalOddSpreadSingle
  const navChapterTitle = formatNavChapterTitle(pages, currentPage, showSpreadLayout)
  const pageCounterText = formatPageCounter(leftPage, rightPage, totalPages, showSpreadLayout)

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
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange)
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange)
  }, [])

  useEffect(() => {
    if (currentPage > maxPageIndex) {
      setCurrentPage(maxPageIndex)
    }
  }, [currentPage, maxPageIndex])

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

  const toggleLayoutMode = useCallback(() => {
    setLayoutMode((mode) => (mode === "spread" ? "single" : "spread"))
  }, [])

  const canGoBack = currentPage - pageStep >= 1
  const canGoForward = currentPage + pageStep <= maxPageIndex

  const finishFlip = useCallback(
    (nextPage) => {
      const clampedPage = Math.min(Math.max(1, nextPage), maxPageIndex)
      setCurrentPage(clampedPage)
      onPageChange?.(clampedPage)
      setFlipDirection(null)
    },
    [maxPageIndex, onPageChange]
  )

  const goBack = useCallback(() => {
    if (!canGoBack || flipDirection) return

    const nextPage = currentPage - pageStep

    if (prefersReducedMotion) {
      finishFlip(nextPage)
      return
    }

    setFlipDirection("backward")
  }, [canGoBack, currentPage, finishFlip, flipDirection, pageStep, prefersReducedMotion])

  const goForward = useCallback(() => {
    if (!canGoForward || flipDirection) return

    const nextPage = currentPage + pageStep

    if (prefersReducedMotion) {
      finishFlip(nextPage)
      return
    }

    setFlipDirection("forward")
  }, [canGoForward, currentPage, finishFlip, flipDirection, pageStep, prefersReducedMotion])

  const handleAnimationComplete = useCallback(() => {
    if (!flipDirection) return

    const nextPage =
      flipDirection === "forward" ? currentPage + pageStep : currentPage - pageStep

    finishFlip(nextPage)
  }, [currentPage, finishFlip, flipDirection, pageStep])

  const flipTransition =
    prefersReducedMotion || !flipDirection
      ? { duration: 0 }
      : { duration: 0.6, ease: "easeInOut" }

  const rightPageMotion = {
    rotateY: flipDirection === "forward" ? -180 : 0,
  }

  const leftPageMotion = {
    rotateY: flipDirection === "backward" ? 180 : 0,
  }

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
    <div className="book-viewer">
      <header className="book-viewer__nav">
        <div className="book-viewer__nav-left">
          <button
            type="button"
            className="book-viewer__back"
            onClick={() => navigate("/library")}
          >
            ← Library
          </button>
          <div className="book-viewer__logo">BOOKY</div>
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
          <button
            type="button"
            className="book-viewer__fullscreen"
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            <FullscreenIcon />
          </button>
        </div>
      </header>

      <div className="book-viewer__stage">
        <button
          type="button"
          className="book-viewer__zone book-viewer__zone--left"
          onClick={goBack}
          disabled={!canGoBack || Boolean(flipDirection)}
          aria-label="Previous page"
        />
        <button
          type="button"
          className="book-viewer__zone book-viewer__zone--right"
          onClick={goForward}
          disabled={!canGoForward || Boolean(flipDirection)}
          aria-label="Next page"
        />

        <span className="book-viewer__arrow book-viewer__arrow--left" aria-hidden="true">
          ‹
        </span>
        <span className="book-viewer__arrow book-viewer__arrow--right" aria-hidden="true">
          ›
        </span>

        <div
          className={`book-viewer__spread ${
            !showSpreadLayout ? "book-viewer__spread--single" : ""
          }`}
        >
          <motion.div
            className={`book-viewer__page-slot book-viewer__page-slot--left ${
              !showSpreadLayout ? "book-viewer__page-slot--single" : ""
            }`}
            style={{
              transformOrigin: showSpreadLayout ? "right center" : "center center",
            }}
            animate={leftPageMotion}
            transition={flipTransition}
            onAnimationComplete={
              flipDirection === "backward" ? handleAnimationComplete : undefined
            }
          >
            <div className="book-viewer__page-face">
              <BookPageContent page={leftPage} />
            </div>
          </motion.div>

          {showSpreadLayout && (
            <>
              <div className="book-viewer__spine" aria-hidden="true" />

              <motion.div
                className="book-viewer__page-slot book-viewer__page-slot--right"
                style={{ transformOrigin: "left center" }}
                animate={rightPageMotion}
                transition={flipTransition}
                onAnimationComplete={
                  flipDirection === "forward" ? handleAnimationComplete : undefined
                }
              >
                <div className="book-viewer__page-face">
                  {rightPage ? (
                    <BookPageContent page={rightPage} />
                  ) : (
                    <div className="book-page book-page--empty" />
                  )}
                </div>
              </motion.div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
