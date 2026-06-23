/**
 * widgetConstants — module-level numeric/string constants shared across the
 * Phase 2 widget subsystem. Pulled out so InlineWidget, the message registry,
 * the theme broadcast singleton, and the error boundary all reference identical
 * values without duplication.
 *
 * All values use the const-assertion suffix per CONVENTIONS.md
 * ("Module-level constants" pattern). No runtime configuration; thresholds
 * are baked in per 02-CONTEXT.md decisions (D-11 rate limit, D-14 height
 * bounds, D-17 revoke delay, D-19 title fallback).
 */

/** Minimum iframe height in pixels (per CONTEXT.md D-14). */
export const MIN_HEIGHT = 60 as const;

/** Maximum iframe height in pixels (per SEC-02 / CONTEXT.md D-14). */
export const MAX_HEIGHT = 600 as const;

/** Sliding-window length for height-message rate limiting in ms (D-11). */
export const RATE_LIMIT_WINDOW_MS = 500 as const;

/** Maximum height messages per widget per RATE_LIMIT_WINDOW_MS (D-11). */
export const RATE_LIMIT_MAX_MSGS = 10 as const;

/** Fallback title used when an empty title slips past the parser (D-19). */
export const WIDGET_TITLE_FALLBACK = "Widget" as const;

/** Fallback delay before revoking an open-in-new-tab Blob URL (D-17). */
export const OPEN_NEW_TAB_REVOKE_DELAY_MS = 30_000 as const;
