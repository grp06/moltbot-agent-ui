import { createElement, useEffect } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRuntimeSyncController } from "@/features/agents/operations/useRuntimeSyncController";
import type { AgentState } from "@/features/agents/state/store";
import type {
  DomainAgentHistoryResult,
  DomainSessionPreviewResult,
} from "@/lib/controlplane/domain-runtime-client";

import { hydrateDomainHistoryWindow } from "@/features/agents/operations/domainHistoryHydration";
import { buildReconcileTerminalPatch } from "@/features/agents/operations/fleetLifecycleWorkflow";
import { readCachedHistoryWindow, writeCachedHistoryWindow } from "@/features/agents/operations/historyWindowCache";
import {
  loadDomainAgentHistoryWindow,
  loadDomainAgentPreviewWindow,
} from "@/lib/controlplane/domain-runtime-client";
import { fetchJson } from "@/lib/http";

vi.mock("@/features/agents/operations/domainHistoryHydration", () => ({
  hydrateDomainHistoryWindow: vi.fn(),
}));

vi.mock("@/features/agents/operations/historyWindowCache", async () => {
  const actual = await vi.importActual<typeof import("@/features/agents/operations/historyWindowCache")>(
    "@/features/agents/operations/historyWindowCache"
  );
  return {
    ...actual,
    readCachedHistoryWindow: vi.fn(),
    writeCachedHistoryWindow: vi.fn(),
  };
});

vi.mock("@/lib/controlplane/domain-runtime-client", () => ({
  loadDomainAgentHistoryWindow: vi.fn(),
  loadDomainAgentPreviewWindow: vi.fn(),
}));

vi.mock("@/lib/http", () => ({
  fetchJson: vi.fn(),
}));

const createAgent = (overrides?: Partial<AgentState>): AgentState => ({
  agentId: "agent-1",
  name: "Agent One",
  sessionKey: "agent:agent-1:main",
  status: "idle",
  sessionCreated: true,
  awaitingUserInput: false,
  hasUnseenActivity: false,
  outputLines: [],
  lastResult: null,
  lastDiff: null,
  runId: null,
  runStartedAt: null,
  streamText: null,
  thinkingTrace: null,
  latestOverride: null,
  latestOverrideKind: null,
  lastAssistantMessageAt: null,
  lastActivityAt: null,
  latestPreview: null,
  lastUserMessage: null,
  draft: "",
  sessionSettingsSynced: true,
  historyLoadedAt: null,
  historyFetchLimit: null,
  historyFetchedCount: null,
  historyMaybeTruncated: false,
  historyHasMore: false,
  historyGatewayCapReached: false,
  toolCallingEnabled: true,
  showThinkingTraces: true,
  model: "openai/gpt-5",
  thinkingLevel: "medium",
  avatarSeed: "seed-1",
  avatarUrl: null,
  ...(overrides ?? {}),
});

type RuntimeSyncControllerValue = ReturnType<typeof useRuntimeSyncController>;

type RenderControllerContext = {
  getValue: () => RuntimeSyncControllerValue;
  rerenderWith: (overrides: Partial<Parameters<typeof useRuntimeSyncController>[0]>) => void;
  unmount: () => void;
  dispatch: ReturnType<typeof vi.fn>;
};

const renderController = (
  overrides?: Partial<Parameters<typeof useRuntimeSyncController>[0]>
): RenderControllerContext => {
  const dispatch = vi.fn();
  const agentWait = vi.fn(async () => ({ status: "running" }));
  const clearRunTracking = vi.fn();

  let currentParams: Parameters<typeof useRuntimeSyncController>[0] = {
    status: "connected",
    agents: [createAgent({ historyLoadedAt: 1000 })],
    focusedAgentId: null,
    dispatch,
    runtimeWriteTransport: { agentWait },
    clearRunTracking,
    isDisconnectLikeError: () => false,
    ...(overrides ?? {}),
  };

  const valueRef: { current: RuntimeSyncControllerValue | null } = { current: null };

  const Probe = ({
    params,
    onValue,
  }: {
    params: Parameters<typeof useRuntimeSyncController>[0];
    onValue: (value: RuntimeSyncControllerValue) => void;
  }) => {
    const value = useRuntimeSyncController(params);
    useEffect(() => {
      onValue(value);
    }, [onValue, value]);
    return createElement("div", { "data-testid": "probe" }, "ok");
  };

  const rendered = render(
    createElement(Probe, {
      params: currentParams,
      onValue: (value) => {
        valueRef.current = value;
      },
    })
  );

  return {
    getValue: () => {
      if (!valueRef.current) {
        throw new Error("runtime sync controller value unavailable");
      }
      return valueRef.current;
    },
    rerenderWith: (nextOverrides) => {
      currentParams = {
        ...currentParams,
        ...nextOverrides,
      };
      rendered.rerender(
        createElement(Probe, {
          params: currentParams,
          onValue: (value) => {
            valueRef.current = value;
          },
        })
      );
    },
    unmount: () => {
      rendered.unmount();
    },
    dispatch,
  };
};

