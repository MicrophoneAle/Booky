/**
 * Splits parsed API document content into fixed-size reader pages.
 */

function flushPage(pages, currentBlocks, chapterTitle, isChapterStart) {
  if (currentBlocks.length === 0) return

  pages.push({
    pageNumber: pages.length + 1,
    blocks: [...currentBlocks],
    chapterTitle,
    isChapterStart,
  })
}

/**
 * @param {object} document - API document with content, chapters, and title
 * @param {object} [options]
 * @param {number} [options.charsPerPage=1200]
 * @param {number} [options.pageWidth=400]
 * @param {number} [options.pageHeight=600]
 * @returns {Array<{ pageNumber: number, blocks: object[], chapterTitle: string|null, isChapterStart: boolean }>}
 */
export function paginateDocument(document, options = {}) {
  const {
    charsPerPage = 1200,
    pageWidth: _pageWidth = 400,
    pageHeight: _pageHeight = 600,
  } = options

  const pages = []
  let currentBlocks = []
  let currentCharCount = 0
  let currentChapterTitle = null
  let currentPageIsChapterStart = false

  const sourcePages = document?.content ?? []

  for (const sourcePage of sourcePages) {
    const sourceBlocks = sourcePage?.blocks ?? []

    for (const block of sourceBlocks) {
      const text = block?.text ?? ""
      if (!text.trim()) continue

      if (block.isHeading) {
        flushPage(pages, currentBlocks, currentChapterTitle, currentPageIsChapterStart)
        currentBlocks = []
        currentCharCount = 0
        currentPageIsChapterStart = false

        currentChapterTitle = text.trim()
        currentBlocks.push(block)
        currentCharCount = text.length
        currentPageIsChapterStart = true
        continue
      }

      if (currentBlocks.length > 0 && currentCharCount + text.length > charsPerPage) {
        flushPage(pages, currentBlocks, currentChapterTitle, currentPageIsChapterStart)
        currentBlocks = []
        currentCharCount = 0
        currentPageIsChapterStart = false
      }

      currentBlocks.push(block)
      currentCharCount += text.length
    }
  }

  flushPage(pages, currentBlocks, currentChapterTitle, currentPageIsChapterStart)

  return pages
}

/**
 * @param {Array<{ pageNumber: number, blocks: object[] }>} pages
 * @returns {Record<string, number>}
 */
export function getChapterPages(pages) {
  const chapterPages = {}

  for (const page of pages) {
    for (const block of page.blocks) {
      const chapterId = block.chapterId
      if (chapterId && chapterPages[chapterId] === undefined) {
        chapterPages[chapterId] = page.pageNumber
      }
    }
  }

  return chapterPages
}
