import { get, keys, set } from "idb-keyval"

const DOCUMENT_CACHE_PREFIX = "booky-doc:"

function keyForDocument(documentId) {
  return `${DOCUMENT_CACHE_PREFIX}${documentId}`
}

export async function saveCachedDocument(document) {
  if (!document?.id) return
  await set(keyForDocument(document.id), {
    document,
    cachedAt: Date.now(),
  })
}

export async function getCachedDocument(documentId) {
  if (!documentId) return null
  const payload = await get(keyForDocument(documentId))
  if (!payload?.document) return null
  return payload
}

export async function getAllCachedDocuments() {
  const allKeys = await keys()
  const documentKeys = allKeys.filter(
    (key) => typeof key === "string" && key.startsWith(DOCUMENT_CACHE_PREFIX)
  )

  const cachedDocuments = await Promise.all(
    documentKeys.map(async (key) => {
      const payload = await get(key)
      if (!payload?.document?.id) return null
      return payload
    })
  )

  return cachedDocuments.filter(Boolean)
}
