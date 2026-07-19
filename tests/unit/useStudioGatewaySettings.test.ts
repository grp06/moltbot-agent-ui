import { createElement, useEffect } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchJson } from "@/lib/http";
import type { StudioSettingsResponse } from "@/lib/studio/coordinator";
import { defaultStudioInstallContext } from "@/lib/studio/install-context";
import { useStudioGatewaySettings } from "@/lib/studio/useStudioGatewaySettings";

vi.mock("@/lib/http", () => ({
  fetchJson: vi.fn(),
}));

type HookValue = ReturnType<typeof useStudioGatewaySettings>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
};

const createDeferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const buildEnvelope = (): StudioSettingsResponse => ({
  settings: {
    version: 1,
    gateway: {
      url: "wss://remote.example:8443",
      token: "",
    },
    gatewayAutoStart: true,
    focused: {},
    avatars: {},
  },
  localGatewayDefaults: null,
  localGatewayDefaultsMeta: {
    hasToken: false,
  },
  gatewayMeta: {
    hasStoredToken: true,
    credentialScope: "scope-one",
  },
  installContext: defaultStudioInstallContext(),
  domainApiModeEnabled: true,
});

const renderHook = (envelope: StudioSettingsResponse = buildEnvelope()) => {
  const coordinator = {
    loadSettings: vi.fn(async () => envelope.settings),
    loadSettingsEnvelope: vi.fn(async () => envelope),
    flushPending: vi.fn(async () => {}),
  };
  const valueRef: { current: HookValue | null } = { current: null };

  const Probe = () => {
    const value = useStudioGatewaySettings(coordinator);
    useEffect(() => {
      valueRef.current = value;
    }, [value]);
    return createElement("div", { "data-testid": "probe" }, "ok");
  };

  const rendered = render(createElement(Probe));

  return {
    coordinator,
    getValue: () => {
      if (!valueRef.current) {
        throw new Error("hook value unavailable");
      }
      return valueRef.current;
    },
    unmount: () => rendered.unmount(),
  };
};

