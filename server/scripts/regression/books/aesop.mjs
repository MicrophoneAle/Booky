import {
  consumeExactTitlesFromPool,
  filterStoryChapters,
  findChapter,
  normalizeTitleKey,
} from "../helpers.mjs"
import {
  AESOP_APPENDIX_TOC_ENTRY_COUNT,
  AESOP_APPENDIX_TOC_TITLES,
  AESOP_EXPECTED_STORY_OPENING_COUNT,
  AESOP_PRIMARY_TOC_ENTRY_COUNT,
  AESOP_PRIMARY_TOC_UNIQUE_KEY_COUNT,
  AESOP_PRINTED_TOC_TITLES,
} from "./_aesop-titles.mjs"

// Appendix reprints share title keys with the primary set but are separate
// openings; the printed appendix mini-index spells "Shepherd Boy" without the
// apostrophe used in the primary TOC and body.
const AESOP_APPENDIX_TITLE_ALIASES = new Map([
  [
    normalizeTitleKey("The Shepherd Boy and the Wolf"),
    normalizeTitleKey("The Shepherd's Boy and the Wolf"),
  ],
])

function consumeAppendixTitlesFromPool(pool, expectedTitles) {
  for (const title of expectedTitles) {
    const key = normalizeTitleKey(title)
    const aliasKey = AESOP_APPENDIX_TITLE_ALIASES.get(key)
    let index = pool.indexOf(key)
    if (index === -1 && aliasKey) {
      index = pool.indexOf(aliasKey)
    }
    if (index === -1) {
      return false
    }
    pool.splice(index, 1)
  }
  return true
}

export default {
  id: "aesop",
  name: "Aesop's Fables",
  file: "Aesop's Fables.pdf",
  skipGeneralChecks: ["headingDensitySane", "indentationConsistency"],
  assertions: [
    [
      `total story openings (${AESOP_EXPECTED_STORY_OPENING_COUNT} = primary ${AESOP_PRIMARY_TOC_ENTRY_COUNT} + appendix ${AESOP_APPENDIX_TOC_ENTRY_COUNT})`,
      (ctx) => filterStoryChapters(ctx.chapters).length === AESOP_EXPECTED_STORY_OPENING_COUNT,
    ],
    [
      `primary printed-TOC entry coverage (${AESOP_PRIMARY_TOC_ENTRY_COUNT} entries, ${AESOP_PRIMARY_TOC_UNIQUE_KEY_COUNT} unique keys)`,
      (ctx) => {
        const pool = filterStoryChapters(ctx.chapters).map((chapter) =>
          normalizeTitleKey(chapter.title)
        )
        return consumeExactTitlesFromPool(pool, AESOP_PRINTED_TOC_TITLES)
      },
    ],
    [
      `appendix printed-TOC reprint coverage (${AESOP_APPENDIX_TOC_ENTRY_COUNT} entries)`,
      (ctx) => {
        const pool = filterStoryChapters(ctx.chapters).map((chapter) =>
          normalizeTitleKey(chapter.title)
        )
        if (!consumeExactTitlesFromPool(pool, AESOP_PRINTED_TOC_TITLES)) {
          return false
        }
        if (pool.length !== AESOP_APPENDIX_TOC_ENTRY_COUNT) {
          return false
        }
        return consumeAppendixTitlesFromPool(pool, AESOP_APPENDIX_TOC_TITLES)
      },
    ],
    [
      `every primary printed-TOC unique title present (${AESOP_PRIMARY_TOC_UNIQUE_KEY_COUNT} keys, exact match)`,
      (ctx) => {
        const present = new Set(
          ctx.chapters.map((chapter) => normalizeTitleKey(chapter.title))
        )
        const uniquePrimaryKeys = new Set(
          AESOP_PRINTED_TOC_TITLES.map((title) => normalizeTitleKey(title))
        )
        return [...uniquePrimaryKeys].every((key) => present.has(key))
      },
    ],
    [
      "first fable The Wolf and the Lamb",
      (ctx) => Boolean(findChapter(ctx.chapters, /Wolf and the Lamb/i)),
    ],
    [
      "middle fable The Hare and the Tortoise",
      (ctx) => Boolean(findChapter(ctx.chapters, /Hare and the Tortoise/i)),
    ],
    [
      "last primary TOC fable The Wolf and the Cat",
      (ctx) => Boolean(findChapter(ctx.chapters, /Wolf and the Cat/i)),
    ],
  ],
}
