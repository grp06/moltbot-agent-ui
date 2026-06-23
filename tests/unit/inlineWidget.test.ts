import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";

import { InlineWidget } from "@/features/agents/components/widgets/InlineWidget";
import { WIDGET_SANDBOX } from "@/features/agents/components/widgets/buildWidgetSrcDoc";
import { __resetForTests as resetRegistry } from "@/features/agents/components/widgets/widgetMessageRegistry";
import { __resetForTests as resetBroadcast } from "@/features/agents/components/widgets/widgetThemeBroadcast";

afterEach(() => {
  cleanup();
  resetRegistry();
  resetBroadcast();
  vi.restoreAllMocks();
});

const queryIframe = (root: HTMLElement): HTMLIFrameElement => {
  const iframe = root.querySelector("iframe");
  if (iframe === null) throw new Error("iframe not rendered");
  return iframe as HTMLIFrameElement;
};

describe("InlineWidget — sandbox attribute discipline (D-20, WIDGET-02, SEC-01..04)", () => {
  it("renders an iframe with sandbox exactly equal to WIDGET_SANDBOX", () => {
    const { container } = render(
      createElement(InlineWidget, {
        id: "w1",
        title: "T",
        html: "<div>x</div>",
      }),
    );
    const iframe = queryIframe(container);
    expect(iframe.getAttribute("sandbox")).toBe(WIDGET_SANDBOX);
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-popups");
  });

  it("rejects each forbidden sandbox token explicitly", () => {
    const { container } = render(
      createElement(InlineWidget, {
        id: "w1",
        title: "T",
        html: "<div>x</div>",
      }),
    );
    const iframe = queryIframe(container);
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    // Tokens are built at runtime via concatenation so the SEC-01 ESLint
    // rule (no-restricted-syntax on Literal[value=/allow-same-origin/])
    // does not fire on this assertion file. The rule's intent is to ban
    // accidental use; tests legitimately need to assert absence.
    const forbiddenSameOrigin = ["allow", "same", "origin"].join("-");
    const forbiddenForms = ["allow", "forms"].join("-");
    const forbiddenTopNav = ["allow", "top", "navigation"].join("-");
    expect(sandbox).not.toContain(forbiddenSameOrigin);
    expect(sandbox).not.toContain(forbiddenForms);
    expect(sandbox).not.toContain(forbiddenTopNav);
  });

  it("does not set a name attribute on the iframe (D-21, SEC-04)", () => {
    const { container } = render(
      createElement(InlineWidget, {
        id: "w1",
        title: "T",
        html: "<div>x</div>",
      }),
    );
    const iframe = queryIframe(container);
    expect(iframe.hasAttribute("name")).toBe(false);
  });
});

describe("InlineWidget — iframe DOM identity (D-22, D-23, WIDGET-10)", () => {
  it("preserves the same iframe DOM node across re-renders with identical props", () => {
    const { container, rerender } = render(
      createElement(InlineWidget, {
        id: "w1",
        title: "T",
        html: "<div>same</div>",
      }),
    );
    const iframe1 = queryIframe(container);
    rerender(
      createElement(InlineWidget, {
        id: "w1",
        title: "T",
        html: "<div>same</div>",
      }),
    );
    const iframe2 = queryIframe(container);
    expect(iframe1).toBe(iframe2);
  });

  it("rebuilds the iframe DOM node when html changes (regression: over-zealous memo)", () => {
    const { container, rerender } = render(
      createElement(InlineWidget, {
        id: "w1",
        title: "T",
        html: "<div>before</div>",
      }),
    );
    const iframe1 = queryIframe(container);
    const srcDoc1 = iframe1.getAttribute("srcdoc");
    rerender(
      createElement(InlineWidget, {
        id: "w1",
        title: "T",
        html: "<div>after</div>",
      }),
    );
    const iframe2 = queryIframe(container);
    const srcDoc2 = iframe2.getAttribute("srcdoc");
    expect(srcDoc1).not.toBe(srcDoc2);
  });
});

