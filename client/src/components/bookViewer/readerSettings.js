import {
  PAGE_FOOTER_RESERVE_PX,
  PAGE_BOTTOM_INSET_PX,
} from "./constants.js"
import { getLayoutHeights, getPageNumberReservedPx } from "./measureLayout.jsx"
export const DEFAULT_SETTINGS = {
  theme: "parchment",
  fontSize: "medium",
  fontStyle: "lora",
  lineSpacing: "normal",
  margins: "normal",
  customFontSizePx: 10,
  customLineSpacing: 1.15,
  customMarginRem: 0.75,
}

export const CUSTOM_FONT_SIZE_LIMITS = { min: 8, max: 22 }
export const CUSTOM_LINE_SPACING_LIMITS = { min: 1, max: 2, step: 0.05 }
export const CUSTOM_MARGIN_REM_LIMITS = { min: 0, max: 2, step: 0.05 }

export const FONT_SIZE_MAP = {
  small: { body: 9, heading: 13, title: 19 },
  medium: { body: 10, heading: 15, title: 22 },
  large: { body: 12, heading: 17, title: 24 },
  xlarge: { body: 14, heading: 19, title: 26 },
}

export const FONT_FAMILY_MAP = {
  lora: { body: "'Lora', Georgia, serif", heading: "'EB Garamond', Georgia, serif" },
  garamond: { body: "'EB Garamond', Georgia, serif", heading: "'EB Garamond', Georgia, serif" },
  georgia: { body: "Georgia, serif", heading: "Georgia, serif" },
  palatino: {
    body: "'Palatino Linotype', 'Book Antiqua', Palatino, serif",
    heading: "'Palatino Linotype', 'Book Antiqua', Palatino, serif",
  },
  times: {
    body: "'Times New Roman', Times, serif",
    heading: "'Times New Roman', Times, serif",
  },
  calibri: {
    body: "Calibri, 'Segoe UI', sans-serif",
    heading: "Calibri, 'Segoe UI', sans-serif",
  },
}

export const FONT_STYLE_OPTIONS = [
  { id: "lora", label: "Lora" },
  { id: "garamond", label: "Garamond" },
  { id: "georgia", label: "Georgia" },
  { id: "palatino", label: "Palatino" },
  { id: "times", label: "Times New Roman" },
  { id: "calibri", label: "Calibri" },
]

export const LINE_HEIGHT_MAP = {
  compact: { body: 1.0, heading: 1.0 },
  normal: { body: 1.15, heading: 1.2 },
  relaxed: { body: 1.5, heading: 1.3 },
  airy: { body: 1.65, heading: 1.4 },
}

export const MARGIN_MAP = {
  none: "0px",
  narrow: "0.35rem",
  normal: "0.75rem",
  wide: "1.25rem",
}

export function getStepDecimalPlaces(step) {
  const stepText = String(step)
  if (!stepText.includes(".")) {
    return 0
  }
  return stepText.split(".")[1].length
}

export function roundToStep(value, step) {
  const decimals = getStepDecimalPlaces(step)
  const rounded = Math.round(value / step) * step
  return Number(rounded.toFixed(decimals))
}

export function sanitizeCustomFontSizePx(
  value,
  fallback = DEFAULT_SETTINGS.customFontSizePx
) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.min(
    CUSTOM_FONT_SIZE_LIMITS.max,
    Math.max(CUSTOM_FONT_SIZE_LIMITS.min, Math.round(parsed))
  )
}

export function sanitizeCustomLineSpacing(
  value,
  fallback = DEFAULT_SETTINGS.customLineSpacing
) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  const clamped = Math.min(
    CUSTOM_LINE_SPACING_LIMITS.max,
    Math.max(CUSTOM_LINE_SPACING_LIMITS.min, parsed)
  )
  return roundToStep(clamped, CUSTOM_LINE_SPACING_LIMITS.step)
}

export function sanitizeCustomMarginRem(
  value,
  fallback = DEFAULT_SETTINGS.customMarginRem
) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback
  }
  const clamped = Math.min(
    CUSTOM_MARGIN_REM_LIMITS.max,
    Math.max(CUSTOM_MARGIN_REM_LIMITS.min, parsed)
  )
  return roundToStep(clamped, CUSTOM_MARGIN_REM_LIMITS.step)
}

export function normalizeReaderSettings(settings) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    customFontSizePx: sanitizeCustomFontSizePx(settings?.customFontSizePx),
    customLineSpacing: sanitizeCustomLineSpacing(settings?.customLineSpacing),
    customMarginRem: sanitizeCustomMarginRem(settings?.customMarginRem),
  }
}

