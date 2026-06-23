/**
 * widgetThemeBroadcast — single MutationObserver on document.documentElement
 * that broadcasts `{ type: "theme:update", vars }` postMessages to every
 * registered widget's contentWindow per CONTEXT.md D-01..D-05. Lazy-installs
 * the observer on first subscribe; disconnects on last unsubscribe so a page
 * with zero widgets has zero observer overhead.
 *
 * The broadcast bypasses React entirely — the bootstrap script inside each
 * widget's srcDoc applies the new vars to `:root` via setProperty, preserving
 * Chart.js animation state and JS state across theme toggles.
 */
import { readThemeSnapshot } from "./widgetTheme";

type Subscriber = { contentWindow: Window };

const subscribers = new Map<string, Subscriber>();
let observer: MutationObserver | null = null;

const broadcast = (): void => {
  let vars;
  try {
    vars = readThemeSnapshot();
  } catch (err) {
    console.error("[widgets] readThemeSnapshot threw", err);
    return;
  }
  for (const sub of subscribers.values()) {
    try {
      sub.contentWindow.postMessage({ type: "theme:update", vars }, "*");
    } catch {
      // Swallow per-widget broadcast errors so one closed iframe never blocks
      // the rest. The widget's contentWindow may be null after unmount.
    }
  }
};

const ensureObserver = (): void => {
  if (observer !== null) return;
  if (typeof document === "undefined" || typeof MutationObserver === "undefined")
    return;
  observer = new MutationObserver(() => {
    broadcast();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });
};

const teardownObserverIfIdle = (): void => {
  if (subscribers.size > 0) return;
  if (observer === null) return;
  observer.disconnect();
  observer = null;
};

/**
 * Subscribe a widget's contentWindow to receive `theme:update` broadcasts.
 * Returns an unsubscribe function. Re-subscribing the same widgetId replaces
 * the prior entry (StrictMode-safe per D-30).
 */
export const subscribe = (
  widgetId: string,
  contentWindow: Window,
): (() => void) => {
  subscribers.set(widgetId, { contentWindow });
  ensureObserver();
  return () => unsubscribe(widgetId);
};

/** Unsubscribe a widget. No-op if not present. */
export const unsubscribe = (widgetId: string): void => {
  subscribers.delete(widgetId);
  teardownObserverIfIdle();
};

/**
 * Test-only: trigger a manual broadcast (useful when tests cannot reliably
 * mutate `document.documentElement` and observe the resulting MutationObserver
 * callback, since the observer fires asynchronously).
 */
export const __broadcastForTests = (): void => {
  broadcast();
};

/** Test-only: clear all subscriber state and disconnect the observer. */
export const __resetForTests = (): void => {
  subscribers.clear();
  if (observer !== null) {
    observer.disconnect();
    observer = null;
  }
};

/** Test-only: snapshot of current subscriber widgetIds. */
export const __snapshotForTests = (): {
  ids: string[];
  observerInstalled: boolean;
} => ({
  ids: Array.from(subscribers.keys()),
  observerInstalled: observer !== null,
});
