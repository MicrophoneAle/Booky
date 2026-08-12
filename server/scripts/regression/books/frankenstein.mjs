import { findChapter, romanToInt } from "../helpers.mjs"

// Printed Contents (source PDF pages 3-5): Volume I Letters I-IV + Chapters
// I-VII; Volume II Chapters I-IX (including VIII); Volume III Chapters I-VII.
// Confirmed by raw pdfjs extraction of the Contents pages.
const FRANKENSTEIN_LETTERS = 4
const FRANKENSTEIN_VOLUME_CHAPTERS = {
  1: 7,
  2: 9,
  3: 7,
}

function volumeChapterPairs(chapters) {
  const pairs = []
  let currentVolume = null

  for (const chapter of chapters) {
    const title = chapter?.title ?? ""
    const volumeOnly = title.match(/^Volume\s+([IVXLCDM]+)\b/i)
    if (volumeOnly && !/Chapter/i.test(title)) {
      currentVolume = romanToInt(volumeOnly[1])
      continue
    }

    const volumeChapter = title.match(
      /Volume\s+([IVXLCDM]+)\s*[—–\-:].*Chapter\s+([IVXLCDM]+|\d+)\b/i
    )
    if (volumeChapter) {
      pairs.push({
        volume: romanToInt(volumeChapter[1]),
        chapter: /^\d+$/.test(volumeChapter[2])
          ? Number(volumeChapter[2])
          : romanToInt(volumeChapter[2]),
      })
      currentVolume = romanToInt(volumeChapter[1])
      continue
    }

    const letter = title.match(/^Letter\s+([IVXLCDM]+|\d+)\b/i)
    if (letter) {
      continue
    }

    const chapterOnly = title.match(/^Chapter\s+([IVXLCDM]+|\d+)\b/i)
    if (chapterOnly && currentVolume) {
      pairs.push({
        volume: currentVolume,
        chapter: /^\d+$/.test(chapterOnly[1])
          ? Number(chapterOnly[1])
          : romanToInt(chapterOnly[1]),
      })
    }
  }

  return pairs
}

function letterNumbers(chapters) {
  return chapters
    .map((chapter) => {
      const match = (chapter?.title ?? "").match(
        /(?:^|Volume\s+[IVXLCDM]+\s*[—–\-:]\s*)Letter\s+([IVXLCDM]+|\d+)\b/i
      )
      if (!match) return null
      return /^\d+$/.test(match[1]) ? Number(match[1]) : romanToInt(match[1])
    })
    .filter((number) => number !== null)
}

export default {
  id: "frankenstein",
  name: "Frankenstein",
  file: "frankenstein.pdf",
  assertions: [
    [
      "Letters I-IV present with no gaps (printed Contents)",
      (ctx) => {
        const present = new Set(letterNumbers(ctx.chapters))
        for (let number = 1; number <= FRANKENSTEIN_LETTERS; number += 1) {
          if (!present.has(number)) {
            return false
          }
        }
        return true
      },
    ],
    [
      "Volume I Chapters I-VII contiguous (printed Contents)",
      (ctx) => {
        const present = new Set(
          volumeChapterPairs(ctx.chapters)
            .filter((entry) => entry.volume === 1)
            .map((entry) => entry.chapter)
        )
        for (let number = 1; number <= FRANKENSTEIN_VOLUME_CHAPTERS[1]; number += 1) {
          if (!present.has(number)) {
            return false
          }
        }
        return true
      },
    ],
    [
      "Volume II Chapters I-IX contiguous including VIII (printed Contents)",
      (ctx) => {
        const present = new Set(
          volumeChapterPairs(ctx.chapters)
            .filter((entry) => entry.volume === 2)
            .map((entry) => entry.chapter)
        )
        for (let number = 1; number <= FRANKENSTEIN_VOLUME_CHAPTERS[2]; number += 1) {
          if (!present.has(number)) {
            return false
          }
        }
        return present.has(8)
      },
    ],
    [
      "Volume III Chapters I-VII contiguous (printed Contents)",
      (ctx) => {
        const present = new Set(
          volumeChapterPairs(ctx.chapters)
            .filter((entry) => entry.volume === 3)
            .map((entry) => entry.chapter)
        )
        for (let number = 1; number <= FRANKENSTEIN_VOLUME_CHAPTERS[3]; number += 1) {
          if (!present.has(number)) {
            return false
          }
        }
        return true
      },
    ],
    [
      "Volume II Chapter VIII present as its own chapter",
      (ctx) =>
        Boolean(
          findChapter(
            ctx.chapters,
            /Volume\s+II\b.*Chapter\s+(?:VIII|8)\b|^Chapter\s+(?:VIII|8)\b/i
          ) ||
            volumeChapterPairs(ctx.chapters).some(
              (entry) => entry.volume === 2 && entry.chapter === 8
            )
        ),
    ],
    [
      "first Letter I present",
      (ctx) =>
        Boolean(
          findChapter(
            ctx.chapters,
            /(?:^|Volume\s+[IVXLCDM]+\s*[—–\-:]\s*)Letter\s+I\b/i
          )
        ),
    ],
    [
      "final Volume III Chapter VII present",
      (ctx) =>
        volumeChapterPairs(ctx.chapters).some(
          (entry) => entry.volume === 3 && entry.chapter === 7
        ),
    ],
  ],
}
