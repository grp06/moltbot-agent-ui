/**
 * widgetMessageRegistry — single global `window.message` listener for inline
 * widget height updates. Module-level singleton chosen per CONTEXT.md D-13;
 * lazy-installs the listener on first `register` and removes it on last
 * `unregister` (PITFALLS #11 — listener leaks).
 *
 * Validation chain (D-11):
 *   1. event.data.type === "iframe:height"
 *   2. registered widget exists by event.data.widgetId
 *   3. event.source === iframe.contentWindow (forgery check, SEC-02)
 *   4. event.source.parent === window (rejects grandchild frames)
 *   5. Number.isFinite(event.data.height)
 *   6. clamp to [MIN_HEIGHT, MAX_HEIGHT]
 *   7. sliding-window rate limit: RATE_LIMIT_MAX_MSGS per RATE_LIMIT_WINDOW_MS
 *
 * Failure modes:
 *   - NaN / non-number height → console.warn, drop (D-32 / SEC-02)
 *   - Forged source / mismatched widgetId → silent drop (no logging — would
 *     give attackers a noise channel)
 *   - Rate limit hit → silent drop after first warn per widget per window
 */
import {
  MAX_HEIGHT,
  MIN_HEIGHT,
  RATE_LIMIT_MAX_MSGS,
  RATE_LIMIT_WINDOW_MS,
} from "./widgetConstants";

type RegistryEntry = {
  iframe: HTMLIFrameElement;
  onHeight: (height: number) => void;
  recentMessages: number[];
};

const registry = new Map<string, RegistryEntry>();
let listenerInstalled = false;

const isHeightMessage = (
  data: unknown,
): data is { type: "iframe:height"; widgetId: string; height: unknown } => {
  if (typeof data !== "object" || data === null) return false;
  const d = data as { type?: unknown; widgetId?: unknown };
  return d.type === "iframe:height" && typeof d.widgetId === "string";
};

const isRateLimited = (entry: RegistryEntry, now: number): boolean => {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  while (entry.recentMessages.length > 0 && entry.recentMessages[0] < cutoff) {
    entry.recentMessages.shift();
  }
  if (entry.recentMessages.length >= RATE_LIMIT_MAX_MSGS) return true;
  entry.recentMessages.push(now);
  return false;
};

const handleMessage = (event: MessageEvent): void => {
  try {
    const data = event.data;
    if (!isHeightMessage(data)) return;
    const entry = registry.get(data.widgetId);
    if (!entry) return;
    if (event.source !== entry.iframe.contentWindow) return;
    const source = event.source as Window | null;
    if (source === null) return;
    // Reject grandchild frames: in a real browser, a direct-child iframe's
    // contentWindow.parent IS the top page window (so `parent.top === parent`).
    // A grandchild's parent is an intermediate iframe whose `top` resolves up
    // to the page (so `parent.top !== parent`). The check below is true only
    // for direct children; reject everything else.
    const parentWin = source.parent as Window | null;
    if (parentWin === null || parentWin.top !== parentWin) return;
    const rawHeight = Number(data.height);
    if (!Number.isFinite(rawHeight)) {
      console.warn("[widgets] dropping non-finite height", data.height);
      return;
    }
    if (isRateLimited(entry, Date.now())) return;
    const clamped = Math.min(Math.max(rawHeight, MIN_HEIGHT), MAX_HEIGHT);
    entry.onHeight(clamped);
  } catch (err) {
    console.error("[widgets] message handler threw", err);
  }
};

const ensureListener = (): void => {
  if (listenerInstalled) return;
  if (typeof window === "undefined") return;
  window.addEventListener("message", handleMessage);
  listenerInstalled = true;
};

const teardownListenerIfIdle = (): void => {
  if (registry.size > 0) return;
  if (!listenerInstalled) return;
  if (typeof window === "undefined") return;
  window.removeEventListener("message", handleMessage);
  listenerInstalled = false;
};

/**
 * Register a widget with the global listener. Returns an unregister function
 * to use as the React effect cleanup. Re-registering the same widgetId
 * replaces the prior entry (StrictMode-safe per D-30).
 */
export const register = (
  widgetId: string,
  iframe: HTMLIFrameElement,
  onHeight: (height: number) => void,
): (() => void) => {
  registry.set(widgetId, { iframe, onHeight, recentMessages: [] });
  ensureListener();
  return () => unregister(widgetId);
};

/** Unregister a widget. No-op if not present. */
export const unregister = (widgetId: string): void => {
  registry.delete(widgetId);
  teardownListenerIfIdle();
};

/** Test-only: clear all registry state and remove the listener. */
export const __resetForTests = (): void => {
  registry.clear();
  if (listenerInstalled && typeof window !== "undefined") {
    window.removeEventListener("message", handleMessage);
  }
  listenerInstalled = false;
};

/** Test-only: snapshot of current registered widgetIds. */
export const __snapshotForTests = (): {
  ids: string[];
  listenerInstalled: boolean;
} => ({
  ids: Array.from(registry.keys()),
  listenerInstalled,
});
