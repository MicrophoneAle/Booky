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
  extractImageChapterTocEntries,
  formatTocChapterTitle,
} from "../utils/paginator"
import { FullscreenIcon } from "./FullscreenButton"
import "../pages/Reader.css"
import "./BookViewer.css"

import {
  LOADING_READY_DISMISS_MS,
  MOBILE_FULLSCREEN_PAGE_HEIGHT_PX,
  NAVBAR_HEIGHT_PX,
  PAGE_HEIGHT_PX,
  PAGE_WIDTH_PX,
  PAGINATION_BATCH_PAGES,
  PAGINATION_INITIAL_PAGES,
  PARSER_VERSION,
  SPINE_PX,
  TYPESETTING_REPAGINATION_DELAY_MS,
} from "./bookViewer/constants.js"
import {
  estimateMobileFullscreenPageHeight,
  estimateTotalPages,
  getMobileFullscreenDownscale,
  getMobileFullscreenLayoutMetrics,
  getPaginationPageHeight,
  idbReadPaginationCache,
  isThemeOnlyPaginationChange,
  layoutPaginationSettingsEqual,
  readPaginationCache,
  readStoredProgressPage,
  resolveMobileFullscreenPageHeight,
  resolvePaginationCacheContext,
  writePaginationCache,
} from "./bookViewer/paginationCache.js"
import {
  buildPaginationLoadingLabel,
  computeOpeningLoadingPercent,
  findResumeAnchorSentence,
  getReadingAnchor,
  resolvePageAfterRepagination,
  schedulePageTextMapBuild,
} from "./bookViewer/readingAnchor.js"
import {
  CUSTOM_FONT_SIZE_LIMITS,
  CUSTOM_LINE_SPACING_LIMITS,
  CUSTOM_MARGIN_REM_LIMITS,
  DEFAULT_SETTINGS,
  FONT_STYLE_OPTIONS,
  formatFontSizeChipLabel,
  formatLineSpacingChipLabel,
  formatMarginChipLabel,
  normalizeReaderSettings,
  resolveFontMetrics,
  resolveLineHeight,
  resolveMarginCss,
  sanitizeCustomFontSizePx,
  sanitizeCustomLineSpacing,
  sanitizeCustomMarginRem,
} from "./bookViewer/readerSettings.js"
import {
  buildLayoutBundle,
  computeMobileFullscreenPages,
  getCachedFlatBlocks,
  measureDocumentPages,
  paginateBlocksByDom,
  releaseMeasurePool,
  setupMeasureElements,
} from "./bookViewer/measureLayout.jsx"
import { BookPageContent } from "./bookViewer/BookPageContent.jsx"
import { dedupeTocEntries, formatNavChapterTitle } from "./bookViewer/navHelpers.js"
import { PageCounterControl } from "./bookViewer/PageCounterControl.jsx"
import { LayoutModeIcon, NibIcon, SearchIcon, TocIcon } from "./bookViewer/icons.jsx"
import { InlineCustomSettingChip } from "./bookViewer/InlineCustomSettingChip.jsx"

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
      window.setTimeout(() => {
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
    }))

    const textEntries = (bookDocument?.chapters ?? []).map((chapter) => ({
      id: chapter.id,
      title: formatTocChapterTitle(chapter.title),
      pageNum: chapterPageMap[chapter.id] ?? null,
    }))

    const textSectionEntries = textEntries.filter((entry) =>
      /^(prelude|prologue|epilogue|part\b)/i.test(entry.title ?? "")
    )

    const combined =
      imageEntries.length >= 10
        ? [...textSectionEntries, ...imageEntries]
        : [...textEntries, ...imageEntries]

    return dedupeTocEntries(
      combined.sort((left, right) => {
        const leftPage =
          left.pageNum ?? left.sourcePageNumber ?? Number.MAX_SAFE_INTEGER
        const rightPage =
          right.pageNum ?? right.sourcePageNumber ?? Number.MAX_SAFE_INTEGER
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
