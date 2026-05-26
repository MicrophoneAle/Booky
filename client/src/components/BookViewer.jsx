import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { motion, useReducedMotion } from "framer-motion"
import { flattenDocument } from "../utils/paginator"
import "../pages/Reader.css"
import "./BookViewer.css"

const NAVBAR_HEIGHT_PX = 48
const PAGE_NUMBER_RESERVED_PX = 32

function getLayoutHeights() {
  const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  const stagePaddingY = 1.5 * remPx * 2
  const pagePaddingY = 1.5 * remPx * 2
  const pageOuterHeight = window.innerHeight - NAVBAR_HEIGHT_PX - stagePaddingY
  const contentMaxHeight = pageOuterHeight - pagePaddingY - PAGE_NUMBER_RESERVED_PX

  return { pageOuterHeight, contentMaxHeight }
}

function createMeasureElements() {
  const root = document.createElement("div")
  root.className = "book-viewer__measure"

  const page = document.createElement("div")
  page.className = "book-page"

  const body = document.createElement("div")
  body.className = "book-page__body"

  const footer = document.createElement("div")
  footer.className = "book-viewer__measure-footer"
  footer.setAttribute("aria-hidden", "true")

  page.appendChild(body)
  page.appendChild(footer)
  root.appendChild(page)
  document.body.appendChild(root)

  return { root, page, body }
}

function mergeConsecutiveHeadingBlocks(flatBlocks) {
  const mergedBlocks = []
  let index = 0

  while (index < flatBlocks.length) {
    const block = flatBlocks[index]

    if (!block.isHeading) {
      mergedBlocks.push(block)
      index += 1
      continue
    }

    let combinedHeading = block.text.trim()
    const mergedBlock = { ...block }

    index += 1

    while (index < flatBlocks.length && flatBlocks[index].isHeading) {
      combinedHeading += ` ${flatBlocks[index].text.trim()}`
      index += 1
    }

    mergedBlocks.push({
      ...mergedBlock,
      text: combinedHeading.replace(/\s+/g, " ").trim(),
      isHeading: true,
    })
  }

  return mergedBlocks
}

function groupBlocksForDisplay(blocks) {
  const visualItems = []
  let currentProse = []
  let currentListItems = []

  const flushProse = () => {
    if (currentProse.length === 0) return
    const combinedText = currentProse.join(" ").replace(/\s+/g, " ").trim()
    currentProse = []
    if (combinedText) visualItems.push({ type: "prose", text: combinedText })
  }

  const flushList = () => {
    if (currentListItems.length === 0) return
    visualItems.push({ type: "list", items: [...currentListItems] })
    currentListItems = []
  }

  // Broad matching regex matching bullet tokens cleanly at the front of text
  const rawBulletMarkerRegex = /^([•o·\-—\s\d\.\)]+)/

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    let text = (block.text ?? "").trim()
    if (!text) continue

    // Handle heading strings smoothly
    if (block.isHeading) {
      flushProse()
      flushList()

      // Look-ahead to group consecutive pieces of headers
      let combinedHeading = text
      while (i + 1 < blocks.length && blocks[i + 1].isHeading) {
        combinedHeading += ` ${(blocks[i + 1].text ?? "").trim()}`
        i++
      }
      visualItems.push({ type: "heading", text: combinedHeading })
      continue
    }

    // Check if block is just a lone layout bullet character
    const isLoneMarker = /^([•o·\-—])$/.test(text)

    if (isLoneMarker) {
      flushProse()
      // Look ahead to capture the actual content description
      if (i + 1 < blocks.length && !blocks[i + 1].isHeading) {
        let contentText = (blocks[i + 1].text ?? "").trim()
        // Clear any repeated token headers from the content text string
        contentText = contentText.replace(rawBulletMarkerRegex, "").trim()
        currentListItems.push({ text: contentText })
        i++ // advance scanner past text element
      }
      continue
    }

    // Check if the block has an inline bullet embedded directly at the start
    const matchesInlineBullet = /^([•o·\-—]|\d+[\.\)])\s+(.*)$/.test(text)
    if (matchesInlineBullet) {
      flushProse()
      const cleanListContent = text.replace(/^([•o·\-—]|\d+[\.\)])\s*/, "").trim()
      currentListItems.push({ text: cleanListContent })
      continue
    }

    // Default: It is standard paragraph prose
    flushList() // ensure past lists are closed
    currentProse.push(text)
  }

  flushProse()
  flushList()
  return visualItems
}

function appendChapterLabel(body, title) {
  const label = document.createElement("p")
  label.className = "book-page__chapter-label"
  label.textContent = title
  body.appendChild(label)
}

function appendVisualItem(body, item) {
  if (item.type === "heading") {
    const heading = document.createElement("h2")
    heading.className = "book-page__heading"
    heading.textContent = item.text
    body.appendChild(heading)
    return
  }

  if (item.type === "list") {
    const list = document.createElement("ul")
    list.className = "book-page__list"

    for (const listItem of item.items) {
      const listEntry = document.createElement("li")
      listEntry.className = "book-page__list-item"
      listEntry.textContent = listItem.text
      list.appendChild(listEntry)
    }

    body.appendChild(list)
    return
  }

  if (item.type === "prose") {
    const paragraph = document.createElement("p")
    paragraph.className = "book-page__text"
    paragraph.textContent = item.text
    body.appendChild(paragraph)
  }
}

