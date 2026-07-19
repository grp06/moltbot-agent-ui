import { createElement, useEffect } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatInteractionController } from "@/features/agents/operations/useChatInteractionController";
import type { AgentState } from "@/features/agents/state/store";
import { sendChatMessageViaStudio } from "@/features/agents/operations/chatSendOperation";
import {
  createRuntimeWriteTransport,
  type RuntimeWriteTransport,
} from "@/features/agents/operations/runtimeWriteTransport";
import { postStudioIntent } from "@/lib/controlplane/intents-client";

vi.mock("@/features/agents/operations/chatSendOperation", () => ({
  sendChatMessageViaStudio: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/controlplane/intents-client", () => ({
  postStudioIntent: vi.fn(async () => ({ ok: true })),
}));

const createAgent = (overrides?: Partial<AgentState>): AgentState => {
  const base: AgentState = {
    agentId: "agent-1",
    name: "Agent One",
    sessionKey: "agent:agent-1:studio:test-session",
    status: "idle",
    sessionCreated: true,
    awaitingUserInput: false,
    hasUnseenActivity: false,
    outputLines: [],
    lastResult: null,
    lastDiff: null,
    runId: "run-1",
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
    queuedMessages: [],
    sessionSettingsSynced: true,
    historyLoadedAt: null,
    historyFetchLimit: null,
    historyFetchedCount: null,
    historyMaybeTruncated: false,
    toolCallingEnabled: true,
    showThinkingTraces: true,
    model: "openai/gpt-5",
    thinkingLevel: "medium",
    avatarSeed: "seed-1",
    avatarUrl: null,
  };
  const merged = { ...base, ...(overrides ?? {}) };
  return {
    ...merged,
    historyFetchLimit: merged.historyFetchLimit ?? null,
    historyFetchedCount: merged.historyFetchedCount ?? null,
    historyMaybeTruncated: merged.historyMaybeTruncated ?? false,
  };
};

type ControllerValue = ReturnType<typeof useChatInteractionController>;
type GatewayStatus = "disconnected" | "connecting" | "connected";
type InteractionDispatchAction =
  | { type: "updateAgent"; agentId: string; patch: Partial<AgentState> }
  | { type: "appendOutput"; agentId: string; line: string }
  | { type: "enqueueQueuedMessage"; agentId: string; message: string }
  | { type: "removeQueuedMessage"; agentId: string; index: number }
  | { type: "shiftQueuedMessage"; agentId: string; expectedMessage?: string };
type CallFn = (method: string, params: unknown) => Promise<unknown>;
type DispatchFn = (action: InteractionDispatchAction) => void;
type ErrorFn = (message: string) => void;
type RunTrackingFn = (runId?: string | null) => void;
type HistoryInFlightFn = (sessionKey: string) => void;
type AgentIdFn = (agentId: string) => void;
type VoidFn = () => void;

type RenderControllerContext = {
  getValue: () => ControllerValue;
  unmount: () => void;
  setAgents: (next: AgentState[]) => void;
  call: ReturnType<typeof vi.fn<CallFn>>;
  dispatch: ReturnType<typeof vi.fn<DispatchFn>>;
  setError: ReturnType<typeof vi.fn<ErrorFn>>;
  clearRunTracking: ReturnType<typeof vi.fn<RunTrackingFn>>;
  clearHistoryInFlight: ReturnType<typeof vi.fn<HistoryInFlightFn>>;
  clearSpecialUpdateMarker: ReturnType<typeof vi.fn<AgentIdFn>>;
  clearSpecialLatestUpdateInFlight: ReturnType<typeof vi.fn<AgentIdFn>>;
  setInspectSidebarNull: ReturnType<typeof vi.fn<VoidFn>>;
  setMobilePaneChat: ReturnType<typeof vi.fn<VoidFn>>;
};

