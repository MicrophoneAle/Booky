export function collectChapterTitlesForPage(page) {
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

export function resolveNavChapterTitlesForPageIndex(pages, pageIndex) {
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

export function normalizeTocTitleKey(title) {
  return (title ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^chapter\s+\d+\s*:\s*/i, "")
    .trim()
}

export function dedupeTocEntries(entries) {
  const seenPageTitle = new Set()
  const deduped = []

  for (const entry of entries) {
    const pageKey = entry.pageNum ?? "unknown"
    const titleKey = normalizeTocTitleKey(entry.title)
    const dedupeKey = `${pageKey}:${titleKey}`
    if (seenPageTitle.has(dedupeKey)) {
      continue
    }
    seenPageTitle.add(dedupeKey)
    deduped.push(entry)
  }

  return deduped
}

export function resolveNavChapterTitlesFromToc(tocEntries, pageNumber) {
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

export function formatNavChapterTitle(pages, currentPage, isSpreadView, tocEntries = []) {
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