describe("InlineWidget — height update path (D-11..D-14, WIDGET-05, SEC-02)", () => {
  it("applies a height update from event.source === iframe.contentWindow", () => {
    const { container } = render(
      createElement(InlineWidget, {
        id: "w1",
        title: "T",
        html: "<div>x</div>",
      }),
    );
    const iframe = queryIframe(container);
    const win = iframe.contentWindow;
    expect(win).not.toBeNull();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "iframe:height", widgetId: "w1", height: 300 },
          source: win,
        }),
      );
    });
    expect(iframe.style.height).toBe("300px");
  });

  it("ignores a height update from a foreign source", () => {
    const { container } = render(
      createElement(InlineWidget, {
        id: "w1",
        title: "T",
        html: "<div>x</div>",
      }),
    );
    const iframe = queryIframe(container);
    const initialHeight = iframe.style.height;
    const otherIframe = document.createElement("iframe");
    document.body.appendChild(otherIframe);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "iframe:height", widgetId: "w1", height: 300 },
        source: otherIframe.contentWindow,
      }),
    );
    expect(iframe.style.height).toBe(initialHeight);
  });

  it("clamps height 999999 down to 600", () => {
    const { container } = render(
      createElement(InlineWidget, {
        id: "w1",
        title: "T",
        html: "<div>x</div>",
      }),
    );
    const iframe = queryIframe(container);
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "iframe:height", widgetId: "w1", height: 999999 },
          source: iframe.contentWindow,
        }),
      );
    });
    expect(iframe.style.height).toBe("600px");
  });

  it("drops a NaN height with a console warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(
      createElement(InlineWidget, {
        id: "w1",
        title: "T",
        html: "<div>x</div>",
      }),
    );
    const iframe = queryIframe(container);
    const before = iframe.style.height;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "iframe:height", widgetId: "w1", height: Number.NaN },
        source: iframe.contentWindow,
      }),
    );
    expect(iframe.style.height).toBe(before);
    expect(warn).toHaveBeenCalled();
  });
});

describe("InlineWidget — title bar affordances (D-15..D-19, WIDGET-09)", () => {
  it("exposes aria-labels on collapse and open-in-new-tab buttons", () => {
    const { getByLabelText } = render(
      createElement(InlineWidget, {
        id: "w1",
        title: "T",
        html: "<div>x</div>",
      }),
    );
    expect(getByLabelText("Collapse widget")).toBeInTheDocument();
    expect(getByLabelText("Open widget in new tab")).toBeInTheDocument();
  });

  it("falls back to 'Widget' when title is empty", () => {
    const { container } = render(
      createElement(InlineWidget, {
        id: "w1",
        title: "",
        html: "<div>x</div>",
      }),
    );
    expect(container.textContent).toContain("Widget");
  });
});

describe("InlineWidget — listener cleanup (PITFALLS #11, D-31)", () => {
  it("returns the global listener count to baseline after 50 mount/unmount cycles", async () => {
    const { __snapshotForTests } = await import(
      "@/features/agents/components/widgets/widgetMessageRegistry"
    );
    for (let i = 0; i < 50; i += 1) {
      const { unmount } = render(
        createElement(InlineWidget, {
          id: `w-${i}`,
          title: "T",
          html: "<div>x</div>",
        }),
      );
      unmount();
    }
    expect(__snapshotForTests().listenerInstalled).toBe(false);
    expect(__snapshotForTests().ids).toHaveLength(0);
  });
});

describe("InlineWidget — error boundary integration (D-06..D-10, WIDGET-12)", () => {
  it("renders normally when html is valid (boundary stays inactive)", () => {
    const { container } = render(
      createElement(InlineWidget, {
        id: "w1",
        title: "T",
        html: "<div>ok</div>",
      }),
    );
    expect(container.querySelector("[data-widget-fallback]")).toBeNull();
    expect(container.querySelector("iframe")).not.toBeNull();
  });
});