const renderController = (
  overrides?: Partial<{
    status: GatewayStatus;
    agents: AgentState[];
    runtimeWriteTransport: RuntimeWriteTransport;
    call: CallFn;
    dispatch: DispatchFn;
    setError: ErrorFn;
    clearRunTracking: RunTrackingFn;
    clearHistoryInFlight: HistoryInFlightFn;
    clearSpecialUpdateMarker: AgentIdFn;
    clearSpecialLatestUpdateInFlight: AgentIdFn;
    setInspectSidebarNull: VoidFn;
    setMobilePaneChat: VoidFn;
  }>
): RenderControllerContext => {
  let agents = overrides?.agents ?? [createAgent()];
  const call = vi.fn<CallFn>(overrides?.call ?? (async () => ({})));
  const dispatch = vi.fn<DispatchFn>(overrides?.dispatch ?? (() => undefined));
  const setError = vi.fn<ErrorFn>(overrides?.setError ?? (() => undefined));
  const clearRunTracking = vi.fn<RunTrackingFn>(
    overrides?.clearRunTracking ?? (() => undefined)
  );
  const clearHistoryInFlight = vi.fn<HistoryInFlightFn>(
    overrides?.clearHistoryInFlight ?? (() => undefined)
  );
  const clearSpecialUpdateMarker = vi.fn<AgentIdFn>(
    overrides?.clearSpecialUpdateMarker ?? (() => undefined)
  );
  const clearSpecialLatestUpdateInFlight = vi.fn<AgentIdFn>(
    overrides?.clearSpecialLatestUpdateInFlight ?? (() => undefined)
  );
  const setInspectSidebarNull = vi.fn<VoidFn>(
    overrides?.setInspectSidebarNull ?? (() => undefined)
  );
  const setMobilePaneChat = vi.fn<VoidFn>(overrides?.setMobilePaneChat ?? (() => undefined));
  const runtimeWriteTransport =
    overrides?.runtimeWriteTransport ??
    createRuntimeWriteTransport({
      client: { call } as never,
      useDomainIntents: false,
      postIntent: postStudioIntent,
    });

  const valueRef: { current: ControllerValue | null } = { current: null };

  const Probe = ({
    onValue,
  }: {
    onValue: (value: ControllerValue) => void;
  }) => {
    const value = useChatInteractionController({
      client: {
        call,
      },
      status: overrides?.status ?? "connected",
      agents,
      dispatch,
      setError,
      getAgents: () => agents,
      clearRunTracking,
      clearHistoryInFlight,
      clearSpecialUpdateMarker,
      clearSpecialLatestUpdateInFlight,
      setInspectSidebarNull,
      setMobilePaneChat,
      runtimeWriteTransport,
    });
    useEffect(() => {
      onValue(value);
    }, [onValue, value]);
    return createElement("div", { "data-testid": "probe" }, "ok");
  };

  const rendered = render(
    createElement(Probe, {
      onValue: (value) => {
        valueRef.current = value;
      },
    })
  );

  return {
    getValue: () => {
      if (!valueRef.current) throw new Error("controller value unavailable");
      return valueRef.current;
    },
    unmount: () => {
      rendered.unmount();
    },
    setAgents: (next) => {
      agents = next;
      rendered.rerender(
        createElement(Probe, {
          onValue: (value) => {
            valueRef.current = value;
          },
        })
      );
    },
    call,
    dispatch,
    setError,
    clearRunTracking,
    clearHistoryInFlight,
    clearSpecialUpdateMarker,
    clearSpecialLatestUpdateInFlight,
    setInspectSidebarNull,
    setMobilePaneChat,
  };
};

