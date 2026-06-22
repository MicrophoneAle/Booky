import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const pdfPath = join(__dirname, "../../client/src/assets/Aesop's Fables.pdf")

const { extractLinesByPosition, PARSER_VERSION } = await import("../index.js")

const pageData = await extractLinesByPosition(readFileSync(pdfPath))

console.log("=== Page 27 lines ===")
for (const line of pageData[26]?.lines ?? []) {
  console.log(
    JSON.stringify({
      text: (line.text ?? "").slice(0, 100),
      fontSize: line.fontSize,
      centered: line.centered,
    })
  )
}

console.log("\n=== Page 19 lines (Wolf/Lamb) ===")
for (const line of pageData[18]?.lines ?? []) {
  console.log(
    JSON.stringify({
      text: (line.text ?? "").slice(0, 100),
      fontSize: line.fontSize,
      centered: line.centered,
    })
  )
}

console.log("\nPARSER_VERSION", PARSER_VERSION)
