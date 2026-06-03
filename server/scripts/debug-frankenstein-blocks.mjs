import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")
const pdfPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/src/assets/frankenstein.pdf"
)

const { chapters, contentWithChapters: content } = await parsePdfBuffer(
  readFileSync(pdfPath),
  "frankenstein.pdf"
)

console.log("Parser", PARSER_VERSION, "chapters:", chapters.length)

const structural = []
for (const page of content) {
  for (let bi = 0; bi < (page.blocks ?? []).length; bi += 1) {
    const b = page.blocks[bi]
    const t = (b.text ?? "").trim()
    if (
      b.isChapterStart ||
      (b.isHeading && /^(chapter|letter|preface|volume|part)/i.test(t))
    ) {
      structural.push({
        page: page.pageIndex,
        bi,
        text: t.slice(0, 100),
        isChapterStart: b.isChapterStart,
        isHeading: b.isHeading,
        fontSize: b.fontSize,
        chapterId: b.chapterId,
      })
    }
  }
}

console.log("Structural-ish blocks:", structural.length)
for (const row of structural.slice(0, 60)) {
  console.log(JSON.stringify(row))
}

const bad = chapters.filter(
  (c) =>
    c.title.length > 40 ||
    /\b(?:chapter|letter)\s+[IVXLCDM\d]+\s+\d/i.test(c.title) ||
    /Good God|garb was rustic/i.test(c.title)
)
console.log("Suspicious chapters:", bad.length)
for (const c of bad.slice(0, 15)) {
  console.log(JSON.stringify({ title: c.title.slice(0, 120), page: c.pageIndex }))
}
