import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConnectionPanel } from "@/features/agents/components/ConnectionPanel";

const buildProps = () => ({
  savedGatewayUrl: "ws://127.0.0.1:18789",
  draftGatewayUrl: "ws://127.0.0.1:18789",
  token: "token",
  hasStoredToken: true,
  localGatewayDefaults: null,
  localGatewayDefaultsHasToken: false,
  hasUnsavedChanges: false,
  status: "disconnected" as const,
  statusReason: null,
  error: null,
  testResult: null,
  saving: false,
  testing: false,
  disconnecting: false,
  onGatewayUrlChange: vi.fn(),
  onTokenChange: vi.fn(),
  onSaveSettings: vi.fn(),
  onTestConnection: vi.fn(),
  onDisconnect: vi.fn(),
});

describe("ConnectionPanel close control", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders close control and calls handler when provided", () => {
    const onClose = vi.fn();
    const props = buildProps();

    render(
      createElement(ConnectionPanel, {
        ...props,
        onClose,
      })
    );

    fireEvent.click(screen.getByTestId("gateway-connection-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not render close control when handler is missing", () => {
    render(createElement(ConnectionPanel, buildProps()));

    expect(screen.queryByTestId("gateway-connection-close")).not.toBeInTheDocument();
  });

  it("renders semantic gateway status class markers", () => {
    const { rerender } = render(
      createElement(ConnectionPanel, {
        ...buildProps(),
      })
    );

    const disconnected = screen.getByText("Disconnected");
    expect(disconnected).toHaveAttribute("data-status", "disconnected");
    expect(disconnected).toHaveClass("ui-badge-status-disconnected");

    rerender(
      createElement(ConnectionPanel, {
        ...buildProps(),
        status: "connected",
      })
    );

    const connected = screen.getByText("Connected");
    expect(connected).toHaveAttribute("data-status", "connected");
    expect(connected).toHaveClass("ui-badge-status-connected");
  });

  it("disables connection actions while disconnecting", () => {
    render(
      createElement(ConnectionPanel, {
        ...buildProps(),
        status: "connected",
        disconnecting: true,
      })
    );

    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disconnecting…" })).toBeDisabled();
  });
});
