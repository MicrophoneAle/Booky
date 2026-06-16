import { Fragment } from "react"
import {
  buildChapterPageMap,
  buildFrontMatterPack,
  buildImageChapterPageMap,
  extractImageChapterTocEntries,
  formatImageChapterTocTitle,
  flattenDocument,
  getImageChapterAccessibilityLabel,
  groupFrontMatterPlacementUnits,
  inferBlockIsChapterStart,
  isChapterBoundaryText,
  isFullPageIllustrationItem,
  normalizeImageDimensions,
  resolveImageLayoutMetrics,
  CHAPTER_WITH_SUBTITLE_REGEX,
  isFrontMatterVisualType,
  isTitlePageVisualItems,
  resolveHeadingVisualType,
  shouldCenterTitlePage,
  isShortDialogueLine,
  proseShouldBeCentered,
} from "../../utils/paginator.js"
import {
  PAGE_WIDTH_PX,
  PAGE_CONTENT_INSET_PX,
  PAGE_HEIGHT_PX,
  MOBILE_FULLSCREEN_PAGE_HEIGHT_PX,
  MOBILE_FULLSCREEN_TOP_INSET_PX,
  MOBILE_FULLSCREEN_BOTTOM_CHROME_PX,
  MOBILE_FULLSCREEN_FOOTER_BLOCK_PX,
  PAGE_FOOTER_RESERVE_PX,
  PAGE_BOTTOM_INSET_PX,
  PAGE_NUMBER_RESERVED_PX,
  BODY_DESCENDER_PAD_PX,
  PAGE_CONTENT_FIT_BUFFER_PX,
  PAGE_FIT_OVERFLOW_TOLERANCE_PX,
  BODY_BOTTOM_PADDING_PX,
  CONTENT_HEIGHT_SAFETY_BUFFER_PX,
  TRIVIAL_LAST_PAGE_CHAR_LIMIT,
  PAGINATION_MEASUREMENT_VERSION,
  MOBILE_FULLSCREEN_PAGE_NUMBER_RESERVED_PX,
  MOBILE_PAGE_NUMBER_RESERVED_PX,
} from "./constants.js"
import {
  DEFAULT_SETTINGS,
  FONT_FAMILY_MAP,
  getPageChromeStyle,
  resolveFontMetrics,
  resolveLineHeight,
  resolveMarginCss,
} from "./readerSettings.js"
import {
  buildNestedListTree,
  createListElement,
  flattenListTree,
  getListItemDisplayText,
  getListItemKind,
  getMarkerLetterPosition,
  getMarkerNumber,
  isChapterBoundaryItem,
  isHeadingVisualItem,
  listItemClassName,
  proseParagraphClassName,
  proseRunClassName,
  TRIVIAL_LIST_PAGE_CHAR_LIMIT,
  EMBEDDED_LIST_MARKER_REGEX,
  CHAPTER_LABEL_REGEX,
} from "./listRendering.jsx"
import { buildPageTextMap } from "./readingAnchor.js"
import { highlightTextContent } from "./highlight.jsx"
import { resolvePaginationCacheContext, readPaginationCache } from "./paginationCache.js"
export function getPageTextCapacity(contentMaxHeight, font, line) {
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

export function bodyContentFitsPage(bodyEl, fitHeight) {
  const limit = Math.floor(fitHeight) + PAGE_FIT_OVERFLOW_TOLERANCE_PX
  if (!bodyEl.lastElementChild) {
    return true
  }

  // scrollHeight tracks the full stacked content more reliably than the last
  // child's offset box alone (which can leave several lines of slack per page).
  return bodyEl.scrollHeight <= limit
}

export function getPageNumberReservedPx(isMobileViewport, mobileFullscreen = false) {
  if (mobileFullscreen) {
    return MOBILE_FULLSCREEN_PAGE_NUMBER_RESERVED_PX
  }
  return isMobileViewport ? MOBILE_PAGE_NUMBER_RESERVED_PX : PAGE_NUMBER_RESERVED_PX
}

export function getLayoutHeights(
  pageHeightOverride,
  marginSetting,
  pageNumberReservedPx = PAGE_NUMBER_RESERVED_PX,
  { pageInsetTopPx = 0, pageInsetBottomPx = 0 } = {}
) {
  const remPx =
    parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const rawMargin = resolveMarginCss(marginSetting)
  const marginPx = rawMargin === "0px" ? 0 : parseFloat(rawMargin) * remPx
  const pageHeight = pageHeightOverride ?? PAGE_HEIGHT_PX
  const contentMaxHeight =
    pageHeight -
    marginPx -
    pageInsetTopPx -
    pageInsetBottomPx -
    pageNumberReservedPx -
    BODY_BOTTOM_PADDING_PX -
    CONTENT_HEIGHT_SAFETY_BUFFER_PX

  return { pageOuterHeight: pageHeight, contentMaxHeight }
}

export function createMeasureElements() {
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

export function getCachedFlatBlocks(bookDocument, cacheRef) {
  if (!bookDocument) {
    return []
  }

  if (cacheRef.bookId === bookDocument.id && cacheRef.blocks) {
    return cacheRef.blocks
  }

  const blocks = flattenDocument(bookDocument)
  cacheRef.bookId = bookDocument.id
  cacheRef.blocks = blocks
  return blocks
}

export function getOrCreateMeasurePool(poolRef) {
  if (poolRef.current) {
    return poolRef.current
  }

  const created = createMeasureElements()
  poolRef.current = created
  return created
}

export function releaseMeasurePool(poolRef) {
  if (poolRef.current?.root?.isConnected) {
    poolRef.current.root.remove()
  }
  poolRef.current = null
}

export function setupMeasureElements(
  measureElements,
  paginationSettings,
  mobileViewport,
  mobileFS,
  mobileFullscreenPageHeight = MOBILE_FULLSCREEN_PAGE_HEIGHT_PX
) {
  const marginSettings = mobileFS ? { margins: "none" } : paginationSettings
  const pageHeightToUse = mobileFS ? mobileFullscreenPageHeight : undefined
  const pageNumberReservedPx = getPageNumberReservedPx(mobileViewport, mobileFS)
  const pageInsetTopPx = mobileFS ? MOBILE_FULLSCREEN_TOP_INSET_PX : 0
  const pageInsetBottomPx = mobileFS
    ? MOBILE_FULLSCREEN_BOTTOM_CHROME_PX
    : PAGE_BOTTOM_INSET_PX
  const { pageOuterHeight, contentMaxHeight } = getLayoutHeights(
    pageHeightToUse,
    marginSettings,
    pageNumberReservedPx,
    { pageInsetTopPx, pageInsetBottomPx }
  )

  const { page, body, footer } = measureElements
  page.className = "book-page"
  page.style.height = `${pageOuterHeight}px`
  page.style.display = "flex"
  page.style.flexDirection = "column"
  page.style.boxSizing = "border-box"
  page.style.setProperty("--page-footer-reserve", `${PAGE_FOOTER_RESERVE_PX}px`)
  page.style.overflow = "visible"

  page.classList.remove("book-page--mobile-fs")
  for (const themeClass of [...page.classList].filter((name) =>
    name.startsWith("book-page--theme-")
  )) {
    page.classList.remove(themeClass)
  }

  if (mobileFS) {
    page.classList.add("book-page--mobile-fs")
    page.style.paddingTop = `${pageInsetTopPx}px`
    page.style.paddingRight = "0"
    page.style.paddingLeft = "0"
    page.style.paddingBottom = `${pageInsetBottomPx}px`
    page.style.setProperty("--mobile-fs-content-h", `${contentMaxHeight}px`)
    page.style.setProperty("--mobile-fs-footer-block", `${MOBILE_FULLSCREEN_FOOTER_BLOCK_PX}px`)
  } else {
    const pageChrome = getPageChromeStyle(paginationSettings, mobileViewport)
    page.style.paddingTop = pageChrome.paddingTop ?? "0"
    page.style.paddingRight = pageChrome.paddingRight ?? "0"
    page.style.paddingLeft = pageChrome.paddingLeft ?? "0"
    page.style.paddingBottom = pageChrome.paddingBottom ?? `${PAGE_BOTTOM_INSET_PX}px`
    page.style.setProperty("--page-content-h", pageChrome["--page-content-h"])
  }

  body.style.padding = "0"
  body.style.paddingBottom = `${BODY_BOTTOM_PADDING_PX}px`
  body.style.minWidth = "0"
  body.style.overflow = "hidden"
  footer.style.display = "none"
  // Always shrink-wrap during measurement. Fixed body height makes scrollHeight
  // equal the container height, so pagination falsely treats each paragraph as
  // filling a whole page (mobile fullscreen was hit hardest).
  body.style.flex = "0 0 auto"
  body.style.minHeight = "0"
  body.style.height = "auto"
  body.style.maxHeight = `${contentMaxHeight}px`

  const font = resolveFontMetrics(paginationSettings)
  const line = resolveLineHeight(paginationSettings)
  const family =
    FONT_FAMILY_MAP[paginationSettings.fontStyle] ?? FONT_FAMILY_MAP.lora
  const pageLayout = {
    contentMaxHeight,
    contentWidth: PAGE_WIDTH_PX - PAGE_CONTENT_INSET_PX,
    font,
    line,
    ...getPageTextCapacity(contentMaxHeight, font, line),
  }

  page.style.setProperty("--fs-body", `${font.body}px`)
  page.style.setProperty("--fs-heading", `${font.heading}px`)
  page.style.setProperty("--fs-title", `${font.title}px`)
  page.style.setProperty("--ff-body", family.body)
  page.style.setProperty("--ff-heading", family.heading)
  page.style.setProperty("--lh-body", line.body)
  page.style.setProperty("--lh-heading", line.heading)
  page.classList.add(`book-page--theme-${paginationSettings.theme}`)

  return pageLayout
}

export function measureDocumentPages(flatBlocks, measureElements, pageLayout) {
  const result = paginateBlocksByDom(flatBlocks, measureElements.body, pageLayout)
  const pages = Array.isArray(result) ? result : result.pages
  return cleanupPages(pages, measureElements.body, pageLayout)
}

export function computeMobileFullscreenPages(
  bookDocument,
  paginationSettings,
  flatBlocksCache,
  measurePoolRef,
  mobileFullscreenPageHeight = estimateMobileFullscreenPageHeight()
) {
  const flatBlocks = getCachedFlatBlocks(bookDocument, flatBlocksCache)
  const measureElements = getOrCreateMeasurePool(measurePoolRef)
  const pageLayout = setupMeasureElements(
    measureElements,
    paginationSettings,
    true,
    true,
    mobileFullscreenPageHeight
  )
  return measureDocumentPages(flatBlocks, measureElements, pageLayout)
}

export function readMobileFullscreenCache(bookDocument, paginationSettings, mobileFullscreenPageHeight) {
  const { cacheKey, parserVersion } = resolvePaginationCacheContext(
    bookDocument.id,
    bookDocument.parserVersion,
    paginationSettings,
    {
      mobile: true,
      mobileFullscreen: true,
      mobileFullscreenPageHeight,
    }
  )
  return {
    cacheKey,
    parserVersion,
    cached: readPaginationCache(cacheKey, parserVersion),
  }
}

export function buildLayoutBundle(pages, chapters) {
  const textChapterMap = buildChapterPageMap(pages, chapters ?? [])
  const imageChapterMap = buildImageChapterPageMap(pages)

  return {
    pages,
    chapterMap: { ...textChapterMap, ...imageChapterMap },
    pageTextMap: buildPageTextMap(pages),
  }
}

export function splitTextAtEmbeddedListMarkers(text) {
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

export function expandBlocksForEmbeddedListMarkers(blocks) {
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
export function groupBlocksForDisplay(blocks) {
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

    if (block.type === "image") {
      if (!block.src) {
        continue
      }

      visualItems.push({
        type: "image",
        id: block.id ?? null,
        src: block.src,
        imageRole: block.imageRole ?? null,
        boundaryKind: block.chapterMetadata?.boundaryKind ?? null,
        isChapterBoundary: Boolean(block.isChapterBoundary),
        chapterMetadata: block.chapterMetadata ?? null,
        coordinates: block.coordinates ?? null,
        dimensions: normalizeImageDimensions(block),
      })
      continue
    }

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

      const nextIsChapterSubtitle =
        isChapterStart &&
        nextText &&
        !nextBlock?.isHeading &&
        !CHAPTER_WITH_SUBTITLE_REGEX.test(text) &&
        nextBlock?.textAlign === "center" &&
        nextText.length <= 72 &&
        !/^["'\u201c]/.test(nextText) &&
        !/^[a-z]/.test(nextText) &&
        !(nextText.length > 45 && /,\s/.test(nextText))

      if (nextIsChapterSubtitle) {
        const parts = text.match(
          /^(chapter|letter)\s+(\d{1,3}|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\.?\s*$/i
        )
        if (parts) {
          const label = parts[1].charAt(0).toUpperCase() + parts[1].slice(1).toLowerCase()
          headingText = `${label} ${parts[2]} - ${nextText}`
          index += 1
        }
      }

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

      const itemType =
        isChapterStart || CHAPTER_WITH_SUBTITLE_REGEX.test(headingText)
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

export function appendSingleListNode(listEl, node) {
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

export function appendGroupedListNodes(parentEl, nodes) {
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

export function getPageContentWidthPx(pageLayout) {
  return pageLayout?.contentWidth ?? PAGE_WIDTH_PX - PAGE_CONTENT_INSET_PX
}

export function applyImageLayoutStylesToElement(element, styles) {
  if (!element || !styles) {
    return
  }

  for (const [key, value] of Object.entries(styles)) {
    if (value != null && value !== "") {
      element.style[key] = value
    }
  }
}

export function illustrationClassNames(item) {
  return [
    "book-page__illustration",
    item?.imageRole === "chapter_heading"
      ? "book-page__illustration--chapter-heading"
      : "",
    isFullPageIllustrationItem(item)
      ? "book-page__illustration--full-page"
      : "",
    item?.isChapterBoundary ? "book-page__illustration--chapter-boundary" : "",
  ]
    .filter(Boolean)
    .join(" ")
}

export function appendImageMeasureElement(body, item, pageLayout = null) {
  const layout = resolveImageLayoutMetrics(item, {
    contentMaxHeight: pageLayout?.contentMaxHeight ?? 0,
    contentWidth: getPageContentWidthPx(pageLayout),
  })

  const illustration = document.createElement("div")
  illustration.className = illustrationClassNames(item)
  illustration.dataset.blockId = item.id ?? ""

  if (item.isChapterBoundary) {
    const srHeading = document.createElement("h2")
    srHeading.className = "book-page__sr-only"
    srHeading.textContent = getImageChapterAccessibilityLabel(item)
    illustration.appendChild(srHeading)
  }

  const wrapper = document.createElement("div")
  wrapper.className = "book-page__illustration-wrapper"
  applyImageLayoutStylesToElement(wrapper, layout.wrapperStyle)

  if (item.src) {
    const image = document.createElement("img")
    image.className = "book-page__illustration-image"
    image.src = item.src
    image.alt = ""
    image.loading = "eager"
    image.decoding = "sync"
    wrapper.appendChild(image)
  }

  illustration.appendChild(wrapper)
  body.appendChild(illustration)
}

export function ImageLayoutItem({ item, pageLayout = null }) {
  const layout = resolveImageLayoutMetrics(item, {
    contentMaxHeight: pageLayout?.contentMaxHeight ?? 0,
    contentWidth: getPageContentWidthPx(pageLayout),
  })

  return (
    <div
      className={illustrationClassNames(item)}
      data-block-id={item.id ?? ""}
    >
      {item.isChapterBoundary ? (
        <h2 className="book-page__sr-only">{getImageChapterAccessibilityLabel(item)}</h2>
      ) : null}
      <div className="book-page__illustration-wrapper" style={layout.wrapperStyle}>
        {item.src ? (
          <img
            className="book-page__illustration-image"
            src={item.src}
            alt=""
            loading="eager"
            decoding="async"
          />
        ) : null}
      </div>
    </div>
  )
}

export function appendVisualItem(body, item, previousItem = null, pageLayout = null) {
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

  if (item.type === "image") {
    appendImageMeasureElement(body, item, pageLayout)
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

export function renderMeasureBody(body, visualItems, { centerTitlePage = false, pageLayout = null } = {}) {
  body.replaceChildren()
  body.className = centerTitlePage
    ? "book-page__body book-page__body--title-spread"
    : "book-page__body book-page__body--measure"

  for (let index = 0; index < visualItems.length; index += 1) {
    appendVisualItem(body, visualItems[index], visualItems[index - 1], pageLayout)
  }
}

export function applyChapterContextFromItem(item, chapterState) {
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

export function pageContentOverflows(bodyEl, fitHeight) {
  return !bodyContentFitsPage(bodyEl, fitHeight)
}

export function countListItemsInTree(nodes) {
  let count = 0

  for (const node of nodes) {
    count += 1
    if (node.children.length > 0) {
      count += countListItemsInTree(node.children)
    }
  }

  return count
}

export function getListTextLength(nodes) {
  return flattenListTree(nodes).reduce((total, item) => total + item.text.length, 0)
}

export function isTrivialListPage(page) {
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

export function cleanupPages(pages, bodyEl, pageLayout) {
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
        renderMeasureBody(bodyEl, mergedItems, { pageLayout })

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
export function flattenVisualItemsToPlaceables(visualItems) {
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

export function placeablesToVisualItems(placeables) {
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

export function isHeadingPlaceable(placeable) {
  return (
    placeable.type === "title" ||
    placeable.type === "heading" ||
    placeable.type === "chapter"
  )
}

export function isChapterBoundaryPlaceable(placeable) {
  if (placeable.type === "image") {
    return Boolean(placeable.item?.isChapterBoundary)
  }

  return (
    placeable.type === "chapter" || Boolean(placeable.item?.isChapterStart)
  )
}

export function isChapterHeadingImagePlaceable(placeable) {
  return (
    placeable.type === "image" &&
    placeable.item?.imageRole === "chapter_heading"
  )
}

export function isFullPageIllustrationPlaceable(placeable) {
  return (
    placeable.type === "image" &&
    isFullPageIllustrationItem(placeable.item)
  )
}

export function isFrontMatterPlaceable(placeable) {
  return isFrontMatterVisualType(placeable.item?.type ?? placeable.type)
}

export function pageOnlyFrontMatter(placeables) {
  const items = placeablesToVisualItems(placeables)
  return isTitlePageVisualItems(items)
}

export function getChapterItemFromPlaceable(placeable) {
  if (placeable.type === "image" && placeable.item?.isChapterBoundary) {
    return placeable.item
  }

  if (isHeadingPlaceable(placeable)) {
    return placeable.item
  }

  return null
}

export function proseFormattingFields(proseItem) {
  return {
    ...(proseItem.isIndented ? { isIndented: true } : {}),
    ...(proseItem.isContinuation ? { isContinuation: true } : {}),
    ...(proseShouldBeCentered(proseItem) ? { textAlign: "center" } : {}),
    ...(proseItem.bold ? { bold: true } : {}),
    ...(proseItem.italic ? { italic: true } : {}),
    ...(proseItem.runs?.length ? { runs: proseItem.runs } : {}),
  }
}

export function prosePlaceableFromItem(proseItem) {
  return { type: "prose", item: proseItem }
}

export function pagePlaceablesFit(bodyEl, pagePlaceables, pageLayout) {
  const trialVisualItems = placeablesToVisualItems(pagePlaceables)
  renderMeasureBody(bodyEl, trialVisualItems, {
    centerTitlePage: shouldCenterTitlePage(trialVisualItems),
    pageLayout,
  })
  const { fitHeight } = getPageTextCapacity(
    pageLayout.contentMaxHeight,
    pageLayout.font,
    pageLayout.line
  )
  return bodyContentFitsPage(bodyEl, fitHeight)
}

export function splitProseAcrossPages(proseItem, bodyEl, pageLayout, alreadyOnPage) {
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

export function paginateBlocksByDom(flatBlocks, bodyEl, pageLayout, incrementalOpts = null) {
  const { contentMaxHeight } = pageLayout
  const visualItems = groupBlocksForDisplay(flatBlocks)
  const placeables = flattenVisualItemsToPlaceables(visualItems)
  const { frontMatterPack, remainder } = buildFrontMatterPack(placeables)
  const maxPages = incrementalOpts?.maxPages ?? null
  const resume = incrementalOpts?.resume ?? null

  let hitPageLimit = false
  let pages = resume ? resume.pages.map((page) => ({ ...page })) : []
  let currentPagePlaceables = resume ? [...resume.currentPagePlaceables] : []
  let currentActiveChapter = resume?.currentActiveChapter ?? null
  let chapterAtPageStart = resume?.chapterAtPageStart ?? null
  const chapterState = resume?.chapterState
    ? { ...resume.chapterState }
    : {
        pageChapterTitle: null,
        pageIsChapterStart: false,
      }
  let placeableIndex = resume?.placeableIndex ?? 0

  const updateCurrentActiveChapter = (item) => {
    if (item.type === "image" && item.isChapterBoundary) {
      const boundaryKind = item.chapterMetadata?.boundaryKind ?? null
      if (boundaryKind === "interlude_divider" || boundaryKind === "part") {
        return
      }

      const imageTitle = formatImageChapterTocTitle(item.chapterMetadata)
      if (imageTitle && imageTitle !== "Chapter") {
        currentActiveChapter = imageTitle
      }
      return
    }

    if (!isHeadingVisualItem(item)) {
      return
    }

    if (isChapterBoundaryItem(item) || item.type === "title") {
      const headingTitle = item.chapterTitle ?? item.text
      if (headingTitle) {
        currentActiveChapter = headingTitle
      }
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
      if (pageItem.type === "image" && pageItem.isChapterBoundary) {
        const boundaryKind = pageItem.chapterMetadata?.boundaryKind ?? null
        if (boundaryKind === "interlude_divider") {
          continue
        }

        const title = formatImageChapterTocTitle(pageItem.chapterMetadata)
        if (title && title !== "Chapter" && !chaptersOnPage.includes(title)) {
          chaptersOnPage.push(title)
        }
        continue
      }

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
      pageLayout,
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

    if (maxPages !== null && pages.length >= maxPages) {
      hitPageLimit = true
    }
  }

  const buildResumeSnapshot = (nextPlaceableIndex) => ({
    pages: pages.map((page) => ({ ...page })),
    currentPagePlaceables: [...currentPagePlaceables],
    currentActiveChapter,
    chapterAtPageStart,
    chapterState: { ...chapterState },
    placeableIndex: nextPlaceableIndex,
    remainderLength: remainder.length,
  })

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

  if (!resume) {
    placeFrontMatterPack(frontMatterPack)

    if (currentPagePlaceables.length > 0) {
      flushPage()
    }
  }

  for (; placeableIndex < remainder.length; placeableIndex += 1) {
    if (hitPageLimit) {
      break
    }

    const placeable = remainder[placeableIndex]

    if (isChapterBoundaryPlaceable(placeable)) {
      ensureChapterStartsOnNewPage(placeable)
      const followingPlaceable = remainder[placeableIndex + 1]
      const canPairWithFollowing =
        followingPlaceable &&
        !isChapterBoundaryPlaceable(followingPlaceable) &&
        !isFrontMatterPlaceable(followingPlaceable)

      if (isChapterHeadingImagePlaceable(placeable) && canPairWithFollowing) {
        placeHeadingWithFollowing(placeable, followingPlaceable)
        placeableIndex += 1
        continue
      }

      placePlaceable(placeable)
      if (isFullPageIllustrationPlaceable(placeable)) {
        flushPage()
      }
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
    if (isFullPageIllustrationPlaceable(placeable)) {
      flushPage()
    }
  }

  const hasRemainingWork =
    hitPageLimit ||
    placeableIndex < remainder.length ||
    currentPagePlaceables.length > 0

  if (!hitPageLimit) {
    if (currentPagePlaceables.length > 0) {
      flushPage()
    }

    return cleanupPages(pages, bodyEl, pageLayout)
  }

  if (incrementalOpts && hasRemainingWork) {
    return {
      pages,
      complete: false,
      resume: buildResumeSnapshot(placeableIndex),
    }
  }

  if (currentPagePlaceables.length > 0) {
    flushPage()
  }

  return cleanupPages(pages, bodyEl, pageLayout)
}

export function renderListNodeReact(
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

export function renderGroupedListItemsReact(
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

