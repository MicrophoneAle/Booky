import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const pdfPath = join(__dirname, "../../client/src/assets/Aesop's Fables.pdf")

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")

const result = await parsePdfBuffer(readFileSync(pdfPath), "Aesop's Fables.pdf")
const blocks = result.contentWithChapters.flatMap((page) => page.blocks ?? [])

const needles = [
  "COUNTRY MOUSE",
  "CITY MOUSE",
  "ANTS AND THE",
  "WOLF AND THE LAMB",
  "FROGS WHO ASKED",
  "MAN, HIS SON",
  "THE CRAB AND HIS MOTHER",
]

for (const needle of needles) {
  console.log(`\n=== ${needle} ===`)
  const matches = blocks.filter((block) =>
    (block.text ?? "").toUpperCase().includes(needle.toUpperCase())
  )
  for (const block of matches.slice(0, 4)) {
    console.log(
      JSON.stringify({
        text: (block.text ?? "").slice(0, 140),
        isHeading: block.isHeading,
        fontSize: block.fontSize,
        textAlign: block.textAlign,
        page: block.sourcePdfPage,
      })
    )
  }
  if (matches.length === 0) {
    console.log("(no matches)")
  }
}

console.log("\nPARSER_VERSION", PARSER_VERSION)

const idx = blocks.findIndex((block) =>
  (block.text ?? "").includes("COUNTRY MOUSE AND THE")
)
console.log("\n=== Context around Country Mouse (index", idx, ") ===")
for (let i = Math.max(0, idx - 2); i < Math.min(blocks.length, idx + 6); i += 1) {
  const block = blocks[i]
  console.log(
    i,
    JSON.stringify({
      text: (block.text ?? "").slice(0, 80),
      isHeading: block.isHeading,
      fontSize: block.fontSize,
      align: block.textAlign,
      page: block.sourcePdfPage,
    })
  )
}

console.log("\n=== KING / Frogs ===")
for (const block of blocks.filter(
  (b) =>
    (b.text ?? "").trim() === "KING" ||
    (b.text ?? "").includes("FROGS WHO ASKED")
)) {
  console.log(
    JSON.stringify({
      text: block.text,
      isHeading: block.isHeading,
      fontSize: block.fontSize,
    })
  )
}

console.log("\n=== Ants prose after title ===")
const antsIdx = blocks.findIndex(
  (block) =>
    block.isHeading && (block.text ?? "").includes("Ants and the Grasshoppers")
)
if (antsIdx >= 0) {
  console.log("title block:", blocks[antsIdx].text, blocks[antsIdx].isHeading)
  for (let j = antsIdx + 1; j < Math.min(antsIdx + 4, blocks.length); j += 1) {
    console.log("  +", (blocks[j].text ?? "").slice(0, 100))
  }
}

console.log("\n=== Wolf/Lamb page 19 ===")
for (const block of blocks.filter((b) => (b.text ?? "").includes("Wolf and the Lamb"))) {
  if ((block.text ?? "").length < 40) {
    console.log(JSON.stringify({ text: block.text, isHeading: block.isHeading, page: block.sourcePdfPage }))
  }
}
