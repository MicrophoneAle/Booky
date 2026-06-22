import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const pdfPath = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../client/src/assets/Aesop's Fables.pdf"
)

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")

let lastPage = 0
let lastPhase = ""
const started = Date.now()

const result = await parsePdfBuffer(readFileSync(pdfPath), "Aesop's Fables.pdf", {
  onProgress(progress) {
    const page = progress.pageCurrent ?? progress.current ?? 0
    const phase = `${progress.phase}:${progress.extractSubphase ?? progress.structureStep ?? ""}`
    if (page !== lastPage || phase !== lastPhase) {
      console.log(
        `[${((Date.now() - started) / 1000).toFixed(1)}s]`,
        phase,
        page,
        "/",
        progress.pageTotal ?? progress.total ?? 0,
        `${progress.percent ?? 0}%`,
        progress.label ?? ""
      )
      lastPage = page
      lastPhase = phase
    }
  },
})

console.log(
  "done",
  PARSER_VERSION,
  `${((Date.now() - started) / 1000).toFixed(1)}s`,
  "chapters",
  result.chapters.length
)