const createHistoryResult = (): DomainAgentHistoryResult => ({
  enabled: true,
  agentId: "agent-1",
  view: "semantic",
  messages: [],
  hasMore: false,
  semanticTurnsIncluded: 0,
  windowTruncated: false,
  gatewayLimit: 200,
  gatewayCapped: false,
});

const createPreviewResult = (): DomainSessionPreviewResult => ({
  enabled: true,
  agentId: "agent-1",
  sessionKey: "agent:agent-1:main",
  items: [],
});

describe("useRuntimeSyncController", () => {
  const mockedLoadDomainAgentHistoryWindow = vi.mocked(loadDomainAgentHistoryWindow);
  const mockedLoadDomainAgentPreviewWindow = vi.mocked(loadDomainAgentPreviewWindow);
  const mockedHydrateDomainHistoryWindow = vi.mocked(hydrateDomainHistoryWindow);
  const mockedReadCachedHistoryWindow = vi.mocked(readCachedHistoryWindow);
  const mockedWriteCachedHistoryWindow = vi.mocked(writeCachedHistoryWindow);
  const mockedFetchJson = vi.mocked(fetchJson);

  beforeEach(() => {
    mockedLoadDomainAgentHistoryWindow.mockReset();
    mockedLoadDomainAgentPreviewWindow.mockReset();
    mockedHydrateDomainHistoryWindow.mockReset();
    mockedReadCachedHistoryWindow.mockReset();
    mockedWriteCachedHistoryWindow.mockReset();
    mockedFetchJson.mockReset();

    mockedLoadDomainAgentHistoryWindow.mockResolvedValue(createHistoryResult());
    mockedLoadDomainAgentPreviewWindow.mockResolvedValue(createPreviewResult());
    mockedHydrateDomainHistoryWindow.mockReturnValue({ historyLoadedAt: 1000 });
    mockedReadCachedHistoryWindow.mockResolvedValue(null);
    mockedWriteCachedHistoryWindow.mockResolvedValue(undefined);
    mockedFetchJson.mockResolvedValue({ summary: {}, freshness: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads summary snapshot when connected", async () => {
    renderController({
      status: "connected",
      agents: [createAgent({ historyLoadedAt: 1234 })],
      focusedAgentId: null,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedFetchJson).toHaveBeenCalledWith("/api/runtime/summary", {
      cache: "no-store",
    });
  });

  it("reconciles terminal running agents through the domain wait transport", async () => {
    const agentWait = vi.fn(async () => ({ status: "ok" }));
    const clearRunTracking = vi.fn();
    const ctx = renderController({
      status: "connected",
      agents: [
        createAgent({
          status: "running",
          runId: "run-1",
          runStartedAt: 1234,
          historyLoadedAt: 1000,
        }),
      ],
      focusedAgentId: null,
      runtimeWriteTransport: { agentWait },
      clearRunTracking,
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(agentWait).toHaveBeenCalledWith({ runId: "run-1", timeoutMs: 1 });
    expect(clearRunTracking).toHaveBeenCalledWith("run-1");
    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: "updateAgent",
      agentId: "agent-1",
      patch: buildReconcileTerminalPatch({ outcome: "ok" }),
    });
    expect(mockedLoadDomainAgentHistoryWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        sessionKey: "agent:agent-1:main",
      })
    );
  });

  it("bootstraps focused agent history when connected and history is missing", async () => {
    renderController({
      status: "connected",
      agents: [createAgent({ historyLoadedAt: null })],
      focusedAgentId: "agent-1",
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedLoadDomainAgentHistoryWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        view: "semantic",
      })
    );
  });

  it("loads deeper focused preview when bootstrap preview is sparse", async () => {
    mockedLoadDomainAgentPreviewWindow.mockResolvedValue({
      ...createPreviewResult(),
      items: [
        { role: "user", text: "u1" },
        { role: "assistant", text: "a1" },
        { role: "user", text: "u2" },
        { role: "assistant", text: "a2" },
      ],
    });

    const ctx = renderController({
      status: "connected",
      agents: [createAgent({ historyLoadedAt: null, previewItems: [{ role: "assistant", text: "one" }] })],
      focusedAgentId: "agent-1",
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedLoadDomainAgentPreviewWindow).toHaveBeenCalledWith({
      agentId: "agent-1",
      sessionKey: "agent:agent-1:main",
      limit: 50,
      maxChars: 480,
    });
    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: "updateAgent",
      agentId: "agent-1",
      patch: {
        previewItems: [
          { role: "user", text: "u1" },
          { role: "assistant", text: "a1" },
          { role: "user", text: "u2" },
          { role: "assistant", text: "a2" },
        ],
        latestPreview: "a2",
        lastUserMessage: "u2",
      },
    });
  });

  it("loads domain history, hydrates it, and dispatches update", async () => {
    const ctx = renderController({
      status: "disconnected",
      agents: [createAgent({ historyLoadedAt: null })],
      focusedAgentId: null,
      defaultHistoryLimit: 50,
      maxHistoryLimit: 300,
    });

    mockedHydrateDomainHistoryWindow.mockReturnValue({
      outputLines: ["restored"],
      historyLoadedAt: 555,
    });

    await act(async () => {
      await ctx.getValue().loadAgentHistory("agent-1", { limit: 500, reason: "refresh" });
    });

    expect(mockedLoadDomainAgentHistoryWindow).toHaveBeenCalledWith({
      agentId: "agent-1",
      sessionKey: "agent:agent-1:main",
      view: "semantic",
      turnLimit: 300,
      scanLimit: 300,
      includeThinking: true,
      includeTools: true,
      signal: expect.any(AbortSignal),
    });
    expect(mockedHydrateDomainHistoryWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.any(String),
        requestedLimit: 300,
        view: "semantic",
        reason: "refresh",
      })
    );
    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: "updateAgent",
      agentId: "agent-1",
      patch: {
        outputLines: ["restored"],
        historyLoadedAt: 555,
      },
    });
  });

  it("requests compact conversation history when thinking traces are disabled", async () => {
    const ctx = renderController({
      status: "disconnected",
      agents: [createAgent({ historyLoadedAt: null, showThinkingTraces: false })],
      focusedAgentId: null,
      defaultHistoryLimit: 50,
      maxHistoryLimit: 300,
    });

    await act(async () => {
      await ctx.getValue().loadAgentHistory("agent-1", { reason: "refresh" });
    });

    expect(mockedLoadDomainAgentHistoryWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        sessionKey: "agent:agent-1:main",
        includeThinking: false,
        includeTools: false,
      })
    );
  });

  it("persists compact history under the same tool-inclusion key used for loading", async () => {
    renderController({
      status: "disconnected",
      gatewayUrl: "ws://gateway.example:18789",
      agents: [
        createAgent({
          historyLoadedAt: 1234,
          historyFetchLimit: 50,
          historyFetchedCount: 2,
          historyVisibleTurnLimit: 2,
          showThinkingTraces: false,
          toolCallingEnabled: true,
          transcriptEntries: [
            {
              entryId: "entry-1",
              role: "assistant",
              kind: "assistant",
              text: "cached reply",
              sessionKey: "agent:agent-1:main",
              runId: null,
              source: "history",
              timestampMs: 1234,
              sequenceKey: 1,
              confirmed: true,
              fingerprint: "fingerprint-1",
            },
          ],
        }),
      ],
      focusedAgentId: null,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedWriteCachedHistoryWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayUrl: "ws://gateway.example:18789",
        agentId: "agent-1",
        sessionKey: "agent:agent-1:main",
        includeThinking: false,
        includeTools: false,
      })
    );
  });

  it("dedupes in-flight history requests by session key", async () => {
    let resolveHistory!: (value: DomainAgentHistoryResult) => void;
    const historyPromise = new Promise<DomainAgentHistoryResult>((resolve) => {
      resolveHistory = resolve;
    });
    mockedLoadDomainAgentHistoryWindow.mockReturnValue(historyPromise);

    const ctx = renderController({
      status: "disconnected",
      agents: [createAgent({ historyLoadedAt: null })],
      focusedAgentId: null,
    });

    const first = ctx.getValue().loadAgentHistory("agent-1");
    const second = ctx.getValue().loadAgentHistory("agent-1");
    await second;

    expect(mockedLoadDomainAgentHistoryWindow).toHaveBeenCalledTimes(1);

    resolveHistory(createHistoryResult());
    await first;
  });

  it("allows manual clear of in-flight key to force a second request", async () => {
    let resolveHistory!: (value: DomainAgentHistoryResult) => void;
    const historyPromise = new Promise<DomainAgentHistoryResult>((resolve) => {
      resolveHistory = resolve;
    });
    mockedLoadDomainAgentHistoryWindow.mockReturnValue(historyPromise);

    const ctx = renderController({
      status: "disconnected",
      agents: [createAgent({ historyLoadedAt: null, sessionKey: "agent:agent-1:main" })],
      focusedAgentId: null,
    });

    void ctx.getValue().loadAgentHistory("agent-1");
    act(() => {
      ctx.getValue().clearHistoryInFlight("agent:agent-1:main");
    });
    void ctx.getValue().loadAgentHistory("agent-1");

    expect(mockedLoadDomainAgentHistoryWindow).toHaveBeenCalledTimes(2);

    resolveHistory(createHistoryResult());
  });

  it("clears session history cache when clearing in-flight state", async () => {
    const ctx = renderController({
      status: "disconnected",
      agents: [createAgent({ historyLoadedAt: null, sessionKey: "agent:agent-1:main" })],
      focusedAgentId: null,
    });

    await act(async () => {
      await ctx.getValue().loadAgentHistory("agent-1", { reason: "bootstrap" });
    });
    expect(mockedLoadDomainAgentHistoryWindow).toHaveBeenCalledTimes(1);

    await act(async () => {
      await ctx.getValue().loadAgentHistory("agent-1", { reason: "bootstrap" });
    });
    expect(mockedLoadDomainAgentHistoryWindow).toHaveBeenCalledTimes(1);

    act(() => {
      ctx.getValue().clearHistoryInFlight("agent:agent-1:main");
    });

    await act(async () => {
      await ctx.getValue().loadAgentHistory("agent-1", { reason: "bootstrap" });
    });
    expect(mockedLoadDomainAgentHistoryWindow).toHaveBeenCalledTimes(2);
  });

  it("does not reuse in-memory history cache across gateway URLs", async () => {
    const ctx = renderController({
      status: "disconnected",
      gatewayUrl: "ws://gateway-old.example:18789",
      agents: [createAgent({ historyLoadedAt: 1234, sessionKey: "agent:agent-1:main" })],
      focusedAgentId: null,
    });

    await act(async () => {
      await ctx.getValue().loadAgentHistory("agent-1", { reason: "bootstrap" });
    });
    expect(mockedLoadDomainAgentHistoryWindow).toHaveBeenCalledTimes(1);

    ctx.rerenderWith({
      gatewayUrl: "ws://gateway-new.example:18789",
    });

    await act(async () => {
      await ctx.getValue().loadAgentHistory("agent-1", { reason: "bootstrap" });
    });
    expect(mockedLoadDomainAgentHistoryWindow).toHaveBeenCalledTimes(2);
  });

  it("grows history limit when loading more history", async () => {
    const ctx = renderController({
      status: "disconnected",
      agents: [
        createAgent({
          historyLoadedAt: 1234,
          historyMaybeTruncated: true,
          historyFetchLimit: 200,
        }),
      ],
      focusedAgentId: null,
      defaultHistoryLimit: 50,
      maxHistoryLimit: 500,
    });

    await act(async () => {
      ctx.getValue().loadMoreAgentHistory("agent-1");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedLoadDomainAgentHistoryWindow).toHaveBeenCalledWith({
      agentId: "agent-1",
      sessionKey: "agent:agent-1:main",
      view: "semantic",
      turnLimit: 400,
      scanLimit: 500,
      includeThinking: true,
      includeTools: true,
      signal: expect.any(AbortSignal),
    });
  });

  it("skips load-more when history is not truncated", async () => {
    const ctx = renderController({
      status: "disconnected",
      agents: [createAgent({ historyLoadedAt: 1234, historyMaybeTruncated: false })],
      focusedAgentId: null,
    });

    await act(async () => {
      ctx.getValue().loadMoreAgentHistory("agent-1");
      await Promise.resolve();
    });

    expect(mockedLoadDomainAgentHistoryWindow).not.toHaveBeenCalled();
  });

  it("skips load-more when gateway cap has been reached", async () => {
    const ctx = renderController({
      status: "disconnected",
      agents: [
        createAgent({
          historyLoadedAt: 1234,
          historyMaybeTruncated: true,
          historyGatewayCapReached: true,
          historyFetchLimit: 1000,
        }),
      ],
      focusedAgentId: null,
    });

    await act(async () => {
      ctx.getValue().loadMoreAgentHistory("agent-1");
      await Promise.resolve();
    });

    expect(mockedLoadDomainAgentHistoryWindow).not.toHaveBeenCalled();
  });

  it("aborts in-flight history loads when clearHistoryInFlight is called", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    mockedLoadDomainAgentHistoryWindow.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<DomainAgentHistoryResult>((_, reject) => {
          if (!signal) {
            reject(new Error("signal missing"));
            return;
          }
          if (signal.aborted) {
            reject(abortError);
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              reject(abortError);
            },
            { once: true }
          );
        })
    );

    const ctx = renderController({
      status: "disconnected",
      agents: [createAgent({ historyLoadedAt: null })],
      focusedAgentId: null,
    });

    const pending = ctx.getValue().loadAgentHistory("agent-1", { reason: "refresh" });
    act(() => {
      ctx.getValue().clearHistoryInFlight("agent:agent-1:main");
    });
    await act(async () => {
      await pending;
    });

    expect(mockedHydrateDomainHistoryWindow).not.toHaveBeenCalled();
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it("aborts stale in-flight history when focused agent changes", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    let capturedSignal: AbortSignal | undefined;
    mockedLoadDomainAgentHistoryWindow.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<DomainAgentHistoryResult>((_, reject) => {
          capturedSignal = signal;
          if (!signal) {
            reject(new Error("signal missing"));
            return;
          }
          if (signal.aborted) {
            reject(abortError);
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              reject(abortError);
            },
            { once: true }
          );
        })
    );

    const ctx = renderController({
      status: "disconnected",
      agents: [createAgent({ historyLoadedAt: null })],
      focusedAgentId: "agent-1",
    });

    const pending = ctx.getValue().loadAgentHistory("agent-1", { reason: "refresh" });
    ctx.rerenderWith({
      focusedAgentId: "agent-2",
      agents: [
        createAgent({ agentId: "agent-1", historyLoadedAt: null }),
        createAgent({ agentId: "agent-2", sessionKey: "agent:agent-2:main", historyLoadedAt: null }),
      ],
    });
    await act(async () => {
      await pending;
    });

    expect(capturedSignal?.aborted).toBe(true);
    expect(mockedHydrateDomainHistoryWindow).not.toHaveBeenCalled();
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it("does not let stale finalized requests clear newer in-flight state for the same session", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const pending: Array<{ resolve: (value: DomainAgentHistoryResult) => void }> = [];
    mockedLoadDomainAgentHistoryWindow.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<DomainAgentHistoryResult>((resolve, reject) => {
          if (!signal) {
            reject(new Error("signal missing"));
            return;
          }
          if (signal.aborted) {
            reject(abortError);
            return;
          }
          pending.push({ resolve });
          signal.addEventListener(
            "abort",
            () => {
              reject(abortError);
            },
            { once: true }
          );
        })
    );

    const ctx = renderController({
      status: "disconnected",
      agents: [createAgent({ historyLoadedAt: null })],
      focusedAgentId: "agent-1",
    });

    const first = ctx.getValue().loadAgentHistory("agent-1", { reason: "refresh" });
    act(() => {
      ctx.getValue().clearHistoryInFlight("agent:agent-1:main");
    });
    const second = ctx.getValue().loadAgentHistory("agent-1", { reason: "refresh" });
    await act(async () => {
      await first;
    });

    await act(async () => {
      await ctx.getValue().loadAgentHistory("agent-1", { reason: "refresh" });
      await Promise.resolve();
    });

    expect(mockedLoadDomainAgentHistoryWindow).toHaveBeenCalledTimes(2);

    pending[1]?.resolve(createHistoryResult());
    await act(async () => {
      await second;
    });
  });
});
