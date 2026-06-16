import {
  PAGE_WIDTH_PX,
  PAGE_HEIGHT_PX,
  MOBILE_FULLSCREEN_PAGE_HEIGHT_PX,
  MOBILE_FULLSCREEN_PAGE_HEIGHT_MIN_PX,
  MOBILE_FULLSCREEN_TOP_INSET_PX,
  MOBILE_FULLSCREEN_BOTTOM_CHROME_PX,
  MOBILE_FULLSCREEN_PAGE_NUMBER_RESERVED_PX,
  MOBILE_FULLSCREEN_FOOTER_BLOCK_PX,
  PARSER_VERSION,
  PAGINATION_MEASUREMENT_VERSION,
  PAGINATION_CACHE_PREFIX,
  PAGINATION_CACHE_TS_PREFIX,
  PAGINATION_CACHE_MAX_BOOKS,
} from "./constants.js"
import {
  DEFAULT_SETTINGS,
  sanitizeCustomFontSizePx,
  sanitizeCustomLineSpacing,
  sanitizeCustomMarginRem,
} from "./readerSettings.js"
import { getLayoutHeights, getPageNumberReservedPx } from "./measureLayout.jsx"
export function layoutPaginationSettingsEqual(previous, next) {
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

export function isThemeOnlyPaginationChange(previous, next) {
  return (
    layoutPaginationSettingsEqual(previous, next) && previous.theme !== next.theme
  )
}

export function estimateTotalPages(donePages, placeableIndex, remainderLength) {
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

export function getLayoutPaginationSettings(settings) {
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

export function buildPaginationCacheKey(
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
export function getMobileFullscreenDownscale(availW, availH, pageOuterHeight) {
  const widthScale = availW / PAGE_WIDTH_PX
  const heightScale = pageOuterHeight > 0 ? availH / pageOuterHeight : 1
  return Math.min(1, widthScale, heightScale)
}

export function estimateMobileFullscreenPageHeight() {
  const visualViewport = window.visualViewport
  const viewportHeight = Math.round(visualViewport?.height ?? window.innerHeight)
  return Math.max(MOBILE_FULLSCREEN_PAGE_HEIGHT_MIN_PX, viewportHeight)
}

export function resolveMobileFullscreenPageHeight(stageEl = null) {
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

export function getMobileFullscreenLayoutMetrics(pageOuterHeight = MOBILE_FULLSCREEN_PAGE_HEIGHT_PX) {
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
export function getPaginationPageHeight(mobileViewport, mobileFullscreen, mobileFullscreenPageHeight) {
  if (mobileViewport && mobileFullscreen) {
    return mobileFullscreenPageHeight ?? MOBILE_FULLSCREEN_PAGE_HEIGHT_PX
  }

  return PAGE_HEIGHT_PX
}

export function resolvePaginationCacheContext(bookId, parserVersionFromDoc, settings, viewport) {
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

export function readStoredProgressPage(progressKey, initialPage) {
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

export function evictPaginationCacheIfNeeded(exceptBookId = null) {
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

export function deletePaginationCacheEntry(cacheKey) {
  try {
    localStorage.removeItem(cacheKey)
  } catch {
    // Ignore storage errors.
  }
}

export function readPaginationCache(cacheKey, parserVersion) {
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

export function writePaginationCache(cacheKey, bookId, payload) {
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

export async function idbReadPaginationCache(cacheKey, parserVersion) {
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
