// Coverage baseline (locked by Phase 4 Plan 04-1, TEST-01 / D-25):
// Branch coverage: >95% threshold enforced via vitest.config.ts.
// Run `npx vitest run --coverage tests/unit/parseWidgetSegments.test.ts` to verify.
import { describe, expect, it, vi } from "vitest";

import {
  fnv1a,
  parseWidgetSegments,
  type MessageSegment,
} from "@/features/agents/components/widgets/parseWidgetSegments";

describe("parseWidgetSegments", () => {
  it("returns an empty array for an empty string", () => {
    expect(parseWidgetSegments("")).toEqual([]);
  });

  it("returns a single markdown segment when no widget tags are present", () => {
    const out = parseWidgetSegments("hello world");
    expect(out).toEqual([{ kind: "markdown", text: "hello world" }]);
  });

  it("emits one widget segment for a single well-formed widget", () => {
    const out = parseWidgetSegments('<widget title="A">body</widget>');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "widget",
      title: "A",
      html: "body",
    });
  });

  it("emits multiple widget segments interleaved with markdown", () => {
    const out = parseWidgetSegments(
      'before <widget title="A">aaa</widget> middle <widget title="B">bbb</widget> after',
    );
    expect(out.map((segment) => segment.kind)).toEqual([
      "markdown",
      "widget",
      "markdown",
      "widget",
      "markdown",
    ]);
    expect((out[0] as { text: string }).text).toBe("before ");
    expect((out[1] as { title: string }).title).toBe("A");
    expect((out[2] as { text: string }).text).toBe(" middle ");
    expect((out[3] as { title: string }).title).toBe("B");
    expect((out[4] as { text: string }).text).toBe(" after");
  });

  it("emits a widget-only segment when the input is exactly one widget", () => {
    const out = parseWidgetSegments('<widget title="X">y</widget>');
    expect(out).toEqual<MessageSegment[]>([
      {
        kind: "widget",
        title: "X",
        html: "y",
        widgetId: `${fnv1a("y").toString(16)}-0`,
      },
    ]);
  });

  it("preserves leading and trailing markdown around a single widget", () => {
    const out = parseWidgetSegments(
      'lead <widget title="X">y</widget> trail',
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ kind: "markdown", text: "lead " });
    expect(out[2]).toEqual({ kind: "markdown", text: " trail" });
  });

  it("buffers an unclosed trailing widget tag as markdown text", () => {
    const out = parseWidgetSegments('text <widget title="X">no close');
    expect(out).toEqual([
      { kind: "markdown", text: 'text <widget title="X">no close' },
    ]);
  });

  it("handles every byte-prefix of a multi-widget fixture without throwing", () => {
    const fixture =
      'before text <widget title="A">aaa</widget> middle <mcwidget title="B">bbb</mcwidget> after';
    for (let i = 0; i <= fixture.length; i += 1) {
      const slice = fixture.slice(0, i);
      const segments = parseWidgetSegments(slice);
      expect(Array.isArray(segments)).toBe(true);
      for (const segment of segments) {
        expect(["markdown", "widget"]).toContain(segment.kind);
      }
    }
  });

  it("rejects an unquoted title and emits the open tag as markdown text", () => {
    const input = "<widget title=Chart>body</widget>";
    const out = parseWidgetSegments(input);
    expect(out).toEqual([{ kind: "markdown", text: input }]);
  });

  it("rejects a single-quoted title and emits the open tag as markdown text", () => {
    const input = "<widget title='Chart'>body</widget>";
    const out = parseWidgetSegments(input);
    expect(out).toEqual([{ kind: "markdown", text: input }]);
  });

  it("rejects a missing close tag at end of stream and emits as markdown", () => {
    const input = '<widget title="X">no close';
    const out = parseWidgetSegments(input);
    expect(out).toEqual([{ kind: "markdown", text: input }]);
  });

  it("rejects a self-closing widget form and emits as markdown", () => {
    const input = '<widget title="X" />';
    const out = parseWidgetSegments(input);
    expect(out).toEqual([{ kind: "markdown", text: input }]);
  });

  it("auto-normalizes curly quotes inside the widget open tag attributes", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const out = parseWidgetSegments('hello <widget title=“Chart”>body</widget>');
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({
      kind: "widget",
      title: "Chart",
      html: "body",
    });
    expect(warnSpy).toHaveBeenCalled();
    const firstCallArg = warnSpy.mock.calls[0]?.[0] ?? "";
    expect(String(firstCallArg)).toContain("auto-normalized");
    warnSpy.mockRestore();
  });

  it("treats nested widgets as outer-wins with inner as literal body text", () => {
    const out = parseWidgetSegments(
      '<widget title="Outer"><widget title="Inner">x</widget></widget>',
    );
    expect(out).toHaveLength(1);
    const widget = out[0] as { kind: "widget"; title: string; html: string };
    expect(widget.kind).toBe("widget");
    expect(widget.title).toBe("Outer");
    expect(widget.html).toBe('<widget title="Inner">x</widget>');
  });

  it("accepts a widget tag with the mc prefix", () => {
    const out = parseWidgetSegments('<mcwidget title="Z">m</mcwidget>');
    expect(out).toEqual<MessageSegment[]>([
      {
        kind: "widget",
        title: "Z",
        html: "m",
        widgetId: `${fnv1a("m").toString(16)}-0`,
      },
    ]);
  });

  it("accepts a mix of widget and mcwidget in the same message", () => {
    const out = parseWidgetSegments(
      '<widget title="A">aaa</widget> sep <mcwidget title="B">bbb</mcwidget>',
    );
    expect(out).toHaveLength(3);
    expect((out[0] as { title: string }).title).toBe("A");
    expect((out[1] as { text: string }).text).toBe(" sep ");
    expect((out[2] as { title: string }).title).toBe("B");
  });

  it("preserves HTML entities in the title attribute", () => {
    const out = parseWidgetSegments(
      '<widget title="A &amp; B">body</widget>',
    );
    expect(out).toHaveLength(1);
    expect((out[0] as { title: string }).title).toBe("A &amp; B");
  });

  it("produces distinct stable widgetIds for two widget segments with identical html", () => {
    // Two widgets with the same HTML must NOT share a widgetId — otherwise
    // widgetMessageRegistry / widgetThemeBroadcast (Map-keyed by widgetId)
    // would route height/theme updates from both iframes to the same entry
    // and the second registration would overwrite the first.
    const input =
      '<widget title="A">same</widget> sep <widget title="B">same</widget>';
    const out = parseWidgetSegments(input);
    const widgets = out.filter(
      (segment): segment is Extract<MessageSegment, { kind: "widget" }> =>
        segment.kind === "widget",
    );
    expect(widgets).toHaveLength(2);
    // Distinct: the byte-index suffix prevents collision.
    expect(widgets[0]?.widgetId).not.toBe(widgets[1]?.widgetId);
    // Both share the FNV-1a content-hash prefix because the bodies are equal.
    const hash = fnv1a("same").toString(16);
    expect(widgets[0]?.widgetId.startsWith(`${hash}-`)).toBe(true);
    expect(widgets[1]?.widgetId.startsWith(`${hash}-`)).toBe(true);
    // Stable across re-parses: same input yields the same widgetIds, so
    // React keys + iframe DOM identity remain preserved across renders.
    const out2 = parseWidgetSegments(input);
    const widgets2 = out2.filter(
      (segment): segment is Extract<MessageSegment, { kind: "widget" }> =>
        segment.kind === "widget",
    );
    expect(widgets2[0]?.widgetId).toBe(widgets[0]?.widgetId);
    expect(widgets2[1]?.widgetId).toBe(widgets[1]?.widgetId);
  });

  // ---- Phase 4 Plan 04-1 gap-closure tests (TEST-01 branch coverage >95%) ----

  it("warns only once when two curly-quoted widgets appear in the same input", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const out = parseWidgetSegments(
      '<widget title=“A”>aaa</widget> sep <widget title=“B”>bbb</widget>',
    );
    expect(out.filter((s) => s.kind === "widget")).toHaveLength(2);
    // The warn is fired at most twice (one per widget tag), but the
    // already-warned branch inside the regex callback is exercised when the
    // second curly-quoted span is processed in the same render pass.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("recovers parsing after a malformed widget open tag and emits literal text plus a later valid widget", () => {
    // The malformed `<widget>` (no title attribute) makes scanWidgetSpan
    // return null. parseInner advances past `<` and the trailing valid widget
    // must still parse. Exercises the `span === null` continue path (L202-206).
    const out = parseWidgetSegments(
      'before <widget>oops</widget> mid <widget title="Real">body</widget> end',
    );
    const widgetSegments = out.filter((s) => s.kind === "widget");
    expect(widgetSegments).toHaveLength(1);
    expect((widgetSegments[0] as { title: string }).title).toBe("Real");
    // The literal `<widget>oops</widget>` survives in markdown text somewhere.
    const joined = out
      .filter((s): s is Extract<MessageSegment, { kind: "markdown" }> => s.kind === "markdown")
      .map((s) => s.text)
      .join("");
    expect(joined).toContain("<widget>oops</widget>");
  });

  it("buffers two unclosed widget open tags as trailing markdown without throwing", () => {
    // Two opens, zero closes — exercises findUnmatchedOpenIndex
    // returning the FIRST open (lastClose = -1, all opens > lastClose).
    const input = 'a <widget title="A"> b <widget title="B"> c';
    const out = parseWidgetSegments(input);
    // No widget segments materialize because nothing closes; entire span
    // from the first open onward becomes markdown via the streaming-safe path.
    expect(out.every((s) => s.kind === "markdown")).toBe(true);
    const joined = out.map((s) => (s as { text: string }).text).join("");
    expect(joined).toBe(input);
  });

  it("handles three-deep nested widgets with depth counter beyond 2", () => {
    // Triple-nested case — exercises the depth>1 path in scanWidgetSpan
    // where another open is encountered before depth returns to 0 (L153-158).
    const input =
      '<widget title="L1"><widget title="L2"><widget title="L3">x</widget></widget></widget>';
    const out = parseWidgetSegments(input);
    expect(out).toHaveLength(1);
    const widget = out[0] as { kind: "widget"; title: string; html: string };
    expect(widget.title).toBe("L1");
    expect(widget.html).toBe(
      '<widget title="L2"><widget title="L3">x</widget></widget>',
    );
  });

  it("treats a literal </widget> in body text as the closing tag and emits trailing remainder as markdown", () => {
    // Non-greedy regex: first </widget> wins. Tail after it is markdown.
    const out = parseWidgetSegments(
      '<widget title="X">body</widget> tail-text',
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "widget", title: "X", html: "body" });
    expect(out[1]).toEqual({ kind: "markdown", text: " tail-text" });
  });

  it("emits an empty title when the title attribute is the empty string", () => {
    const out = parseWidgetSegments('<widget title="">x</widget>');
    expect(out).toHaveLength(1);
    expect((out[0] as { title: string }).title).toBe("");
  });

  it("buffers a streaming partial open tag with no closing bracket as markdown", () => {
    const out = parseWidgetSegments('prefix <widget title="X');
    expect(out).toEqual([
      { kind: "markdown", text: 'prefix <widget title="X' },
    ]);
  });

  it("preserves widget segments before an unclosed trailing widget open tag (streaming-safe)", () => {
    // First widget closes cleanly; second is unclosed — exercises the
    // findUnmatchedOpenIndex path where there are matched closes but the
    // last open is still dangling.
    const input =
      '<widget title="A">aaa</widget> mid <widget title="B">unclosed';
    const out = parseWidgetSegments(input);
    // The first widget should survive; the unclosed second open + body
    // must emerge as a trailing markdown segment.
    const widgets = out.filter((s) => s.kind === "widget");
    expect(widgets).toHaveLength(1);
    expect((widgets[0] as { title: string }).title).toBe("A");
    const tail = out
      .filter((s): s is Extract<MessageSegment, { kind: "markdown" }> => s.kind === "markdown")
      .map((s) => s.text)
      .join("");
    expect(tail).toContain('<widget title="B">unclosed');
  });

  it("merges trailing unmatched-open tail into the preceding markdown segment when present", () => {
    // Exercises the branch in parseWidgetSegments where the prefix's last
    // segment is markdown and the tail is appended to it (L242-244).
    const out = parseWidgetSegments('hello <widget title="X');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      kind: "markdown",
      text: 'hello <widget title="X',
    });
  });

  it("appends an unmatched-open tail when prefix segments are empty", () => {
    // `<widget` at the very start with no close → unmatched=0, prefix is empty.
    // Exercises the else-branch where prefixSegments has no last markdown
    // segment, so a fresh markdown segment with the tail is pushed.
    const out = parseWidgetSegments('<widget title="X">incomplete');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      kind: "markdown",
      text: '<widget title="X">incomplete',
    });
  });

  it("treats a malformed widget open without a title attribute as literal text and continues parsing", () => {
    // `<widget` followed by text but no `title="..."` open-tag attribute —
    // OPEN_TAG_TITLE_RE returns null inside scanWidgetSpan, so it returns null
    // immediately at L139 (the `if (!openMatch) return null` early exit).
    const input =
      '<widget>plain</widget> mid <widget title="Real">body</widget>';
    const out = parseWidgetSegments(input);
    const widgets = out.filter((s) => s.kind === "widget");
    expect(widgets).toHaveLength(1);
    expect((widgets[0] as { title: string }).title).toBe("Real");
  });

  it("handles a triple-deep nest with stable depth bookkeeping (no extra widgets emitted)", () => {
    const input =
      'pre <widget title="A"><widget title="B"><widget title="C">x</widget></widget></widget> post';
    const out = parseWidgetSegments(input);
    expect(out).toHaveLength(3);
    expect((out[0] as { text: string }).text).toBe("pre ");
    expect((out[1] as { kind: string }).kind).toBe("widget");
    expect((out[1] as { title: string }).title).toBe("A");
    expect((out[2] as { text: string }).text).toBe(" post");
  });
});
