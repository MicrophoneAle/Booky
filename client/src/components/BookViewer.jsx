import { Fragment, useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { motion, useReducedMotion } from "framer-motion"
import { flattenDocument } from "../utils/paginator"
import "../pages/Reader.css"
import "./BookViewer.css"

const NAVBAR_HEIGHT_PX = 48
const PAGE_NUMBER_RESERVED_PX = 32
const CONTENT_HEIGHT_SAFETY_BUFFER_PX = 20
const TRIVIAL_LAST_PAGE_CHAR_LIMIT = 50
const UNUSED_PAGE_SPACE_THRESHOLD_PX = 100

const IMPLIED_LIST_LINE_REGEX = /^(Add|Test|Explore|Verify|Ensure|Click)\b/i
const TRIVIAL_LIST_PAGE_CHAR_LIMIT = 30
const STANDALONE_URL_REGEX = /^https?:\/\/\S+$/i

const LEVEL_0_NUMBER_REGEX = /^(\d+[\.\)])\s*(.*)$/
const LEVEL_0_BULLET_REGEX = /^([•·\-—])\s*(.*)$/
const LEVEL_1_MARKER_REGEX = /^([o*]|[a-z][\.\)])\s*(.*)$/i
const LEVEL_2_MARKER_REGEX = /^((?:[ivxlcdm]+|\([a-z]\))[\.\)])\s*(.*)$/i
const LONE_MARKER_REGEX = /^(\d+[\.\)]|[•·\-—]|[o*]|[a-z][\.\)]|(?:[ivxlcdm]+|\([a-z]\))[\.\)])$/i

function isStandaloneUrl(text) {
  return STANDALONE_URL_REGEX.test(text.trim())
}

function isImpliedListLine(text) {
  return IMPLIED_LIST_LINE_REGEX.test(text.trim())
}

function isListMarkerLine(text) {
  return parseListLine(text) !== null || LONE_MARKER_REGEX.test(text.trim())
}

function buildNumberedListText(marker, body) {
  const trimmedBody = body.trim()
  return trimmedBody ? `${marker} ${trimmedBody}`.replace(/\s+/g, " ").trim() : marker
}

function parseListLine(text) {
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

  match = trimmed.match(/^([o*])\s*(.*)$/i)
  if (match) {
    const marker = match[1]
    const body = match[2].trim()
    return {
      level: 1,
      marker,
      hasBullet: true,
      text: body,
      markerOnly: !body,
    }
  }

  match = trimmed.match(/^([a-z][\.\)])\s*(.*)$/i)
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

