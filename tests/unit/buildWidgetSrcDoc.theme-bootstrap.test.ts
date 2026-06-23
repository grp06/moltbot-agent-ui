// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildWidgetSrcDoc } from "@/features/agents/components/widgets/buildWidgetSrcDoc";
import type { ThemeVars } from "@/features/agents/components/widgets/widgetTheme";

const sampleTheme: ThemeVars = {
  "--bg": "#000",
  "--text": "#fff",
  "--card": "#111",
  "--border": "#222",
  "--accent": "#333",
  "--muted": "#444",
  "--ok": "#0f0",
  "--warn": "#ff0",
  "--danger": "#f00",
};

describe("buildWidgetSrcDoc — theme bootstrap script (D-01..D-05)", () => {
  it("emits a listener for 'theme:update' messages", () => {
    const out = buildWidgetSrcDoc({
      html: "<div/>",
      themeVars: sampleTheme,
      widgetId: "w1",
    });
    expect(out).toContain("'theme:update'");
    expect(out).toContain("addEventListener('message'");
  });

  it("applies updates via document.documentElement.style.setProperty", () => {
    const out = buildWidgetSrcDoc({
      html: "<div/>",
      themeVars: sampleTheme,
      widgetId: "w1",
    });
    expect(out).toContain("document.documentElement.style.setProperty");
  });

  it("includes all 9 widget-side var names in the bootstrap allowlist", () => {
    const out = buildWidgetSrcDoc({
      html: "<div/>",
      themeVars: sampleTheme,
      widgetId: "w1",
    });
    for (const name of [
      "--bg",
      "--text",
      "--card",
      "--border",
      "--accent",
      "--muted",
      "--ok",
      "--warn",
      "--danger",
    ]) {
      expect(out).toContain(name);
    }
  });

  it("wraps the bootstrap body in a try/catch so a bad message never breaks the widget", () => {
    const out = buildWidgetSrcDoc({
      html: "<div/>",
      themeVars: sampleTheme,
      widgetId: "w1",
    });
    expect(out).toMatch(/try\{[\s\S]*?\}catch\(err\)\{\}/);
  });

  it("emits the bootstrap script in addition to the existing height reporter", () => {
    const out = buildWidgetSrcDoc({
      html: "<div/>",
      themeVars: sampleTheme,
      widgetId: "w1",
    });
    expect(out).toContain("iframe:height");
    expect(out).toContain("theme:update");
  });

  it("is byte-identical for repeated calls with the same args (purity)", () => {
    const a = buildWidgetSrcDoc({
      html: "<div>same</div>",
      themeVars: sampleTheme,
      widgetId: "w1",
    });
    const b = buildWidgetSrcDoc({
      html: "<div>same</div>",
      themeVars: sampleTheme,
      widgetId: "w1",
    });
    expect(a).toBe(b);
  });
});
