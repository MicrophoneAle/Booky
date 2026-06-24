const PAGINATION_CACHE_PREFIX = "booky-pages|"
const PAGINATION_CACHE_TS_PREFIX = "booky-pages-ts|"
const PAGINATION_IDB_NAME = "booky-pagination-cache"
const PAGINATION_IDB_STORE = "pages"

function openPaginationDb() {
  return new Promise((resolve) => {
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
}

function paginationCacheKeyMatchesBook(key, bookId) {
  const normalizedBookId = String(bookId)
  if (key.startsWith(PAGINATION_CACHE_PREFIX)) {
    return key.split("|")[1] === normalizedBookId
  }
  return String(key).split("|")[1] === normalizedBookId
}

export function clearBookLocalStorageCache(bookId) {
  if (!bookId) {
    return
  }

  try {
    for (const key of Object.keys(localStorage)) {
      if (paginationCacheKeyMatchesBook(key, bookId)) {
        localStorage.removeItem(key)
      }
    }
    localStorage.removeItem(`${PAGINATION_CACHE_TS_PREFIX}${bookId}`)
    localStorage.removeItem(`booky-progress-${bookId}`)
  } catch {
    // Ignore storage errors.
  }
}

export async function clearBookIndexedDbCache(bookId) {
  if (!bookId) {
    return
  }

  try {
    const db = await openPaginationDb()
    if (!db) {
      return
    }

    await new Promise((resolve) => {
      try {
        const tx = db.transaction(PAGINATION_IDB_STORE, "readwrite")
        const store = tx.objectStore(PAGINATION_IDB_STORE)
        const request = store.getAllKeys()
        request.onsuccess = () => {
          for (const key of request.result ?? []) {
            if (paginationCacheKeyMatchesBook(String(key), bookId)) {
              store.delete(key)
            }
          }
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  } catch {
    // Ignore IndexedDB errors.
  }
}

export function clearBookLocalCache(bookId) {
  clearBookLocalStorageCache(bookId)
  void clearBookIndexedDbCache(bookId)
}

export function patchLibraryDocumentsCache(libraryCacheKey, updater) {
  if (!libraryCacheKey) {
    return null
  }

  try {
    const raw = localStorage.getItem(libraryCacheKey)
    const current = raw ? JSON.parse(raw) : []
    const next = updater(Array.isArray(current) ? current : [])
    localStorage.setItem(libraryCacheKey, JSON.stringify(next))
    return next
  } catch {
    return null
  }
}
