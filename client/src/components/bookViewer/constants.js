export const NAVBAR_HEIGHT_PX = 44
export const PAGE_WIDTH_PX = 400
export const PAGE_CONTENT_INSET_PX = 72
export const PAGE_HEIGHT_PX = 600
/** Fallback page height when the stage is not mounted yet (matches 059e9ea). */
export const MOBILE_FULLSCREEN_PAGE_HEIGHT_PX = 780
export const MOBILE_FULLSCREEN_PAGE_HEIGHT_MIN_PX = 600
export const SPINE_PX = 1
export const PAGE_FOOTER_RESERVE_PX = 12
export const PAGE_BOTTOM_INSET_PX = 2
export const PAGE_NUMBER_RESERVED_PX = PAGE_FOOTER_RESERVE_PX
export const BODY_DESCENDER_PAD_PX = 5
export const PAGE_CONTENT_FIT_BUFFER_PX = 3
export const PAGE_FIT_OVERFLOW_TOLERANCE_PX = 0
export const MOBILE_PAGE_NUMBER_GAP_PX = 3
/** Compact mobile footer reserve (page number line + small breathing room). */
export const MOBILE_PAGE_NUMBER_RESERVED_PX = 12
/** Gap above page number + number line in mobile fullscreen. */
export const MOBILE_FULLSCREEN_FOOTER_BLOCK_PX = 8
/** Bottom inset so the page number sits near the Safari URL bar. */
export const MOBILE_FULLSCREEN_BOTTOM_CHROME_PX = 4
/** Top inset matching .book-page--mobile-fs safe-area padding. */
export const MOBILE_FULLSCREEN_TOP_INSET_PX = 8
export const MOBILE_FULLSCREEN_PAGE_NUMBER_RESERVED_PX =
  MOBILE_FULLSCREEN_FOOTER_BLOCK_PX
export const CONTENT_HEIGHT_SAFETY_BUFFER_PX = 4
export const BODY_BOTTOM_PADDING_PX = 2
/**
 * Exact body (text) height for a mobile-fullscreen page. Kept in lock-step with
 * the measurement math in getLayoutHeights so the displayed body is the same
 * height the text was paginated for — no gap above the page number, no clipping.
 */
export const MOBILE_FULLSCREEN_CONTENT_HEIGHT_PX =
  MOBILE_FULLSCREEN_PAGE_HEIGHT_PX -
  MOBILE_FULLSCREEN_TOP_INSET_PX -
  MOBILE_FULLSCREEN_BOTTOM_CHROME_PX -
  MOBILE_FULLSCREEN_FOOTER_BLOCK_PX -
  BODY_BOTTOM_PADDING_PX
export const TRIVIAL_LAST_PAGE_CHAR_LIMIT = 50
export const TYPESETTING_REPAGINATION_DELAY_MS = 32
export const PAGINATION_INITIAL_PAGES = 80
export const PAGINATION_BATCH_PAGES = 80
/** Keep in sync with server/index.js PARSER_VERSION — invalidates pagination cache when bumped. */
export const PARSER_VERSION = 65
/** Bump only when client pagination/measurement logic changes (not server parser). */
export const PAGINATION_MEASUREMENT_VERSION = 24
export const PAGINATION_CACHE_PREFIX = "booky-pages|"
export const PAGINATION_CACHE_TS_PREFIX = "booky-pages-ts|"
/**
 * Each book stores up to two pagination entries (normal + mobile fullscreen),
 * so this caps roughly the number of fully-cached books. Eviction is grouped by
 * book to avoid leaving a book half-cached (which would force re-pagination).
 */
export const PAGINATION_CACHE_MAX_BOOKS = 8
export const READING_ANCHOR_PREFIX_LENGTH = 40
export const LOADING_READY_DISMISS_MS = 150
