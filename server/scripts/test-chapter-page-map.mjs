import {
  buildChapterPageMap,
  chapterTitlesReferToSameChapter,
} from "../../client/src/utils/paginator.js"

let pass = true

function assert(label, condition) {
  if (!condition) {
    console.log(`FAIL ${label}`)
    pass = false
    return
  }
  console.log(`OK   ${label}`)
}

assert(
  "PART ONE Ch 1 is not PART TWO Ch 1",
  !chapterTitlesReferToSameChapter(
    "PART ONE — Chapter 1",
    "PART TWO — Chapter 1"
  )
)

assert(
  "VOLUME ONE Ch 8 is not VOLUME TWO Ch 8",
  !chapterTitlesReferToSameChapter(
    "VOLUME ONE — Chapter 8 - The Château d'If",
    "VOLUME TWO — Chapter 8"
  )
)

assert(
  "PART ONE Ch 1 matches subtitle variant",
  chapterTitlesReferToSameChapter(
    "PART ONE — Chapter 1",
    "PART ONE — Chapter 1 - Title"
  )
)

assert(
  "PART TWO header is not PART TWO Chapter I",
  !chapterTitlesReferToSameChapter("PART TWO", "PART TWO — Chapter I")
)

assert(
  "PART TWO Chapter I matches roman label",
  chapterTitlesReferToSameChapter(
    "PART TWO — Chapter I",
    "PART TWO — Chapter I"
  )
)

const measuredPages = [
  {
    pageNumber: 3,
    isChapterStart: true,
    chapterTitle: "PART ONE — Chapter 1",
    chaptersOnPage: ["PART ONE — Chapter 1"],
    visualItems: [
      {
        type: "chapter",
        text: "PART ONE — Chapter 1",
        chapterId: "part-one-chapter-1",
        isChapterStart: true,
      },
    ],
  },
  {
    pageNumber: 64,
    isChapterStart: true,
    chapterTitle: "PART TWO",
    chaptersOnPage: ["PART TWO"],
    visualItems: [
      {
        type: "title",
        text: "PART TWO",
        chapterId: "part-two",
        isChapterStart: true,
      },
    ],
  },
  {
    pageNumber: 65,
    isChapterStart: true,
    chapterTitle: "PART TWO — Chapter 1",
    chaptersOnPage: ["PART TWO — Chapter 1"],
    visualItems: [
      {
        type: "chapter",
        text: "PART TWO — Chapter 1",
        chapterId: "part-two-chapter-1",
        isChapterStart: true,
      },
    ],
  },
]

const apiChapters = [
  { id: "part-one-chapter-1", title: "PART ONE — Chapter 1" },
  { id: "part-two", title: "PART TWO" },
  { id: "part-two-chapter-1", title: "PART TWO — Chapter 1" },
]

const map = buildChapterPageMap(measuredPages, apiChapters)

assert("PART ONE Ch 1 maps to page 3", map["part-one-chapter-1"] === 3)
assert("PART TWO maps to page 64", map["part-two"] === 64)
assert("PART TWO Ch 1 maps to page 65", map["part-two-chapter-1"] === 65)

process.exit(pass ? 0 : 1)
