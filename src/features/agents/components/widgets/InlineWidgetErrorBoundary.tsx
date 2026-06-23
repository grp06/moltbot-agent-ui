"use client";

/**
 * InlineWidgetErrorBoundary — per-widget React error boundary (CONTEXT.md
 * D-06..D-10, WIDGET-12). Catches:
 *   - render errors thrown by InlineWidget itself
 *   - synchronous throws originating in buildWidgetSrcDoc (defensive — the
 *     function is pure and shouldn't throw, but a future regression would be
 *     contained here)
 *
 * Renders fallback chrome that mirrors the title bar + a "View source"
 * disclosure showing the raw HTML so the user can see what the agent emitted.
 * Logs via console.error per D-10. There is no telemetry channel in Studio
 * for browser errors today; logging is sufficient.
 *
 * React mandates a class component for componentDidCatch — this is the only
 * class component in the widgets/ subsystem.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

import { WIDGET_TITLE_FALLBACK } from "./widgetConstants";

type Props = {
  widgetId: string;
  title: string;
  html: string;
  children?: ReactNode;
};

type State = { error: Error | null };

const FALLBACK_SHELL_CLASSES =
  "rounded-md border border-border bg-card text-foreground my-2 overflow-hidden";
const FALLBACK_HEADER_CLASSES =
  "flex items-center justify-between px-3 py-2 text-sm font-medium border-b border-border bg-muted/40";
const FALLBACK_BODY_CLASSES = "px-3 py-2 text-sm";
const FALLBACK_PRE_CLASSES =
  "mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 text-xs";

export class InlineWidgetErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[InlineWidget] failed to render widget ${this.props.widgetId}: ${this.props.title}`,
      error,
      info,
    );
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    const titleText =
      this.props.title.trim().length > 0
        ? this.props.title
        : WIDGET_TITLE_FALLBACK;
    return (
      <div className={FALLBACK_SHELL_CLASSES} data-widget-fallback="true">
        <div className={FALLBACK_HEADER_CLASSES}>
          <span className="truncate">{titleText}</span>
          <span className="text-xs text-muted-foreground">failed to render</span>
        </div>
        <div className={FALLBACK_BODY_CLASSES}>
          <p className="text-muted-foreground">
            This widget threw a render error. Studio fell back to source view.
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              View source
            </summary>
            <pre className={FALLBACK_PRE_CLASSES}>
              <code>{this.props.html}</code>
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
