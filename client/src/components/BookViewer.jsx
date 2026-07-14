import {
  Fragment,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import {
  buildChapterPageMap,
  buildFrontMatterPack,
  buildImageChapterPageMap,
  chapterTitlesReferToSameChapter,
  extractImageChapterTocEntries,
  formatImageChapterTocTitle,
  formatTocChapterTitle,
  flattenDocument,
  getImageChapterAccessibilityLabel,
  groupFrontMatterPlacementUnits,
  inferBlockIsChapterStart,
  isChapterBoundaryText,
  isFableStoryTitleBlock,
  isSaddlebackStoryChapterBlock,
  isEpigraphOrChapterOpenerProse,
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
} from "../utils/paginator"
import { FullscreenIcon } from "./FullscreenButton"
import "../pages/Reader.css"
import "./BookViewer.css"

const PAGE_WIDTH_PX = 400
const PAGE_CONTENT_INSET_PX = 72
const PAGE_HEIGHT_PX = 600
/** Fallback page height when the stage is not mounted yet (matches 059e9ea). */
const MOBILE_FULLSCREEN_PAGE_HEIGHT_PX = 780
const MOBILE_FULLSCREEN_PAGE_HEIGHT_MIN_PX = 600
const SPINE_PX = 1
const PAGE_FOOTER_RESERVE_PX = 12
const PAGE_BOTTOM_INSET_PX = 2
const PAGE_NUMBER_RESERVED_PX = PAGE_FOOTER_RESERVE_PX
const BODY_DESCENDER_PAD_PX = 5
const PAGE_CONTENT_FIT_BUFFER_PX = 3
const PAGE_FIT_OVERFLOW_TOLERANCE_PX = 0
/** Compact mobile footer reserve (page number line + small breathing room). */
const MOBILE_PAGE_NUMBER_RESERVED_PX = 12
/** Gap above page number + number line in mobile fullscreen. */
const MOBILE_FULLSCREEN_FOOTER_BLOCK_PX = 8
/** Bottom inset so the page number sits near the Safari URL bar. */
const MOBILE_FULLSCREEN_BOTTOM_CHROME_PX = 4
/** Top inset matching .book-page--mobile-fs safe-area padding. */
const MOBILE_FULLSCREEN_TOP_INSET_PX = 8
const MOBILE_FULLSCREEN_PAGE_NUMBER_RESERVED_PX =
  MOBILE_FULLSCREEN_FOOTER_BLOCK_PX
const CONTENT_HEIGHT_SAFETY_BUFFER_PX = 4
const BODY_BOTTOM_PADDING_PX = 2
const TRIVIAL_LAST_PAGE_CHAR_LIMIT = 50
const TYPESETTING_REPAGINATION_DELAY_MS = 32
const PAGINATION_INITIAL_PAGES = 80
const PAGINATION_BATCH_PAGES = 80
/** Keep in sync with server/index.js PARSER_VERSION — invalidates pagination cache when bumped. */
const PARSER_VERSION = 117
/** Bump only when client pagination/measurement logic changes (not server parser). */
const PAGINATION_MEASUREMENT_VERSION = 24
const PAGINATION_CACHE_PREFIX = "booky-pages|"
const PAGINATION_CACHE_TS_PREFIX = "booky-pages-ts|"
/**
 * Each book stores up to two pagination entries (normal + mobile fullscreen),
 * so this caps roughly the number of fully-cached books. Eviction is grouped by
 * book to avoid leaving a book half-cached (which would force re-pagination).
 */
const PAGINATION_CACHE_MAX_BOOKS = 8
const READING_ANCHOR_PREFIX_LENGTH = 40
const LOADING_READY_DISMISS_MS = 150

function layoutPaginationSettingsEqual(previous, next) {
  if (!previous || !next) {
    return false
  }

  const prevLayout = getLayoutPaginationSettings(previous)
  const nextLayout = getLayoutPaginationSettings(next)

  return (
    prevLayout.fontSize === nextLayout.fontSize &&
    prevLayout.fontStyle === nextLayout.fontStyle &&
    prevLayout.lineSpacing === nextLayout.lineSpacing &&
    prevLayout.margins === nextLayout.margins &&
    prevLayout.customFontSizePx === nextLayout.customFontSizePx &&
    prevLayout.customLineSpacing === nextLayout.customLineSpacing &&
    prevLayout.customMarginRem === nextLayout.customMarginRem
  )
}

function isThemeOnlyPaginationChange(previous, next) {
  return (
    layoutPaginationSettingsEqual(previous, next) && previous.theme !== next.theme
  )
}

function estimateTotalPages(donePages, placeableIndex, remainderLength) {
  if (!placeableIndex || placeableIndex >= remainderLength) {
    return donePages
  }

  const safeRemainder = Math.max(1, remainderLength)
  const estimated = Math.max(
    donePages,
    Math.ceil((safeRemainder / placeableIndex) * donePages)
  )

  return Number.isFinite(estimated) ? estimated : donePages
}

function getLayoutPaginationSettings(settings) {
  return {
    fontSize: settings?.fontSize ?? DEFAULT_SETTINGS.fontSize,
    fontStyle: settings?.fontStyle ?? DEFAULT_SETTINGS.fontStyle,
    lineSpacing: settings?.lineSpacing ?? DEFAULT_SETTINGS.lineSpacing,
    margins: settings?.margins ?? DEFAULT_SETTINGS.margins,
    customFontSizePx: sanitizeCustomFontSizePx(settings?.customFontSizePx),
    customLineSpacing: sanitizeCustomLineSpacing(settings?.customLineSpacing),
    customMarginRem: sanitizeCustomMarginRem(settings?.customMarginRem),
  }
}

function buildPaginationCacheKey(
  bookId,
  parserVersion,
  layoutSettings,
  pageWidth,
  pageHeight
) {
  return [
    "booky-pages",
    bookId,
    parserVersion,
    PAGINATION_MEASUREMENT_VERSION,
    layoutSettings.fontSize,
    layoutSettings.customFontSizePx,
    layoutSettings.fontStyle,
    layoutSettings.lineSpacing,
    layoutSettings.customLineSpacing,
    layoutSettings.margins,
    layoutSettings.customMarginRem,
    pageWidth,
    pageHeight,
  ].join("|")
}

/** Downscale only — never upscale (prevents left/right clipping from transform). */
function getMobileFullscreenDownscale(availW, availH, pageOuterHeight) {
  const widthScale = availW / PAGE_WIDTH_PX
  const heightScale = pageOuterHeight > 0 ? availH / pageOuterHeight : 1
  return Math.min(1, widthScale, heightScale)
}

function estimateMobileFullscreenPageHeight() {
  const visualViewport = window.visualViewport
  const viewportHeight = Math.round(visualViewport?.height ?? window.innerHeight)
  return Math.max(MOBILE_FULLSCREEN_PAGE_HEIGHT_MIN_PX, viewportHeight)
}

function resolveMobileFullscreenPageHeight(stageEl = null) {
  if (stageEl) {
    const cs = getComputedStyle(stageEl)
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    const availH = stageEl.clientHeight - padY
    if (availH >= MOBILE_FULLSCREEN_PAGE_HEIGHT_MIN_PX) {
      return Math.round(availH)
    }
  }

  return estimateMobileFullscreenPageHeight()
}

function getMobileFullscreenLayoutMetrics(pageOuterHeight = MOBILE_FULLSCREEN_PAGE_HEIGHT_PX) {
  const pageInsetTopPx = MOBILE_FULLSCREEN_TOP_INSET_PX
  const pageInsetBottomPx = MOBILE_FULLSCREEN_BOTTOM_CHROME_PX
  const pageNumberReservedPx = MOBILE_FULLSCREEN_PAGE_NUMBER_RESERVED_PX
  const { contentMaxHeight } = getLayoutHeights(
    pageOuterHeight,
    "none",
    pageNumberReservedPx,
    { pageInsetTopPx, pageInsetBottomPx }
  )

  return {
    pageOuterHeight,
    contentMaxHeight,
    pageInsetTopPx,
    pageInsetBottomPx,
    footerBlockPx: MOBILE_FULLSCREEN_FOOTER_BLOCK_PX,
  }
}

/** Single source of truth for cache key — same inputs at read and write. */
function getPaginationPageHeight(mobileViewport, mobileFullscreen, mobileFullscreenPageHeight) {
  if (mobileViewport && mobileFullscreen) {
    return mobileFullscreenPageHeight ?? MOBILE_FULLSCREEN_PAGE_HEIGHT_PX
  }

  return PAGE_HEIGHT_PX
}

function resolvePaginationCacheContext(bookId, parserVersionFromDoc, settings, viewport) {
  const layoutSettings = getLayoutPaginationSettings(settings)
  const docParserVersion = Number(parserVersionFromDoc)
  const parserVersion =
    Number.isFinite(docParserVersion) && docParserVersion > 0
      ? docParserVersion
      : PARSER_VERSION
  const pageHeight = getPaginationPageHeight(
    viewport.mobile,
    viewport.mobileFullscreen,
    viewport.mobileFullscreenPageHeight
  )

  return {
    cacheKey: buildPaginationCacheKey(
      bookId,
      parserVersion,
      layoutSettings,
      PAGE_WIDTH_PX,
      pageHeight
    ),
    parserVersion,
    layoutSettings,
    pageHeight,
  }
}

function readStoredProgressPage(progressKey, initialPage) {
  try {
    const saved = Number(localStorage.getItem(progressKey))
    if (Number.isFinite(saved) && saved > 0) {
      return saved
    }
  } catch {
    // Ignore storage read errors.
  }

  return Number.isFinite(initialPage) && initialPage > 0 ? initialPage : 1
}

function evictPaginationCacheIfNeeded(exceptBookId = null) {
  try {
    const allKeys = Object.keys(localStorage).filter((key) =>
      key.startsWith(PAGINATION_CACHE_PREFIX)
    )

    // Group cache keys by bookId (second segment of the key).
    const keysByBook = new Map()
    for (const key of allKeys) {
      const bookId = key.split("|")[1]
      if (!bookId) {
        continue
      }
      if (!keysByBook.has(bookId)) {
        keysByBook.set(bookId, [])
      }
      keysByBook.get(bookId).push(key)
    }

    const books = [...keysByBook.keys()].filter(
      (bookId) => bookId !== String(exceptBookId)
    )
    if (keysByBook.size <= PAGINATION_CACHE_MAX_BOOKS) {
      return
    }

    // Oldest books first (by their stored timestamp).
    books.sort((a, b) => {
      const tsA = Number(localStorage.getItem(`${PAGINATION_CACHE_TS_PREFIX}${a}`) ?? 0)
      const tsB = Number(localStorage.getItem(`${PAGINATION_CACHE_TS_PREFIX}${b}`) ?? 0)
      return tsA - tsB
    })

    let bookCount = keysByBook.size
    for (const bookId of books) {
      if (bookCount <= PAGINATION_CACHE_MAX_BOOKS) {
        break
      }
      for (const key of keysByBook.get(bookId) ?? []) {
        localStorage.removeItem(key)
      }
      localStorage.removeItem(`${PAGINATION_CACHE_TS_PREFIX}${bookId}`)
      bookCount -= 1
    }
  } catch {
    // Ignore eviction errors.
  }
}

function deletePaginationCacheEntry(cacheKey) {
  try {
    localStorage.removeItem(cacheKey)
  } catch {
    // Ignore storage errors.
  }
}

function readPaginationCache(cacheKey, parserVersion) {
  try {
    const raw = localStorage.getItem(cacheKey)
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw)
    if (!parsed?.pages?.length) {
      return null
    }

    const cachedParserVersion = Number(parsed.parserVersion)
    const expectedParserVersion = Number(parserVersion)
    if (
      Number.isFinite(cachedParserVersion) &&
      Number.isFinite(expectedParserVersion) &&
      cachedParserVersion !== expectedParserVersion
    ) {
      deletePaginationCacheEntry(cacheKey)
      return null
    }

    const cachedMeasurementVersion = Number(parsed.measurementVersion)
    if (
      Number.isFinite(cachedMeasurementVersion) &&
      cachedMeasurementVersion !== PAGINATION_MEASUREMENT_VERSION
    ) {
      deletePaginationCacheEntry(cacheKey)
      return null
    }

    return parsed
  } catch {
    deletePaginationCacheEntry(cacheKey)
    return null
  }
}

function writePaginationCache(cacheKey, bookId, payload) {
  // Always mirror to IndexedDB (large quota — handles big books that overflow
  // localStorage). localStorage stays the fast synchronous path for small books.
  void idbWritePaginationCache(cacheKey, payload)
  try {
    evictPaginationCacheIfNeeded(bookId)
    localStorage.setItem(cacheKey, JSON.stringify(payload))
    localStorage.setItem(`${PAGINATION_CACHE_TS_PREFIX}${bookId}`, String(Date.now()))
  } catch (error) {
    if (error?.name !== "QuotaExceededError") {
      return
    }
    try {
      const allKeys = Object.keys(localStorage).filter((key) =>
        key.startsWith(PAGINATION_CACHE_PREFIX)
      )
      for (const key of allKeys) {
        if (key === cacheKey) {
          continue
        }
        localStorage.removeItem(key)
      }
      localStorage.setItem(cacheKey, JSON.stringify(payload))
      localStorage.setItem(`${PAGINATION_CACHE_TS_PREFIX}${bookId}`, String(Date.now()))
    } catch {
      // localStorage is full (large book). IndexedDB mirror above still serves it.
    }
  }
}

const PAGINATION_IDB_NAME = "booky-pagination-cache"
const PAGINATION_IDB_STORE = "pages"
let paginationDbPromise = null

function openPaginationDb() {
  if (paginationDbPromise) {
    return paginationDbPromise
  }
  paginationDbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null)
        return
      }
      const request = indexedDB.open(PAGINATION_IDB_NAME, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(PAGINATION_IDB_STORE)) {
          db.createObjectStore(PAGINATION_IDB_STORE)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return paginationDbPromise
}

async function idbWritePaginationCache(cacheKey, payload) {
  try {
    const db = await openPaginationDb()
    if (!db) {
      return
    }
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(PAGINATION_IDB_STORE, "readwrite")
        tx.objectStore(PAGINATION_IDB_STORE).put(payload, cacheKey)
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  } catch {
    // IndexedDB unavailable — localStorage still covers small books.
  }
}

