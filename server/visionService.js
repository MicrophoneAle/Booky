import OpenAI from "openai"

const VISION_ANALYSIS_PROMPT =
  "You are a specialized layout parsing agent for a digital publishing platform. Analyze this book graphic. Determine if it is a stylized chapter heading, character point-of-view icon, or book-section graphic that denotes a major narrative transition. If it is just a normal story illustration, margin decoration, or divider flourish, flag it false."

const CHAPTER_GRAPHIC_RESPONSE_SCHEMA = {
  name: "chapter_graphic_analysis",
  strict: true,
  schema: {
    type: "object",
    properties: {
      isChapterBoundary: { type: "boolean" },
      title: { type: ["string", "null"] },
      number: { type: ["string", "null"] },
      rawText: { type: ["string", "null"] },
    },
    required: ["isChapterBoundary", "title", "number", "rawText"],
    additionalProperties: false,
  },
}

const SAFE_FALLBACK = Object.freeze({
  isChapterBoundary: false,
  title: null,
  number: null,
  rawText: null,
})

const DEFAULT_VISION_MODEL = "gpt-4o-mini"
const DEFAULT_VISION_TIMEOUT_MS = 30_000

let openAiClient = null

function getOpenAiClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null
  }

  if (!openAiClient) {
    openAiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: Number(process.env.OPENAI_VISION_TIMEOUT_MS) || DEFAULT_VISION_TIMEOUT_MS,
      maxRetries: 0,
    })
  }

  return openAiClient
}

function resolveVisionModel() {
  return (process.env.OPENAI_VISION_MODEL ?? DEFAULT_VISION_MODEL).trim()
}

function normalizeBase64Image(base64Image) {
  const trimmed = (base64Image ?? "").trim()
  if (!trimmed) {
    return ""
  }

  if (trimmed.startsWith("data:")) {
    return trimmed
  }

  return `data:image/png;base64,${trimmed}`
}

function logVisionServiceError(error, context = {}) {
  const message = error instanceof Error ? error.message : String(error)
  const payload = {
    service: "visionService",
    message,
    ...context,
  }

  if (error instanceof OpenAI.APIError) {
    payload.status = error.status
    payload.code = error.code
    payload.type = error.type
  }

  console.error("[visionService]", JSON.stringify(payload))
}

function normalizeNullableString(value) {
  if (value == null) {
    return null
  }

  const trimmed = String(value).trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseChapterGraphicAnalysis(rawContent) {
  if (typeof rawContent !== "string" || !rawContent.trim()) {
    throw new Error("Vision model returned an empty response")
  }

  let parsed
  try {
    parsed = JSON.parse(rawContent)
  } catch (error) {
    throw new Error(
      `Vision model returned invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`
    )
  }

  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    throw new Error("Vision model JSON response was not an object")
  }

  return {
    isChapterBoundary: Boolean(parsed.isChapterBoundary),
    title: normalizeNullableString(parsed.title),
    number: normalizeNullableString(parsed.number),
    rawText: normalizeNullableString(parsed.rawText),
  }
}

/**
 * Analyze a book graphic with a multimodal vision model.
 *
 * @param {string} base64Image Raw base64 image bytes or a data URL.
 * @returns {Promise<{ isChapterBoundary: boolean, title: string | null, number: string | null, rawText: string | null }>}
 */
async function analyzeChapterGraphic(base64Image) {
  const imageUrl = normalizeBase64Image(base64Image)
  if (!imageUrl) {
    logVisionServiceError(new Error("Missing base64 image payload"), {
      stage: "input_validation",
    })
    return { ...SAFE_FALLBACK }
  }

  const client = getOpenAiClient()
  if (!client) {
    logVisionServiceError(new Error("OPENAI_API_KEY is not configured"), {
      stage: "client_initialization",
    })
    return { ...SAFE_FALLBACK }
  }

  try {
    const response = await client.chat.completions.create({
      model: resolveVisionModel(),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: VISION_ANALYSIS_PROMPT },
            {
              type: "image_url",
              image_url: {
                url: imageUrl,
                detail: "low",
              },
            },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: CHAPTER_GRAPHIC_RESPONSE_SCHEMA,
      },
    })

    const rawContent = response.choices?.[0]?.message?.content
    return parseChapterGraphicAnalysis(rawContent)
  } catch (error) {
    const context = { stage: "vision_api_call", model: resolveVisionModel() }

    if (error instanceof OpenAI.APIError) {
      if (error.status === 429) {
        context.reason = "rate_limit"
      } else if (error.code === "timeout" || /timed out/i.test(error.message ?? "")) {
        context.reason = "timeout"
      }
    }

    logVisionServiceError(error, context)
    return { ...SAFE_FALLBACK }
  }
}

export { analyzeChapterGraphic }
