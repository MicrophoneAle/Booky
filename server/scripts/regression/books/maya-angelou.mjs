import {
  consumeContentsTitleFromPool,
  findChapter,
  normalizeTitleKey,
} from "../helpers.mjs"
import {
  MAYA_CONTENTS_TO_BODY_TITLE_ALIASES,
  MAYA_PRINTED_TOC_POEMS,
} from "./_maya-titles.mjs"

// Printed Contents (source PDF pages 7-16) of The Complete Collected Poems.
// Poem titles enumerated from those Contents pages via raw pdfjs (collection
// section headers excluded; inaugural poem "On the Pulse of Morning" kept).
// ALSO BY is on page 4; Library of Congress cataloging is on the final page.
const MAYA_EXPECTED_POEM_COUNT = MAYA_PRINTED_TOC_POEMS.length

// Deliberately undetected: the inaugural poem has no title in the PDF text layer
// at its opening; inserting a synthetic boundary was rejected as guesswork.
const MAYA_KNOWN_CONTENTS_GAPS = ["On the Pulse of Morning"]

const MAYA_KNOWN_CONTENTS_GAP_KEYS = new Set(
  MAYA_KNOWN_CONTENTS_GAPS.map((title) => normalizeTitleKey(title))
)

const MAYA_CONTENTS_BODY_ALIAS_KEYS = new Map(
  MAYA_CONTENTS_TO_BODY_TITLE_ALIASES.map(([contentsTitle, bodyTitle]) => [
    normalizeTitleKey(contentsTitle),
    normalizeTitleKey(bodyTitle),
  ])
)

export default {
  id: "maya-angelou",
  name: "Maya Angelou - Complete Collected Poems",
  file: "maya_angelou.pdf",
  skipGeneralChecks: ["headingDensitySane", "indentationConsistency"],
  assertions: [
    [
      `printed-Contents poem count (${MAYA_EXPECTED_POEM_COUNT})`,
      (ctx) => ctx.chapters.length === MAYA_EXPECTED_POEM_COUNT,
    ],
    [
      "first Contents poem They Went Home",
      (ctx) => Boolean(findChapter(ctx.chapters, /^They Went Home$/i)),
    ],
    [
      "middle poem Phenomenal Woman",
      (ctx) => Boolean(findChapter(ctx.chapters, /Phenomenal Woman/i)),
    ],
    [
      "Still I Rise present",
      (ctx) => Boolean(findChapter(ctx.chapters, /^Still I Rise$/i)),
    ],
    [
      "[KNOWN GAP] On the Pulse of Morning undetected (no title in PDF text layer)",
      (ctx) =>
        Boolean(findChapter(ctx.chapters, /On the Pulse of Morning/i)),
    ],
    [
      "no Contents listing retained in body",
      (ctx) => {
        const firstPoemIndex = ctx.blocks.findIndex((block) =>
          /^They Went Home$/i.test((block.text ?? "").trim())
        )
        const scan = firstPoemIndex > 0 ? ctx.blocks.slice(0, firstPoemIndex) : ctx.blocks
        // A lone "Contents" heading in stripped front matter is acceptable only
        // if the TOC body rows themselves are gone; fail if classic TOC rows remain.
        return !scan.some((block) => {
          const text = (block.text ?? "").trim()
          return (
            /^They Went Home\s+\d+/i.test(text) ||
            /^Harlem Hopscotch\s+\d+/i.test(text) ||
            /^Phenomenal Woman\s+\d+/i.test(text)
          )
        })
      },
    ],
    [
      "no ALSO BY page retained in content",
      (ctx) =>
        !ctx.blocks.some((block) =>
          /^ALSO BY\b/i.test((block.text ?? "").trim())
        ),
    ],
    [
      "no Library of Congress cataloging tail",
      (ctx) => {
        const tail = ctx.blocks.slice(-20)
        return !tail.some((block) => {
          const text = (block.text ?? "").trim()
          return (
            /^Angelou,\s*Maya\.?$/i.test(text) ||
            /^p\.\s*cm\.?$/i.test(text) ||
            /^I\.\s*Title\.?$/i.test(text) ||
            /Cataloging-in-Publication/i.test(text)
          )
        })
      },
    ],
    [
      `printed-Contents poems present except documented gaps (${MAYA_KNOWN_CONTENTS_GAPS.length} known)`,
      (ctx) => {
        const pool = ctx.chapters.map((chapter) =>
          normalizeTitleKey(chapter.title)
        )
        const expectedMatches = MAYA_PRINTED_TOC_POEMS.filter(
          (title) => !MAYA_KNOWN_CONTENTS_GAP_KEYS.has(normalizeTitleKey(title))
        )
        for (const title of expectedMatches) {
          if (
            !consumeContentsTitleFromPool(
              pool,
              title,
              MAYA_CONTENTS_BODY_ALIAS_KEYS
            )
          ) {
            return false
          }
        }
        return true
      },
    ],
  ],
}