async function idbReadPaginationCache(cacheKey, parserVersion) {
  try {
    const db = await openPaginationDb()
    if (!db) {
      return null
    }
    const parsed = await new Promise((resolve) => {
      try {
        const tx = db.transaction(PAGINATION_IDB_STORE, "readonly")
        const request = tx.objectStore(PAGINATION_IDB_STORE).get(cacheKey)
        request.onsuccess = () => resolve(request.result ?? null)
        request.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })

    if (!parsed?.pages?.length) {
      return null
    }

    const cachedParserVersion = Number(parsed.parserVersion)
    const expectedParserVersion = Number(parserVersion)
    if (
      Number.isFinite(cachedParserVersion) &&
      Number.isFinite(expectedParserVersion) &&
      cachedParserVersion !== expectedParserVersion
    ) {
      return null
    }

    const cachedMeasurementVersion = Number(parsed.measurementVersion)
    if (
      Number.isFinite(cachedMeasurementVersion) &&
      cachedMeasurementVersion !== PAGINATION_MEASUREMENT_VERSION
    ) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

function visualItemPlainText(item) {
  if (!item) {
    return ""
  }
  if (
    item.type === "prose" ||
    item.type === "heading" ||
    item.type === "chapter" ||
    item.type === "title" ||
    item.type === "subtitle" ||
    item.type === "author"
  ) {
    return item.text ?? ""
  }
  if (item.type === "list") {
    return flattenListText(item.items).join(" ")
  }
  return ""
}

function getReadingAnchorPrefix(pages, currentPage, isSpreadView) {
  const pageIndices = isSpreadView
    ? [currentPage - 1, currentPage]
    : [currentPage - 1]

  for (const pageIndex of pageIndices) {
    const page = pages[pageIndex]
    if (!page) {
      continue
    }

    for (const item of page.visualItems ?? []) {
      const text = visualItemPlainText(item).trim()
      if (text) {
        return text.slice(0, READING_ANCHOR_PREFIX_LENGTH)
      }
    }
  }

  return null
}

function findPageIndexWithAnchorPrefix(pages, anchorPrefix) {
  if (!anchorPrefix) {
    return null
  }

  const normalizedAnchor = anchorPrefix.trim().toLowerCase()
  if (!normalizedAnchor) {
    return null
  }

  for (const page of pages) {
    for (const item of page.visualItems ?? []) {
      const text = visualItemPlainText(item).trim().toLowerCase()
      if (text.startsWith(normalizedAnchor)) {
        return page.pageNumber
      }
    }
  }

  return null
}

/** Concatenated plain text of a page's visual items (stable across page heights). */
function getPagePlainText(page) {
  return (page?.visualItems ?? [])
    .map((item) => visualItemPlainText(item).trim())
    .filter(Boolean)
    .join(" ")
}

/**
 * Whitespace-insensitive character count of a page's text. Whitespace is stripped
 * so the cumulative offset of a given sentence is identical regardless of how many
 * pages precede it (different page heights produce different page counts, and any
 * per-page separator would otherwise drift the offset and misalign the swap).
 */
function getPageTextLength(page) {
  return getPagePlainText(page).replace(/\s+/g, "").length
}

/**
 * Character offset (in the book's whitespace-stripped text) of the first character
 * shown on `currentPage`. Robust to page-height changes because the total text is
 * identical regardless of where pages break.
 */
function getReadingAnchorCharOffset(pages, currentPage) {
  const startIndex = Math.max(0, currentPage - 1)
  let offset = 0
  for (let i = 0; i < startIndex && i < pages.length; i += 1) {
    offset += getPageTextLength(pages[i])
  }
  return offset
}

/** Find the page whose text range contains `targetOffset` (mirrors the forward walk). */
function resolvePageByCharOffset(newPages, targetOffset) {
  if (!Number.isFinite(targetOffset) || targetOffset <= 0 || newPages.length === 0) {
    return newPages.length > 0 ? newPages[0].pageNumber : 1
  }

  let cumulative = 0
  for (let i = 0; i < newPages.length; i += 1) {
    const span = getPageTextLength(newPages[i])
    if (targetOffset < cumulative + span) {
      return newPages[i].pageNumber
    }
    cumulative += span
  }

  return newPages[newPages.length - 1].pageNumber
}

/** Map a whitespace-stripped offset into the original plain-text string. */
function mapStrippedOffsetToPlain(plainText, strippedOffset) {
  let stripped = 0
  for (let i = 0; i < plainText.length; i += 1) {
    if (!/\s/.test(plainText[i])) {
      if (stripped >= strippedOffset) {
        return i
      }
      stripped += 1
    }
  }
  return plainText.length
}

/** Split prose into sentence spans with start/end indices in the source string. */
function splitIntoSentenceSpans(text) {
  const hasReadableChars = (value) => /[\p{L}\p{N}]/u.test(value)
  const hasEnoughBody = (value) =>
    value.replace(/^[\s"'`“”‘’()[\]{}<>-–—]+/, "").trim().length >= 2

  const sentences = []
  // Prefer full sentences that end in terminal punctuation, while still allowing
  // dialogue-style paragraph lines that are separated by line breaks.
  const regex =
    /[^.!?…\n]+[.!?…]+["'`“”‘’)\]]*(?=\s|$)|[^.!?…\n]+(?=\n|$)/g
  let match = regex.exec(text)
  while (match) {
    const raw = match[0]
    const trimmed = raw.trim()
    if (trimmed && hasReadableChars(trimmed) && hasEnoughBody(trimmed)) {
      const start = match.index + raw.indexOf(trimmed)
      sentences.push({
        text: trimmed,
        start,
        end: start + trimmed.length,
      })
    }
    match = regex.exec(text)
  }
  return sentences
}

/**
 * Returns the first full sentence at the reading anchor on `targetPageNumber`.
 * When the page starts mid-paragraph, skips the partial fragment and marks the
 * next complete sentence instead.
 */
function findResumeAnchorSentence(newPages, targetPageNumber, targetOffset) {
  if (!newPages?.length || !Number.isFinite(targetOffset)) {
    return null
  }

  let cumulative = 0
  let targetPage = null
  for (const page of newPages) {
    if (page.pageNumber === targetPageNumber) {
      targetPage = page
      break
    }
    cumulative += getPageTextLength(page)
  }

  if (!targetPage) {
    return null
  }

  const items = targetPage.visualItems ?? []
  const offsetIntoPage = Math.max(0, targetOffset - cumulative)
  let itemCumulative = 0

  for (let i = 0; i < items.length; i += 1) {
    const plain = visualItemPlainText(items[i])
    const strippedLen = plain.replace(/\s+/g, "").length
    if (strippedLen === 0) {
      continue
    }

    if (offsetIntoPage < itemCumulative + strippedLen) {
      const offsetInItem = offsetIntoPage - itemCumulative
      const plainOffset = mapStrippedOffsetToPlain(plain, offsetInItem)
      const sentences = splitIntoSentenceSpans(plain)
      if (sentences.length === 0) {
        return null
      }

      const pageStartsMidItem = offsetInItem > 0
      if (pageStartsMidItem) {
        const nextFull = sentences.find((sentence) => sentence.start >= plainOffset)
        if (nextFull) {
          return { itemIndex: i, sentenceText: nextFull.text }
        }
        // This item starts mid-sentence and has no later full sentence.
        // Continue scanning the following items for the first complete one.
        itemCumulative += strippedLen
        continue
      }

      const containing = sentences.find(
        (sentence) => plainOffset >= sentence.start && plainOffset < sentence.end
      )
      if (containing) {
        return { itemIndex: i, sentenceText: containing.text }
      }

      const following = sentences.find((sentence) => sentence.start >= plainOffset)
      if (following) {
        return { itemIndex: i, sentenceText: following.text }
      }
      return { itemIndex: i, sentenceText: sentences[0].text }
    }

    itemCumulative += strippedLen
  }

  return null
}

/**
 * Builds a reading anchor capturing both a text prefix and a character offset.
 * Used to preserve reading position across repagination / fullscreen swaps.
 */
function getReadingAnchor(pages, currentPage, isSpreadView) {
  return {
    prefix: getReadingAnchorPrefix(pages, currentPage, isSpreadView),
    charOffset: getReadingAnchorCharOffset(pages, currentPage),
  }
}

function resolvePageAfterRepagination({
  newPages,
  anchor,
  oldPage,
  oldTotal,
  isSpreadView,
  normalizeBookmarkPage,
}) {
  const prefix = typeof anchor === "string" ? anchor : anchor?.prefix ?? null
  const charOffset =
    anchor && typeof anchor === "object" ? anchor.charOffset : null

  // Character-offset matching first — robust both ways (default <-> fullscreen)
  // and across split paragraphs, where prefix matching can miss.
  if (Number.isFinite(charOffset) && charOffset > 0 && newPages.length > 0) {
    const byOffset = resolvePageByCharOffset(newPages, charOffset)
    if (byOffset) {
      return normalizeBookmarkPage(byOffset, newPages.length, isSpreadView)
    }
  }

  const matched = findPageIndexWithAnchorPrefix(newPages, prefix)
  if (matched) {
    return normalizeBookmarkPage(matched, newPages.length, isSpreadView)
  }

  if (oldTotal > 0 && newPages.length > 0) {
    const proportional = Math.round((oldPage / oldTotal) * newPages.length)
    return normalizeBookmarkPage(proportional, newPages.length, isSpreadView)
  }

  return 1
}

function buildPaginationLoadingLabel(percent, isComplete, mode = "opening") {
  if (isComplete || percent >= 100) {
    return mode === "typesetting" ? "Typesetting complete" : "Ready"
  }
  if (percent >= 90) {
    return mode === "typesetting" ? "Finishing typesetting..." : "Almost there..."
  }
  if (percent <= 0) {
    return mode === "typesetting" ? "Applying typesetting..." : "Preparing pages..."
  }
  return mode === "typesetting"
    ? `Applying typesetting… ${percent}%`
    : `Preparing pages… ${percent}%`
}

function computeOpeningLoadingPercent(
  donePages,
  estimatedTotal,
  isComplete,
  placeableProgress = null
) {
  if (isComplete) {
    return 100
  }

  let percent = 0

  if (placeableProgress != null) {
    percent = Math.round(placeableProgress * 100)
  } else if (donePages > 0) {
    const safeTotal = Math.max(donePages, estimatedTotal || donePages, 1)
    percent = Math.round((donePages / safeTotal) * 100)
  }

  if (!Number.isFinite(percent)) {
    percent = 0
  }

  return Math.max(0, Math.min(99, percent))
}

function schedulePageTextMapBuild(measuredPages, buildIdRef, setPageTextMap) {
  const buildId = buildIdRef.current + 1
  buildIdRef.current = buildId

  const runBuild = () => {
    if (buildIdRef.current !== buildId) {
      return
    }
    setPageTextMap(buildPageTextMap(measuredPages))
  }

  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(runBuild, { timeout: 2500 })
  } else {
    setTimeout(runBuild, 0)
  }
}

function buildPageTextMap(measuredPages) {
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

  return textMap
}

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
  if (!bodyEl.lastElementChild) {
    return true
  }

  // scrollHeight tracks the full stacked content more reliably than the last
  // child's offset box alone (which can leave several lines of slack per page).
  return bodyEl.scrollHeight <= limit
}

function getPageNumberReservedPx(isMobileViewport, mobileFullscreen = false) {
  if (mobileFullscreen) {
    return MOBILE_FULLSCREEN_PAGE_NUMBER_RESERVED_PX
  }
  return isMobileViewport ? MOBILE_PAGE_NUMBER_RESERVED_PX : PAGE_NUMBER_RESERVED_PX
}

const DEFAULT_SETTINGS = {
  theme: "parchment",
  fontSize: "medium",
  fontStyle: "lora",
  lineSpacing: "normal",
  margins: "normal",
  customFontSizePx: 10,
  customLineSpacing: 1.15,
  customMarginRem: 0.75,
}

const CUSTOM_FONT_SIZE_LIMITS = { min: 8, max: 22 }
const CUSTOM_LINE_SPACING_LIMITS = { min: 1, max: 2, step: 0.05 }
const CUSTOM_MARGIN_REM_LIMITS = { min: 0, max: 2, step: 0.05 }

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
  palatino: {
    body: "'Palatino Linotype', 'Book Antiqua', Palatino, serif",
    heading: "'Palatino Linotype', 'Book Antiqua', Palatino, serif",
  },
  times: {
    body: "'Times New Roman', Times, serif",
    heading: "'Times New Roman', Times, serif",
  },
  calibri: {
    body: "Calibri, 'Segoe UI', sans-serif",
    heading: "Calibri, 'Segoe UI', sans-serif",
  },
}

const FONT_STYLE_OPTIONS = [
  { id: "lora", label: "Lora" },
  { id: "garamond", label: "Garamond" },
  { id: "georgia", label: "Georgia" },
  { id: "palatino", label: "Palatino" },
  { id: "times", label: "Times New Roman" },
  { id: "calibri", label: "Calibri" },
]

const LINE_HEIGHT_MAP = {
  compact: { body: 1.0, heading: 1.0 },
  normal: { body: 1.15, heading: 1.2 },
  relaxed: { body: 1.5, heading: 1.3 },
  airy: { body: 1.65, heading: 1.4 },
}

const MARGIN_MAP = {
  none: "0px",
  narrow: "0.35rem",
  normal: "0.75rem",
  wide: "1.25rem",
}

function getStepDecimalPlaces(step) {
  const stepText = String(step)
  if (!stepText.includes(".")) {
    return 0
  }
  return stepText.split(".")[1].length
}

function roundToStep(value, step) {
  const decimals = getStepDecimalPlaces(step)
  const rounded = Math.round(value / step) * step
  return Number(rounded.toFixed(decimals))
}

function sanitizeCustomFontSizePx(
  value,
  fallback = DEFAULT_SETTINGS.customFontSizePx
) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.min(
    CUSTOM_FONT_SIZE_LIMITS.max,
    Math.max(CUSTOM_FONT_SIZE_LIMITS.min, Math.round(parsed))
  )
}

function sanitizeCustomLineSpacing(
  value,
  fallback = DEFAULT_SETTINGS.customLineSpacing
) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  const clamped = Math.min(
    CUSTOM_LINE_SPACING_LIMITS.max,
    Math.max(CUSTOM_LINE_SPACING_LIMITS.min, parsed)
  )
  return roundToStep(clamped, CUSTOM_LINE_SPACING_LIMITS.step)
}

function sanitizeCustomMarginRem(
  value,
  fallback = DEFAULT_SETTINGS.customMarginRem
) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback
  }
  const clamped = Math.min(
    CUSTOM_MARGIN_REM_LIMITS.max,
    Math.max(CUSTOM_MARGIN_REM_LIMITS.min, parsed)
  )
  return roundToStep(clamped, CUSTOM_MARGIN_REM_LIMITS.step)
}

function normalizeReaderSettings(settings) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    customFontSizePx: sanitizeCustomFontSizePx(settings?.customFontSizePx),
    customLineSpacing: sanitizeCustomLineSpacing(settings?.customLineSpacing),
    customMarginRem: sanitizeCustomMarginRem(settings?.customMarginRem),
  }
}

