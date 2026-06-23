/**
 * buildWidgetSrcDoc — pure HTML-document builder for inline widgets.
 *
 * Pure: same `{ html, themeVars, widgetId }` always produces byte-identical
 * output. No DOM reads (`document.*`, `window.*`, `getComputedStyle`); no
 * randomness (`Date.now`, `Math.random`, `crypto.randomUUID`); no React
 * imports. Theme reading lives in `widgetTheme.ts` per D-07/D-08.
 *
 * Sandbox token (`WIDGET_SANDBOX`) and CDN URLs (`TAILWIND_CDN_URL`,
 * `CHART_JS_CDN_URL`) are exported as named module-level `as const` strings
 * per D-21..D-24 so unit tests assert literal-equality.
 */
import type { ThemeVars } from "./widgetTheme";

/**
 * iframe sandbox token. Hard guardrail: `allow-scripts allow-popups` ONLY.
 * Never extend with `allow-same-origin` (the documented WHATWG sandbox
 * escape) or `allow-forms` / `allow-top-navigation`.
 */
export const WIDGET_SANDBOX = "allow-scripts allow-popups" as const;

/**
 * Tailwind v4 browser CDN. The original spec referenced v3
 * `cdn.tailwindcss.com`; research-corrected to the v4 jsdelivr URL.
 */
export const TAILWIND_CDN_URL =
  "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4" as const;

/**
 * Chart.js 4.5.1 pinned UMD bundle. Pinned full version per D-22 — never
 * `@latest` (would silently break when Chart.js 5 ships with a non-UMD
 * default).
 */
export const CHART_JS_CDN_URL =
  "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js" as const;

const WIDGET_VAR_ORDER = [
  "--bg",
  "--text",
  "--card",
  "--border",
  "--accent",
  "--muted",
  "--ok",
  "--warn",
  "--danger",
] as const;

const buildThemeStyleBlock = (themeVars: ThemeVars): string => {
  const lines: string[] = [];
  for (const name of WIDGET_VAR_ORDER) {
    lines.push(`${name}: ${themeVars[name]};`);
  }
  return `<style>:root{${lines.join(" ")}}</style>`;
};

const buildHeightReporterScript = (widgetId: string): string => {
  return [
    "<script>(function(){",
    `var widgetId = ${JSON.stringify(widgetId)};`,
    "function report(){try{parent.postMessage({type:'iframe:height',widgetId:widgetId,height:document.documentElement.scrollHeight},'*');}catch(e){}}",
    "window.addEventListener('load',report);",
    "if(typeof ResizeObserver!=='undefined'){new ResizeObserver(report).observe(document.body);}",
    "})();</script>",
  ].join("");
};

/**
 * Theme-update listener bootstrap (D-01..D-05). Listens for window messages
 * of shape `{ type: "theme:update", vars: ThemeVars }` and applies each
 * mapped CSS variable to `:root` in place. Does NOT rebuild the document —
 * Chart.js instances and JS state survive theme toggles.
 *
 * Wraps the body in a try/catch so a bad message never breaks the widget.
 */
const buildThemeBootstrapScript = (): string => {
  const varNames = JSON.stringify([
    "--bg",
    "--text",
    "--card",
    "--border",
    "--accent",
    "--muted",
    "--ok",
    "--warn",
    "--danger",
  ]);
  return [
    "<script>(function(){",
    `var widgetVars = ${varNames};`,
    "window.addEventListener('message',function(e){",
    "try{",
    "if(!e || !e.data || e.data.type !== 'theme:update' || !e.data.vars) return;",
    "var vars = e.data.vars;",
    "for(var i=0;i<widgetVars.length;i++){",
    "var name = widgetVars[i];",
    "if(typeof vars[name] === 'string'){",
    "document.documentElement.style.setProperty(name, vars[name]);",
    "}}",
    "}catch(err){}",
    "});",
    "})();</script>",
  ].join("");
};

type BuildWidgetSrcDocArgs = {
  html: string;
  themeVars: ThemeVars;
  widgetId: string;
};

/**
 * Build a complete srcDoc HTML string for a widget iframe. The returned
 * document includes:
 *   - `<!DOCTYPE html>` declaration
 *   - `<head>` with the 9 widget-side CSS variables (deterministic order)
 *     and the Tailwind v4 + Chart.js 4.5.1 CDN script tags
 *   - `<body>` containing the agent-supplied HTML followed by the
 *     height-reporter postMessage script bound to the supplied `widgetId`
 *
 * Function is pure — invoking with identical args returns the exact same
 * string. The consumer (Phase 2 `InlineWidget`) is responsible for applying
 * `WIDGET_SANDBOX` to the iframe element.
 */
export const buildWidgetSrcDoc = ({
  html,
  themeVars,
  widgetId,
}: BuildWidgetSrcDocArgs): string => {
  const styleBlock = buildThemeStyleBlock(themeVars);
  const reporter = buildHeightReporterScript(widgetId);
  const themeBootstrap = buildThemeBootstrapScript();
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    styleBlock,
    `<script src="${TAILWIND_CDN_URL}"></script>`,
    `<script src="${CHART_JS_CDN_URL}"></script>`,
    "</head>",
    "<body>",
    html,
    reporter,
    themeBootstrap,
    "</body>",
    "</html>",
  ].join("");
};
