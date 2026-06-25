import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test"

const __dirname = dirname(fileURLToPath(import.meta.url))
const assets = join(__dirname, "../../client/src/assets")
const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")

const books = [
  "herman-melville-moby-dick.pdf",
  "Aesop's Fables.pdf",
  "Narnia.pdf",
  "frankenstein.pdf",
  "The Jungle Book.pdf",
  "the-metamorphosis.pdf",
  "PrideAndPrejudice.pdf",
  "797The-Count-of-Monte-Cristo.pdf",
]

console.log(`Parser v${PARSER_VERSION}\n`)

for (const file of books) {
  const result = await parsePdfBuffer(readFileSync(join(assets, file)), file)
  const sample = result.chapters
    .slice(0, 3)
    .map((chapter) => chapter.title)
    .join(" | ")
  console.log(`${result.chapters.length.toString().padStart(4)}  ${file}`)
  console.log(`      ${sample}`)
}