function renderMeasureBody(body, blocks, showChapterLabel, chapterTitle) {
  body.replaceChildren()

  if (showChapterLabel && chapterTitle) {
    appendChapterLabel(body, chapterTitle)
  }

  for (const item of groupBlocksForDisplay(blocks)) {
    appendVisualItem(body, item)
  }
}

function paginateBlocksByDom(flatBlocks, pageEl, bodyEl, contentMaxHeight) {
  const pages = []
  let currentBlocks = []
  let pageChapterTitle = null
  let pageIsChapterStart = false

  const flushPage = () => {
    if (currentBlocks.length === 0) return

    pages.push({
      pageNumber: pages.length + 1,
      blocks: currentBlocks.map((block) => ({
        text: block.text,
        isHeading: block.isHeading,
        fontSize: block.fontSize,
        chapterId: block.chapterId,
      })),
      chapterTitle: pageChapterTitle,
      isChapterStart: pageIsChapterStart,
    })

    pageChapterTitle = null
    pageIsChapterStart = false
  }

  for (const block of flatBlocks) {
    if (block.isHeading) {
      flushPage()
      currentBlocks = []
      pageChapterTitle = block.chapterTitle ?? block.text.trim()
      pageIsChapterStart = block.isChapterStart
    }

    const trialBlocks = [...currentBlocks, block]
    const showChapterLabel =
      pageIsChapterStart && Boolean(pageChapterTitle) && currentBlocks.length === 0

    renderMeasureBody(bodyEl, trialBlocks, showChapterLabel, pageChapterTitle)

    if (bodyEl.scrollHeight > contentMaxHeight && currentBlocks.length > 0) {
      flushPage()
      currentBlocks = [block]
      pageChapterTitle = block.chapterTitle ?? block.text.trim()
      pageIsChapterStart = block.isChapterStart

      renderMeasureBody(
        bodyEl,
        currentBlocks,
        pageIsChapterStart && Boolean(pageChapterTitle),
        pageChapterTitle
      )
    } else {
      currentBlocks = trialBlocks
    }
  }

  flushPage()
  return pages
}

function BookPageContent({ page }) {
  if (!page) {
    return <div className="book-page book-page--empty" />
  }

  const visualItems = groupBlocksForDisplay(page.blocks ?? [])

  return (
    <div className="book-page">
      {page.chapterTitle && (
        <p className="book-page__chapter-label">{page.chapterTitle}</p>
      )}

      <div className="book-page__body">
        {visualItems.map((item, index) => {
          if (item.type === "heading") {
            return (
              <h2 key={index} className="book-page__heading">
                {item.text}
              </h2>
            )
          }

          if (item.type === "list") {
            return (
              <ul key={index} className="book-page__list">
                {item.items.map((listItem, listIndex) => (
                  <li key={listIndex} className="book-page__list-item">
                    {listItem.text}
                  </li>
                ))}
              </ul>
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

function formatNavChapterTitle(leftPage, rightPage) {
  const leftTitle = leftPage?.chapterTitle
  const rightTitle = rightPage?.chapterTitle

  if (leftTitle && rightTitle) {
    if (leftTitle === rightTitle) return leftTitle
    return `${leftTitle}  ·  ${rightTitle}`
  }

  return leftTitle ?? rightTitle ?? ""
}

function formatPageCounter(leftPage, rightPage, totalPages) {
  if (!leftPage || totalPages === 0) return ""

  const leftNumber = leftPage.pageNumber

  if (rightPage) {
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
      const flatBlocks = mergeConsecutiveHeadingBlocks(flattenDocument(bookDocument))
      const { pageOuterHeight, contentMaxHeight } = getLayoutHeights()
      const measureElements = createMeasureElements()

      measureRoot = measureElements.root
      measureElements.page.style.height = `${pageOuterHeight}px`

      const measuredPages = paginateBlocksByDom(
        flatBlocks,
        measureElements.page,
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

  const totalPages = pages.length
  const pageStep = isMobile ? 1 : 2
  const maxSpreadPage = isMobile ? totalPages : Math.max(1, totalPages - 1)

  const leftPage = pages[currentPage - 1] ?? null
  const rightPage = isMobile ? null : pages[currentPage] ?? null
  const navChapterTitle = formatNavChapterTitle(leftPage, rightPage)
  const pageCounterText = formatPageCounter(leftPage, rightPage, totalPages)

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

  const canGoBack = currentPage - pageStep >= 1
  const canGoForward = currentPage + pageStep <= maxSpreadPage

  const finishFlip = useCallback(
    (nextPage) => {
      setCurrentPage(nextPage)
      onPageChange?.(nextPage)
      setFlipDirection(null)
    },
    [onPageChange]
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

        <div className="book-viewer__spread">
          <motion.div
            className={`book-viewer__page-slot book-viewer__page-slot--left ${
              isMobile ? "book-viewer__page-slot--single" : ""
            }`}
            style={{ transformOrigin: "right center" }}
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

          {!isMobile && (
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
                  <BookPageContent page={rightPage} />
                </div>
              </motion.div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
