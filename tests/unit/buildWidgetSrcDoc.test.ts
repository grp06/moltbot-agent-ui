// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildWidgetSrcDoc,
  CHART_JS_CDN_URL,
  TAILWIND_CDN_URL,
  WIDGET_SANDBOX,
} from "@/features/agents/components/widgets/buildWidgetSrcDoc";
import type { ThemeVars } from "@/features/agents/components/widgets/widgetTheme";

const FIXTURE_THEME: ThemeVars = {
  "--bg": "#ffffff",
  "--text": "#111827",
  "--card": "#f9fafb",
  "--border": "#e5e7eb",
  "--accent": "#2563eb",
  "--muted": "#6b7280",
  "--ok": "#16a34a",
  "--warn": "#d97706",
  "--danger": "#dc2626",
};

const FIXTURE_HTML = '<canvas id="c"></canvas>';
const FIXTURE_WIDGET_ID = "abc123";

describe("buildWidgetSrcDoc", () => {
  it("exports the literal sandbox token string allow-scripts allow-popups", () => {
    expect(WIDGET_SANDBOX).toBe("allow-scripts allow-popups");
  });

  it("emits the Tailwind v4 jsdelivr browser CDN URL in the output", () => {
    const out = buildWidgetSrcDoc({
      html: FIXTURE_HTML,
      themeVars: FIXTURE_THEME,
      widgetId: FIXTURE_WIDGET_ID,
    });
    expect(TAILWIND_CDN_URL).toBe(
      "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4",
    );
    expect(out).toContain(
      "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4",
    );
  });

  it("emits the Chart.js 4.5.1 jsdelivr URL in the output (never @latest)", () => {
    const out = buildWidgetSrcDoc({
      html: FIXTURE_HTML,
      themeVars: FIXTURE_THEME,
      widgetId: FIXTURE_WIDGET_ID,
    });
    expect(CHART_JS_CDN_URL).toBe(
      "https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js",
    );
    expect(out).toContain("chart.js@4.5.1/dist/chart.umd.min.js");
    expect(out).not.toContain("@latest");
  });

  it("injects all 9 widget-side CSS variables into the style block", () => {
    const out = buildWidgetSrcDoc({
      html: FIXTURE_HTML,
      themeVars: FIXTURE_THEME,
      widgetId: FIXTURE_WIDGET_ID,
    });
    const expectedNames: ReadonlyArray<keyof ThemeVars> = [
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
    for (const name of expectedNames) {
      expect(out).toContain(`${name}: ${FIXTURE_THEME[name]};`);
    }
  });

  it("includes the height-reporter postMessage script with the widgetId", () => {
    const out = buildWidgetSrcDoc({
      html: FIXTURE_HTML,
      themeVars: FIXTURE_THEME,
      widgetId: FIXTURE_WIDGET_ID,
    });
    expect(out).toContain("parent.postMessage");
    expect(out).toContain("iframe:height");
    expect(out).toContain(FIXTURE_WIDGET_ID);
  });

  it("returns byte-identical output for identical inputs (purity)", () => {
    const args = {
      html: FIXTURE_HTML,
      themeVars: FIXTURE_THEME,
      widgetId: FIXTURE_WIDGET_ID,
    };
    const a = buildWidgetSrcDoc(args);
    const b = buildWidgetSrcDoc(args);
    expect(a).toBe(b);
  });
});
