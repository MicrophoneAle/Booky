import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

process.env.SUPABASE_URL ??= "https://example.supabase.co"
process.env.SUPABASE_SERVICE_KEY ??= "test-service-key"

const { parsePdfBuffer } = await import("../index.js")
const buffer = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "../../client/src/assets/Oliver Twist.pdf")
)
const result = await parsePdfBuffer(buffer, "Oliver Twist.pdf")

const dangling =
  /\b(?:the|a|an|and|of|his|her|to|in|on|with|for|at|by|from|into|that|which|who|as|if|their|our|your|had|has|have|not|are|were|is|merry|short|word|very|being|this|these|those|some|any|each|every|such|other|another|same|own|new|old|first|last|next|same|one|two|three|four|five|six|seven|eight|nine|ten)\s*$/i

console.log("chapters:", result.chapters.length)
for (const ch of result.chapters) {
  const title = ch.title ?? ""
  if (dangling.test(title) || title.length < 25) {
    console.log("SUSPECT:", title)
  }
}