export function deriveFontMetricsFromBody(bodyPx) {
  const body = sanitizeCustomFontSizePx(bodyPx)
  return {
    body,
    heading: body + 5,
    title: body + 12,
  }
}

export function resolveFontMetrics(settings) {
  if (settings?.fontSize === "custom") {
    return deriveFontMetricsFromBody(settings.customFontSizePx)
  }
  return FONT_SIZE_MAP[settings?.fontSize] ?? FONT_SIZE_MAP.medium
}

export function resolveLineHeight(settings) {
  if (settings?.lineSpacing === "custom") {
    const body = sanitizeCustomLineSpacing(settings.customLineSpacing)
    const heading = sanitizeCustomLineSpacing(
      Math.min(body + 0.05, body * 1.08),
      body
    )
    return { body, heading }
  }
  return LINE_HEIGHT_MAP[settings?.lineSpacing] ?? LINE_HEIGHT_MAP.normal
}

export function resolveMarginCss(settingsOrKey) {
  if (typeof settingsOrKey === "string") {
    return MARGIN_MAP[settingsOrKey] ?? MARGIN_MAP.normal
  }

  const marginKey = settingsOrKey?.margins ?? DEFAULT_SETTINGS.margins
  if (marginKey === "custom") {
    const rem = sanitizeCustomMarginRem(settingsOrKey?.customMarginRem)
    return rem <= 0 ? "0px" : `${rem}rem`
  }

  return MARGIN_MAP[marginKey] ?? MARGIN_MAP.normal
}

export function getPageMarginPx(settingsOrKey) {
  const remPx =
    typeof document !== "undefined"
      ? parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      : 16
  const raw = resolveMarginCss(settingsOrKey)
  return raw === "0px" ? 0 : parseFloat(raw) * remPx
}

export function getPagePaddingStyle(settingsOrKey) {
  const pad = resolveMarginCss(settingsOrKey)
  if (pad === "0px") {
    return { padding: 0 }
  }
  return {
    paddingTop: pad,
    paddingRight: pad,
    paddingLeft: pad,
    paddingBottom: 0,
  }
}

export function formatFontSizeChipLabel(size, settings) {
  if (size === "custom") {
    const bodyPx = sanitizeCustomFontSizePx(settings?.customFontSizePx)
    return `Custom ${bodyPx}px`
  }
  const name =
    size === "xlarge" ? "XL" : size.charAt(0).toUpperCase() + size.slice(1)
  const bodyPx = FONT_SIZE_MAP[size]?.body ?? FONT_SIZE_MAP.medium.body
  return `${name} ${bodyPx}px`
}

export function formatLineSpacingChipLabel(spacing, settings) {
  if (spacing === "custom") {
    const lineHeight = sanitizeCustomLineSpacing(settings?.customLineSpacing)
    return `Custom ${lineHeight}`
  }
  const name = spacing.charAt(0).toUpperCase() + spacing.slice(1)
  const lineHeight =
    LINE_HEIGHT_MAP[spacing]?.body ?? LINE_HEIGHT_MAP.normal.body
  return `${name} ${lineHeight}`
}

export function formatMarginChipLabel(margin, settings) {
  if (margin === "custom") {
    const rem = sanitizeCustomMarginRem(settings?.customMarginRem)
    return rem <= 0 ? "Custom 0px" : `Custom ${rem}rem`
  }
  const name = margin.charAt(0).toUpperCase() + margin.slice(1)
  return `${name} ${MARGIN_MAP[margin] ?? MARGIN_MAP.normal}`
}

/** Non-fullscreen chrome: margins + exact paginated body height (matches measurement). */
export function getPageContentHeightPx(settingsOrKey, isMobileViewport = false) {
  const { contentMaxHeight } = getLayoutHeights(
    undefined,
    settingsOrKey,
    getPageNumberReservedPx(isMobileViewport, false),
    { pageInsetTopPx: 0, pageInsetBottomPx: PAGE_BOTTOM_INSET_PX }
  )
  return contentMaxHeight
}

export function getPageChromeStyle(settingsOrKey, isMobileViewport = false) {
  const pad = resolveMarginCss(settingsOrKey)
  const contentHeightPx = getPageContentHeightPx(settingsOrKey, isMobileViewport)
  return {
    "--page-footer-reserve": `${PAGE_FOOTER_RESERVE_PX}px`,
    "--page-content-h": `${contentHeightPx}px`,
    ...(pad === "0px"
      ? { padding: 0, paddingBottom: `${PAGE_BOTTOM_INSET_PX}px` }
      : {
          paddingTop: pad,
          paddingRight: pad,
          paddingLeft: pad,
          paddingBottom: `${PAGE_BOTTOM_INSET_PX}px`,
        }),
  }
}

