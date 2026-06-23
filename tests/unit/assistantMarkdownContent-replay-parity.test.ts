import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { AssistantMarkdownContent } from "@/features/agents/components/widgets/AssistantMarkdownContent";

const FINALIZED_WIDGET_MESSAGE = [
  "Here is the chart you requested:",
  "",
  '<widget title="Sales Chart">',
  "<div style=\"background:var(--card);color:var(--text);padding:12px\">",
  "  <h2>Weekly Sales</h2>",
  "  <canvas id=\"sales\"></canvas>",
  "</div>",
  "</widget>",
  "",
  "Let me know if you need a deeper breakdown.",
].join("\n");

describe("AssistantMarkdownContent SSE replay parity (RENDER-04 unit-level)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders byte-identical DOM for live and replay paths on the same finalized text", () => {
    // First render — simulates the LIVE path: SSE frame delivered the closing
    // </widget>, message is now finalized, isStreaming flips to false.
    const live = render(
      createElement(AssistantMarkdownContent, {
        text: FINALIZED_WIDGET_MESSAGE,
        isStreaming: false,
      }),
    );
    const liveHtml = live.container.innerHTML;
    cleanup();

    // Second render — simulates the REPLAY path: page reload triggers
    // outbox replay; the same stored text is rendered cold from a fresh
    // component instance with isStreaming false. Parser is pure, segment
    // keys are content-hash, srcDoc is memoized on (html, themeVars, id).
    // Output MUST be byte-identical.
    const replay = render(
      createElement(AssistantMarkdownContent, {
        text: FINALIZED_WIDGET_MESSAGE,
        isStreaming: false,
      }),
    );
    const replayHtml = replay.container.innerHTML;

    expect(replayHtml).toBe(liveHtml);
  });

  it("emits identical iframe sandbox and srcDoc attributes across live and replay renders", () => {
    const live = render(
      createElement(AssistantMarkdownContent, {
        text: FINALIZED_WIDGET_MESSAGE,
        isStreaming: false,
      }),
    );
    const liveIframe = live.container.querySelector("iframe");
    expect(liveIframe).not.toBeNull();
    const liveSandbox = liveIframe?.getAttribute("sandbox");
    const liveSrcDoc = liveIframe?.getAttribute("srcdoc");
    cleanup();

    const replay = render(
      createElement(AssistantMarkdownContent, {
        text: FINALIZED_WIDGET_MESSAGE,
        isStreaming: false,
      }),
    );
    const replayIframe = replay.container.querySelector("iframe");
    expect(replayIframe).not.toBeNull();
    const replaySandbox = replayIframe?.getAttribute("sandbox");
    const replaySrcDoc = replayIframe?.getAttribute("srcdoc");

    expect(replaySandbox).toBe(liveSandbox);
    expect(replaySrcDoc).toBe(liveSrcDoc);
    expect(replaySandbox).toBe("allow-scripts allow-popups");
  });

  it("produces a stable widgetId-derived key for the same widget HTML across renders", () => {
    // Two renders of the same text should yield iframes nested inside DOM
    // shells with stable data-widget-id attributes (Phase 2's InlineWidget
    // sets data-widget-id on its outer wrapper). Identical input → identical
    // content-hash widgetId → identical attribute value.
    const first = render(
      createElement(AssistantMarkdownContent, {
        text: FINALIZED_WIDGET_MESSAGE,
        isStreaming: false,
      }),
    );
    const firstShell = first.container.querySelector("[data-widget-id]");
    expect(firstShell).not.toBeNull();
    const firstId = firstShell?.getAttribute("data-widget-id");
    cleanup();

    const second = render(
      createElement(AssistantMarkdownContent, {
        text: FINALIZED_WIDGET_MESSAGE,
        isStreaming: false,
      }),
    );
    const secondShell = second.container.querySelector("[data-widget-id]");
    expect(secondShell).not.toBeNull();
    const secondId = secondShell?.getAttribute("data-widget-id");

    expect(secondId).toBe(firstId);
  });
});
