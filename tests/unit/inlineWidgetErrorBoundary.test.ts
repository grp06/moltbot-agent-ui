import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createElement, type FC } from "react";

import { InlineWidgetErrorBoundary } from "@/features/agents/components/widgets/InlineWidgetErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const Throwing: FC = () => {
  throw new Error("widget render exploded");
};

const Healthy: FC = () =>
  createElement("div", { "data-testid": "healthy" }, "ok");

describe("InlineWidgetErrorBoundary", () => {
  it("renders children when no error is thrown", () => {
    const { getByTestId } = render(
      createElement(
        InlineWidgetErrorBoundary,
        { widgetId: "w1", title: "T", html: "<div>x</div>" },
        createElement(Healthy),
      ),
    );
    expect(getByTestId("healthy")).toBeInTheDocument();
  });

  it("catches a throwing child and renders fallback chrome with the title", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByText } = render(
      createElement(
        InlineWidgetErrorBoundary,
        { widgetId: "w1", title: "Sales", html: "<div>x</div>" },
        createElement(Throwing),
      ),
    );
    expect(getByText("Sales")).toBeInTheDocument();
    expect(getByText("failed to render")).toBeInTheDocument();
    expect(error).toHaveBeenCalled();
  });

  it("renders the raw HTML inside a <details> source-view block", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const html = "<button>click me</button>";
    const { container, getByText } = render(
      createElement(
        InlineWidgetErrorBoundary,
        { widgetId: "w1", title: "Test", html },
        createElement(Throwing),
      ),
    );
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    const summary = container.querySelector("details > summary");
    expect(summary?.textContent).toBe("View source");
    expect(getByText(html)).toBeInTheDocument();
  });

  it("falls back to the literal title 'Widget' when title is empty", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { getByText } = render(
      createElement(
        InlineWidgetErrorBoundary,
        { widgetId: "w1", title: "", html: "<div/>" },
        createElement(Throwing),
      ),
    );
    expect(getByText("Widget")).toBeInTheDocument();
  });

  it("logs via console.error with widgetId and title context", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      createElement(
        InlineWidgetErrorBoundary,
        { widgetId: "alpha", title: "Beta", html: "<div/>" },
        createElement(Throwing),
      ),
    );
    expect(error).toHaveBeenCalled();
    // React 19 emits its own internal error logs alongside componentDidCatch.
    // Find the log entry whose first string argument carries the boundary's
    // widgetId+title context — that's the one our boundary produced.
    const ours = error.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("alpha") &&
        (call[0] as string).includes("Beta"),
    );
    expect(ours).toBeDefined();
  });
});