function deriveFontMetricsFromBody(bodyPx) {
  const body = sanitizeCustomFontSizePx(bodyPx)
  return {
    body,
    heading: body + 5,
    title: body + 12,
  }
}

function resolveFontMetrics(settings) {
  if (settings?.fontSize === "custom") {
    return deriveFontMetricsFromBody(settings.customFontSizePx)
  }
  return FONT_SIZE_MAP[settings?.fontSize] ?? FONT_SIZE_MAP.medium
}

function resolveLineHeight(settings) {
  if (settings?.lineSpacing === "custom") {
    const body = sanitizeCustomLineSpacing(settings.customLineSpacing)
    const heading = sanitizeCustomLineSpacing(
      Math.min(body + 0.05, body * 1.08),
      body
    )
    return { body, heading }
  }
  return LINE_HEIGHT_MAP[settings?.lineSpacing] ?? LINE_HEIGHT_MAP.normal
}

function resolveMarginCss(settingsOrKey) {
  if (typeof settingsOrKey === "string") {
    return MARGIN_MAP[settingsOrKey] ?? MARGIN_MAP.normal
  }

  const marginKey = settingsOrKey?.margins ?? DEFAULT_SETTINGS.margins
  if (marginKey === "custom") {
    const rem = sanitizeCustomMarginRem(settingsOrKey?.customMarginRem)
    return rem <= 0 ? "0px" : `${rem}rem`
  }

  return MARGIN_MAP[marginKey] ?? MARGIN_MAP.normal
}

function formatFontSizeChipLabel(size, settings) {
  if (size === "custom") {
    const bodyPx = sanitizeCustomFontSizePx(settings?.customFontSizePx)
    return `Custom ${bodyPx}px`
  }
  const name =
    size === "xlarge" ? "XL" : size.charAt(0).toUpperCase() + size.slice(1)
  const bodyPx = FONT_SIZE_MAP[size]?.body ?? FONT_SIZE_MAP.medium.body
  return `${name} ${bodyPx}px`
}

function formatLineSpacingChipLabel(spacing, settings) {
  if (spacing === "custom") {
    const lineHeight = sanitizeCustomLineSpacing(settings?.customLineSpacing)
    return `Custom ${lineHeight}`
  }
  const name = spacing.charAt(0).toUpperCase() + spacing.slice(1)
  const lineHeight =
    LINE_HEIGHT_MAP[spacing]?.body ?? LINE_HEIGHT_MAP.normal.body
  return `${name} ${lineHeight}`
}

function formatMarginChipLabel(margin, settings) {
  if (margin === "custom") {
    const rem = sanitizeCustomMarginRem(settings?.customMarginRem)
    return rem <= 0 ? "Custom 0px" : `Custom ${rem}rem`
  }
  const name = margin.charAt(0).toUpperCase() + margin.slice(1)
  return `${name} ${MARGIN_MAP[margin] ?? MARGIN_MAP.normal}`
}

/** Non-fullscreen chrome: margins + exact paginated body height (matches measurement). */
function getPageContentHeightPx(settingsOrKey, isMobileViewport = false) {
  const { contentMaxHeight } = getLayoutHeights(
    undefined,
    settingsOrKey,
    getPageNumberReservedPx(isMobileViewport, false),
    { pageInsetTopPx: 0, pageInsetBottomPx: PAGE_BOTTOM_INSET_PX }
  )
  return contentMaxHeight
}

function getPageChromeStyle(settingsOrKey, isMobileViewport = false) {
  const pad = resolveMarginCss(settingsOrKey)
  const contentHeightPx = getPageContentHeightPx(settingsOrKey, isMobileViewport)
  return {
    "--page-footer-reserve": `${PAGE_FOOTER_RESERVE_PX}px`,
    "--page-content-h": `${contentHeightPx}px`,
    ...(pad === "0px"
      ? { padding: 0, paddingBottom: `${PAGE_BOTTOM_INSET_PX}px` }
      : {
          paddingTop: pad,
          paddingRight: pad,
          paddingLeft: pad,
          paddingBottom: `${PAGE_BOTTOM_INSET_PX}px`,
        }),
  }
}

const TRIVIAL_LIST_PAGE_CHAR_LIMIT = 30
const STANDALONE_URL_REGEX = /^https?:\/\/\S+$/i

const CHAPTER_LABEL_REGEX =
  /^(Chapter|Part|Section|Prologue|Epilogue)\s+(\d+|[IVXLCDM]+|[A-Za-z]+)$/i
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

  // Verse lines render flush-left with no first-line indent and tight spacing so
  // a poem's line breaks are preserved exactly as written.
  if (proseItem?.isVerse) {
    classes.push("book-page__text--verse")
    if (proseItem?.italic) {
      classes.push("book-page__text--italic")
    }
    return classes.join(" ")
  }

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
  if (proseItem?.bold && !proseShouldBeCentered(proseItem)) {
    classes.push("book-page__text--bold")
  }
  if (proseItem?.italic) {
    classes.push("book-page__text--italic")
  }

  return classes.join(" ")
}

function proseRunClassName(run, proseItem = null) {
  const classes = []
  if (run?.bold && !proseShouldBeCentered(proseItem)) {
    classes.push("book-page__run--bold")
  }
  if (run?.italic) {
    classes.push("book-page__run--italic")
  }
  return classes.length > 0 ? classes.join(" ") : undefined
}

