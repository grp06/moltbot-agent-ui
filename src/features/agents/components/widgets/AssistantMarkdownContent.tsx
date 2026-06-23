"use client";

/**
 * AssistantMarkdownContent — RENDER-01 wrapper bridging the existing
 * `<ReactMarkdown remarkPlugins={[remarkGfm]}>{rewriteMediaLinesToMarkdown(...)}</ReactMarkdown>`
 * pipeline (used at `AgentChatPanel.tsx:507,514`) and the Phase 2
 * `<InlineWidget>` component, using Phase 1's `parseWidgetSegments` to split
 * the input string into ordered markdown / widget segments.
 *
 * Honors CONTEXT.md (Phase 3) decisions:
 *   - D-06: streaming-glow class lands on the LAST markdown segment ONLY,
 *     never on widget segments
 *   - D-07/D-08: "Generating widget…" indicator renders only when
 *     `isStreaming === true` AND `detectUnclosedWidgetTag(text)` returns true
 *   - D-09: indicator uses `var(--muted-foreground)` via Tailwind's
 *     `text-muted-foreground` — no new color tokens
 *   - D-17..D-21: signature, body shape, glow class plumbing, indicator
 *     gating, helper locality
 *
 * No `useEffect`, `useState`, `useRef`, `startTransition`, `Suspense`, or
 * class components in this wrapper (PITFALLS #15 — React 19 concurrent edges
 * stay out of the render path). Memoization lives at the parent
 * `AssistantMessageCard` level; this wrapper computes both `useMemo`s but
 * does not wrap itself in `React.memo`.
 *
 * `GeneratingWidgetIndicator` is inline JSX rather than a separate component
 * file (D-21).
 */

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { rewriteMediaLinesToMarkdown } from "@/lib/text/media-markdown";

import { InlineWidget } from "./InlineWidget";
import { parseWidgetSegments, type MessageSegment } from "./parseWidgetSegments";

// Discovery (D-19): grep on `src/features/agents/components/AgentChatPanel.tsx`
// at the time this wrapper landed shows NO `streaming-glow` class is applied
// to the markdown wrapper today. The streaming branch (lines 488-510) renders
// either a `whitespace-pre-wrap break-words text-foreground` div or the
// `agent-markdown text-foreground` div — neither carries a glow class.
//
// Per D-19's planner-discretion clause we keep the empty placeholder so the
// `isStreaming` prop plumbing exists for a future glow CSS without changing
// observable behavior in this plan. If a real glow class lands later, swap
// this constant value and the conditional below picks it up automatically.
const STREAMING_GLOW_CLASS = "" as const;
const MARKDOWN_WRAPPER_BASE_CLASS = "agent-markdown text-foreground" as const;
const INDICATOR_CLASS =
  "text-xs text-muted-foreground flex items-center gap-1.5 mt-1.5" as const;

/**
 * `detectUnclosedWidgetTag` — counts opens vs closes for `<widget>` and
 * `<mcwidget>` tags via fresh `RegExp` instances per call (no shared
 * `lastIndex`) and returns true when an unmatched open exists.
 *
 * D-20: this logic is deliberately duplicated locally rather than imported
 * from `parseWidgetSegments`. Phase 1 modules are read-only by hard
 * guardrail; we cannot add a new export there without churn.
 */
const detectUnclosedWidgetTag = (text: string): boolean => {
  const openRe = /<(?:mc)?widget\b/gi;
  const closeRe = /<\/(?:mc)?widget>/gi;
  let opens = 0;
  let closes = 0;
  while (openRe.exec(text) !== null) {
    opens += 1;
  }
  while (closeRe.exec(text) !== null) {
    closes += 1;
  }
  return opens > closes;
};

type AssistantMarkdownContentProps = {
  text: string;
  isStreaming?: boolean;
};

const renderSegment = (
  segment: MessageSegment,
  index: number,
  isLast: boolean,
  isStreaming: boolean,
) => {
  if (segment.kind === "markdown") {
    const glowClass =
      isLast && isStreaming && STREAMING_GLOW_CLASS.length > 0
        ? ` ${STREAMING_GLOW_CLASS}`
        : "";
    return (
      <div
        key={`m-${index}`}
        className={`${MARKDOWN_WRAPPER_BASE_CLASS}${glowClass}`}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {rewriteMediaLinesToMarkdown(segment.text)}
        </ReactMarkdown>
      </div>
    );
  }
  return (
    <InlineWidget
      key={`w-${segment.widgetId}-${index}`}
      id={segment.widgetId}
      title={segment.title}
      html={segment.html}
    />
  );
};

export const AssistantMarkdownContent = ({
  text,
  isStreaming = false,
}: AssistantMarkdownContentProps) => {
  const segments = useMemo(() => parseWidgetSegments(text), [text]);
  const hasUnclosedTag = useMemo(() => detectUnclosedWidgetTag(text), [text]);

  return (
    <>
      {segments.map((segment, index) =>
        renderSegment(segment, index, index === segments.length - 1, isStreaming),
      )}
      {isStreaming && hasUnclosedTag ? (
        <div
          className={INDICATOR_CLASS}
          role="status"
          aria-live="polite"
          data-testid="widget-generating-indicator"
        >
          <span className="animate-pulse" aria-hidden="true">
            ●
          </span>
          Generating widget…
        </div>
      ) : null}
    </>
  );
};
