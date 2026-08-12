import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const { parsePdfBuffer, PARSER_VERSION } = await import("../index.js")

const pdfPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/src/assets/The Old Man and the Sea.pdf"
)

const { contentWithChapters } = await parsePdfBuffer(
  readFileSync(pdfPath),
  "oldman.pdf"
)

const blocks = contentWithChapters.flatMap((page) => page.blocks ?? [])
const joined = blocks.map((block) => block.text ?? "").join(" ")

let pass = true
const checks = [
  ["no asiaing watermark", () => !/asiaing/i.test(joined)],
  [
    "permanent defeat merged",
    () => {
      const block = blocks.find((entry) =>
        /permanent defeat/.test(entry.text ?? "")
      )
      return (
        block &&
        !block.isHeading &&
        /it looked/i.test(block.text ?? "")
      )
    },
  ],
  [
    "eyes sentence merged",
    () => {
      const block = blocks.find((entry) =>
        /cheerful and undefeated/.test(entry.text ?? "")
      )
      return block && /Everything about him was old/.test(block.text ?? "")
    },
  ],
  [
    "dialogue split",
    () => {
      const eyes = blocks.find((entry) =>
        /Are his eyes that bad/.test(entry.text ?? "")
      )
      return eyes && (eyes.text ?? "").length < 120
    },
  ],
  // Source dedication is three lines ("To Charlie Shribner" / "And" /
  // "To Max Perkins"). The pre-fix assertion expected the buggy merge
  // "To Charlie Shribner And"; the two addressee lines must stay separate.
  [
    "dedication lines present",
    () => {
      const charlie = blocks.some((entry) =>
        /^To Charlie Shribner$/i.test((entry.text ?? "").trim())
      )
      const max = blocks.some((entry) =>
        /^To Max Perkins$/i.test((entry.text ?? "").trim())
      )
      return charlie && max
    },
  ],
  [
    "no false narrative headings",
    () =>
      !blocks.some(
        (entry) =>
          entry.isHeading &&
          /Terrace and asked for a can of coffee|Finally the old man woke|sun was hot now although the breeze|Not in the absolute dark\. But almost|heavy brisa have we|How much did you suffer/.test(
            entry.text ?? ""
          )
      ),
  ],
]

console.log(`Parser version: ${PARSER_VERSION}`)
for (const [label, fn] of checks) {
  const ok = fn()
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`)
  if (!ok) {
    pass = false
  }
}

process.exit(pass ? 0 : 1)
