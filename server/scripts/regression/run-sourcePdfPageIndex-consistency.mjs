/**
 * Diagnostics-only harness:
 * Finds blocks where sourcePdfPageIndex is not a member of sourcePdfPageProvenance.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parsePdfBuffer } from "../../index.js"
import { sourcePdfPageIndexConsistentWithProvenance } from "./checks.mjs"

import oldman from "./books/oldman.mjs"
import orwell1984 from "./books/orwell1984.mjs"
import monteCristo from "./books/monte-cristo.mjs"
import pridePrejudice from "./books/pride-prejudice.mjs"
import mobyDick from "./books/moby-dick.mjs"
import treasureIsland from "./books/treasure-island.mjs"
import frankenstein from "./books/frankenstein.mjs"
import oliverTwist from "./books/oliver-twist.mjs"
import jungleBook from "./books/jungle-book.mjs"
import aesop from "./books/aesop.mjs"
import metamorphosis from "./books/metamorphosis.mjs"
import narnia from "./books/narnia.mjs"
import mayaAngelou from "./books/maya-angelou.mjs"
import wayOfKings from "./books/way-of-kings.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = path.resolve(__dirname, "../../../client/src/assets")

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const ALL_BOOKS = [
  oldman,
  orwell1984,
  monteCristo,
  pridePrejudice,
  mobyDick,
  treasureIsland,
  frankenstein,
  oliverTwist,
  jungleBook,
  aesop,
  metamorphosis,
  narnia,
  mayaAngelou,
  wayOfKings,
]

const bookFilter = process.argv.find((arg) => arg.startsWith("--book="))?.split("=")[1]
const books = bookFilter
  ? ALL_BOOKS.filter((book) => book.id === bookFilter)
  : ALL_BOOKS

for (const book of books) {
  const pdfPath = path.join(ASSETS_DIR, book.file)
  if (!fs.existsSync(pdfPath)) {
    console.error(`Missing PDF for ${book.name}: ${pdfPath}`)
    continue
  }

  console.log("")
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log(`BOOK: ${book.name}`)
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

  const buffer = fs.readFileSync(pdfPath)

  const parseResult = await parsePdfBuffer(buffer, book.file, {
    documentId: `diag-${book.id}-${Date.now()}`,
  })

  const contentWithChapters = parseResult.contentWithChapters ?? []
  const blocks = contentWithChapters.flatMap((page) => page.blocks ?? [])

  const outcome = sourcePdfPageIndexConsistentWithProvenance(blocks)

  console.log(
    `Check: ${outcome?.summary ?? ""}`.trim() ||
      "Check summary: (none provided)"
  )

  if (outcome?.failures?.length) {
    console.log(`Violations (${outcome.failures.length}):`)
    for (const line of outcome.failures) {
      console.log("  " + line)
    }
  } else {
    console.log("Violations: none")
  }
}
