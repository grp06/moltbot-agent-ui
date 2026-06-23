/**
 * parseWidgetSegments — pure streaming-safe widget parser.
 *
 * Converts a raw assistant string into an ordered list of `MessageSegment`s
 * (markdown | widget) with deterministic FNV-1a content-hash keys. The parser
 * is greenfield TypeScript with zero dependencies and contains:
 *   - no `Date.now()`, `Math.random()`, or `crypto.randomUUID()` calls
 *     (D-16 — randomness in keys would break iframe stability)
 *   - no DOM reads (`document.*`, `window.*`)
 *   - no React imports
 *
 * Contract (D-01..D-04, D-11..D-15):
 *   - Accepts both `<widget>` and `<mcwidget>` tag prefixes
 *   - Title attribute MUST be double-quoted ASCII; unquoted, single-quoted,
 *     missing-close, and self-closing forms are rejected and emitted as
 *     literal markdown text
 *   - Curly quotes (U+201C, U+201D) inside the open-tag attribute span are
 *     auto-normalized to `"` (D-13) with a `console.warn` per render (D-04)
 *   - Nested widgets follow outer-wins semantics (D-03): the entire span up
 *     to the matching `</widget>` belongs to the outer widget body
 *   - Streaming-safe (D-12): when an unmatched open tag is detected, the
 *     parser truncates input to the unmatched position and emits the tail
 *     (open + after) as a trailing markdown segment so the rest of the
 *     transcript renders correctly while the agent is still streaming
 */

export type MarkdownSegment = { kind: "markdown"; text: string };
export type WidgetSegment = {
  kind: "widget";
  title: string;
  html: string;
  widgetId: string;
};
export type MessageSegment = MarkdownSegment | WidgetSegment;

// Locked as module-level constants. Do not modify the regex bodies — they are
// non-greedy ([\s\S]*?) on purpose to prevent two adjacent widgets from being
// merged into one match (PITFALLS #3 — Streaming parser eats widget split across
// SSE chunks). The `(?:mc)?` prefix accepts both `<widget>` and `<mcwidget>`
// per D-11. Each call site clones these into a local instance to avoid
// shared `lastIndex` state across reentrant scans.
//
// `OPEN_RE`, `CLOSE_RE`, and `WIDGET_RE` are exported so other modules and
// downstream phases can import the canonical patterns instead of redeclaring
// them. They MUST stay as named module-level exports per D-11.
export const OPEN_RE = /<(?:mc)?widget\b/gi;
export const CLOSE_RE = /<\/(?:mc)?widget>/gi;
export const WIDGET_RE =
  /<(?:mc)?widget\s+title="([^"]*)">([\s\S]*?)<\/(?:mc)?widget>/gi;

// Open-tag attribute regex used by the depth scanner. Requires `>` immediately
// after `title="..."` (no `/>` allowed — self-closing is rejected per D-02).
const OPEN_TAG_TITLE_RE = /^<(?:mc)?widget\s+title="([^"]*)">/i;

/**
 * FNV-1a 32-bit hash. Synchronous, no crypto API needed (D-14).
 * Seed: 0x811c9dc5; Prime: 0x01000193.
 *
 * Used for `widgetId` so identical widget HTML produces identical keys
 * across renders — this lets React reuse the iframe DOM node and avoids
 * Chart.js restart / flicker / memory leak (PITFALLS #4).
 */
export const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
};

/**
 * Normalize curly quotes inside `<widget ...>` open tag attributes ONLY.
 * Body content (between open and close tags) is never touched. When at
 * least one replacement happens, fires `console.warn` once per render
 * (D-04 — debug visibility into agent prompt drift).
 */
const normalizeWidgetQuotes = (text: string): string => {
  let warned = false;
  return text.replace(
    /<(mc)?widget([^>]*?)>/gi,
    (match, prefix: string | undefined, attrs: string) => {
      const replaced = attrs.replace(/[“”]/g, '"');
      if (replaced !== attrs && !warned) {
        warned = true;
        console.warn(
          "[widgets] auto-normalized curly quotes in widget tag:",
          match,
        );
      }
      return `<${prefix ?? ""}widget${replaced}>`;
    },
  );
};

/**
 * Find the byte index of the first unmatched `<widget` open tag, or null
 * when every open has a matching close (D-12 streaming-safe truncation).
 */
const findUnmatchedOpenIndex = (text: string): number | null => {
  const opens: number[] = [];
  const closes: number[] = [];
  const localOpenRe = /<(?:mc)?widget\b/gi;
  const localCloseRe = /<\/(?:mc)?widget>/gi;
  let m: RegExpExecArray | null;
  while ((m = localOpenRe.exec(text)) !== null) {
    opens.push(m.index);
    if (m.index === localOpenRe.lastIndex) localOpenRe.lastIndex += 1;
  }
  while ((m = localCloseRe.exec(text)) !== null) {
    closes.push(m.index);
    if (m.index === localCloseRe.lastIndex) localCloseRe.lastIndex += 1;
  }
  if (opens.length <= closes.length) return null;
  const lastClose = closes.length > 0 ? closes[closes.length - 1] : -1;
  for (const openIndex of opens) {
    if (openIndex > lastClose) return openIndex;
  }
  return opens[opens.length - 1] ?? null;
};

