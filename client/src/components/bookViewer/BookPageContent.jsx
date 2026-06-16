import { Fragment } from "react"
import { PAGE_WIDTH_PX, MOBILE_FULLSCREEN_PAGE_HEIGHT_PX } from "./constants.js"
import {
  DEFAULT_SETTINGS,
  getPageChromeStyle,
  getPageContentHeightPx,
} from "./readerSettings.js"
import { getMobileFullscreenLayoutMetrics } from "./paginationCache.js"
import { highlightTextContent } from "./highlight.jsx"
import {
  proseParagraphClassName,
  renderProseContent,
} from "./listRendering.jsx"
import { ImageLayoutItem, renderGroupedListItemsReact } from "./measureLayout.jsx"
export function BookPageContent({
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
