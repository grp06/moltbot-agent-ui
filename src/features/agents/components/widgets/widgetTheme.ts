/**
 * widgetTheme — DOM-aware Studio→widget theme bridge.
 *
 * Exposes:
 *   - `WidgetCssVarName` — string-literal union of the 9 widget-side var names
 *   - `ThemeVars` — `Record<WidgetCssVarName, string>`
 *   - `MAPPED_CSS_VARS` — frozen 9-row mapping (widget-side -> Studio token + light/dark fallbacks)
 *   - `readThemeSnapshot()` — DOM-aware helper that resolves the live theme into a `ThemeVars`
 *
 * Mapping table is sourced from CONTEXT.md D-19 and confirmed by Phase 1 DISC-03 audit
 * (see `.planning/phases/01-foundation-discovery/01-DISCOVERY.md`); Studio's globals.css
 * defines all 9 source tokens with no deviation.
 *
 * Phase 1 boundary: this module reads the DOM only inside `readThemeSnapshot()`. Pure
 * helpers (and tests under node env) consume `ThemeVars` directly via the type.
 */

export type WidgetCssVarName =
  | "--bg"
  | "--text"
  | "--card"
  | "--border"
  | "--accent"
  | "--muted"
  | "--ok"
  | "--warn"
  | "--danger";

export type ThemeVars = Record<WidgetCssVarName, string>;

type WidgetVarMapping = {
  studioToken: string;
  lightFallback: string;
  darkFallback: string;
};

/**
 * Studio→widget CSS variable mapping. Frozen at module load so no consumer can
 * mutate the table at runtime. Sourced from DISC-03 audit and CONTEXT.md D-19.
 */
export const MAPPED_CSS_VARS: Readonly<
  Record<WidgetCssVarName, WidgetVarMapping>
> = Object.freeze({
  "--bg": {
    studioToken: "--background",
    lightFallback: "#ffffff",
    darkFallback: "#0b0f17",
  },
  "--text": {
    studioToken: "--foreground",
    lightFallback: "#111827",
    darkFallback: "#e5e7eb",
  },
  "--card": {
    studioToken: "--card",
    lightFallback: "#f9fafb",
    darkFallback: "#111827",
  },
  "--border": {
    studioToken: "--border",
    lightFallback: "#e5e7eb",
    darkFallback: "#374151",
  },
  "--accent": {
    studioToken: "--accent",
    lightFallback: "#2563eb",
    darkFallback: "#3b82f6",
  },
  "--muted": {
    studioToken: "--muted-foreground",
    lightFallback: "#6b7280",
    darkFallback: "#9ca3af",
  },
  "--ok": {
    studioToken: "--status-running-fg",
    lightFallback: "#16a34a",
    darkFallback: "#22c55e",
  },
  "--warn": {
    studioToken: "--status-connecting-fg",
    lightFallback: "#d97706",
    darkFallback: "#f59e0b",
  },
  "--danger": {
    studioToken: "--danger-soft-fg",
    lightFallback: "#dc2626",
    darkFallback: "#ef4444",
  },
} as const);

const WIDGET_VAR_NAMES: readonly WidgetCssVarName[] = [
  "--bg",
  "--text",
  "--card",
  "--border",
  "--accent",
  "--muted",
  "--ok",
  "--warn",
  "--danger",
];

/**
 * Read the live Studio theme into a complete `ThemeVars` object. Falls back
 * to the per-row light/dark default when a Studio token is unset (e.g. in
 * SSR or unit-test environments where `document` is unavailable).
 *
 * Theme is "dark" iff `document.documentElement` carries the `dark` class
 * (DISC-04 — Studio's `ThemeToggle` mutates that class only).
 */
export const readThemeSnapshot = (): ThemeVars => {
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");
  const computed =
    typeof document !== "undefined" && typeof getComputedStyle === "function"
      ? getComputedStyle(document.documentElement)
      : null;
  const result = {} as ThemeVars;
  for (const name of WIDGET_VAR_NAMES) {
    const mapping = MAPPED_CSS_VARS[name];
    const studioValue =
      computed !== null
        ? computed.getPropertyValue(mapping.studioToken).trim()
        : "";
    const fallback = isDark ? mapping.darkFallback : mapping.lightFallback;
    result[name] = studioValue.length > 0 ? studioValue : fallback;
  }
  return result;
};
