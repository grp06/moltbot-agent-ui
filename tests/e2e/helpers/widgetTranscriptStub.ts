/**
 * widgetTranscriptStub — deterministic Playwright fixture for widget e2e tests.
 *
 * Builds a stable assistant-text fixture containing N widget blocks plus
 * surrounding markdown. The text and widget IDs are deterministic so the
 * same `widgetCount` produces byte-identical output across calls — this is
 * the foundation of the SSE-replay parity assertion in
 * `widget-replay-parity.spec.ts` (Phase 4 D-01, D-15).
 *
 * Phase 4 design decision (D-01..D-04):
 *   - The fixture text is consumed by `AssistantMarkdownContent` which calls
 *     `parseWidgetSegments` to split into ordered markdown/widget segments.
 *   - Each widget gets a unique deterministic title `Sales Card N` so the
 *     iframe `title` attribute (used by tests as a locator) is stable.
 *   - Body HTML for each widget references all 9 mapped Studio CSS theme
 *     variables (`--bg`, `--text`, `--card`, `--border`, `--accent`, `--muted`,
 *     `--ok`, `--warn`, `--danger`) so the spec can assert their presence in
 *     the iframe srcDoc.
 *
 * No `Date.now()`, `Math.random()`, or `crypto.randomUUID()` — determinism
 * is the contract. Calling `buildAssistantMessageText(N)` twice MUST return
 * byte-identical strings.
 */

export type WidgetTranscriptStubOptions = {
  /** Number of <widget> blocks to embed in the assistant message. */
  widgetCount: number;
};

const WIDGET_BODY_TEMPLATE = (
  index: number,
): string =>
  `<div style="padding:12px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px"><h2 style="color:var(--accent);margin:0">Sales Card ${index}</h2><p style="color:var(--muted);margin:4px 0 0">Demo widget body for parity assertion. Status: <span style="color:var(--ok)">OK</span> / <span style="color:var(--warn)">WARN</span> / <span style="color:var(--danger)">FAIL</span> on <span style="background:var(--bg);padding:1px 4px">background</span>.</p></div>`;

/**
 * Build a single assistant message text containing exactly `widgetCount`
 * widget blocks plus surrounding markdown. Determinism: same `widgetCount`
 * MUST produce a byte-identical string across calls — the parity test
 * relies on this for the live-vs-replay byte-equality assertion.
 */
export const buildAssistantMessageText = (widgetCount: number): string => {
  if (widgetCount <= 0) {
    return [
      "Here is a transcript with NO widgets.",
      "",
      "Just regular markdown text and a list:",
      "",
      "- item one",
      "- item two",
      "- item three",
    ].join("\n");
  }
  const parts: string[] = [
    "Here is a transcript with widgets demonstrating theme-aware rendering.",
    "",
  ];
  for (let i = 1; i <= widgetCount; i += 1) {
    parts.push(`Widget ${i} below shows a sales card.`);
    parts.push("");
    parts.push(`<widget title="Sales Card ${i}">${WIDGET_BODY_TEMPLATE(i)}</widget>`);
    parts.push("");
  }
  parts.push("Trailing markdown after all widgets.");
  return parts.join("\n");
};
