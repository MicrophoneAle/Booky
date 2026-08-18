/**
 * Diagnostics-only harness:
 * Finds blocks where `sourcePdfPageIndex` does not match the page where the
 * block's text appears in the raw extracted pdf text lines.
 *
 * This is harness-only and does not modify parser behavior.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parsePdfBuffer, extractLinesByPosition } from "../../index.js"
import {
  sourcePdfPageIndexConsistentWithConstituentLines,
} from "./checks.mjs"

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

for (const book of ALL_BOOKS) {
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

  const pageData = await extractLinesByPosition(buffer).catch((err) => {
    console.error(`[${book.id}] extractLinesByPosition failed:`, err?.message ?? err)
    return null
  })

  const outcome = sourcePdfPageIndexConsistentWithConstituentLines(blocks, {
    bookId: book.id,
    pageData,
  })

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

