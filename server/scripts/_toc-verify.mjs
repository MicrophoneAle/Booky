import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const assets = path.resolve(__dirname, "../../client/src/assets")

const {
  extractImageChapterTocEntries,
  chapterTitlesReferToSameChapter,
  formatTocChapterTitle,
} = await import("../../client/src/utils/paginator.js")

// Local mirror of formatImageChapterTocTitle behaviour is not needed: image
// entry titles are compared by chapter NUMBER via chapterTitlesReferToSameChapter,
// so we use the chapterMetadata title text directly.
function imageEntryTitle(metadata) {
  const number = (metadata?.number ?? "").trim()
  const title = (metadata?.title ?? "").trim()
  if (number && title) return `${number}: ${title}`
  return number || title || "Chapter"
}

const { parsePdfBuffer } = await import("../index.js")

const books = [
  ["The Way of Kings", "The Way of Kings.pdf"],
  ["1984", "orwell1984.pdf"],
  ["Treasure Island", "Treasure Island.pdf"],
]

for (const [name, file] of books) {
  const p = path.join(assets, file)
  if (!existsSync(p)) {
    console.log(`SKIP ${name} (missing)`)
    continue
  }
  const result = await parsePdfBuffer(readFileSync(p), file, {
    documentId: `toc-verify-${file}`,
  })
  const document = {
    content: result.contentWithChapters,
    chapters: result.chapters,
  }

  const imageEntries = extractImageChapterTocEntries(document).map((e) => ({
    title: formatTocChapterTitle(imageEntryTitle(e.chapterMetadata)),
  }))

  const textEntries = (document.chapters ?? []).map((c) => ({
    title: formatTocChapterTitle(c.title),
  }))
  const textChapterEntries = textEntries.filter((e) =>
    /\bchapter\b/i.test(e.title ?? "")
  )

  const useImageChapterToc = imageEntries.length >= 10

  const unmatched = useImageChapterToc
    ? textChapterEntries.filter(
        (t) =>
          !imageEntries.some((im) =>
            chapterTitlesReferToSameChapter(t.title, im.title)
          )
      )
    : []

  console.log(`\n===== ${name} =====`)
  console.log(`imageEntries: ${imageEntries.length}, useImageChapterToc: ${useImageChapterToc}`)
  console.log(`textChapterEntries: ${textChapterEntries.length}`)
  console.log(`unmatched text chapters (would be re-added): ${unmatched.length}`)
  unmatched.forEach((u) => console.log(`   + ${u.title}`))
}
console.log("\nDONE_TOC_VERIFY")
