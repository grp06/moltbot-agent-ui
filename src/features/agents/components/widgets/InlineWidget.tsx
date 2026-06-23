"use client";

/**
 * InlineWidget — sandboxed iframe component for inline agent-emitted HTML.
 *
 * Owns one iframe's full lifecycle (CONTEXT.md D-20..D-32, WIDGET-01..12,
 * SEC-02..04). Builds the srcDoc via Phase 1's `buildWidgetSrcDoc`, registers
 * with the global `widgetMessageRegistry` for height updates (single
 * source-validated listener), subscribes via `widgetThemeBroadcast` for live
 * theme refresh (no remount on theme toggle — Chart.js state preserved).
 *
 * Hard guardrails honored here:
 *   - sandbox = literal `WIDGET_SANDBOX` constant only (D-20)
 *   - no `name` attribute on the iframe (D-21, SEC-04)
 *   - srcDoc memoized on (html, themeVars, id) (D-22)
 *   - widget HTML is NOT sanitized — sandbox is the trust boundary (SEC-03)
 *   - no transition-API wrapping anywhere (D-30); all effects idempotent
 *   - exported via React.memo with custom comparator on (title, html, id) (D-28)
 *
 * Phase 2 leaves this component DEAD CODE — no other module imports it. Phase
 * 3 wires it into `AssistantMarkdownContent`.
 */
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { buildWidgetSrcDoc, WIDGET_SANDBOX } from "./buildWidgetSrcDoc";
import { InlineWidgetErrorBoundary } from "./InlineWidgetErrorBoundary";
import {
  MIN_HEIGHT,
  OPEN_NEW_TAB_REVOKE_DELAY_MS,
  WIDGET_TITLE_FALLBACK,
} from "./widgetConstants";
import { register as registerHeight } from "./widgetMessageRegistry";
import { readThemeSnapshot, type ThemeVars } from "./widgetTheme";
import { subscribe as subscribeTheme } from "./widgetThemeBroadcast";

type InlineWidgetProps = {
  id: string;
  title: string;
  html: string;
};

const SHELL_CLASSES =
  "rounded-md border border-border bg-card text-foreground my-2 overflow-hidden";
const TITLE_BAR_CLASSES =
  "flex items-center justify-between gap-2 px-3 py-2 text-sm font-medium border-b border-border bg-muted/40";
const TITLE_TEXT_CLASSES = "flex-1 truncate";
const ICON_BUTTON_CLASSES =
  "inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const IFRAME_CLASSES = "block w-full border-0";

const InlineWidgetImpl = ({ id, title, html }: InlineWidgetProps) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [height, setHeight] = useState<number>(MIN_HEIGHT);

  // Capture the theme snapshot at MOUNT only (D-09 + D-02). After mount, the
  // bootstrap script inside srcDoc applies live theme:update messages directly
  // to :root via setProperty, so React doesn't need to rebuild srcDoc on theme
  // toggles — Chart.js state and scroll position survive the refresh.
  const themeVars = useMemo<ThemeVars>(() => readThemeSnapshot(), []);

  const srcDoc = useMemo(
    () => buildWidgetSrcDoc({ html, themeVars, widgetId: id }),
    [html, themeVars, id],
  );

  // Height registration: per-widget clamp + rate limit live in the registry.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (iframe === null) return;
    const unregister = registerHeight(id, iframe, (next: number) => {
      setHeight(next);
    });
    return unregister;
  }, [id]);

  // Theme subscription: bind once contentWindow is available. We re-run the
  // subscribe call whenever the iframe DOM node identity changes (which only
  // happens when (html, themeVars, id) change — see D-22 / D-23).
  useEffect(() => {
    const iframe = iframeRef.current;
    const win = iframe?.contentWindow;
    if (!iframe || !win) return;
    const unsubscribe = subscribeTheme(id, win);
    return unsubscribe;
  }, [id, srcDoc]);

  const titleText =
    title.trim().length > 0 ? title : WIDGET_TITLE_FALLBACK;

  const handleToggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  const handleOpenInNewTab = useCallback(() => {
    if (typeof window === "undefined" || typeof URL === "undefined") return;
    let url: string | null = null;
    let revoked = false;
    const revoke = () => {
      if (revoked || url === null) return;
      revoked = true;
      try {
        URL.revokeObjectURL(url);
      } catch {
        // browser may have already cleaned up the blob; ignore
      }
    };
    try {
      const blob = new Blob([srcDoc], { type: "text/html" });
      url = URL.createObjectURL(blob);
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (opened) {
        try {
          opened.addEventListener("load", revoke, { once: true });
        } catch {
          // some browsers block addEventListener on cross-origin opened
          // windows; the timeout fallback below covers the case
        }
      }
    } catch (err) {
      console.error("[InlineWidget] failed to open in new tab", err);
    }
    // D-17 belt-and-suspenders: revoke after timeout regardless of load event.
    setTimeout(revoke, OPEN_NEW_TAB_REVOKE_DELAY_MS);
  }, [srcDoc]);

  return (
    <InlineWidgetErrorBoundary widgetId={id} title={titleText} html={html}>
      <div className={SHELL_CLASSES} data-widget-id={id}>
        <div className={TITLE_BAR_CLASSES}>
          <span className={TITLE_TEXT_CLASSES}>{titleText}</span>
          {collapsed ? (
            <button
              type="button"
              className={ICON_BUTTON_CLASSES}
              aria-label="Expand widget"
              onClick={handleToggleCollapsed}
            >
              <ChevronDown aria-hidden="true" size={16} />
            </button>
          ) : (
            <button
              type="button"
              className={ICON_BUTTON_CLASSES}
              aria-label="Collapse widget"
              onClick={handleToggleCollapsed}
            >
              <ChevronUp aria-hidden="true" size={16} />
            </button>
          )}
          <button
            type="button"
            className={ICON_BUTTON_CLASSES}
            aria-label="Open widget in new tab"
            onClick={handleOpenInNewTab}
          >
            <ExternalLink aria-hidden="true" size={16} />
          </button>
        </div>
        {!collapsed ? (
          <iframe
            ref={iframeRef}
            title={titleText}
            sandbox={WIDGET_SANDBOX}
            srcDoc={srcDoc}
            className={IFRAME_CLASSES}
            style={{ height: `${height}px` }}
          />
        ) : null}
      </div>
    </InlineWidgetErrorBoundary>
  );
};

const inlineWidgetPropsAreEqual = (
  prev: InlineWidgetProps,
  next: InlineWidgetProps,
): boolean =>
  prev.title === next.title && prev.html === next.html && prev.id === next.id;

export const InlineWidget = memo(InlineWidgetImpl, inlineWidgetPropsAreEqual);