function wrapResumeSentenceHighlight(content, sentenceText) {
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

function getItemRenderablePlain(item) {
  if (item?.runs?.length > 1) {
    return item.runs.map((run) => run.text).join(" ")
  }
  return item.text ?? visualItemPlainText(item)
}

function renderProseContent(
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
        <span className={proseRunClassName(run, item)}>
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

function createListNode(item) {
  return {
    text: item.text,
    level: item.level,
    marker: item.marker ?? "",
    hasBullet: Boolean(item.hasBullet),
    children: [],
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

function getCachedFlatBlocks(bookDocument, cacheRef) {
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

function getOrCreateMeasurePool(poolRef) {
  if (poolRef.current) {
    return poolRef.current
  }

  const created = createMeasureElements()
  poolRef.current = created
  return created
}

function releaseMeasurePool(poolRef) {
  if (poolRef.current?.root?.isConnected) {
    poolRef.current.root.remove()
  }
  poolRef.current = null
}

function setupMeasureElements(
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

function measureDocumentPages(flatBlocks, measureElements, pageLayout) {
  const result = paginateBlocksByDom(flatBlocks, measureElements.body, pageLayout)
  const pages = Array.isArray(result) ? result : result.pages
  return cleanupPages(pages, measureElements.body, pageLayout)
}

function computeMobileFullscreenPages(
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

function readMobileFullscreenCache(bookDocument, paginationSettings, mobileFullscreenPageHeight) {
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

function buildLayoutBundle(pages, chapters) {
  const textChapterMap = buildChapterPageMap(pages, chapters ?? [])
  const imageChapterMap = buildImageChapterPageMap(pages)

  return {
    pages,
    chapterMap: { ...textChapterMap, ...imageChapterMap },
    pageTextMap: buildPageTextMap(pages),
  }
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
    if (last.isVerse) return false
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
        isTitlePageCover: Boolean(block.isTitlePageCover),
        ...(block.forcesOwnPage ? { forcesOwnPage: true } : {}),
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
      if (block.isTitlePage) {
        const titlePageType =
          /^by\s+/i.test(text) || (block.fontSize ?? 0) <= 14
            ? /^by\s+/i.test(text)
              ? "author"
              : "subtitle"
            : "title"
        visualItems.push({
          type: titlePageType,
          text,
          fontSize: block.fontSize ?? 16,
          isTitlePage: true,
          textAlign: block.textAlign,
        })
        continue
      }

      const isFableTitle = isFableStoryTitleBlock(block)
      const isSaddlebackTitle = isSaddlebackStoryChapterBlock(block)
      const headingFontSize = isFableTitle || isSaddlebackTitle ? 15 : (block.fontSize ?? 16)
      const isChapterStart = inferBlockIsChapterStart(block)
      let headingText = text
      if (
        block.chapterTitle &&
        /^part\s+[ivxlcdm\d]+\.?$/i.test(headingText) &&
        block.chapterTitle.length > headingText.length
      ) {
        headingText = block.chapterTitle
      }
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
        isChapterStart ||
        isFableTitle ||
        isSaddlebackTitle ||
        CHAPTER_WITH_SUBTITLE_REGEX.test(headingText)
          ? "chapter"
          : resolveHeadingVisualType(headingFontSize, headingText)

      visualItems.push({
        type: itemType,
        text: headingText,
        fontSize: headingFontSize,
        chapterId: block.chapterId ?? null,
        chapterTitle: block.chapterTitle ?? headingText,
        isChapterStart,
        ...(block.storyChapterNumber != null
          ? { storyChapterNumber: block.storyChapterNumber }
          : {}),
        ...(isSaddlebackTitle ? { isSaddlebackChapter: true } : {}),
      })
      continue
    }

    if (isStandaloneUrl(text)) {
      pushProse(text)
      continue
    }

    // Verse lines are never reflowed into a paragraph: each becomes its own prose
    // item so the poem's original line breaks are preserved on the page.
    if (block.isVerse) {
      visualItems.push({
        type: "prose",
        text,
        isVerse: true,
        ...(block.italic ? { italic: true } : {}),
      })
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

function getPageContentWidthPx(pageLayout) {
  return pageLayout?.contentWidth ?? PAGE_WIDTH_PX - PAGE_CONTENT_INSET_PX
}

function applyImageLayoutStylesToElement(element, styles) {
  if (!element || !styles) {
    return
  }

  for (const [key, value] of Object.entries(styles)) {
    if (value != null && value !== "") {
      element.style[key] = value
    }
  }
}

function illustrationClassNames(item) {
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

function appendImageMeasureElement(body, item, pageLayout = null) {
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

function ImageLayoutItem({ item, pageLayout = null }) {
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

function appendVisualItem(body, item, previousItem = null, pageLayout = null) {
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
    if (item.storyChapterNumber != null) {
      const opener = document.createElement("div")
      opener.className = "book-page__chapter-opener"
      const number = document.createElement("span")
      number.className = "book-page__chapter-number"
      number.textContent = String(item.storyChapterNumber)
      const chapterHeading = document.createElement("h2")
      chapterHeading.className =
        "book-page__chapter-heading book-page__chapter-heading--saddleback"
      chapterHeading.textContent = item.text
      opener.append(number, chapterHeading)
      body.appendChild(opener)
      return
    }

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
        const runClass = proseRunClassName(run, item)
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

function renderMeasureBody(body, visualItems, { centerTitlePage = false, pageLayout = null } = {}) {
  body.replaceChildren()
  body.className = centerTitlePage
    ? "book-page__body book-page__body--title-spread"
    : "book-page__body book-page__body--measure"

  for (let index = 0; index < visualItems.length; index += 1) {
    appendVisualItem(body, visualItems[index], visualItems[index - 1], pageLayout)
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
  if (placeable.type === "image") {
    return Boolean(placeable.item?.isChapterBoundary)
  }

  return (
    placeable.type === "chapter" || Boolean(placeable.item?.isChapterStart)
  )
}

function requiresChapterNewPagePlaceable(placeable) {
  if (isFrontMatterPlaceable(placeable)) {
    return false
  }

  // A standalone plate (e.g. a poetry-collection section illustration) opens its
  // own page rather than sharing one with the preceding poem.
  if (placeable.item?.forcesOwnPage) {
    return true
  }

  if (isChapterBoundaryPlaceable(placeable)) {
    return true
  }

  if (placeable.type === "image" && placeable.item?.isChapterBoundary) {
    return true
  }

  if (placeable.type === "chapter") {
    return true
  }

  const text = (placeable.item?.text ?? "").trim()
  if (text && isChapterBoundaryText(text)) {
    return true
  }

  return false
}

function isChapterHeadingImagePlaceable(placeable) {
  return (
    placeable.type === "image" &&
    placeable.item?.imageRole === "chapter_heading" &&
    !isFullPageIllustrationItem(placeable.item)
  )
}

function isFullPageIllustrationPlaceable(placeable) {
  return (
    placeable.type === "image" &&
    isFullPageIllustrationItem(placeable.item)
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
  if (placeable.type === "image" && placeable.item?.isChapterBoundary) {
    return placeable.item
  }

  if (isHeadingPlaceable(placeable)) {
    return placeable.item
  }

  return null
}

function proseFormattingFields(proseItem) {
  return {
    ...(proseItem.isVerse ? { isVerse: true } : {}),
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
    pageLayout,
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

  // A verse line is an indivisible unit - never break it across pages mid-line.
  // It is short enough to always fit a fresh page, so it simply flows to the
  // next page intact when it does not fit the current one.
  if (proseItem.isVerse) {
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

function paginateBlocksByDom(flatBlocks, bodyEl, pageLayout, incrementalOpts = null) {
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
    if (!requiresChapterNewPagePlaceable(placeable)) {
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
        !isFrontMatterPlaceable(followingPlaceable) &&
        isEpigraphOrChapterOpenerProse(followingPlaceable)

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

    if (requiresChapterNewPagePlaceable(placeable)) {
      ensureChapterStartsOnNewPage(placeable)
    }

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
  isMobileViewport = false,
  mobileFullscreenMetrics = null,
  settings,
  searchQuery = "",
  activeSearchOccurrence = null,
  highlightResumeSentence = null,
}) {
  const themeId = settings?.theme ?? DEFAULT_SETTINGS.theme
  const pageClassName = [
    "book-page",
    `book-page--theme-${themeId}`,
    isMobileFullscreen ? "book-page--mobile-fs" : "",
  ]
    .filter(Boolean)
    .join(" ")

  const fsMetrics =
    mobileFullscreenMetrics ?? getMobileFullscreenLayoutMetrics(MOBILE_FULLSCREEN_PAGE_HEIGHT_PX)
  const pageContentHeightPx = isMobileFullscreen
    ? fsMetrics.contentMaxHeight
    : getPageContentHeightPx(settings, isMobileViewport)

  const pageStyle = isMobileFullscreen
    ? {
        "--page-footer-reserve": `${fsMetrics.footerBlockPx}px`,
        "--mobile-fs-footer-block": `${fsMetrics.footerBlockPx}px`,
        "--mobile-fs-content-h": `${fsMetrics.contentMaxHeight}px`,
        "--mobile-fs-top-inset": `${fsMetrics.pageInsetTopPx}px`,
        "--mobile-fs-bottom-chrome": `${fsMetrics.pageInsetBottomPx}px`,
        paddingTop: `${fsMetrics.pageInsetTopPx}px`,
        paddingBottom: `${fsMetrics.pageInsetBottomPx}px`,
      }
    : getPageChromeStyle(settings, isMobileViewport)

  const bodyStyle =
    !isMobileFullscreen && !page?.centerTitlePage
      ? { maxHeight: `${pageContentHeightPx}px` }
      : undefined

  const imagePageLayout = {
    contentMaxHeight: pageContentHeightPx,
    contentWidth: PAGE_WIDTH_PX - PAGE_CONTENT_INSET_PX,
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
        style={bodyStyle}
      >
        {visualItems.map((item, index) => {
          const renderItemElement = () => {
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
            if (item.storyChapterNumber != null) {
              return (
                <div key={index} className="book-page__chapter-opener">
                  <span className="book-page__chapter-number">
                    {item.storyChapterNumber}
                  </span>
                  <h2 className="book-page__chapter-heading book-page__chapter-heading--saddleback">
                    {highlightTextContent(
                      item.text,
                      searchQuery,
                      highlightTracker,
                      activeSearchOccurrence
                    )}
                  </h2>
                </div>
              )
            }

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

          if (item.type === "image") {
            return (
              <ImageLayoutItem
                key={item.id ?? index}
                item={item}
                pageLayout={imagePageLayout}
              />
            )
          }

          const previousItem = index > 0 ? visualItems[index - 1] : null
          const sentenceForItem =
            highlightResumeSentence?.itemIndex === index
              ? highlightResumeSentence.text
              : null

          return (
            <p key={index} className={proseParagraphClassName(previousItem, item)}>
              {renderProseContent(
                item,
                searchQuery,
                highlightTracker,
                activeSearchOccurrence,
                sentenceForItem
              )}
            </p>
          )
          }

          return renderItemElement()
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

function normalizeTocTitleKey(title) {
  return (title ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^chapter\s+\d+\s*:\s*/i, "")
    .trim()
}

function isTextSectionTocEntry(title) {
  const normalized = (title ?? "").trim()
  if (!normalized) {
    return false
  }
  if (/^(prelude|prologue|epilogue|introduction|preface)\b/i.test(normalized)) {
    return true
  }
  if (/^prelude to\b/i.test(normalized)) {
    return true
  }
  if (/^part\s+/i.test(normalized) && !/\bchapter\b/i.test(normalized)) {
    return true
  }
  return false
}

const TOC_BLOCK_INDEX_STRIDE = 100000

/**
 * Single reading-order key shared by text chapters and image/structural
 * boundaries, derived from the content-stream position (pageIndex first, then
 * blockIndex) that the server now assigns to every chapter. Using one scale for
 * every entry keeps part dividers interleaved correctly with the chapters that
 * surround them instead of mixing the content-page scale (sections) with the
 * reader-page scale (chapters).
 */
function tocReadingOrderKey(pageIndex, blockIndex) {
  if (!Number.isFinite(pageIndex)) {
    return null
  }
  const block = Number.isFinite(blockIndex) ? blockIndex : 0
  return pageIndex * TOC_BLOCK_INDEX_STRIDE + block
}

function tocEntrySortKey(entry) {
  if (Number.isFinite(entry?.readingOrder)) {
    return entry.readingOrder
  }
  // Fallback only for entries that lack a content-stream position (e.g. stale
  // pre-reparse data). Fresh parses always populate readingOrder.
  if (isTextSectionTocEntry(entry.title)) {
    return entry.sourcePageNumber ?? entry.pageNum ?? Number.MAX_SAFE_INTEGER
  }
  return entry.pageNum ?? entry.sourcePageNumber ?? Number.MAX_SAFE_INTEGER
}

function dedupeTocEntries(entries) {
  const seenPageTitle = new Set()
  const deduped = []

  for (const entry of entries) {
    const pageKey = entry.pageNum ?? "unknown"
    const titleKey = normalizeTocTitleKey(entry.title)
    const dedupeKey = `${pageKey}:${titleKey}`
    if (seenPageTitle.has(dedupeKey)) {
      continue
    }

    const chapterDuplicate = deduped.find((existing) =>
      chapterTitlesReferToSameChapter(existing.title, entry.title)
    )
    if (chapterDuplicate) {
      if ((entry.title ?? "").length > (chapterDuplicate.title ?? "").length) {
        chapterDuplicate.title = entry.title
        chapterDuplicate.pageNum = entry.pageNum ?? chapterDuplicate.pageNum
        chapterDuplicate.id = entry.id ?? chapterDuplicate.id
      } else if (chapterDuplicate.pageNum == null && entry.pageNum != null) {
        chapterDuplicate.pageNum = entry.pageNum
      }
      continue
    }

    seenPageTitle.add(dedupeKey)
    deduped.push(entry)
  }

  return deduped
}

function resolveNavChapterTitlesFromToc(tocEntries, pageNumber) {
  if (!pageNumber || tocEntries.length === 0) {
    return []
  }

  let activeTitle = null
  for (const entry of tocEntries) {
    if (entry.pageNum != null && entry.pageNum <= pageNumber) {
      activeTitle = entry.title
    }
  }

  return activeTitle ? [activeTitle] : []
}

function formatNavChapterTitle(pages, currentPage, isSpreadView, tocEntries = []) {
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
  if (!result && tocEntries.length > 0) {
    const pageIndices = [currentPage - 1]
    if (isSpreadView && currentPage < pages.length) {
      pageIndices.push(currentPage)
    }

    const fallbackTitles = []
    for (const pageIndex of pageIndices) {
      const pageNumber = pages[pageIndex]?.pageNumber ?? pageIndex + 1
      for (const title of resolveNavChapterTitlesFromToc(tocEntries, pageNumber)) {
        if (title && !fallbackTitles.includes(title)) {
          fallbackTitles.push(title)
        }
      }
    }

    return fallbackTitles.join(" · ").trim()
  }

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

function InlineCustomSettingChip({
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

export default function BookViewer({
  document: bookDocument,
  initialPage = 1,
  onPageChange,
}) {
  const navigate = useNavigate()
  const progressKey = `booky-progress-${bookDocument?.id ?? ""}`
  const [pages, setPages] = useState([])
  const [isPaginating, setIsPaginating] = useState(true)
  const [isRepaginating, setIsRepaginating] = useState(false)
  const [paginationLoadingMode, setPaginationLoadingMode] = useState("opening")
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [loadingProgressLabel, setLoadingProgressLabel] = useState("Preparing pages...")
  const [currentPage, setCurrentPage] = useState(1)
  const [isMobile, setIsMobile] = useState(false)
  const [layoutMode, setLayoutMode] = useState("spread")
  const [isMobileFullscreen, setIsMobileFullscreen] = useState(false)
  const [fullscreenCacheReady, setFullscreenCacheReady] = useState(false)
  const [showFsTip, setShowFsTip] = useState(false)
  const stageRef = useRef(null)
  const tapCountRef = useRef(0)
  const tapTimerRef = useRef(null)
  const [scale, setScale] = useState(1)
  const [mobileFsDisplayLayout, setMobileFsDisplayLayout] = useState(null)
  const [mobileFsPageHeight, setMobileFsPageHeight] = useState(MOBILE_FULLSCREEN_PAGE_HEIGHT_PX)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [resumeHighlight, setResumeHighlight] = useState(null)
  const resumeHighlightTimerRef = useRef(null)

  const loadSavedSettings = () => {
    try {
      const saved = localStorage.getItem("booky-settings")
      return saved
        ? normalizeReaderSettings(JSON.parse(saved))
        : normalizeReaderSettings(DEFAULT_SETTINGS)
    } catch {
      return normalizeReaderSettings(DEFAULT_SETTINGS)
    }
  }

  const [uiSettings, setUiSettings] = useState(loadSavedSettings)
  const [paginationSettings, setPaginationSettings] = useState(loadSavedSettings)
  const prevPaginationSettingsRef = useRef(null)
  const paginationCancelRef = useRef(false)
  const hasDisplayedBookRef = useRef(false)
  const displayedPagesCountRef = useRef(0)
  const loadingDismissTimerRef = useRef(null)
  const maxLoadingProgressRef = useRef(0)
  const bookmarkPageRef = useRef(null)
  const paginationRunIdRef = useRef(0)
  const openingPaginationStartedRef = useRef(false)
  const openingPaginationInFlightRef = useRef(false)
  const pageTextMapBuildIdRef = useRef(0)
  const isMobileLayoutRef = useRef(false)
  const isMobileFullscreenLayoutRef = useRef(false)
  const [viewportRevision, setViewportRevision] = useState(0)
  const lastPaginatedViewportRevisionRef = useRef(0)
  const lastPaginatedMobileFullscreenRef = useRef(false)
  const fullscreenSwapAtRef = useRef(0)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [customEditField, setCustomEditField] = useState(null)
  const [customEditDraft, setCustomEditDraft] = useState("")
  const customEditInputRef = useRef(null)
  const customEditSuppressCommitRef = useRef(false)
  const customBlurCommitTimerRef = useRef(null)
  const bookmarkDismissAnimationRef = useRef(null)
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
  const [progressHydrated, setProgressHydrated] = useState(false)
  const [bookmarkDismissed, setBookmarkDismissed] = useState(false)
  const [bookmarkHidden, setBookmarkHidden] = useState(false)
  const [bookmarkPosition, setBookmarkPosition] = useState(null)
  const leftPageFaceRef = useRef(null)
  const rightPageFaceRef = useRef(null)
  const bookmarkRef = useRef(null)
  const currentPageRef = useRef(currentPage)
  const hasShownResumeToastRef = useRef(false)
  const hasShownFsTipRef = useRef(false)
  const flatBlocksCacheRef = useRef({ bookId: null, blocks: null })
  const measurePoolRef = useRef(null)
  const fullscreenWarmupRunIdRef = useRef(0)
  const fullscreenLayoutBundleRef = useRef(null)
  const normalLayoutBundleRef = useRef(null)
  const normalLayoutAtEnterRef = useRef(null)
  const initialFullscreenPrepareDoneRef = useRef(false)
  const mobileFullscreenPageHeightRef = useRef(MOBILE_FULLSCREEN_PAGE_HEIGHT_PX)

  const normalizeBookmarkPage = useCallback((page, total, desktopSpreadBehavior) => {
    if (!Number.isFinite(page)) return 1
    const clamped = Math.min(Math.max(1, Number(page)), Math.max(1, total))
    if (desktopSpreadBehavior && clamped % 2 === 0) return Math.max(1, clamped - 1)
    return clamped
  }, [])

  const cancelCustomEdit = useCallback(() => {
    setCustomEditField(null)
    setCustomEditDraft("")
  }, [])

  const commitCustomEditForField = useCallback(
    (field, draft) => {
      if (field === "fontSize") {
        const nextPx = sanitizeCustomFontSizePx(draft, uiSettings.customFontSizePx)
        setUiSettings((s) => ({
          ...s,
          fontSize: "custom",
          customFontSizePx: nextPx,
        }))
      } else if (field === "lineSpacing") {
        const nextSpacing = sanitizeCustomLineSpacing(
          draft,
          uiSettings.customLineSpacing
        )
        setUiSettings((s) => ({
          ...s,
          lineSpacing: "custom",
          customLineSpacing: nextSpacing,
        }))
      } else if (field === "margins") {
        const nextMargin = sanitizeCustomMarginRem(draft, uiSettings.customMarginRem)
        setUiSettings((s) => ({
          ...s,
          margins: "custom",
          customMarginRem: nextMargin,
        }))
      }

      setCustomEditField(null)
      setCustomEditDraft("")
    },
    [
      uiSettings.customFontSizePx,
      uiSettings.customLineSpacing,
      uiSettings.customMarginRem,
    ]
  )

  const commitCustomFontSizeEdit = useCallback(() => {
    commitCustomEditForField("fontSize", customEditDraft)
  }, [commitCustomEditForField, customEditDraft])

  const commitCustomLineSpacingEdit = useCallback(() => {
    commitCustomEditForField("lineSpacing", customEditDraft)
  }, [commitCustomEditForField, customEditDraft])

  const commitCustomMarginEdit = useCallback(() => {
    commitCustomEditForField("margins", customEditDraft)
  }, [commitCustomEditForField, customEditDraft])

  const deferCustomBlurCommit = useCallback(
    (field) => {
      const draft = customEditDraft
      clearTimeout(customBlurCommitTimerRef.current)
      customBlurCommitTimerRef.current = window.setTimeout(() => {
        if (customEditSuppressCommitRef.current) {
          customEditSuppressCommitRef.current = false
          return
        }
        commitCustomEditForField(field, draft)
      }, 0)
    },
    [commitCustomEditForField, customEditDraft]
  )

  const prepareCustomEditCancel = useCallback(() => {
    customEditSuppressCommitRef.current = true
    cancelCustomEdit()
  }, [cancelCustomEdit])

  const startCustomFontSizeEdit = useCallback(() => {
    const nextPx = sanitizeCustomFontSizePx(uiSettings.customFontSizePx)
    setCustomEditField("fontSize")
    setCustomEditDraft(String(nextPx))
  }, [uiSettings.customFontSizePx])

  const startCustomLineSpacingEdit = useCallback(() => {
    const nextSpacing = sanitizeCustomLineSpacing(uiSettings.customLineSpacing)
    setCustomEditField("lineSpacing")
    setCustomEditDraft(String(nextSpacing))
  }, [uiSettings.customLineSpacing])

  const startCustomMarginEdit = useCallback(() => {
    const nextMargin = sanitizeCustomMarginRem(uiSettings.customMarginRem)
    setCustomEditField("margins")
    setCustomEditDraft(String(nextMargin))
  }, [uiSettings.customMarginRem])

  useEffect(() => {
    if (!customEditField) {
      return undefined
    }

    const frameId = requestAnimationFrame(() => {
      customEditInputRef.current?.focus()
      customEditInputRef.current?.select()
    })

    return () => cancelAnimationFrame(frameId)
  }, [customEditField])

  useEffect(() => {
    if (settingsOpen || !customEditField) {
      return
    }

    commitCustomEditForField(customEditField, customEditDraft)
  }, [settingsOpen, customEditField, customEditDraft, commitCustomEditForField])

  useEffect(() => {
    currentPageRef.current = currentPage
  }, [currentPage])

  useEffect(() => {
    displayedPagesCountRef.current = pages.length
  }, [pages.length])

  // Unmount-only cleanup for work scheduled outside effects (callbacks and
  // idle-time builds): otherwise a pending timer / idle callback / animation
  // can fire setState after the reader unmounts.
  useEffect(() => {
    return () => {
      // Invalidates any pending schedulePageTextMapBuild idle callback via
      // its buildId guard.
      pageTextMapBuildIdRef.current += 1
      clearTimeout(resumeHighlightTimerRef.current)
      clearTimeout(customBlurCommitTimerRef.current)
      bookmarkDismissAnimationRef.current?.cancel()
    }
  }, [])

  useEffect(() => {
    prevPaginationSettingsRef.current = null
    lastPaginatedViewportRevisionRef.current = 0
    lastPaginatedMobileFullscreenRef.current = false
    hasDisplayedBookRef.current = false
    openingPaginationStartedRef.current = false
    openingPaginationInFlightRef.current = false
    pageTextMapBuildIdRef.current += 1
    maxLoadingProgressRef.current = 0
    setPaginationLoadingMode("opening")
    setPages([])
    // progressHydrated is owned by useLayoutEffect (bookmark read). Do not clear it here —
    // this effect runs after layout and was leaving progressHydrated false forever.
    setIsPaginating(true)
    setLoadingProgress(0)
    setLoadingProgressLabel("Preparing pages...")
  }, [bookDocument?.id])

  useEffect(() => {
    if (!hasDisplayedBookRef.current) {
      setPaginationSettings(uiSettings)
      return undefined
    }

    const timer = setTimeout(() => {
      setPaginationSettings((previous) => {
        if (
          layoutPaginationSettingsEqual(previous, uiSettings) &&
          previous.theme === uiSettings.theme
        ) {
          return previous
        }
        return { ...uiSettings }
      })
    }, TYPESETTING_REPAGINATION_DELAY_MS)

    return () => clearTimeout(timer)
  }, [uiSettings])

  useEffect(() => {
    try {
      localStorage.setItem("booky-settings", JSON.stringify(uiSettings))
    } catch {
      // Ignore storage write errors (private mode, quota, etc.)
    }
  }, [uiSettings])

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
    flatBlocksCacheRef.current = { bookId: null, blocks: null }
    releaseMeasurePool(measurePoolRef)
    initialFullscreenPrepareDoneRef.current = false
    fullscreenLayoutBundleRef.current = null
    normalLayoutBundleRef.current = null
    normalLayoutAtEnterRef.current = null
  }, [bookDocument?.id])

  useEffect(() => {
    if (!bookDocument) {
      setPages([])
      setIsPaginating(false)
      return undefined
    }

    // Wait for bookmark hydration before any pagination/cache work.
    if (!progressHydrated) {
      return undefined
    }

    const viewport = {
      mobile: window.matchMedia("(max-width: 767px)").matches,
      mobileFullscreen: isMobileFullscreen,
      mobileFullscreenPageHeight:
        isMobileFullscreen && window.matchMedia("(max-width: 767px)").matches
          ? resolveMobileFullscreenPageHeight(stageRef.current)
          : null,
    }
    isMobileLayoutRef.current = viewport.mobile
    isMobileFullscreenLayoutRef.current = viewport.mobileFullscreen
    if (viewport.mobileFullscreenPageHeight != null) {
      mobileFullscreenPageHeightRef.current = viewport.mobileFullscreenPageHeight
      setMobileFsPageHeight(viewport.mobileFullscreenPageHeight)
    }

    const { cacheKey, parserVersion, layoutSettings } = resolvePaginationCacheContext(
      bookDocument.id,
      bookDocument.parserVersion,
      paginationSettings,
      viewport
    )

    const isSpreadViewForTarget = !viewport.mobile && layoutMode === "spread"

    const applyMeasuredPages = (
      measuredPages,
      {
        isFinal = false,
        preservePage = null,
        anchor = null,
        oldPage = null,
        oldTotal = null,
      } = {}
    ) => {
      const totalMeasuredPages = measuredPages.length
      const textChapterMap = buildChapterPageMap(
        measuredPages,
        bookDocument?.chapters ?? []
      )
      const imageChapterMap = buildImageChapterPageMap(measuredPages)
      const chapterMap = { ...textChapterMap, ...imageChapterMap }

      setPages(measuredPages)
      setChapterPageMap(chapterMap)
      schedulePageTextMapBuild(measuredPages, pageTextMapBuildIdRef, setPageTextMap)
      setCurrentPage((previousPage) => {
        const maxPage = Math.max(1, totalMeasuredPages)
        if (totalMeasuredPages === 0) {
          return 1
        }

        if (preservePage !== null && preservePage !== undefined) {
          return normalizeBookmarkPage(preservePage, maxPage, isSpreadViewForTarget)
        }

        if (anchor && oldPage && oldTotal) {
          return resolvePageAfterRepagination({
            newPages: measuredPages,
            anchor,
            oldPage,
            oldTotal,
            isSpreadView: isSpreadViewForTarget,
            normalizeBookmarkPage,
          })
        }

        const target =
          bookmarkPageRef.current ??
          (bookmarkPage !== null && bookmarkPage !== undefined
            ? bookmarkPage
            : previousPage)
        return normalizeBookmarkPage(target, maxPage, isSpreadViewForTarget)
      })

      const resumePage = bookmarkPageRef.current ?? bookmarkPage
      if (
        isFinal &&
        !hasShownResumeToastRef.current &&
        resumePage &&
        resumePage > 1
      ) {
        setRestoredPage(resumePage)
        hasShownResumeToastRef.current = true
      }

      if (isFinal) {
        prevPaginationSettingsRef.current = paginationSettings
        lastPaginatedViewportRevisionRef.current = viewportRevision
        lastPaginatedMobileFullscreenRef.current = isMobileFullscreen

        if (!isMobileFullscreen) {
          normalLayoutBundleRef.current = buildLayoutBundle(
            measuredPages,
            bookDocument?.chapters ?? []
          )
          setFullscreenCacheReady(false)
          fullscreenLayoutBundleRef.current = null
        } else {
          fullscreenLayoutBundleRef.current = buildLayoutBundle(
            measuredPages,
            bookDocument?.chapters ?? []
          )
          setFullscreenCacheReady(true)
        }
      }
    }

    const resolveOpeningBookmarkPage = () =>
      bookmarkPageRef.current ??
      (Number.isFinite(initialPage) && initialPage > 0 ? initialPage : 1)

    const previousPaginationSettingsForCache = prevPaginationSettingsRef.current
    const layoutRepaginationNeeded =
      hasDisplayedBookRef.current &&
      displayedPagesCountRef.current > 0 &&
      previousPaginationSettingsForCache !== null &&
      !layoutPaginationSettingsEqual(
        previousPaginationSettingsForCache,
        paginationSettings
      )

    // Entering/exiting fullscreen makes the browser show/hide its toolbar, which
    // fires a visualViewport resize. Without this guard, that resize triggers a
    // full normal-layout repagination right after exit and freezes the reader.
    const withinFullscreenSwapWindow =
      Date.now() - fullscreenSwapAtRef.current < 1200

    const viewportRepaginationNeeded =
      hasDisplayedBookRef.current &&
      displayedPagesCountRef.current > 0 &&
      viewportRevision !== lastPaginatedViewportRevisionRef.current &&
      !(viewport.mobile && isMobileFullscreen) &&
      !withinFullscreenSwapWindow

    // Consume any viewport bump that occurred during a fullscreen swap so it does
    // not fire a delayed repagination once the suppression window elapses.
    if (
      withinFullscreenSwapWindow &&
      viewportRevision !== lastPaginatedViewportRevisionRef.current
    ) {
      lastPaginatedViewportRevisionRef.current = viewportRevision
    }

    const mobileFullscreenLayoutChanged =
      hasDisplayedBookRef.current &&
      displayedPagesCountRef.current > 0 &&
      lastPaginatedMobileFullscreenRef.current !== isMobileFullscreen

    if (
      mobileFullscreenLayoutChanged &&
      !layoutRepaginationNeeded &&
      !viewportRepaginationNeeded
    ) {
      lastPaginatedMobileFullscreenRef.current = isMobileFullscreen
      return undefined
    }

    const repaginationNeeded =
      layoutRepaginationNeeded || viewportRepaginationNeeded

    const preserveReadingPageRepagination = viewportRepaginationNeeded

    const pagesSnapshotForAnchor = pages
    const layoutAnchor = repaginationNeeded
      ? getReadingAnchor(
          pagesSnapshotForAnchor,
          currentPageRef.current,
          isSpreadViewForTarget
        )
      : null
    const layoutOldPage = currentPageRef.current
    const layoutOldTotal = pagesSnapshotForAnchor.length

    // Opening cache read FIRST — before theme/layout guards (cache is optional).
    const tryApplyOpeningCache = () => {
      let cacheRaw = null
      try {
        if (import.meta.env.DEV) {
          console.log("[cache READ] looking for:", cacheKey)
        }
        cacheRaw = localStorage.getItem(cacheKey)
        if (import.meta.env.DEV) {
          console.log("[cache READ] found:", cacheRaw ? "YES" : "NO")
        }
      } catch (readError) {
        if (import.meta.env.DEV) {
          console.log("[cache READ] found:", "NO (read error)", readError)
        }
        return false
      }

      const cached = readPaginationCache(cacheKey, parserVersion)
      if (!cached?.pages?.length) {
        return false
      }

      openingPaginationStartedRef.current = true
      applyMeasuredPages(cached.pages, {
        isFinal: true,
        preservePage: resolveOpeningBookmarkPage(),
      })
      setIsPaginating(false)
      hasDisplayedBookRef.current = true
      maxLoadingProgressRef.current = 100
      prevPaginationSettingsRef.current = paginationSettings
      lastPaginatedViewportRevisionRef.current = viewportRevision
      lastPaginatedMobileFullscreenRef.current = isMobileFullscreen

      // Warm fullscreen readiness synchronously from cache so reopening is
      // instant — no "Preparing fullscreen" screen when it was cached before.
      if (viewport.mobile && !isMobileFullscreen) {
        const fsCache = readMobileFullscreenCache(
          bookDocument,
          paginationSettings,
          estimateMobileFullscreenPageHeight()
        )
        if (fsCache.cached?.pages?.length) {
          fullscreenLayoutBundleRef.current = buildLayoutBundle(
            fsCache.cached.pages,
            bookDocument?.chapters ?? []
          )
          initialFullscreenPrepareDoneRef.current = true
          setFullscreenCacheReady(true)
        }
      }
      return true
    }

    // Only apply the opening cache during the initial open. Once the book is
    // displayed, re-applying it would reset the reader to the bookmark page
    // (e.g. after a fullscreen swap or a suppressed viewport bump).
    if (
      !openingPaginationInFlightRef.current &&
      !repaginationNeeded &&
      !hasDisplayedBookRef.current
    ) {
      if (tryApplyOpeningCache()) {
        return undefined
      }
    }

    const previousPaginationSettings = prevPaginationSettingsRef.current
    if (
      previousPaginationSettings &&
      isThemeOnlyPaginationChange(previousPaginationSettings, paginationSettings)
    ) {
      prevPaginationSettingsRef.current = paginationSettings
      lastPaginatedMobileFullscreenRef.current = isMobileFullscreen
      setIsRepaginating(false)
      return undefined
    }

    if (
      previousPaginationSettings &&
      hasDisplayedBookRef.current &&
      layoutPaginationSettingsEqual(previousPaginationSettings, paginationSettings) &&
      !repaginationNeeded
    ) {
      prevPaginationSettingsRef.current = paginationSettings
      lastPaginatedViewportRevisionRef.current = viewportRevision
      lastPaginatedMobileFullscreenRef.current = isMobileFullscreen
      setIsRepaginating(false)
      return undefined
    }

    const isSettingsRepagination = repaginationNeeded

    let measureRoot = null
    paginationCancelRef.current = false

    const updatePaginationLoadingUi = (
      donePages,
      estimatedTotal,
      isComplete,
      resume = null
    ) => {
      const placeableProgress =
        resume?.remainderLength > 0
          ? Math.min(1, (resume.placeableIndex ?? 0) / resume.remainderLength)
          : null
      const percent = computeOpeningLoadingPercent(
        donePages,
        estimatedTotal,
        isComplete,
        placeableProgress
      )
      const safePercent = Number.isFinite(percent) ? percent : 0
      const monotonicPercent = isComplete
        ? 100
        : Math.max(maxLoadingProgressRef.current, safePercent)
      maxLoadingProgressRef.current = monotonicPercent
      const progressMode = layoutRepaginationNeeded ? "typesetting" : "opening"
      const label = buildPaginationLoadingLabel(
        monotonicPercent,
        isComplete,
        progressMode
      )

      setLoadingProgress(monotonicPercent)
      setLoadingProgressLabel(label)
    }

    const beginPaginationLoadingScreen = (mode) => {
      maxLoadingProgressRef.current = 0
      setPaginationLoadingMode(mode)
      if (mode === "opening") {
        setIsPaginating(true)
        setIsRepaginating(false)
        setLoadingProgress(0)
        setLoadingProgressLabel("Preparing pages...")
      } else if (mode === "typesetting") {
        setIsRepaginating(true)
        setIsPaginating(false)
        setLoadingProgress(0)
        setLoadingProgressLabel("Applying typesetting...")
      } else {
        setIsRepaginating(true)
      }
      if (mode === "typesetting") {
        setSettingsOpen(false)
        setTocOpen(false)
        setSearchOpen(false)
      }
    }

    const createMeasurementContext = () => {
      const flatBlocks = getCachedFlatBlocks(
        bookDocument,
        flatBlocksCacheRef.current
      )
      const mobileViewport = isMobileLayoutRef.current
      const mobileFS = mobileViewport && isMobileFullscreenLayoutRef.current
      const measureElements = getOrCreateMeasurePool(measurePoolRef)
      measureRoot = measureElements.root
      const fsPageHeight = mobileFS
        ? resolveMobileFullscreenPageHeight(stageRef.current)
        : MOBILE_FULLSCREEN_PAGE_HEIGHT_PX
      const pageLayout = setupMeasureElements(
        measureElements,
        paginationSettings,
        mobileViewport,
        mobileFS,
        fsPageHeight
      )

      return { flatBlocks, measureElements, pageLayout }
    }

    const normalizePaginationResult = (result) => {
      if (Array.isArray(result)) {
        return { pages: result, complete: true, resume: null }
      }

      return result
    }

    const persistPaginationCache = (finalPages, { sync = false } = {}) => {
      const writeContext = resolvePaginationCacheContext(
        bookDocument.id,
        bookDocument.parserVersion,
        paginationSettings,
        {
          mobile: isMobileLayoutRef.current,
          mobileFullscreen: isMobileFullscreenLayoutRef.current,
          mobileFullscreenPageHeight: isMobileFullscreenLayoutRef.current
            ? mobileFullscreenPageHeightRef.current
            : null,
        }
      )
      const payload = {
        parserVersion: writeContext.parserVersion,
        measurementVersion: PAGINATION_MEASUREMENT_VERSION,
        settings: writeContext.layoutSettings,
        pages: finalPages,
        cachedAt: Date.now(),
      }

      const persist = () => {
        if (import.meta.env.DEV) {
          console.log("[cache WRITE]", writeContext.cacheKey, "pages:", finalPages.length)
        }
        writePaginationCache(writeContext.cacheKey, bookDocument.id, payload)
      }

      if (sync) {
        persist()
        return
      }

      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(persist, { timeout: 5000 })
      } else {
        setTimeout(persist, 0)
      }
    }

    const finishMeasurement = (finalPages, measureElements, pageLayout, options = {}) => {
      const cleanedPages = cleanupPages(
        finalPages,
        measureElements.body,
        pageLayout
      )
      applyMeasuredPages(cleanedPages, options)
      return cleanedPages
    }

    const runFullPagination = async ({
      loadingMode = "opening",
      anchor = null,
      oldPage = null,
      oldTotal = null,
      runId = 0,
    } = {}) => {
      const isTypesettingReload = loadingMode === "typesetting"
      const isLayoutReload = loadingMode === "layout"
      const isOpeningRun = loadingMode === "opening"

      const isActiveRun = () =>
        !paginationCancelRef.current && runId === paginationRunIdRef.current

      const abortRun = () => {
        measureRoot = null
        if (isOpeningRun) {
          openingPaginationInFlightRef.current = false
        }
      }

      try {
      // Large books overflow localStorage, so the synchronous opening-cache read
      // misses. Check IndexedDB before doing a full re-pagination.
      if (isOpeningRun) {
        const idbCached = await idbReadPaginationCache(cacheKey, parserVersion)
        if (!isActiveRun()) {
          abortRun()
          return
        }
        if (idbCached?.pages?.length) {
          openingPaginationStartedRef.current = true
          applyMeasuredPages(idbCached.pages, {
            isFinal: true,
            preservePage: resolveOpeningBookmarkPage(),
          })
          setIsPaginating(false)
          hasDisplayedBookRef.current = true
          maxLoadingProgressRef.current = 100
          setLoadingProgress(100)
          setLoadingProgressLabel("Ready")
          prevPaginationSettingsRef.current = paginationSettings
          lastPaginatedViewportRevisionRef.current = viewportRevision
          lastPaginatedMobileFullscreenRef.current = isMobileFullscreen
          abortRun()
          return
        }
      }

      const { flatBlocks, measureElements, pageLayout } = createMeasurementContext()

      if (isLayoutReload) {
        const cleanedPages = measureDocumentPages(
          flatBlocks,
          measureElements,
          pageLayout
        )

        if (!isActiveRun()) {
          abortRun()
          return
        }

        applyMeasuredPages(cleanedPages, {
          isFinal: true,
          anchor,
          oldPage,
          oldTotal,
        })
        prevPaginationSettingsRef.current = paginationSettings
        lastPaginatedViewportRevisionRef.current = viewportRevision
        lastPaginatedMobileFullscreenRef.current = isMobileFullscreen
        if (isMobileFullscreenLayoutRef.current) {
          fullscreenLayoutBundleRef.current = buildLayoutBundle(
            cleanedPages,
            bookDocument?.chapters ?? []
          )
          setFullscreenCacheReady(true)
        }
        persistPaginationCache(cleanedPages, { sync: true })
        setIsRepaginating(false)
        abortRun()
        return
      }

      const runPaginationChunkWithProgress = (runChunk) => {
        const heartbeat = setInterval(() => {
          if (!isActiveRun()) {
            return
          }

          const bumped = Math.min(94, maxLoadingProgressRef.current + 1)
          if (bumped === maxLoadingProgressRef.current) {
            return
          }

          maxLoadingProgressRef.current = bumped
          setLoadingProgress(bumped)
          setLoadingProgressLabel(
            buildPaginationLoadingLabel(
              bumped,
              false,
              isTypesettingReload ? "typesetting" : "opening"
            )
          )
        }, 120)

        try {
          return runChunk()
        } finally {
          clearInterval(heartbeat)
        }
      }

      const estimateFromResult = (pagesDone, resume, isComplete) => {
        if (isComplete) {
          return pagesDone
        }
        if (pagesDone < 10) {
          return Math.max(pagesDone, PAGINATION_INITIAL_PAGES)
        }
        return estimateTotalPages(
          pagesDone,
          resume?.placeableIndex ?? 0,
          resume?.remainderLength ?? 1
        )
      }

      let result = normalizePaginationResult(
        runPaginationChunkWithProgress(() =>
          paginateBlocksByDom(flatBlocks, measureElements.body, pageLayout, {
            maxPages: PAGINATION_INITIAL_PAGES,
          })
        )
      )

      if (!isActiveRun()) {
        abortRun()
        return
      }

      let cumulativePages = result.pages
      let resume = result.resume
      let estimatedTotal = estimateFromResult(
        cumulativePages.length,
        resume,
        result.complete
      )

      updatePaginationLoadingUi(
        cumulativePages.length,
        estimatedTotal,
        false,
        resume
      )

      await new Promise((resolve) => requestAnimationFrame(resolve))

      while (!result.complete) {
        await new Promise((resolve) => requestAnimationFrame(resolve))

        if (!isActiveRun()) {
          abortRun()
          return
        }

        if (!resume) {
          result = normalizePaginationResult(
            runPaginationChunkWithProgress(() =>
              paginateBlocksByDom(flatBlocks, measureElements.body, pageLayout)
            )
          )
          cumulativePages = result.pages
          resume = result.resume
          break
        }

        const nextMaxPages = cumulativePages.length + PAGINATION_BATCH_PAGES
        result = normalizePaginationResult(
          runPaginationChunkWithProgress(() =>
            paginateBlocksByDom(flatBlocks, measureElements.body, pageLayout, {
              maxPages: nextMaxPages,
              resume,
            })
          )
        )

        if (!isActiveRun()) {
          abortRun()
          return
        }

        cumulativePages = result.pages
        resume = result.resume
        estimatedTotal = estimateFromResult(
          cumulativePages.length,
          resume,
          result.complete
        )
        updatePaginationLoadingUi(
          cumulativePages.length,
          estimatedTotal,
          false,
          resume
        )
      }

      if (!result.complete) {
        result = normalizePaginationResult(
          runPaginationChunkWithProgress(() =>
            paginateBlocksByDom(flatBlocks, measureElements.body, pageLayout)
          )
        )
        cumulativePages = result.pages
      }

      if (!isActiveRun()) {
        abortRun()
        return
      }

      updatePaginationLoadingUi(
        cumulativePages.length,
        cumulativePages.length,
        true,
        null
      )

      if (!isTypesettingReload) {
        await new Promise((resolve) => {
          loadingDismissTimerRef.current = setTimeout(resolve, LOADING_READY_DISMISS_MS)
        })

        if (!isActiveRun()) {
          abortRun()
          return
        }
      }

      const applyOptions = isTypesettingReload
        ? { isFinal: true, anchor, oldPage, oldTotal }
        : preserveReadingPageRepagination || isLayoutReload
          ? {
              isFinal: true,
              anchor,
              oldPage,
              oldTotal,
            }
          : { isFinal: true, preservePage: resolveOpeningBookmarkPage() }

      const finalPages = finishMeasurement(
        cumulativePages,
        measureElements,
        pageLayout,
        applyOptions
      )
      persistPaginationCache(finalPages)

      if (isTypesettingReload) {
        maxLoadingProgressRef.current = 100
        setLoadingProgress(100)
        setLoadingProgressLabel(buildPaginationLoadingLabel(100, true, "typesetting"))
        await new Promise((resolve) => {
          loadingDismissTimerRef.current = setTimeout(resolve, LOADING_READY_DISMISS_MS)
        })
        if (!isActiveRun()) {
          abortRun()
          return
        }
        setIsRepaginating(false)
      } else if (isLayoutReload) {
        setIsRepaginating(false)
      } else {
        setIsPaginating(false)
        hasDisplayedBookRef.current = true
        setLoadingProgress(100)
        setLoadingProgressLabel("Ready")
      }

      abortRun()
      } catch (error) {
        console.error("[BookViewer] runFullPagination failed:", error)
        setIsPaginating(false)
        setIsRepaginating(false)
        abortRun()
      }
    }

    if (!isSettingsRepagination) {
      if (openingPaginationInFlightRef.current) {
        return undefined
      }

      if (hasDisplayedBookRef.current && openingPaginationStartedRef.current) {
        return undefined
      }

      openingPaginationStartedRef.current = true
      openingPaginationInFlightRef.current = true
      beginPaginationLoadingScreen("opening")
      setPages([])

      const runId = paginationRunIdRef.current + 1
      paginationRunIdRef.current = runId

      requestAnimationFrame(() => {
        void runFullPagination({ loadingMode: "opening", runId })
      })

      return () => {
        paginationCancelRef.current = true
        paginationRunIdRef.current += 1
        openingPaginationInFlightRef.current = false
        if (loadingDismissTimerRef.current) {
          clearTimeout(loadingDismissTimerRef.current)
          loadingDismissTimerRef.current = null
        }
        measureRoot = null
      }
    }

    beginPaginationLoadingScreen(
      layoutRepaginationNeeded ? "typesetting" : "layout"
    )

    const runId = paginationRunIdRef.current + 1
    paginationRunIdRef.current = runId

    const startLayoutRepagination = () => {
      if (layoutRepaginationNeeded) {
        const pagesSnapshot = pages
        const anchor = getReadingAnchor(
          pagesSnapshot,
          currentPageRef.current,
          isSpreadViewForTarget
        )
        void runFullPagination({
          loadingMode: "typesetting",
          anchor,
          oldPage: currentPageRef.current,
          oldTotal: pagesSnapshot.length,
          runId,
        })
        return
      }

      void runFullPagination({
        loadingMode: "layout",
        anchor: layoutAnchor,
        oldPage: layoutOldPage,
        oldTotal: layoutOldTotal,
        runId,
      })
    }

    if (layoutRepaginationNeeded) {
      requestAnimationFrame(startLayoutRepagination)
    } else {
      startLayoutRepagination()
    }

    return () => {
      paginationCancelRef.current = true
      paginationRunIdRef.current += 1
      if (loadingDismissTimerRef.current) {
        clearTimeout(loadingDismissTimerRef.current)
        loadingDismissTimerRef.current = null
      }
      measureRoot = null
    }
  }, [
    bookDocument,
    initialPage,
    paginationSettings,
    progressHydrated,
    viewportRevision,
    isMobileFullscreen,
    normalizeBookmarkPage,
  ])

  const mobileFullscreenActive = isMobile && isMobileFullscreen
  const mobileFsLayoutMetrics = useMemo(
    () => getMobileFullscreenLayoutMetrics(mobileFsPageHeight),
    [mobileFsPageHeight]
  )
  const activePageHeight = mobileFullscreenActive
    ? mobileFsPageHeight
    : PAGE_HEIGHT_PX

  const isSpreadView = !isMobile && layoutMode === "spread"
  const totalPages = pages.length
  const pageStep = isSpreadView ? 2 : 1
  const maxPageIndex = Math.max(1, totalPages)

  const leftPage = pages[currentPage - 1] ?? null
  const rightPage = isSpreadView ? pages[currentPage] ?? null : null

  // The bookmark is saved as a normal-layout page number. In mobile fullscreen the
  // page numbering differs, so translate it to the current layout via char offset.
  const bookmarkDisplayPage = useMemo(() => {
    if (!bookmarkPage) {
      return null
    }
    if (!mobileFullscreenActive) {
      return bookmarkPage
    }
    const normalPages =
      normalLayoutAtEnterRef.current?.pages ?? normalLayoutBundleRef.current?.pages
    if (!normalPages?.length) {
      return null
    }
    const offset = getReadingAnchorCharOffset(normalPages, bookmarkPage)
    return resolvePageByCharOffset(pages, offset)
  }, [bookmarkPage, mobileFullscreenActive, pages])

  const font = resolveFontMetrics(uiSettings)
  const family = FONT_FAMILY_MAP[uiSettings.fontStyle] ?? FONT_FAMILY_MAP.lora
  const line = resolveLineHeight(uiSettings)

  const isFinalOddSpreadSingle =
    isSpreadView && totalPages % 2 === 1 && Boolean(leftPage) && !rightPage
  const showSpreadLayout = isSpreadView && !isFinalOddSpreadSingle
  const tocEntries = useMemo(() => {
    const imageEntries = extractImageChapterTocEntries(bookDocument).map((entry) => ({
      id: entry.id,
      title: formatTocChapterTitle(formatImageChapterTocTitle(entry.chapterMetadata)),
      pageNum: chapterPageMap[entry.id] ?? null,
      sourcePageNumber: entry.sourcePageNumber ?? null,
      readingOrder: tocReadingOrderKey(entry.pageIndex, entry.blockIndex),
    }))

    const textEntries = (bookDocument?.chapters ?? []).map((chapter) => ({
      id: chapter.id,
      title: formatTocChapterTitle(chapter.title),
      pageNum: chapterPageMap[chapter.id] ?? null,
      sourcePageNumber: Number.isFinite(chapter.sourcePageNumber)
        ? chapter.sourcePageNumber
        : Number.isFinite(chapter.pageIndex)
          ? chapter.pageIndex + 1
          : null,
      readingOrder: tocReadingOrderKey(chapter.pageIndex, chapter.blockIndex),
    }))

    const textChapterEntries = textEntries.filter((entry) =>
      /\bchapter\b/i.test(entry.title ?? "")
    )
    const textSectionEntries = textEntries.filter((entry) =>
      isTextSectionTocEntry(entry.title)
    )

    const useImageChapterToc = imageEntries.length >= 10

    const imageEntriesForToc = useImageChapterToc
      ? imageEntries
      : imageEntries.filter(
          (entry) =>
            !textChapterEntries.some((textEntry) =>
              chapterTitlesReferToSameChapter(textEntry.title, entry.title)
            )
        )

    // In the image-chapter TOC, banners normally supply every chapter, so text
    // chapter entries are dropped to avoid duplicating a banner. That assumption
    // breaks for a genuinely bannerless chapter (none in Way of Kings as of
    // v116 - all 75 have real arch banners - but other illustrated books may
    // have one): it has a server-side text chapter entry but no image entry,
    // so it would otherwise vanish. Add back
    // ONLY the text chapter entries that no image entry already represents,
    // matched with chapterTitlesReferToSameChapter (the same dedupe the
    // non-image branch uses for imageEntriesForToc). This is strictly additive -
    // any chapter covered by a banner matches an image entry and is excluded, so
    // banner-covered chapters are never duplicated. A bannerless chapter opens on
    // the page of the banner that immediately follows it, so when it has no
    // measured page of its own it borrows that following entry's page for
    // display/navigation; chapterPageMap itself is left untouched.
    const unmatchedTextChapterEntries = useImageChapterToc
      ? textChapterEntries
          .filter(
            (textEntry) =>
              !imageEntries.some((imageEntry) =>
                chapterTitlesReferToSameChapter(
                  textEntry.title,
                  imageEntry.title
                )
              )
          )
          .map((textEntry) => {
            if (textEntry.pageNum != null) {
              return textEntry
            }
            const followingEntry = imageEntries
              .filter(
                (imageEntry) =>
                  imageEntry.pageNum != null &&
                  Number.isFinite(imageEntry.readingOrder) &&
                  Number.isFinite(textEntry.readingOrder) &&
                  imageEntry.readingOrder >= textEntry.readingOrder
              )
              .sort((left, right) => left.readingOrder - right.readingOrder)[0]
            return followingEntry
              ? { ...textEntry, pageNum: followingEntry.pageNum }
              : textEntry
          })
      : []

    const combined = useImageChapterToc
      ? [
          ...textSectionEntries,
          ...unmatchedTextChapterEntries,
          ...imageEntriesForToc,
        ]
      : [...textEntries, ...imageEntriesForToc]

    return dedupeTocEntries(
      combined.sort((left, right) => {
        const leftPage = tocEntrySortKey(left)
        const rightPage = tocEntrySortKey(right)
        if (leftPage !== rightPage) {
          return leftPage - rightPage
        }
        return 0
      })
    )
  }, [bookDocument, chapterPageMap])

  const navChapterTitle = formatNavChapterTitle(
    pages,
    currentPage,
    showSpreadLayout,
    tocEntries
  )
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
    const entries = tocEntries
      .filter((entry) => entry.pageNum != null)
      .map((entry) => ({ id: entry.id, pg: entry.pageNum }))
      .sort((a, b) => a.pg - b.pg)

    let active = entries[0]?.id ?? null
    for (const entry of entries) {
      if (currentPage >= entry.pg) {
        active = entry.id
      }
    }
    return active
  }, [currentPage, tocEntries])

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

      if (isMobile && isMobileFullscreen) {
        const fsPageHeight = Math.max(
          MOBILE_FULLSCREEN_PAGE_HEIGHT_MIN_PX,
          Math.round(availH)
        )
        const downscale = getMobileFullscreenDownscale(availW, availH, fsPageHeight)
        setMobileFsPageHeight(fsPageHeight)
        mobileFullscreenPageHeightRef.current = fsPageHeight
        setMobileFsDisplayLayout({
          downscale,
          wrapperW: naturalW * downscale,
          wrapperH: fsPageHeight * downscale,
        })
        setScale(1)
        return
      }

      setMobileFsDisplayLayout(null)
      setScale(fitScale > 0 && Number.isFinite(fitScale) ? fitScale : 1)
    }

    recomputeScale()
    window.addEventListener("resize", recomputeScale)
    document.addEventListener("fullscreenchange", recomputeScale)
    const visualViewport = window.visualViewport
    visualViewport?.addEventListener("resize", recomputeScale)
    visualViewport?.addEventListener("scroll", recomputeScale)
    return () => {
      window.removeEventListener("resize", recomputeScale)
      document.removeEventListener("fullscreenchange", recomputeScale)
      visualViewport?.removeEventListener("resize", recomputeScale)
      visualViewport?.removeEventListener("scroll", recomputeScale)
    }
  }, [showSpreadLayout, isMobile, isMobileFullscreen, isFullscreen, activePageHeight, pages.length, isPaginating])

  useEffect(() => {
    isMobileLayoutRef.current = isMobile
  }, [isMobile])

  useEffect(() => {
    isMobileFullscreenLayoutRef.current = isMobileFullscreen
  }, [isMobileFullscreen])

  useEffect(() => {
    if (!hasDisplayedBookRef.current || displayedPagesCountRef.current === 0) {
      return undefined
    }

    setViewportRevision((revision) => revision + 1)
    return undefined
  }, [isMobile])

  useEffect(() => {
    if (
      !hasDisplayedBookRef.current ||
      displayedPagesCountRef.current === 0 ||
      !isMobile ||
      !isMobileFullscreen
    ) {
      return undefined
    }

    let debounceTimer = null
    const scheduleViewportRepagination = () => {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        setViewportRevision((revision) => revision + 1)
      }, 200)
    }

    const visualViewport = window.visualViewport
    visualViewport?.addEventListener("resize", scheduleViewportRepagination)
    window.addEventListener("orientationchange", scheduleViewportRepagination)

    return () => {
      clearTimeout(debounceTimer)
      visualViewport?.removeEventListener("resize", scheduleViewportRepagination)
      window.removeEventListener("orientationchange", scheduleViewportRepagination)
    }
  }, [isMobile, isMobileFullscreen])

  useEffect(() => {
    setFullscreenCacheReady(false)
    fullscreenLayoutBundleRef.current = null
  }, [
    bookDocument?.id,
    paginationSettings.fontSize,
    paginationSettings.fontStyle,
    paginationSettings.lineSpacing,
    paginationSettings.margins,
  ])

  useEffect(() => {
    if (fullscreenCacheReady) {
      initialFullscreenPrepareDoneRef.current = true
    }
  }, [fullscreenCacheReady])

  useEffect(() => {
    if (!isMobile || !bookDocument?.id || isPaginating || isRepaginating) {
      return undefined
    }

    if (!hasDisplayedBookRef.current || pages.length === 0 || isMobileFullscreen) {
      return undefined
    }

    // Already warmed (e.g. after exiting fullscreen). Rebuilding the bundle here
    // runs buildPageTextMap over the whole book synchronously and freezes the
    // reader, so skip it when a valid bundle is in memory.
    if (fullscreenCacheReady && fullscreenLayoutBundleRef.current?.pages?.length) {
      return undefined
    }

    const estimatedFsPageHeight = estimateMobileFullscreenPageHeight()
    const { cacheKey, parserVersion, cached } = readMobileFullscreenCache(
      bookDocument,
      paginationSettings,
      estimatedFsPageHeight
    )

    if (cached?.pages?.length) {
      fullscreenLayoutBundleRef.current = buildLayoutBundle(
        cached.pages,
        bookDocument.chapters ?? []
      )
      setFullscreenCacheReady(true)
      return undefined
    }

    const warmupRunId = fullscreenWarmupRunIdRef.current + 1
    fullscreenWarmupRunIdRef.current = warmupRunId
    let cancelled = false

    const warmFullscreenCache = async () => {
      if (cancelled || fullscreenWarmupRunIdRef.current !== warmupRunId) {
        return
      }

      const existing = readPaginationCache(cacheKey, parserVersion)
      if (existing?.pages?.length) {
        fullscreenLayoutBundleRef.current = buildLayoutBundle(
          existing.pages,
          bookDocument.chapters ?? []
        )
        setFullscreenCacheReady(true)
        return
      }

      const idbExisting = await idbReadPaginationCache(cacheKey, parserVersion)
      if (cancelled || fullscreenWarmupRunIdRef.current !== warmupRunId) {
        return
      }
      if (idbExisting?.pages?.length) {
        fullscreenLayoutBundleRef.current = buildLayoutBundle(
          idbExisting.pages,
          bookDocument.chapters ?? []
        )
        setFullscreenCacheReady(true)
        return
      }

      const cleanedPages = computeMobileFullscreenPages(
        bookDocument,
        paginationSettings,
        flatBlocksCacheRef.current,
        measurePoolRef,
        estimatedFsPageHeight
      )

      if (cancelled || fullscreenWarmupRunIdRef.current !== warmupRunId) {
        return
      }

      const { layoutSettings } = resolvePaginationCacheContext(
        bookDocument.id,
        bookDocument.parserVersion,
        paginationSettings,
        {
          mobile: true,
          mobileFullscreen: true,
          mobileFullscreenPageHeight: estimatedFsPageHeight,
        }
      )

      writePaginationCache(cacheKey, bookDocument.id, {
        parserVersion,
        measurementVersion: PAGINATION_MEASUREMENT_VERSION,
        settings: layoutSettings,
        pages: cleanedPages,
        cachedAt: Date.now(),
      })

      fullscreenLayoutBundleRef.current = buildLayoutBundle(
        cleanedPages,
        bookDocument.chapters ?? []
      )
      setFullscreenCacheReady(true)
    }

    let idleHandle = null
    if (typeof requestIdleCallback === "function") {
      idleHandle = requestIdleCallback(warmFullscreenCache, { timeout: 5000 })
    } else {
      idleHandle = setTimeout(warmFullscreenCache, 1500)
    }

    return () => {
      cancelled = true
      if (typeof cancelIdleCallback === "function" && idleHandle) {
        cancelIdleCallback(idleHandle)
      } else {
        clearTimeout(idleHandle)
      }
    }
  }, [
    bookDocument,
    paginationSettings,
    isMobile,
    isMobileFullscreen,
    pages.length,
    isPaginating,
    isRepaginating,
    fullscreenCacheReady,
  ])

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)")
    const updateLayout = () => setIsMobile(mediaQuery.matches)

    updateLayout()
    mediaQuery.addEventListener("change", updateLayout)
    return () => mediaQuery.removeEventListener("change", updateLayout)
  }, [])

  useLayoutEffect(() => {
    if (!bookDocument?.id) {
      setBookmarkPage(null)
      bookmarkPageRef.current = null
      setProgressHydrated(false)
      return
    }

    const savedPage = readStoredProgressPage(progressKey, initialPage)
    bookmarkPageRef.current = savedPage
    setBookmarkPage(savedPage)
    setProgressHydrated(true)
  }, [bookDocument?.id, initialPage, progressKey])

  useEffect(() => {
    if (isPaginating || totalPages === 0) return
    if (currentPage > maxPageIndex) {
      setCurrentPage(maxPageIndex)
    }
  }, [currentPage, maxPageIndex, isPaginating, totalPages])

  useEffect(() => {
    if (isPaginating || pages.length === 0) {
      return undefined
    }

    const frameId = requestAnimationFrame(() => {
      viewerRef.current?.focus({ preventScroll: true })
    })

    return () => cancelAnimationFrame(frameId)
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

  const swapReadingLayout = useCallback(
    (layoutBundle, anchor, oldPage, oldTotal, { afterSwap, markResumeAnchor } = {}) => {
      if (!layoutBundle?.pages?.length) {
        return
      }

      const targetPage = resolvePageAfterRepagination({
        newPages: layoutBundle.pages,
        anchor,
        oldPage,
        oldTotal,
        isSpreadView: false,
        normalizeBookmarkPage,
      })

      let resumeMark = null
      if (markResumeAnchor) {
        const charOffset =
          anchor && typeof anchor === "object" ? anchor.charOffset : null
        const anchorSentence = findResumeAnchorSentence(
          layoutBundle.pages,
          targetPage,
          charOffset
        )
        if (anchorSentence?.sentenceText) {
          resumeMark = {
            pageNumber: targetPage,
            itemIndex: anchorSentence.itemIndex,
            sentenceText: anchorSentence.sentenceText,
            token: Date.now(),
          }
        }
      }

      startTransition(() => {
        setPages(layoutBundle.pages)
        setChapterPageMap(layoutBundle.chapterMap)
        setPageTextMap(layoutBundle.pageTextMap)
        setCurrentPage(targetPage)
        if (markResumeAnchor) {
          setResumeHighlight(resumeMark)
        }
        afterSwap?.()
        onPageChange?.(targetPage)
      })

      if (markResumeAnchor) {
        if (resumeHighlightTimerRef.current) {
          clearTimeout(resumeHighlightTimerRef.current)
        }
        if (resumeMark) {
          resumeHighlightTimerRef.current = setTimeout(() => {
            setResumeHighlight(null)
          }, 2800)
        }
      }
    },
    [normalizeBookmarkPage, onPageChange]
  )

  const enterMobileFullscreen = useCallback(() => {
    if (!isMobile || isMobileFullscreen || !fullscreenCacheReady) {
      return
    }

    let fsBundle = fullscreenLayoutBundleRef.current
    if (!fsBundle?.pages?.length) {
      const { cached } = readMobileFullscreenCache(
        bookDocument,
        paginationSettings,
        mobileFsPageHeight
      )
      if (!cached?.pages?.length) {
        return
      }
      fsBundle = buildLayoutBundle(cached.pages, bookDocument?.chapters ?? [])
      fullscreenLayoutBundleRef.current = fsBundle
    }

    normalLayoutAtEnterRef.current = normalLayoutBundleRef.current
    const anchor = getReadingAnchor(pages, currentPageRef.current, false)
    isMobileFullscreenLayoutRef.current = true
    lastPaginatedMobileFullscreenRef.current = true
    fullscreenSwapAtRef.current = Date.now()
    swapReadingLayout(
      fsBundle,
      anchor,
      currentPageRef.current,
      pages.length,
      { afterSwap: () => setIsMobileFullscreen(true), markResumeAnchor: true }
    )
  }, [
    bookDocument,
    fullscreenCacheReady,
    isMobile,
    isMobileFullscreen,
    pages,
    paginationSettings,
    mobileFsPageHeight,
    swapReadingLayout,
  ])

  const exitMobileFullscreen = useCallback(() => {
    if (!isMobile || !isMobileFullscreen) {
      return
    }

    const normalBundle =
      normalLayoutAtEnterRef.current ?? normalLayoutBundleRef.current
    if (!normalBundle?.pages?.length) {
      return
    }

    const anchor = getReadingAnchor(pages, currentPageRef.current, false)
    isMobileFullscreenLayoutRef.current = false
    lastPaginatedMobileFullscreenRef.current = false
    fullscreenSwapAtRef.current = Date.now()
    swapReadingLayout(
      normalBundle,
      anchor,
      currentPageRef.current,
      pages.length,
      { afterSwap: () => setIsMobileFullscreen(false), markResumeAnchor: true }
    )
  }, [isMobile, isMobileFullscreen, pages, swapReadingLayout])

  useEffect(
    () => () => {
      if (resumeHighlightTimerRef.current) {
        clearTimeout(resumeHighlightTimerRef.current)
      }
    },
    []
  )

  const handleStageTap = useCallback(() => {
    if (!isMobile) return
    tapCountRef.current += 1
    clearTimeout(tapTimerRef.current)
    tapTimerRef.current = setTimeout(() => {
      if (tapCountRef.current >= 3) {
        if (isMobileFullscreen) {
          exitMobileFullscreen()
        } else if (fullscreenCacheReady) {
          enterMobileFullscreen()
        }
      }
      tapCountRef.current = 0
    }, 400)
  }, [
    enterMobileFullscreen,
    exitMobileFullscreen,
    fullscreenCacheReady,
    isMobile,
    isMobileFullscreen,
  ])

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
    if (isPaginating || pages.length === 0 || !bookmarkDisplayPage) {
      return undefined
    }

    let frameId = 0
    let innerFrameId = 0
    let outerFrameId = 0
    let retryFrameId = 0
    let retriesLeft = 30

    const isOnBookmarkPage =
      leftPage?.pageNumber === bookmarkDisplayPage ||
      rightPage?.pageNumber === bookmarkDisplayPage

    const measureBookmarkPosition = () => {
      if (bookmarkHidden) {
        setBookmarkPosition(null)
        return
      }

      if (!isOnBookmarkPage) {
        setBookmarkPosition(null)
        return
      }

      const anchorElement =
        leftPage?.pageNumber === bookmarkDisplayPage
          ? leftPageFaceRef.current
          : rightPageFaceRef.current

      const rect = anchorElement?.getBoundingClientRect()
      // On initial open the page face may not be laid out (or the scale transform
      // not yet applied) on the first frame. Retry a few frames before giving up
      // so the ribbon appears without needing to navigate away and back.
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        if (retriesLeft > 0) {
          retriesLeft -= 1
          retryFrameId = requestAnimationFrame(measureBookmarkPosition)
        }
        return
      }

      setBookmarkPosition({
        top: rect.top - 1,
        left: rect.right - 14 - 20,
      })
    }

    const scheduleMeasure = () => {
      cancelAnimationFrame(innerFrameId)
      cancelAnimationFrame(retryFrameId)
      retriesLeft = 30
      innerFrameId = requestAnimationFrame(measureBookmarkPosition)
    }

    outerFrameId = requestAnimationFrame(() => {
      frameId = requestAnimationFrame(scheduleMeasure)
    })
    window.addEventListener("resize", scheduleMeasure)
    window.addEventListener("scroll", scheduleMeasure, true)

    return () => {
      cancelAnimationFrame(outerFrameId)
      cancelAnimationFrame(frameId)
      cancelAnimationFrame(innerFrameId)
      cancelAnimationFrame(retryFrameId)
      window.removeEventListener("resize", scheduleMeasure)
      window.removeEventListener("scroll", scheduleMeasure, true)
    }
  }, [
    bookmarkPage,
    bookmarkDisplayPage,
    bookmarkHidden,
    isPaginating,
    isRepaginating,
    currentPage,
    leftPage?.pageNumber,
    rightPage?.pageNumber,
    pages.length,
    scale,
    // Re-measure once the loading / "Preparing fullscreen" screen is dismissed and
    // the real page DOM mounts, and whenever the fullscreen layout swaps.
    fullscreenCacheReady,
    mobileFullscreenActive,
  ])

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

    bookmarkDismissAnimationRef.current = animation
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
              if (isMobileFullscreen) {
                exitMobileFullscreen()
              } else if (fullscreenCacheReady) {
                enterMobileFullscreen()
              }
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
            exitMobileFullscreen()
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

        case "b":
        case "B":
          if (!event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault()
            persistReadingPosition()
            navigate("/library")
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
    fullscreenCacheReady,
    enterMobileFullscreen,
    exitMobileFullscreen,
    toggleFullscreen,
    setSearchOpen,
    setTocOpen,
    setSettingsOpen,
    setSearchQuery,
    setSearchResults,
    persistReadingPosition,
    navigate,
  ])

  const showFullscreenPrepareScreen =
    isMobile &&
    !isMobileFullscreen &&
    !fullscreenCacheReady &&
    !initialFullscreenPrepareDoneRef.current &&
    pages.length > 0 &&
    !isPaginating &&
    !isRepaginating

  const showTypesettingScreen =
    isRepaginating && paginationLoadingMode === "typesetting"

  if (
    (isPaginating && paginationLoadingMode === "opening") ||
    showTypesettingScreen ||
    showFullscreenPrepareScreen
  ) {
    const loadingSubtext = showFullscreenPrepareScreen
      ? "Preparing fullscreen…"
      : showTypesettingScreen
        ? "Updating layout…"
        : "Opening your book..."
    const progressValue = showFullscreenPrepareScreen ? 100 : loadingProgress
    const progressLabel = showFullscreenPrepareScreen
      ? "Preparing fullscreen…"
      : showTypesettingScreen
        ? loadingProgressLabel
        : buildPaginationLoadingLabel(loadingProgress, loadingProgress >= 100)

    return (
      <div className="reader-screen">
        <div className="reader-screen__content">
          <p className="reader-screen__logo">BOOKY</p>
          <p className="reader-screen__subtext">{loadingSubtext}</p>
          <div
            className="reader-screen__progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressValue}
            aria-label={progressLabel}
          >
            <div
              className={`reader-screen__progress-fill${
                showFullscreenPrepareScreen
                  ? " reader-screen__progress-fill--indeterminate"
                  : ""
              }`}
              style={{
                "--reader-progress": String(
                  Math.max(0, Math.min(100, progressValue)) / 100
                ),
              }}
            />
          </div>
          <p className="reader-screen__progress-label">{progressLabel}</p>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={viewerRef}
      className={`book-viewer book-viewer--theme-${uiSettings.theme}${
        mobileFullscreenActive ? " book-viewer--mobile-fs" : ""
      }${isRepaginating ? " book-viewer--repaginating" : ""}`}
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
            disabled={
              (isPaginating && paginationLoadingMode === "opening") ||
              totalPages === 0
            }
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
              className={`book-viewer__typesetting-btn${
                isRepaginating ? " book-viewer__typesetting-btn--busy" : ""
              }`}
              onClick={() => {
                setSettingsOpen((prev) => !prev)
                setTocOpen(false)
                setSearchOpen(false)
              }}
              title={isRepaginating ? "Applying typesetting…" : "Typesetting"}
              aria-label={isRepaginating ? "Applying typesetting" : "Typesetting"}
              aria-expanded={settingsOpen}
              aria-busy={isRepaginating}
            >
              <NibIcon />
              <span className="book-viewer__typesetting-label">Typesetting</span>
            </button>
          )}

          {!(isMobile && isMobileFullscreen) && (
            <button
              type="button"
              className={`book-viewer__fullscreen${
                isMobile && !fullscreenCacheReady
                  ? " book-viewer__fullscreen--disabled"
                  : ""
              }`}
              onClick={isMobile ? enterMobileFullscreen : toggleFullscreen}
              disabled={isMobile && !fullscreenCacheReady}
              title={
                isMobile && !fullscreenCacheReady
                  ? "Preparing fullscreen…"
                  : isFullscreen
                    ? "Exit fullscreen"
                    : "Enter fullscreen"
              }
              aria-label={
                isMobile && !fullscreenCacheReady
                  ? "Preparing fullscreen"
                  : isFullscreen
                    ? "Exit fullscreen"
                    : "Enter fullscreen"
              }
            >
              <FullscreenIcon />
            </button>
          )}
        </div>
        <div className="book-viewer__progress-bar" aria-hidden="true">
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
          className={`book-viewer__scale-wrapper${
            mobileFsDisplayLayout ? " book-viewer__scale-wrapper--mobile-fs" : ""
          }`}
          style={{
            ...(mobileFsDisplayLayout
              ? {
                  width: mobileFsDisplayLayout.wrapperW,
                  height: mobileFsDisplayLayout.wrapperH,
                }
              : {
                  transform: `scale(${scale})`,
                  transformOrigin: "center center",
                }),
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
            style={{
              // Only force single-page width for the mobile-fullscreen downscale
              // wrapper. On desktop the CSS width:fit-content must win so the
              // two-page spread can hold both page slots (otherwise the right
              // page is clipped by overflow:hidden).
              width: mobileFsDisplayLayout ? PAGE_WIDTH_PX : undefined,
              height: activePageHeight,
              ...(mobileFsDisplayLayout && mobileFsDisplayLayout.downscale < 1
                ? {
                    transform: `scale(${mobileFsDisplayLayout.downscale})`,
                    transformOrigin: "top center",
                  }
                : {}),
            }}
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
                  isMobileViewport={isMobile}
                  mobileFullscreenMetrics={
                    mobileFullscreenActive ? mobileFsLayoutMetrics : null
                  }
                  settings={uiSettings}
                  searchQuery={searchOpen ? searchQuery : ""}
                  activeSearchOccurrence={
                    searchOpen &&
                    searchResults[searchResultIndex]?.pageNumber === leftPage?.pageNumber
                      ? searchResults[searchResultIndex]?.occurrenceOnPage ?? null
                      : null
                  }
                  highlightResumeSentence={
                    resumeHighlight &&
                    leftPage?.pageNumber === resumeHighlight.pageNumber
                      ? {
                          text: resumeHighlight.sentenceText,
                          itemIndex: resumeHighlight.itemIndex,
                        }
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
                        isMobileViewport={isMobile}
                        mobileFullscreenMetrics={
                          mobileFullscreenActive ? mobileFsLayoutMetrics : null
                        }
                        settings={uiSettings}
                        searchQuery={searchOpen ? searchQuery : ""}
                        activeSearchOccurrence={
                          searchOpen &&
                          searchResults[searchResultIndex]?.pageNumber === rightPage?.pageNumber
                            ? searchResults[searchResultIndex]?.occurrenceOnPage ?? null
                            : null
                        }
                        highlightResumeSentence={
                          resumeHighlight &&
                          rightPage?.pageNumber === resumeHighlight.pageNumber
                            ? {
                                text: resumeHighlight.sentenceText,
                                itemIndex: resumeHighlight.itemIndex,
                              }
                            : null
                        }
                      />
                    ) : (
                      <BookPageContent
                        page={null}
                        isMobileFullscreen={mobileFullscreenActive}
                        isMobileViewport={isMobile}
                        mobileFullscreenMetrics={
                          mobileFullscreenActive ? mobileFsLayoutMetrics : null
                        }
                        settings={uiSettings}
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

        {tocEntries.length > 0 ? (
          <nav className="book-viewer__toc-list">
            {tocEntries.map((entry) => {
              const pageNum = entry.pageNum
              const isCurrent = entry.id === activeChapterId
              return (
                <button
                  key={entry.id}
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
                  <span className="book-viewer__toc-title">{entry.title}</span>
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
                    uiSettings.theme === theme.id
                      ? "book-viewer__theme-swatch--active"
                      : ""
                  }`}
                  style={{
                    background: theme.bg,
                    color: theme.ink,
                    border:
                      uiSettings.theme === theme.id
                        ? "2px solid #d4af37"
                        : "2px solid transparent",
                  }}
                  onClick={() => setUiSettings((s) => ({ ...s, theme: theme.id }))}
                  title={theme.label}
                  aria-label={theme.label}
                  aria-pressed={uiSettings.theme === theme.id}
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
                    uiSettings.fontSize === size
                      ? "book-viewer__settings-chip--active"
                      : ""
                  }`}
                  onMouseDown={prepareCustomEditCancel}
                  onClick={() =>
                    setUiSettings((s) => ({
                      ...s,
                      fontSize: size,
                    }))
                  }
                >
                  {formatFontSizeChipLabel(size, uiSettings)}
                </button>
              ))}
              <InlineCustomSettingChip
                field="fontSize"
                editingField={customEditField}
                editInputRef={customEditInputRef}
                isActive={
                  uiSettings.fontSize === "custom" || customEditField === "fontSize"
                }
                displayLabel={formatFontSizeChipLabel("custom", uiSettings)}
                draft={customEditDraft}
                staticSuffix="px"
                onStartEdit={startCustomFontSizeEdit}
                onDraftChange={setCustomEditDraft}
                onCommit={commitCustomFontSizeEdit}
                onBlurCommit={() => deferCustomBlurCommit("fontSize")}
                onCancel={cancelCustomEdit}
              />
            </div>
          </div>

          <div className="book-viewer__settings-section">
            <p className="book-viewer__settings-label">Typeface</p>
            <div className="book-viewer__settings-row">
              {FONT_STYLE_OPTIONS.map((fontOption) => (
                <button
                  key={fontOption.id}
                  type="button"
                  className={`book-viewer__settings-chip ${
                    uiSettings.fontStyle === fontOption.id
                      ? "book-viewer__settings-chip--active"
                      : ""
                  }`}
                  onClick={() =>
                    setUiSettings((s) => ({
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
                    uiSettings.lineSpacing === sp
                      ? "book-viewer__settings-chip--active"
                      : ""
                  }`}
                  onMouseDown={prepareCustomEditCancel}
                  onClick={() =>
                    setUiSettings((s) => ({
                      ...s,
                      lineSpacing: sp,
                    }))
                  }
                >
                  {formatLineSpacingChipLabel(sp, uiSettings)}
                </button>
              ))}
              <InlineCustomSettingChip
                field="lineSpacing"
                editingField={customEditField}
                editInputRef={customEditInputRef}
                isActive={
                  uiSettings.lineSpacing === "custom" ||
                  customEditField === "lineSpacing"
                }
                displayLabel={formatLineSpacingChipLabel("custom", uiSettings)}
                draft={customEditDraft}
                onStartEdit={startCustomLineSpacingEdit}
                onDraftChange={setCustomEditDraft}
                onCommit={commitCustomLineSpacingEdit}
                onBlurCommit={() => deferCustomBlurCommit("lineSpacing")}
                onCancel={cancelCustomEdit}
              />
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
                    uiSettings.margins === m
                      ? "book-viewer__settings-chip--active"
                      : ""
                  }`}
                  onMouseDown={prepareCustomEditCancel}
                  onClick={() =>
                    setUiSettings((s) => ({
                      ...s,
                      margins: m,
                    }))
                  }
                >
                  {formatMarginChipLabel(m, uiSettings)}
                </button>
              ))}
              <InlineCustomSettingChip
                field="margins"
                editingField={customEditField}
                editInputRef={customEditInputRef}
                isActive={
                  uiSettings.margins === "custom" || customEditField === "margins"
                }
                displayLabel={formatMarginChipLabel("custom", uiSettings)}
                draft={customEditDraft}
                staticSuffix="rem"
                onStartEdit={startCustomMarginEdit}
                onDraftChange={setCustomEditDraft}
                onCommit={commitCustomMarginEdit}
                onBlurCommit={() => deferCustomBlurCommit("margins")}
                onCancel={cancelCustomEdit}
              />
            </div>
          </div>

          <div className="book-viewer__settings-section">
            <button
              type="button"
              className="book-viewer__settings-reset"
              onMouseDown={prepareCustomEditCancel}
              onClick={() =>
                setUiSettings(normalizeReaderSettings(DEFAULT_SETTINGS))
              }
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
                { keys: ["B"], label: "Library" },
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