type WidgetSpan = {
  openEnd: number;
  closeStart: number;
  closeEnd: number;
  title: string;
  html: string;
};

/**
 * Walk forward from an open-tag position with a depth counter, returning
 * the matching close span. Implements D-03 outer-wins nested semantics —
 * the entire interior including any nested `<widget>...</widget>` is
 * returned as the outer's body text.
 */
const scanWidgetSpan = (text: string, openStart: number): WidgetSpan | null => {
  const tail = text.slice(openStart);
  const openMatch = tail.match(OPEN_TAG_TITLE_RE);
  if (!openMatch) return null;
  const openTagLength = openMatch[0].length;
  const title = openMatch[1] ?? "";
  const openEnd = openStart + openTagLength;

  const localOpenRe = /<(?:mc)?widget\b/gi;
  const localCloseRe = /<\/(?:mc)?widget>/gi;
  localOpenRe.lastIndex = openEnd;
  localCloseRe.lastIndex = openEnd;

  let depth = 1;
  let nextOpen = localOpenRe.exec(text);
  let nextClose = localCloseRe.exec(text);
  while (nextClose !== null) {
    if (nextOpen !== null && nextOpen.index < nextClose.index) {
      depth += 1;
      const advanceFrom = nextOpen.index + nextOpen[0].length;
      localOpenRe.lastIndex = advanceFrom;
      nextOpen = localOpenRe.exec(text);
      continue;
    }
    depth -= 1;
    const closeStart = nextClose.index;
    const closeEnd = closeStart + nextClose[0].length;
    if (depth === 0) {
      return {
        openEnd,
        closeStart,
        closeEnd,
        title,
        html: text.slice(openEnd, closeStart),
      };
    }
    localCloseRe.lastIndex = closeEnd;
    if (nextOpen !== null && nextOpen.index < closeEnd) {
      localOpenRe.lastIndex = closeEnd;
      nextOpen = localOpenRe.exec(text);
    }
    nextClose = localCloseRe.exec(text);
  }
  return null;
};

/**
 * Parse a string that has already been quote-normalized and prefix-truncated
 * (no unmatched opens). Walks the input left-to-right collecting widget and
 * markdown segments. Malformed open tags (unquoted/single-quoted/self-closing
 * — see D-02) cause `scanWidgetSpan` to return null; we advance past the
 * malformed `<` and the tag eventually flows out as part of the trailing
 * markdown emission below.
 */
const parseInner = (text: string): MessageSegment[] => {
  if (text.length === 0) return [];
  const segments: MessageSegment[] = [];
  let cursor = 0;
  const scanRe = /<(?:mc)?widget\b/gi;
  let match: RegExpExecArray | null;
  while ((match = scanRe.exec(text)) !== null) {
    const openStart = match.index;
    if (openStart < cursor) {
      continue;
    }
    const span = scanWidgetSpan(text, openStart);
    if (span === null) {
      if (scanRe.lastIndex === openStart) {
        scanRe.lastIndex = openStart + 1;
      }
      continue;
    }
    if (openStart > cursor) {
      segments.push({ kind: "markdown", text: text.slice(cursor, openStart) });
    }
    // The widgetId combines the FNV-1a hash of the body (for content stability
    // across re-renders) with the open-tag byte index (`openStart`) within the
    // current parse output. The byte index defends against collisions when two
    // widgets in the same message share identical HTML — without it,
    // `widgetMessageRegistry` and `widgetThemeBroadcast` would map both
    // iframes to the same key and the second would silently overwrite the
    // first's height/theme subscriptions.
    segments.push({
      kind: "widget",
      title: span.title,
      html: span.html,
      widgetId: `${fnv1a(span.html).toString(16)}-${openStart}`,
    });
    cursor = span.closeEnd;
    scanRe.lastIndex = span.closeEnd;
  }
  if (cursor < text.length) {
    segments.push({ kind: "markdown", text: text.slice(cursor) });
  }
  return segments;
};

/**
 * Parse a raw assistant string into ordered `MessageSegment`s. Empty input
 * returns `[]`. Malformed widget tags (unquoted title, single-quoted title,
 * self-closing, missing-close) are emitted as literal markdown text so the
 * agent's mistake stays visible in the transcript instead of corrupting it.
 */
export const parseWidgetSegments = (text: string): MessageSegment[] => {
  if (text.length === 0) return [];
  const normalized = normalizeWidgetQuotes(text);
  const unmatched = findUnmatchedOpenIndex(normalized);
  if (unmatched !== null) {
    const prefix = normalized.slice(0, unmatched);
    const tail = normalized.slice(unmatched);
    const prefixSegments = parseInner(prefix);
    if (tail.length > 0) {
      const last = prefixSegments[prefixSegments.length - 1];
      if (last && last.kind === "markdown") {
        last.text = last.text + tail;
      } else {
        prefixSegments.push({ kind: "markdown", text: tail });
      }
    }
    return prefixSegments;
  }
  return parseInner(normalized);
};