function parseLoneMarker(text) {
  const trimmed = text.trim()
  if (!trimmed || !LONE_MARKER_REGEX.test(trimmed)) return null

  if (/^\d+[\.\)]$/.test(trimmed)) {
    return { level: 0, markerOnly: true, text: "" }
  }

  if (/^[•·\-—]$/.test(trimmed)) {
    return { level: 0, markerOnly: true, text: "" }
  }

  if (/^[o*]$/i.test(trimmed)) {
    return { level: 1, markerOnly: true, text: "" }
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

/**
 * Stage 1 (client): turn flat API blocks into grouped visual layout items.
 */
function groupBlocksForDisplay(blocks) {
  const visualItems = []
  let currentProse = []
  let pendingListItems = []

  const flushProse = () => {
    if (currentProse.length === 0) return

    const combinedText = currentProse.join(" ").replace(/\s+/g, " ").trim()
    currentProse = []

    if (combinedText) {
      visualItems.push({ type: "prose", text: combinedText })
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

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const text = (block.text ?? "").trim()

    if (!text) {
      flushProse()
      flushPendingList()
      continue
    }

    if (block.isHeading) {
      flushProse()
      flushPendingList()

      const headingFontSize = block.fontSize ?? 16
      visualItems.push({
        type: resolveHeadingType(headingFontSize),
        text,
        fontSize: headingFontSize,
        chapterId: block.chapterId ?? null,
        chapterTitle: block.chapterTitle ?? null,
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
      currentProse.push(text)
      continue
    }

    const loneMarker = parseLoneMarker(text)
    if (loneMarker) {
      flushProse()

      const nextBlock = blocks[index + 1]
      const nextText = (nextBlock?.text ?? "").trim()
      const canConsumeNextLine =
        nextBlock &&
        !nextBlock.isHeading &&
        nextText &&
        !isListMarkerLine(nextText)

      if (canConsumeNextLine) {
        const parsedNext = parseListLine(nextText)
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

    const parsedList = parseListLine(text)
    if (parsedList && !parsedList.markerOnly) {
      flushProse()
      pushListItem(toFlatListItem(parsedList))
      continue
    }

    if (isImpliedListLine(text) && pendingListItems.length > 0) {
      flushProse()
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
      flushProse()
      const lastListItem = pendingListItems[pendingListItems.length - 1]
      lastListItem.text = `${lastListItem.text} ${text}`.replace(/\s+/g, " ").trim()
      continue
    }

    flushPendingList()
    currentProse.push(text)
  }

  flushProse()
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

    while (index < nodes.length && getListItemKind(nodes[index]) === kind) {
      appendSingleListNode(listEl, nodes[index])
      index += 1
    }

    parentEl.appendChild(listEl)
  }
}

function appendVisualItem(body, item) {
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
    paragraph.className = "book-page__text"
    paragraph.textContent = item.text
    body.appendChild(paragraph)
  }
}

function renderMeasureBody(body, visualItems, showChapterLabel, chapterTitle) {
  body.replaceChildren()

  if (showChapterLabel && chapterTitle) {
    appendChapterLabel(body, chapterTitle)
  }

  for (const item of visualItems) {
    appendVisualItem(body, item)
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

function splitListAcrossPages(listItem, bodyEl, contentMaxHeight, showChapterLabel, chapterTitle) {
  const flatItems = flattenListTree(listItem.items)
  if (flatItems.length <= 1) {
    return [listItem]
  }

  const segments = []
  let chunk = []

  for (const flatItem of flatItems) {
    const nextChunk = [...chunk, flatItem]
    const trialList = { type: "list", items: buildNestedListTree(nextChunk) }

    renderMeasureBody(bodyEl, [trialList], showChapterLabel, chapterTitle)

    if (pageContentOverflows(bodyEl, contentMaxHeight) && chunk.length > 0) {
      segments.push({ type: "list", items: buildNestedListTree(chunk) })
      chunk = [flatItem]
    } else {
      chunk = nextChunk
    }
  }

  if (chunk.length > 0) {
    segments.push({ type: "list", items: buildNestedListTree(chunk) })
  }

  return segments.length > 0 ? segments : [listItem]
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
function isHeadingVisualItem(item) {
  return item?.type === "title" || item?.type === "heading"
}

function paginateBlocksByDom(flatBlocks, bodyEl, contentMaxHeight) {
  const visualItems = groupBlocksForDisplay(flatBlocks)
  const pages = []
  let currentPageItems = []
  let activeChapterTitle = null
  let activeChapterAtPageStart = null
  const chapterState = {
    pageChapterTitle: null,
    pageIsChapterStart: false,
  }

  const showChapterLabel = () =>
    chapterState.pageIsChapterStart &&
    Boolean(chapterState.pageChapterTitle) &&
    currentPageItems.length === 0

  const syncActiveChapterFromItem = (item) => {
    if (item.type !== "title" && item.type !== "heading") {
      return
    }

    if (item.isChapterStart || item.type === "title") {
      activeChapterTitle = item.chapterTitle ?? item.text
      return
    }

    if (!activeChapterTitle) {
      activeChapterTitle = item.chapterTitle ?? item.text
    }
  }

  const markPageStartIfEmpty = () => {
    if (currentPageItems.length === 0) {
      activeChapterAtPageStart = activeChapterTitle
    }
  }

  const measurePageUnusedSpace = (pageItems, showLabel, labelTitle) => {
    renderMeasureBody(bodyEl, pageItems, showLabel, labelTitle)
    return contentMaxHeight - bodyEl.scrollHeight
  }

  const tryPlaceOnPreviousPage = (units) => {
    if (pages.length === 0) {
      return false
    }

    const unitsToPlace = Array.isArray(units) ? units : [units]
    const lastPage = pages[pages.length - 1]
    const unusedSpace = measurePageUnusedSpace(
      lastPage.visualItems,
      Boolean(lastPage.isChapterStart && lastPage.chapterTitle),
      lastPage.chapterTitle
    )

    if (unusedSpace <= UNUSED_PAGE_SPACE_THRESHOLD_PX) {
      return false
    }

    const trialItems = [...lastPage.visualItems, ...unitsToPlace]
    renderMeasureBody(
      bodyEl,
      trialItems,
      Boolean(lastPage.isChapterStart && lastPage.chapterTitle),
      lastPage.chapterTitle
    )

    if (!pageContentOverflows(bodyEl, contentMaxHeight)) {
      lastPage.visualItems = trialItems
      return true
    }

    return false
  }

  const flushPage = () => {
    if (currentPageItems.length === 0) {
      return
    }

    pages.push({
      pageNumber: pages.length + 1,
      visualItems: [...currentPageItems],
      chapterTitle: chapterState.pageChapterTitle,
      activeChapterTitle: activeChapterAtPageStart,
      isChapterStart: chapterState.pageIsChapterStart,
    })

    currentPageItems = []
    activeChapterAtPageStart = null
    chapterState.pageChapterTitle = null
    chapterState.pageIsChapterStart = false
  }

  const tryPlaceUnits = (units) => {
    markPageStartIfEmpty()

    if (tryPlaceOnPreviousPage(units)) {
      return
    }

    const trialItems = [...currentPageItems, ...units]

    renderMeasureBody(
      bodyEl,
      trialItems,
      showChapterLabel(),
      chapterState.pageChapterTitle
    )

    if (!pageContentOverflows(bodyEl, contentMaxHeight)) {
      currentPageItems = trialItems
      return
    }

    if (currentPageItems.length > 0) {
      flushPage()
    }

    markPageStartIfEmpty()

    if (units.length === 1) {
      tryPlaceUnit(units[0])
      return
    }

    renderMeasureBody(
      bodyEl,
      units,
      chapterState.pageIsChapterStart && Boolean(chapterState.pageChapterTitle),
      chapterState.pageChapterTitle
    )

    if (!pageContentOverflows(bodyEl, contentMaxHeight)) {
      currentPageItems = units
      return
    }

    for (const unit of units) {
      tryPlaceUnit(unit)
    }
  }

  const tryPlaceUnit = (unit) => {
    markPageStartIfEmpty()

    if (tryPlaceOnPreviousPage(unit)) {
      return
    }

    const trialItems = [...currentPageItems, unit]

    renderMeasureBody(
      bodyEl,
      trialItems,
      showChapterLabel(),
      chapterState.pageChapterTitle
    )

    if (!pageContentOverflows(bodyEl, contentMaxHeight)) {
      currentPageItems = trialItems
      return
    }

    if (currentPageItems.length > 0) {
      flushPage()
    }

    markPageStartIfEmpty()

    renderMeasureBody(
      bodyEl,
      [unit],
      chapterState.pageIsChapterStart && Boolean(chapterState.pageChapterTitle),
      chapterState.pageChapterTitle
    )

    if (!pageContentOverflows(bodyEl, contentMaxHeight) || unit.type !== "list") {
      currentPageItems = [unit]
      return
    }

    const listSegments = splitListAcrossPages(
      unit,
      bodyEl,
      contentMaxHeight,
      chapterState.pageIsChapterStart && Boolean(chapterState.pageChapterTitle),
      chapterState.pageChapterTitle
    )

    for (let segmentIndex = 0; segmentIndex < listSegments.length; segmentIndex += 1) {
      const segment = listSegments[segmentIndex]

      if (segmentIndex > 0) {
        flushPage()
      }

      markPageStartIfEmpty()

      let trialItems =
        segmentIndex === 0 ? [...currentPageItems, segment] : [segment]

      renderMeasureBody(
        bodyEl,
        trialItems,
        showChapterLabel(),
        chapterState.pageChapterTitle
      )

      if (!pageContentOverflows(bodyEl, contentMaxHeight)) {
        currentPageItems = trialItems
        continue
      }

      if (segmentIndex === 0 && currentPageItems.length > 0) {
        flushPage()
        markPageStartIfEmpty()
        trialItems = [segment]
        renderMeasureBody(
          bodyEl,
          trialItems,
          chapterState.pageIsChapterStart && Boolean(chapterState.pageChapterTitle),
          chapterState.pageChapterTitle
        )
      }

      currentPageItems = trialItems
    }
  }

  const tryPlaceHeadingWithFollowing = (heading, following) => {
    tryPlaceUnits([heading, following])
  }

  for (let itemIndex = 0; itemIndex < visualItems.length; itemIndex += 1) {
    const item = visualItems[itemIndex]
    applyChapterContextFromItem(item, chapterState)
    syncActiveChapterFromItem(item)

    const followingItem = visualItems[itemIndex + 1]

    if (isHeadingVisualItem(item) && followingItem && !isHeadingVisualItem(followingItem)) {
      tryPlaceHeadingWithFollowing(item, followingItem)
      itemIndex += 1
      continue
    }

    tryPlaceUnit(item)
  }

  if (currentPageItems.length > 0) {
    flushPage()
  }

  return cleanupPages(pages, bodyEl, contentMaxHeight)
}

function renderListNodeReact(node, itemKey) {
  return (
    <li key={itemKey} className={listItemClassName(node)}>
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
      elements.push(
        <ol
          key={listKey}
          className="book-page__list"
          {...(kind === "lettered" ? { type: "a" } : {})}
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

          return (
            <p key={index} className="book-page__text">
              {item.text}
            </p>
          )
        })}
      </div>

      <p className="book-page__number">— {page.pageNumber} —</p>
    </div>
  )
}

function getPageActiveChapterTitle(pages, pageIndex) {
  if (pageIndex < 0 || pageIndex >= pages.length) {
    return null
  }

  for (let index = pageIndex; index >= 0; index -= 1) {
    const page = pages[index]
    const title = page.activeChapterTitle ?? page.chapterTitle
    if (title) {
      return title
    }
  }

  return null
}

function formatNavChapterTitle(pages, currentPage, isSpreadView) {
  const pageIndices = [currentPage - 1]

  if (isSpreadView && currentPage < pages.length) {
    pageIndices.push(currentPage)
  }

  const titles = []

  for (const pageIndex of pageIndices) {
    const title = getPageActiveChapterTitle(pages, pageIndex)
    if (title && !titles.includes(title)) {
      titles.push(title)
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
  const navChapterTitle = formatNavChapterTitle(pages, currentPage, isSpreadView)
  const pageCounterText = formatPageCounter(leftPage, rightPage, totalPages, isSpreadView)

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
            !isSpreadView ? "book-viewer__spread--single" : ""
          }`}
        >
          <motion.div
            className={`book-viewer__page-slot book-viewer__page-slot--left ${
              !isSpreadView ? "book-viewer__page-slot--single" : ""
            }`}
            style={{ transformOrigin: isSpreadView ? "right center" : "center center" }}
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

          {isSpreadView && (
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
