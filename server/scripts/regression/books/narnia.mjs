import { findChapter } from "../helpers.mjs"

// Seven-book omnibus confirmed by raw pdfjs title-page markers at pages
// 2 / 81 / 180 / 287 / 393 / 491 / 576. Standard chapter counts for the seven
// Chronicles (independent of parser output): 17+15+16+16+15+15+16 = 110.
// This edition promotes story chapters as "Chapter ONE - Title" (etc.) and does
// not emit the seven book titles themselves as chapter entries - so book
// presence is locked via each book's distinctive opening chapter title from
// the source text, not via a book-title TOC row.
const NARNIA_BOOK_OPENERS = [
  { id: "LWW", opener: /Lucy Looks Into a Wardrobe/i },
  { id: "PC", opener: /Chapter ONE - The Island/i },
  { id: "VDT", opener: /Picture in the Bedroom/i },
  { id: "SC", opener: /Behind the Gym/i },
  { id: "HHB", opener: /How Shasta Set Out on His Travels/i },
  { id: "MN", opener: /Wrong Door/i },
  // This edition's LB ch1 subtitle is "By Caldron Pool" (pdf p576) - not the
  // classic "By Night in Narnia", which has zero occurrences in this PDF.
  { id: "LB", opener: /By Caldron Pool/i },
]

const NARNIA_EXPECTED_CHAPTER_TOTAL = 110

export default {
  id: "narnia",
  name: "The Chronicles of Narnia",
  file: "Narnia.pdf",
  skipGeneralChecks: ["indentationConsistency", "headingDensitySane"],
  assertions: [
    [
      "seven Chronicle opening chapters present",
      (ctx) =>
        NARNIA_BOOK_OPENERS.every((book) =>
          Boolean(findChapter(ctx.chapters, book.opener))
        ),
    ],
    [
      `total story chapters (${NARNIA_EXPECTED_CHAPTER_TOTAL}) across seven books`,
      (ctx) => ctx.chapters.length === NARNIA_EXPECTED_CHAPTER_TOTAL,
    ],
    [
      "LWW first/mid/last chapter titles present",
      (ctx) =>
        Boolean(findChapter(ctx.chapters, /Lucy Looks Into a Wardrobe/i)) &&
        Boolean(findChapter(ctx.chapters, /Spell Begins to Break/i)) &&
        Boolean(findChapter(ctx.chapters, /Hunting of the White Stag/i)),
    ],
    [
      "Dawn Treader Eustace / Very End chapters present",
      (ctx) =>
        Boolean(findChapter(ctx.chapters, /Adventures of Eustace/i)) &&
        Boolean(findChapter(ctx.chapters, /Very End of the World/i)),
    ],
    [
      "Magician's Nephew Wrong Door present",
      (ctx) => Boolean(findChapter(ctx.chapters, /Wrong Door/i)),
    ],
    [
      "Last Battle closes with Farewell to Shadowlands",
      (ctx) =>
        Boolean(findChapter(ctx.chapters, /Farewell to Shadowlands/i)),
    ],
  ],
}