describe("useChatInteractionController", () => {
  const mockedSendChatMessageViaStudio = vi.mocked(sendChatMessageViaStudio);
  const mockedPostStudioIntent = vi.mocked(postStudioIntent);
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCaf = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    vi.useFakeTimers();
    mockedSendChatMessageViaStudio.mockReset();
    mockedSendChatMessageViaStudio.mockResolvedValue({ ok: true });
    mockedPostStudioIntent.mockReset();
    mockedPostStudioIntent.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
    vi.restoreAllMocks();
    delete process.env.NEXT_PUBLIC_STUDIO_DOMAIN_API_MODE;
  });

  it("flushes pending draft and cancels debounce timer", async () => {
    const ctx = renderController();

    act(() => {
      ctx.getValue().handleDraftChange("agent-1", "first");
      ctx.getValue().handleDraftChange("agent-1", "second");
    });
    expect(ctx.dispatch).not.toHaveBeenCalled();

    act(() => {
      ctx.getValue().flushPendingDraft("agent-1");
    });

    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: "updateAgent",
      agentId: "agent-1",
      patch: { draft: "second" },
    });

    await vi.advanceTimersByTimeAsync(1000);
    const draftUpdates = ctx.dispatch.mock.calls
      .map(([action]: [InteractionDispatchAction]) => action)
      .filter(
        (action) =>
          action.type === "updateAgent" &&
          action.agentId === "agent-1" &&
          action.patch?.draft === "second"
      );
    expect(draftUpdates).toHaveLength(1);
  });

  it("clears pending draft timer/value and live patch before send", async () => {
    let queuedFrame: ((time: number) => void) | null = null;
    globalThis.requestAnimationFrame = vi.fn((callback: (time: number) => void) => {
      queuedFrame = callback;
      return 77;
    });
    globalThis.cancelAnimationFrame = vi.fn();

    const ctx = renderController();

    act(() => {
      ctx.getValue().handleDraftChange("agent-1", "queued draft");
      ctx.getValue().queueLivePatch("agent-1", { streamText: "pending stream" });
    });

    await act(async () => {
      await ctx.getValue().handleSend("agent-1", "session-1", "  hello world  ");
    });

    expect(mockedSendChatMessageViaStudio).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        sessionKey: "session-1",
        message: "hello world",
      })
    );
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalledWith(77);

    await vi.advanceTimersByTimeAsync(300);
    expect(
      ctx.dispatch.mock.calls.some(
        ([action]: [InteractionDispatchAction]) =>
          action.type === "updateAgent" &&
          action.agentId === "agent-1" &&
          action.patch?.draft === "queued draft"
      )
    ).toBe(false);

    if (queuedFrame) {
      act(() => {
        queuedFrame?.(0);
      });
    }
    expect(
      ctx.dispatch.mock.calls.some(
        ([action]: [InteractionDispatchAction]) =>
          action.type === "updateAgent" &&
          action.agentId === "agent-1" &&
          action.patch?.streamText === "pending stream"
      )
    ).toBe(false);
  });

  it("queues messages instead of sending while the agent is running", async () => {
    const ctx = renderController({
      agents: [createAgent({ status: "running", queuedMessages: [] })],
    });

    await act(async () => {
      await ctx.getValue().handleSend("agent-1", "session-1", "  follow up  ");
    });

    expect(mockedSendChatMessageViaStudio).not.toHaveBeenCalled();
    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: "enqueueQueuedMessage",
      agentId: "agent-1",
      message: "follow up",
    });
  });

  it("drains one queued message when an agent becomes idle", async () => {
    const ctx = renderController({
      agents: [createAgent({ status: "running", queuedMessages: ["next message"] })],
    });

    act(() => {
      ctx.setAgents([
        createAgent({
          status: "idle",
          sessionKey: "agent:agent-1:studio:drain",
          queuedMessages: ["next message"],
        }),
      ]);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: "shiftQueuedMessage",
      agentId: "agent-1",
      expectedMessage: "next message",
    });
    expect(mockedSendChatMessageViaStudio).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        sessionKey: "agent:agent-1:studio:drain",
        message: "next message",
      })
    );
  });

  it("retains queued message when deferred send fails", async () => {
    mockedSendChatMessageViaStudio.mockResolvedValueOnce({ ok: false });
    const ctx = renderController({
      agents: [createAgent({ status: "running", queuedMessages: ["next message"] })],
    });

    act(() => {
      ctx.setAgents([
        createAgent({
          status: "idle",
          sessionKey: "agent:agent-1:studio:drain",
          queuedMessages: ["next message"],
        }),
      ]);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedSendChatMessageViaStudio).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        sessionKey: "agent:agent-1:studio:drain",
        message: "next message",
      })
    );
    expect(
      ctx.dispatch.mock.calls.some(
        ([action]: [InteractionDispatchAction]) => action.type === "shiftQueuedMessage"
      )
    ).toBe(false);
  });

  it("does not drain queued messages while disconnected", async () => {
    const ctx = renderController({
      status: "disconnected",
      agents: [createAgent({ status: "idle", queuedMessages: ["keep queued"] })],
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedSendChatMessageViaStudio).not.toHaveBeenCalled();
    expect(
      ctx.dispatch.mock.calls.some(
        ([action]: [InteractionDispatchAction]) => action.type === "shiftQueuedMessage"
      )
    ).toBe(false);
  });

  it("removes a queued message by index", () => {
    const ctx = renderController({
      agents: [createAgent({ queuedMessages: ["first", "second"] })],
    });

    act(() => {
      ctx.getValue().removeQueuedMessage("agent-1", 0);
    });

    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: "removeQueuedMessage",
      agentId: "agent-1",
      index: 0,
    });
  });

  it("deduplicates stop-run while busy and clears busy state after success", async () => {
    let resolveAbort: ((value?: void | PromiseLike<void>) => void) | undefined;
    const abortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const call = vi.fn(async (method: string) => {
      if (method === "chat.abort") {
        await abortPromise;
        return {};
      }
      return {};
    });

    const ctx = renderController({ call });

    let firstCall: Promise<void> | null = null;
    act(() => {
      firstCall = ctx.getValue().handleStopRun("agent-1", " session-1 ");
    });
    expect(ctx.getValue().stopBusyAgentId).toBe("agent-1");

    await act(async () => {
      await ctx.getValue().handleStopRun("agent-1", "session-1");
    });
    expect(call).toHaveBeenCalledTimes(1);

    resolveAbort?.();
    await act(async () => {
      await firstCall;
    });
    expect(ctx.getValue().stopBusyAgentId).toBeNull();
  });

  it("reports stop-run failures and clears busy state", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = renderController({
      call: vi.fn(async (method: string) => {
        if (method === "chat.abort") {
          throw new Error("abort failed");
        }
        return {};
      }),
    });

    await act(async () => {
      await ctx.getValue().handleStopRun("agent-1", "session-1");
    });

    expect(ctx.setError).toHaveBeenCalledWith("abort failed");
    expect(logSpy).toHaveBeenCalledWith("abort failed");
    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: "appendOutput",
      agentId: "agent-1",
      line: "Stop failed: abort failed",
    });
    expect(ctx.getValue().stopBusyAgentId).toBeNull();
  });

  it("runs new-session side effects in sequence and updates agent state", async () => {
    const order: string[] = [];
    const call = vi.fn(async (method: string) => {
      if (method === "sessions.reset") {
        order.push("sessions.reset");
      }
      return {};
    });
    const dispatch = vi.fn<DispatchFn>((action) => {
      if (action.type === "updateAgent") {
        order.push("dispatch:updateAgent");
      }
    });
    const clearRunTracking = vi.fn(() => {
      order.push("clearRunTracking");
    });
    const clearHistoryInFlight = vi.fn(() => {
      order.push("clearHistoryInFlight");
    });
    const clearSpecialUpdateMarker = vi.fn(() => {
      order.push("clearSpecialUpdateMarker");
    });
    const clearSpecialLatestUpdateInFlight = vi.fn(() => {
      order.push("clearSpecialLatestUpdateInFlight");
    });
    const setInspectSidebarNull = vi.fn(() => {
      order.push("setInspectSidebarNull");
    });
    const setMobilePaneChat = vi.fn(() => {
      order.push("setMobilePaneChat");
    });

    const ctx = renderController({
      call,
      dispatch,
      clearRunTracking,
      clearHistoryInFlight,
      clearSpecialUpdateMarker,
      clearSpecialLatestUpdateInFlight,
      setInspectSidebarNull,
      setMobilePaneChat,
      agents: [
        createAgent({
          agentId: "agent-1",
          runId: "run-42",
          sessionKey: "  session-42  ",
        }),
      ],
    });

    await act(async () => {
      await ctx.getValue().handleNewSession("agent-1");
    });

    expect(call).toHaveBeenCalledWith("sessions.reset", { key: "session-42" });
    expect(order).toEqual([
      "sessions.reset",
      "clearRunTracking",
      "clearHistoryInFlight",
      "clearSpecialUpdateMarker",
      "clearSpecialLatestUpdateInFlight",
      "dispatch:updateAgent",
      "setInspectSidebarNull",
      "setMobilePaneChat",
    ]);
  });

  it("uses sessions-reset intent for new-session in domain mode", async () => {
    const call = vi.fn(async () => ({}));
    const ctx = renderController({
      call,
      runtimeWriteTransport: createRuntimeWriteTransport({
        client: { call } as never,
        useDomainIntents: true,
        postIntent: mockedPostStudioIntent,
      }),
      agents: [
        createAgent({
          agentId: "agent-1",
          runId: "run-42",
          sessionKey: "  session-42  ",
        }),
      ],
    });

    await act(async () => {
      await ctx.getValue().handleNewSession("agent-1");
    });

    expect(mockedPostStudioIntent).toHaveBeenCalledWith("/api/intents/sessions-reset", {
      key: "session-42",
    });
    expect(ctx.call).not.toHaveBeenCalledWith("sessions.reset", expect.anything());
  });

  it("discards pending draft and live patch when starting a new session", async () => {
    let queuedFrame: ((time: number) => void) | null = null;
    globalThis.requestAnimationFrame = vi.fn((callback: (time: number) => void) => {
      queuedFrame = callback;
      return 91;
    });
    globalThis.cancelAnimationFrame = vi.fn();
    const ctx = renderController({
      agents: [
        createAgent({
          agentId: "agent-1",
          runId: "run-42",
          sessionKey: "session-42",
        }),
      ],
    });

    act(() => {
      ctx.getValue().handleDraftChange("agent-1", "stale draft");
      ctx.getValue().queueLivePatch("agent-1", { streamText: "stale stream" });
    });

    await act(async () => {
      await ctx.getValue().handleNewSession("agent-1");
    });

    await vi.advanceTimersByTimeAsync(300);
    if (queuedFrame) {
      act(() => {
        queuedFrame?.(0);
      });
    }

    const stalePatches = ctx.dispatch.mock.calls
      .map(([action]: [InteractionDispatchAction]) => action)
      .filter(
        (action) =>
          action.type === "updateAgent" &&
          action.agentId === "agent-1" &&
          (action.patch?.draft === "stale draft" || action.patch?.streamText === "stale stream")
      );
    expect(stalePatches).toEqual([]);
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalledWith(91);
  });

  it("does not switch to domain intents when explicit mode flag is false", async () => {
    process.env.NEXT_PUBLIC_STUDIO_DOMAIN_API_MODE = "true";
    const call = vi.fn(async () => ({}));
    const ctx = renderController({
      call,
      runtimeWriteTransport: createRuntimeWriteTransport({
        client: { call } as never,
        useDomainIntents: false,
        postIntent: mockedPostStudioIntent,
      }),
      agents: [
        createAgent({
          agentId: "agent-1",
          runId: "run-42",
          sessionKey: "session-42",
        }),
      ],
    });

    await act(async () => {
      await ctx.getValue().handleNewSession("agent-1");
    });

    expect(ctx.call).toHaveBeenCalledWith("sessions.reset", { key: "session-42" });
    expect(mockedPostStudioIntent).not.toHaveBeenCalledWith(
      "/api/intents/sessions-reset",
      expect.anything()
    );
  });

  it("appends output when new-session fails", async () => {
    const ctx = renderController({
      agents: [
        createAgent({
          agentId: "agent-1",
          sessionKey: "  ",
        }),
      ],
    });

    await act(async () => {
      await ctx.getValue().handleNewSession("agent-1");
    });

    expect(ctx.setError).toHaveBeenCalledWith("Missing session key for agent.");
    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: "appendOutput",
      agentId: "agent-1",
      line: "New session failed: Missing session key for agent.",
    });
  });

  it("cleans up draft timers and queued frame on unmount", async () => {
    globalThis.requestAnimationFrame = vi.fn(() => 555);
    globalThis.cancelAnimationFrame = vi.fn();
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");

    const ctx = renderController();

    act(() => {
      ctx.getValue().handleDraftChange("agent-1", "queued");
      ctx.getValue().queueLivePatch("agent-1", { streamText: "delta" });
    });

    ctx.unmount();

    expect(globalThis.cancelAnimationFrame).toHaveBeenCalledWith(555);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(
      ctx.dispatch.mock.calls.some(
        ([action]: [InteractionDispatchAction]) =>
          action.type === "updateAgent" &&
          action.agentId === "agent-1" &&
          action.patch?.draft === "queued"
      )
    ).toBe(false);
  });
});
