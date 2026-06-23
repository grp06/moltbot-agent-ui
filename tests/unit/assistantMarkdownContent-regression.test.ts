import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { rewriteMediaLinesToMarkdown } from "@/lib/text/media-markdown";
import { AssistantMarkdownContent } from "@/features/agents/components/widgets/AssistantMarkdownContent";

const CANONICAL_WIDGETLESS_MESSAGE = [
  "# Status Report",
  "",
  "Here are the latest results:",
  "",
  "- All checks passing",
  "- Build green",
  "- Deployment ready",
  "",
  "```ts",
  "const answer = 42;",
  "console.log(answer);",
  "```",
  "",
  "Reference image:",
  "MEDIA: workspace://images/screenshot.png",
  "",
].join("\n");

describe("AssistantMarkdownContent regression (RENDER-03)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders widget-less markdown identically to the pre-swap baseline", () => {
    // Baseline: render the legacy pipeline directly. This is what
    // AgentChatPanel.tsx does today at lines 507/514.
    const baseline = render(
      createElement(
        "div",
        { className: "agent-markdown text-foreground" },
        createElement(
          ReactMarkdown,
          { remarkPlugins: [remarkGfm] },
          rewriteMediaLinesToMarkdown(CANONICAL_WIDGETLESS_MESSAGE),
        ),
      ),
    );
    const baselineHtml = baseline.container.innerHTML;
    cleanup();

    // New path: render through AssistantMarkdownContent. Because the input
    // contains zero <widget> tags, parseWidgetSegments returns a single
    // markdown segment, the wrapper renders that segment via the SAME
    // <ReactMarkdown remarkPlugins={[remarkGfm]}>{rewriteMediaLinesToMarkdown(...)}</ReactMarkdown>
    // pipeline inside the SAME <div className="agent-markdown text-foreground">,
    // and emits no indicator (isStreaming defaults to false). Output MUST
    // be byte-identical.
    const swapped = render(
      createElement(AssistantMarkdownContent, {
        text: CANONICAL_WIDGETLESS_MESSAGE,
      }),
    );
    const swappedHtml = swapped.container.innerHTML;

    expect(swappedHtml).toBe(baselineHtml);
  });

  it("renders widget-less markdown identically when isStreaming is true and no unclosed tag is present", () => {
    // Streaming case for a finalized widget-less message: parser returns one
    // markdown segment, the wrapper applies STREAMING_GLOW_CLASS only if it
    // is non-empty. With the placeholder empty constant, output must still
    // match the baseline. detectUnclosedWidgetTag returns false (no opens),
    // so the indicator does NOT render.
    const baseline = render(
      createElement(
        "div",
        { className: "agent-markdown text-foreground" },
        createElement(
          ReactMarkdown,
          { remarkPlugins: [remarkGfm] },
          rewriteMediaLinesToMarkdown(CANONICAL_WIDGETLESS_MESSAGE),
        ),
      ),
    );
    const baselineHtml = baseline.container.innerHTML;
    cleanup();

    const swapped = render(
      createElement(AssistantMarkdownContent, {
        text: CANONICAL_WIDGETLESS_MESSAGE,
        isStreaming: true,
      }),
    );
    const swappedHtml = swapped.container.innerHTML;

    expect(swappedHtml).toBe(baselineHtml);
  });

  it("does not render the generating-widget indicator on a widget-less finalized message", () => {
    const result = render(
      createElement(AssistantMarkdownContent, {
        text: CANONICAL_WIDGETLESS_MESSAGE,
        isStreaming: false,
      }),
    );
    expect(
      result.container.querySelector("[data-testid=\"widget-generating-indicator\"]"),
    ).toBeNull();
  });

  it("does not render the generating-widget indicator on a widget-less streaming message", () => {
    const result = render(
      createElement(AssistantMarkdownContent, {
        text: CANONICAL_WIDGETLESS_MESSAGE,
        isStreaming: true,
      }),
    );
    expect(
      result.container.querySelector("[data-testid=\"widget-generating-indicator\"]"),
    ).toBeNull();
  });
});