describe("useStudioGatewaySettings", () => {
  const mockedFetchJson = vi.mocked(fetchJson);
  const fetchMock = vi.fn();

  beforeEach(() => {
    mockedFetchJson.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          enabled: true,
          summary: {
            status: "connected",
            reason: null,
          },
        }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("blocks save while disconnect is still in flight", async () => {
    const disconnectDeferred = createDeferred<{
      enabled: boolean;
      summary: {
        status: string;
        reason: string | null;
        asOf?: string | null;
        outboxHead?: number;
      };
    }>();
    mockedFetchJson.mockImplementation(async (input) => {
      if (input === "/api/runtime/disconnect") {
        return await disconnectDeferred.promise;
      }
      throw new Error(`Unexpected fetchJson call: ${String(input)}`);
    });

    const ctx = renderHook();

    await waitFor(() => {
      expect(ctx.getValue().status).toBe("connected");
    });

    let disconnectPromise: Promise<void> | undefined;
    act(() => {
      disconnectPromise = ctx.getValue().disconnect();
    });

    await waitFor(() => {
      expect(ctx.getValue().disconnecting).toBe(true);
    });
    expect(ctx.getValue().status).toBe("connected");

    let saveResult = true;
    await act(async () => {
      saveResult = await ctx.getValue().saveSettings();
    });

    expect(saveResult).toBe(false);
    expect(ctx.coordinator.flushPending).not.toHaveBeenCalled();
    expect(mockedFetchJson).not.toHaveBeenCalledWith(
      "/api/studio",
      expect.anything()
    );

    disconnectDeferred.resolve({
      enabled: true,
      summary: {
        status: "stopped",
        reason: null,
      },
    });

    await act(async () => {
      await disconnectPromise;
    });

    await waitFor(() => {
      expect(ctx.getValue().status).toBe("disconnected");
    });
    expect(ctx.getValue().disconnecting).toBe(false);
    ctx.unmount();
  });

  it("shows actionable guidance for control-ui secure-context gateway errors", async () => {
    mockedFetchJson.mockImplementation(async (input) => {
      if (input === "/api/studio/test-connection") {
        return {
          ok: false,
          error:
            "Control-plane connect rejected: INVALID_REQUEST control ui requires device identity (use HTTPS or localhost secure context)",
          startFailure: {
            code: "INVALID_REQUEST",
            profileId: "legacy-control-ui",
            message:
              "Control-plane connect rejected: INVALID_REQUEST control ui requires device identity (use HTTPS or localhost secure context)",
          },
        };
      }
      throw new Error(`Unexpected fetchJson call: ${String(input)}`);
    });

    const ctx = renderHook();

    await waitFor(() => {
      expect(ctx.getValue().status).toBe("connected");
    });

    await act(async () => {
      await ctx.getValue().testConnection();
    });

    expect(ctx.getValue().testResult).toEqual({
      kind: "error",
      message:
        "OpenClaw rejected this connection because its control-ui compatibility mode needs HTTPS or localhost device identity. Use wss:// via Tailscale Serve, or tunnel the gateway to ws://localhost from the Studio host.",
    });
    expect(ctx.getValue().error).toBe(
      "OpenClaw rejected this connection because its control-ui compatibility mode needs HTTPS or localhost device identity. Use wss:// via Tailscale Serve, or tunnel the gateway to ws://localhost from the Studio host."
    );

    ctx.unmount();
  });

  it("shows the raw backend-local startup failure when the failure is not legacy control-ui", async () => {
    mockedFetchJson.mockImplementation(async (input) => {
      if (input === "/api/studio/test-connection") {
        return {
          ok: false,
          error: "Control-plane gateway connection failed: connect ECONNREFUSED 127.0.0.1:18789",
          startFailure: {
            code: "CONNECT_FAILED",
            profileId: "backend-local",
            message:
              "Control-plane gateway connection failed: connect ECONNREFUSED 127.0.0.1:18789",
          },
        };
      }
      throw new Error(`Unexpected fetchJson call: ${String(input)}`);
    });

    const ctx = renderHook();

    await waitFor(() => {
      expect(ctx.getValue().status).toBe("connected");
    });

    await act(async () => {
      await ctx.getValue().testConnection();
    });

    expect(ctx.getValue().testResult).toEqual({
      kind: "error",
      message: "Control-plane gateway connection failed: connect ECONNREFUSED 127.0.0.1:18789",
    });
    expect(ctx.getValue().error).toBe(
      "Control-plane gateway connection failed: connect ECONNREFUSED 127.0.0.1:18789"
    );

    ctx.unmount();
  });

  it("formats legacy control-ui startup failures from runtime summary with actionable guidance", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          enabled: true,
          error:
            "Control-plane connect rejected: INVALID_REQUEST control ui requires device identity (use HTTPS or localhost secure context)",
          startFailure: {
            code: "INVALID_REQUEST",
            profileId: "legacy-control-ui",
            message:
              "Control-plane connect rejected: INVALID_REQUEST control ui requires device identity (use HTTPS or localhost secure context)",
          },
          summary: {
            status: "error",
            reason: "gateway_closed",
          },
        }),
    });

    const ctx = renderHook();

    await waitFor(() => {
      expect(ctx.getValue().status).toBe("error");
    });
    expect(ctx.getValue().error).toBe(
      "OpenClaw rejected this connection because its control-ui compatibility mode needs HTTPS or localhost device identity. Use wss:// via Tailscale Serve, or tunnel the gateway to ws://localhost from the Studio host."
    );

    ctx.unmount();
  });

  it("keeps backend-local startup failures from runtime summary verbatim", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          enabled: true,
          error: "Control-plane gateway connection failed: connect ECONNREFUSED 127.0.0.1:18789",
          startFailure: {
            code: "CONNECT_FAILED",
            profileId: "backend-local",
            message:
              "Control-plane gateway connection failed: connect ECONNREFUSED 127.0.0.1:18789",
          },
          summary: {
            status: "error",
            reason: "gateway_closed",
          },
        }),
    });

    const ctx = renderHook();

    await waitFor(() => {
      expect(ctx.getValue().status).toBe("error");
    });
    expect(ctx.getValue().error).toBe(
      "Control-plane gateway connection failed: connect ECONNREFUSED 127.0.0.1:18789"
    );

    ctx.unmount();
  });

  it("requires an explicit token when only local defaults exist and the draft url is remote", async () => {
    const envelope = buildEnvelope();
    envelope.settings.gateway = {
      url: "ws://localhost:18789",
      token: "",
    };
    envelope.gatewayMeta = {
      hasStoredToken: false,
      credentialScope: "local-scope",
    };
    envelope.localGatewayDefaults = {
      url: "ws://localhost:18789",
      token: "",
    };
    envelope.localGatewayDefaultsMeta = {
      hasToken: true,
    };
    const ctx = renderHook(envelope);

    await waitFor(() => {
      expect(ctx.getValue().status).toBe("connected");
    });

    act(() => {
      ctx.getValue().setGatewayUrl("wss://gateway.example");
    });

    let saved = true;
    await act(async () => {
      saved = await ctx.getValue().saveSettings();
    });

    expect(saved).toBe(false);
    expect(ctx.getValue().error).toBe(
      "Gateway token is required. Enter one or keep the stored token."
    );
    expect(ctx.coordinator.flushPending).not.toHaveBeenCalled();
    expect(mockedFetchJson).not.toHaveBeenCalledWith("/api/studio", expect.anything());

    ctx.unmount();
  });

  it("requires an explicit token when a stored token exists for a different gateway url", async () => {
    const envelope = buildEnvelope();
    envelope.settings.gateway = {
      url: "wss://gateway.old.example",
      token: "",
    };
    envelope.gatewayMeta = {
      hasStoredToken: true,
      credentialScope: "stored-scope",
    };
    const ctx = renderHook(envelope);

    await waitFor(() => {
      expect(ctx.getValue().status).toBe("connected");
    });

    act(() => {
      ctx.getValue().setGatewayUrl("wss://gateway.new.example");
    });

    let saved = true;
    await act(async () => {
      saved = await ctx.getValue().saveSettings();
    });

    expect(saved).toBe(false);
    expect(ctx.getValue().error).toBe(
      "Gateway token is required. Enter one or keep the stored token."
    );
    expect(ctx.coordinator.flushPending).not.toHaveBeenCalled();
    expect(mockedFetchJson).not.toHaveBeenCalledWith("/api/studio", expect.anything());

    ctx.unmount();
  });

  it("allows a blank token when local defaults apply to the draft url", async () => {
    const envelope = buildEnvelope();
    envelope.settings.gateway = {
      url: "ws://localhost:18789",
      token: "",
    };
    envelope.gatewayMeta = {
      hasStoredToken: false,
      credentialScope: "local-scope",
    };
    envelope.localGatewayDefaults = {
      url: "ws://localhost:18789",
      token: "",
    };
    envelope.localGatewayDefaultsMeta = {
      hasToken: true,
    };
    mockedFetchJson.mockImplementation(async (input) => {
      if (input === "/api/studio") {
        return envelope;
      }
      throw new Error(`Unexpected fetchJson call: ${String(input)}`);
    });
    const ctx = renderHook(envelope);

    await waitFor(() => {
      expect(ctx.getValue().status).toBe("connected");
    });

    let saved = false;
    await act(async () => {
      saved = await ctx.getValue().saveSettings();
    });

    expect(saved).toBe(true);
    expect(ctx.coordinator.flushPending).toHaveBeenCalledTimes(1);
    expect(mockedFetchJson).toHaveBeenCalledWith(
      "/api/studio",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ gateway: { url: "ws://localhost:18789" } }),
      })
    );

    ctx.unmount();
  });
});
