import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RATE_LIMIT_MAX_MSGS,
  RATE_LIMIT_WINDOW_MS,
  MIN_HEIGHT,
  MAX_HEIGHT,
} from "@/features/agents/components/widgets/widgetConstants";
import {
  __resetForTests,
  __snapshotForTests,
  register,
  unregister,
} from "@/features/agents/components/widgets/widgetMessageRegistry";

afterEach(() => {
  __resetForTests();
  vi.restoreAllMocks();
});

const makeIframe = (): HTMLIFrameElement => {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  return iframe;
};

const dispatchHeightFrom = (
  source: Window,
  widgetId: string,
  height: unknown,
): void => {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "iframe:height", widgetId, height },
      source,
    }),
  );
};

describe("widgetMessageRegistry", () => {
  it("installs the global window message listener on first register", () => {
    expect(__snapshotForTests().listenerInstalled).toBe(false);
    const iframe = makeIframe();
    register("w1", iframe, () => {});
    expect(__snapshotForTests().listenerInstalled).toBe(true);
  });

  it("removes the global listener when the last widget unregisters", () => {
    const iframe = makeIframe();
    const unreg = register("w1", iframe, () => {});
    unreg();
    expect(__snapshotForTests().listenerInstalled).toBe(false);
  });

  it("delivers a clamped height when the source matches iframe.contentWindow", () => {
    const iframe = makeIframe();
    let received = 0;
    register("w1", iframe, (h) => {
      received = h;
    });
    const win = iframe.contentWindow;
    expect(win).not.toBeNull();
    dispatchHeightFrom(win!, "w1", 300);
    expect(received).toBe(300);
  });

  it("rejects a height update from a foreign source", () => {
    const iframe = makeIframe();
    const otherIframe = makeIframe();
    let received = 0;
    register("w1", iframe, (h) => {
      received = h;
    });
    const foreignWin = otherIframe.contentWindow;
    expect(foreignWin).not.toBeNull();
    dispatchHeightFrom(foreignWin!, "w1", 300);
    expect(received).toBe(0);
  });

  it("clamps a 999999 height to MAX_HEIGHT", () => {
    const iframe = makeIframe();
    let received = 0;
    register("w1", iframe, (h) => {
      received = h;
    });
    dispatchHeightFrom(iframe.contentWindow!, "w1", 999999);
    expect(received).toBe(MAX_HEIGHT);
  });

  it("clamps a height below MIN_HEIGHT to MIN_HEIGHT", () => {
    const iframe = makeIframe();
    let received = 0;
    register("w1", iframe, (h) => {
      received = h;
    });
    dispatchHeightFrom(iframe.contentWindow!, "w1", 10);
    expect(received).toBe(MIN_HEIGHT);
  });

  it("drops a NaN height with a console warning", () => {
    const iframe = makeIframe();
    let received = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    register("w1", iframe, (h) => {
      received = h;
    });
    dispatchHeightFrom(iframe.contentWindow!, "w1", Number.NaN);
    expect(received).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("rate-limits beyond RATE_LIMIT_MAX_MSGS in RATE_LIMIT_WINDOW_MS", () => {
    const iframe = makeIframe();
    let calls = 0;
    register("w1", iframe, () => {
      calls += 1;
    });
    for (let i = 0; i < RATE_LIMIT_MAX_MSGS + 5; i += 1) {
      dispatchHeightFrom(iframe.contentWindow!, "w1", 100 + i);
    }
    expect(calls).toBe(RATE_LIMIT_MAX_MSGS);
  });

  it("forgets old timestamps once outside the rate-limit window", () => {
    vi.useFakeTimers();
    const iframe = makeIframe();
    let calls = 0;
    register("w1", iframe, () => {
      calls += 1;
    });
    for (let i = 0; i < RATE_LIMIT_MAX_MSGS; i += 1) {
      dispatchHeightFrom(iframe.contentWindow!, "w1", 100);
    }
    expect(calls).toBe(RATE_LIMIT_MAX_MSGS);
    vi.advanceTimersByTime(RATE_LIMIT_WINDOW_MS + 50);
    dispatchHeightFrom(iframe.contentWindow!, "w1", 100);
    expect(calls).toBe(RATE_LIMIT_MAX_MSGS + 1);
    vi.useRealTimers();
  });

  it("ignores messages targeting an unregistered widget id", () => {
    const iframe = makeIframe();
    let received = 0;
    register("w1", iframe, (h) => {
      received = h;
    });
    dispatchHeightFrom(iframe.contentWindow!, "wDoesNotExist", 300);
    expect(received).toBe(0);
  });

  it("ignores messages whose data.type is not iframe:height", () => {
    const iframe = makeIframe();
    let received = 0;
    register("w1", iframe, (h) => {
      received = h;
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "theme:update", vars: {} },
        source: iframe.contentWindow,
      }),
    );
    expect(received).toBe(0);
  });

  it("returns the listener count to baseline after 50 mount/unmount cycles", () => {
    for (let i = 0; i < 50; i += 1) {
      const iframe = makeIframe();
      const unreg = register(`w-${i}`, iframe, () => {});
      unreg();
    }
    expect(__snapshotForTests().listenerInstalled).toBe(false);
    expect(__snapshotForTests().ids).toHaveLength(0);
  });

  it("replaces the prior entry when the same widgetId re-registers (StrictMode-safe)", () => {
    const iframe = makeIframe();
    let firstCount = 0;
    let secondCount = 0;
    register("w1", iframe, () => {
      firstCount += 1;
    });
    register("w1", iframe, () => {
      secondCount += 1;
    });
    dispatchHeightFrom(iframe.contentWindow!, "w1", 100);
    expect(firstCount).toBe(0);
    expect(secondCount).toBe(1);
  });

  it("unregister of an unknown widgetId is a no-op", () => {
    expect(() => unregister("does-not-exist")).not.toThrow();
  });
});
