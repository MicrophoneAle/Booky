const STATIC_CACHE = "booky-static-v1"
const DOCUMENTS_CACHE = "booky-documents-v1"
const STATIC_ASSETS = ["/", "/index.html"]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  )
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

function isDocumentApiRequest(url) {
  return /^\/documents(\/[^/]+)?$/.test(url.pathname)
}

self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET") return

  const url = new URL(request.url)

  if (url.origin === self.location.origin && isDocumentApiRequest(url)) {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(DOCUMENTS_CACHE)
            cache.put(request, response.clone())
          }
          return response
        })
        .catch(async () => {
          const cache = await caches.open(DOCUMENTS_CACHE)
          const cached = await cache.match(request)
          if (cached) return cached
          throw new Error("Offline and no cached response")
        })
    )
    return
  }

  const isStaticAsset =
    request.destination === "script" ||
    request.destination === "style" ||
    request.destination === "font"

  if (isStaticAsset) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request)
        if (cached) return cached

        const response = await fetch(request)
        if (response.ok) {
          cache.put(request, response.clone())
        }
        return response
      })
    )
  }
})
