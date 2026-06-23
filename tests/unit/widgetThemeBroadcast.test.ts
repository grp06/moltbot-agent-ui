import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __broadcastForTests,
  __resetForTests,
  __snapshotForTests,
  subscribe,
  unsubscribe,
} from "@/features/agents/components/widgets/widgetThemeBroadcast";

afterEach(() => {
  __resetForTests();
  vi.restoreAllMocks();
});

const makeContentWindow = () => {
  const calls: { msg: unknown; targetOrigin: string }[] = [];
  const win = {
    postMessage: (msg: unknown, targetOrigin: string) => {
      calls.push({ msg, targetOrigin });
    },
  } as unknown as Window;
  return { win, calls };
};

describe("widgetThemeBroadcast", () => {
  it("installs the MutationObserver on first subscribe", () => {
    expect(__snapshotForTests().observerInstalled).toBe(false);
    const { win } = makeContentWindow();
    subscribe("w1", win);
    expect(__snapshotForTests().observerInstalled).toBe(true);
  });

  it("disconnects the observer when the last widget unsubscribes", () => {
    const { win } = makeContentWindow();
    const unsub = subscribe("w1", win);
    unsub();
    expect(__snapshotForTests().observerInstalled).toBe(false);
  });

  it("broadcasts a theme:update postMessage with the 9 widget vars", () => {
    const { win, calls } = makeContentWindow();
    subscribe("w1", win);
    __broadcastForTests();
    expect(calls).toHaveLength(1);
    const payload = calls[0].msg as {
      type: string;
      vars: Record<string, string>;
    };
    expect(payload.type).toBe("theme:update");
    expect(Object.keys(payload.vars).sort()).toEqual(
      [
        "--accent",
        "--bg",
        "--border",
        "--card",
        "--danger",
        "--muted",
        "--ok",
        "--text",
        "--warn",
      ].sort(),
    );
    expect(calls[0].targetOrigin).toBe("*");
  });

  it("broadcasts to every subscribed contentWindow", () => {
    const a = makeContentWindow();
    const b = makeContentWindow();
    subscribe("a", a.win);
    subscribe("b", b.win);
    __broadcastForTests();
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it("does not broadcast to a widget that unsubscribed", () => {
    const a = makeContentWindow();
    const b = makeContentWindow();
    subscribe("a", a.win);
    const unsub = subscribe("b", b.win);
    unsub();
    __broadcastForTests();
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });

  it("survives a postMessage failure on one subscriber without breaking others", () => {
    const a = {
      postMessage: () => {
        throw new Error("boom");
      },
    } as unknown as Window;
    const b = makeContentWindow();
    subscribe("a", a);
    subscribe("b", b.win);
    expect(() => __broadcastForTests()).not.toThrow();
    expect(b.calls).toHaveLength(1);
  });

  it("re-subscribing the same widgetId replaces the prior contentWindow", () => {
    const a = makeContentWindow();
    const b = makeContentWindow();
    subscribe("w1", a.win);
    subscribe("w1", b.win);
    __broadcastForTests();
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(1);
  });

  it("unsubscribe of an unknown widgetId is a no-op", () => {
    expect(() => unsubscribe("does-not-exist")).not.toThrow();
  });
});
