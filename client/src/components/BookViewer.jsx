import { useCallback, useEffect, useState } from "react"
import { motion, useReducedMotion } from "framer-motion"
import "./BookViewer.css"

function BookPageContent({ page }) {
  if (!page) {
    return <div className="book-page book-page--empty" />
  }

  return (
    <div className="book-page">
      {page.isChapterStart && page.chapterTitle && (
        <p className="book-page__chapter-label">{page.chapterTitle}</p>
      )}

      <div className="book-page__body">
        {page.blocks.map((block, index) =>
          block.isHeading ? (
            <h2 key={index} className="book-page__heading">
              {block.text}
            </h2>
          ) : (
            <p key={index} className="book-page__text">
              {block.text}
            </p>
          )
        )}
      </div>

      <p className="book-page__number">— {page.pageNumber} —</p>
    </div>
  )
}

export default function BookViewer({ pages = [], initialPage = 1, onPageChange }) {
  const prefersReducedMotion = useReducedMotion()
  const [currentPage, setCurrentPage] = useState(initialPage)
  const [flipDirection, setFlipDirection] = useState(null)
  const [isMobile, setIsMobile] = useState(false)

  const totalPages = pages.length
  const pageStep = isMobile ? 1 : 2
  const maxSpreadPage = isMobile ? totalPages : Math.max(1, totalPages - 1)

  const leftPage = pages[currentPage - 1] ?? null
  const rightPage = isMobile ? null : pages[currentPage] ?? null
  const navChapterTitle = leftPage?.chapterTitle ?? pages[0]?.chapterTitle ?? ""

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

  return (
    <div className="book-viewer">
      <header className="book-viewer__nav">
        <div className="book-viewer__logo">BOOKY</div>
        <p className="book-viewer__chapter">{navChapterTitle}</p>
        <p className="book-viewer__counter">
          Page {currentPage} of {totalPages}
        </p>
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
