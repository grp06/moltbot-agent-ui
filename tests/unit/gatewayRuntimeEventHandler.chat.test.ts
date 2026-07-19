import { describe, expect, it, vi } from "vitest";

import { createGatewayRuntimeEventHandler } from "@/features/agents/state/gatewayRuntimeEventHandler";
import {
  agentStoreReducer,
  initialAgentStoreState,
  type AgentState,
  type AgentStoreSeed,
} from "@/features/agents/state/store";
import * as transcriptState from "@/features/agents/state/transcript";
import type { EventFrame } from "@/lib/gateway/GatewayClient";

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

describe("gateway runtime event handler (chat)", () => {
  it("applies delta assistant chat stream via queueLivePatch", () => {
    const agents = [createAgent({ status: "running", runId: "run-1", runStartedAt: 900 })];
    const dispatch = vi.fn();
    const queueLivePatch = vi.fn();

    const handler = createGatewayRuntimeEventHandler({
      getAgents: () => agents,
      dispatch,
      queueLivePatch,
      clearPendingLivePatch: vi.fn(),
      now: () => 1000,
      requestHistoryRefresh: vi.fn(async () => {}),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
      logWarn: vi.fn(),
      updateSpecialLatestUpdate: vi.fn(),
    });

    const event: EventFrame = {
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: agents[0]!.sessionKey,
        state: "delta",
        message: { role: "assistant", content: "Hello" },
      },
    };

    handler.handleEvent(event);

    expect(queueLivePatch).toHaveBeenCalledTimes(1);
    expect(queueLivePatch).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        streamText: "Hello",
        status: "running",
      })
    );
  });

  it("ignores user/system roles for streaming output", () => {
    const agents = [createAgent({ status: "running", runId: "run-1", runStartedAt: 900 })];
    const queueLivePatch = vi.fn();
    const dispatch = vi.fn();

    const handler = createGatewayRuntimeEventHandler({
      getAgents: () => agents,
      dispatch,
      queueLivePatch,
      clearPendingLivePatch: vi.fn(),
      now: () => 1000,
      requestHistoryRefresh: vi.fn(async () => {}),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
      logWarn: vi.fn(),
      updateSpecialLatestUpdate: vi.fn(),
    });

    handler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: agents[0]!.sessionKey,
        state: "delta",
        message: { role: "user", content: "Hello" },
      },
    });

    expect(queueLivePatch).not.toHaveBeenCalled();
  });

  it("appends confirmed user turns during chat-final replay", () => {
    const agents = [createAgent({ status: "running", runId: "run-1", runStartedAt: 900 })];
    const queueLivePatch = vi.fn();
    const dispatched: Array<Record<string, unknown>> = [];
    const dispatch = vi.fn((action) => {
      dispatched.push(action as Record<string, unknown>);
    });

    const handler = createGatewayRuntimeEventHandler({
      getAgents: () => agents,
      dispatch,
      queueLivePatch,
      clearPendingLivePatch: vi.fn(),
      now: () => 1000,
      requestHistoryRefresh: vi.fn(async () => {}),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
      logWarn: vi.fn(),
      updateSpecialLatestUpdate: vi.fn(),
    });

    handler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: agents[0]!.sessionKey,
        state: "final",
        message: {
          role: "user",
          content: "Hello from history",
          timestamp: "2026-03-03T12:00:00.000Z",
        },
      },
    });

    expect(queueLivePatch).not.toHaveBeenCalled();
    expect(
      dispatched.some(
        (action) =>
          action.type === "appendOutput" &&
          action.line === "> Hello from history" &&
          (action.transcript as { entryId?: string; confirmed?: boolean } | undefined)?.entryId ===
            "run:run-1:user" &&
          (action.transcript as { confirmed?: boolean } | undefined)?.confirmed === true
      )
    ).toBe(true);
  });

  it("ignores stale delta chat events for non-active runIds", () => {
    const agents = [
      createAgent({
        status: "running",
        runId: "run-2",
        runStartedAt: 900,
      }),
    ];
    const queueLivePatch = vi.fn();
    const handler = createGatewayRuntimeEventHandler({
      getAgents: () => agents,
      dispatch: vi.fn(),
      queueLivePatch,
      clearPendingLivePatch: vi.fn(),
      now: () => 1000,
      requestHistoryRefresh: vi.fn(async () => {}),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
      logWarn: vi.fn(),
      updateSpecialLatestUpdate: vi.fn(),
    });

    handler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: agents[0]!.sessionKey,
        state: "delta",
        message: { role: "assistant", content: "stale text" },
      },
    });

    expect(queueLivePatch).not.toHaveBeenCalled();
  });

  it("applies final assistant chat by appending output and clearing stream fields", async () => {
    const agents = [
      createAgent({
        lastUserMessage: "hello",
        latestOverride: null,
        status: "running",
        runId: "run-1",
        runStartedAt: 900,
      }),
    ];
    const dispatched: Array<{ type: string; agentId: string; line?: string; patch?: unknown }> = [];
    const dispatch = vi.fn((action) => {
      dispatched.push(action as never);
    });
    const updateSpecialLatestUpdate = vi.fn();
    const clearPendingLivePatch = vi.fn();

    const handler = createGatewayRuntimeEventHandler({
      getAgents: () => agents,
      dispatch,
      queueLivePatch: vi.fn(),
      clearPendingLivePatch,
      now: () => 1000,
      requestHistoryRefresh: vi.fn(async () => {}),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
      logWarn: vi.fn(),
      updateSpecialLatestUpdate,
    });

    const ts = "2024-01-01T00:00:00.000Z";
    handler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: agents[0]!.sessionKey,
        state: "final",
        message: { role: "assistant", content: "Done", timestamp: ts, thinking: "t" },
      },
    });

    expect(dispatched.some((entry) => entry.type === "appendOutput" && entry.line === "Done")).toBe(
      true
    );
    expect(
      dispatched.some((entry) => {
        if (entry.type !== "updateAgent") return false;
        const patch = entry.patch as Record<string, unknown>;
        return patch.streamText === null && patch.thinkingTrace === null;
      })
    ).toBe(true);
    expect(
      dispatched.some((entry) => {
        if (entry.type !== "updateAgent") return false;
        const patch = entry.patch as Record<string, unknown>;
        return patch.status === "idle" && patch.runId === null;
      })
    ).toBe(true);
    expect(
      dispatched.some((entry) => {
        if (entry.type !== "updateAgent") return false;
        const patch = entry.patch as Record<string, unknown>;
        return patch.lastAssistantMessageAt === Date.parse(ts);
      })
    ).toBe(true);

    expect(updateSpecialLatestUpdate).toHaveBeenCalledTimes(1);
    expect(updateSpecialLatestUpdate).toHaveBeenCalledWith("agent-1", agents[0], "hello");
    expect(clearPendingLivePatch).toHaveBeenCalledWith("agent-1");
  });

  it("uses the current chat agent snapshot for latest-update effects", () => {
    const agents = [
      createAgent({
        lastUserMessage: "hello",
        latestOverride: null,
        status: "running",
        runId: "run-1",
        runStartedAt: 900,
      }),
    ];
    let getAgentsCalls = 0;
    const getAgents = () => {
      getAgentsCalls += 1;
      return getAgentsCalls === 1 ? agents : [];
    };
    const updateSpecialLatestUpdate = vi.fn();

    const handler = createGatewayRuntimeEventHandler({
      getAgents,
      dispatch: vi.fn(),
      queueLivePatch: vi.fn(),
      clearPendingLivePatch: vi.fn(),
      now: () => 1000,
      requestHistoryRefresh: vi.fn(async () => {}),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
      logWarn: vi.fn(),
      updateSpecialLatestUpdate,
    });

    handler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: agents[0]!.sessionKey,
        state: "final",
        message: { role: "assistant", content: "Done", timestamp: "2024-01-01T00:00:00.000Z" },
      },
    });

    expect(updateSpecialLatestUpdate).toHaveBeenCalledTimes(1);
    expect(updateSpecialLatestUpdate).toHaveBeenCalledWith("agent-1", agents[0], "hello");
  });

  it("normalizes markdown-rich final assistant chat text before append and lastResult update", () => {
    const agents = [createAgent({ status: "running", runId: "run-1", runStartedAt: 900 })];
    const dispatched: Array<{ type: string; line?: string; patch?: unknown }> = [];
    const normalizedAssistantText = ["- item one", "- item two", "", "```ts", "const n = 1;", "```"].join(
      "\n"
    );
    const handler = createGatewayRuntimeEventHandler({
      getAgents: () => agents,
      dispatch: vi.fn((action) => {
        dispatched.push(action as never);
      }),
      queueLivePatch: vi.fn(),
      clearPendingLivePatch: vi.fn(),
      now: () => 1000,
      requestHistoryRefresh: vi.fn(async () => {}),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
      logWarn: vi.fn(),
      updateSpecialLatestUpdate: vi.fn(),
    });

    handler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: agents[0]!.sessionKey,
        state: "final",
        message: {
          role: "assistant",
          content: "\n- item one  \r\n- item two\t \r\n\r\n\r\n```ts  \r\nconst n = 1;\t\r\n```\r\n\r\n",
        },
      },
    });

    expect(
      dispatched.some(
        (entry) => entry.type === "appendOutput" && entry.line === normalizedAssistantText
      )
    ).toBe(true);
    expect(
      dispatched.some((entry) => {
        if (entry.type !== "updateAgent") return false;
        const patch = entry.patch as Record<string, unknown>;
        return patch.lastResult === normalizedAssistantText;
      })
    ).toBe(true);
  });

  it("does not request history refresh when final assistant arrives without trace lines", () => {
    vi.useFakeTimers();
    try {
      const agents = [createAgent({ outputLines: [] })];
      const requestHistoryRefresh = vi.fn(async () => {});
      const handler = createGatewayRuntimeEventHandler({
        getAgents: () => agents,
        dispatch: vi.fn(),
        queueLivePatch: vi.fn(),
        clearPendingLivePatch: vi.fn(),
        now: () => 1000,
        requestHistoryRefresh,
        setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
        clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
        logWarn: vi.fn(),
        updateSpecialLatestUpdate: vi.fn(),
      });

      handler.handleEvent({
        type: "event",
        event: "chat",
        payload: {
          runId: "run-1",
          sessionKey: agents[0]!.sessionKey,
          state: "final",
          message: { role: "assistant", content: "Done" },
        },
      });

      expect(requestHistoryRefresh).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(requestHistoryRefresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces committed lifecycle fallback with canonical chat final in reducer state", () => {
    vi.useFakeTimers();
    const metricSpy = vi
      .spyOn(transcriptState, "logTranscriptDebugMetric")
      .mockImplementation(() => {});
    try {
      const agents = [
        createAgent({
          status: "running",
          runId: "run-1",
          runStartedAt: 900,
          streamText: "fallback final",
        }),
      ];
      const dispatched: Array<Record<string, unknown>> = [];
      const dispatch = vi.fn((action) => {
        dispatched.push(action as never);
      });
      const handler = createGatewayRuntimeEventHandler({
        getAgents: () => agents,
        dispatch,
        queueLivePatch: vi.fn(),
        clearPendingLivePatch: vi.fn(),
        now: () => 1000,
        requestHistoryRefresh: vi.fn(async () => {}),
        setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
        clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
        logWarn: vi.fn(),
        updateSpecialLatestUpdate: vi.fn(),
      });

      handler.handleEvent({
        type: "event",
        event: "agent",
        payload: {
          runId: "run-1",
          sessionKey: agents[0]!.sessionKey,
          stream: "lifecycle",
          data: { phase: "end" },
        },
      } as EventFrame);
      vi.advanceTimersByTime(400);

      expect(
        dispatched.some(
          (entry) =>
            entry.type === "appendOutput" &&
            entry.line === "fallback final" &&
            typeof entry.transcript === "object"
        )
      ).toBe(true);

      const event: EventFrame = {
        type: "event",
        event: "chat",
        payload: {
          runId: "run-1",
          sessionKey: agents[0]!.sessionKey,
          state: "final",
          message: { role: "assistant", content: "canonical final" },
        },
      };
      handler.handleEvent(event);

      const seed: AgentStoreSeed = {
        agentId: "agent-1",
        name: "Agent One",
        sessionKey: agents[0]!.sessionKey,
      };
      let state = agentStoreReducer(initialAgentStoreState, {
        type: "hydrateAgents",
        agents: [seed],
      });
      state = agentStoreReducer(state, {
        type: "updateAgent",
        agentId: "agent-1",
        patch: {
          status: "running",
          runId: "run-1",
          runStartedAt: 900,
          streamText: "fallback final",
        },
      });
      for (const action of dispatched) {
        if (!action || typeof action !== "object") continue;
        if (typeof (action as { type?: unknown }).type !== "string") continue;
        state = agentStoreReducer(state, action as never);
      }
      const agentState = state.agents.find((entry) => entry.agentId === "agent-1");
      const transcriptEntries = agentState?.transcriptEntries ?? [];
      const assistantEntries = transcriptEntries.filter((entry) => entry.kind === "assistant");
      const assistantMetaEntries = transcriptEntries.filter(
        (entry) => entry.kind === "meta" && entry.role === "assistant"
      );

      expect(assistantEntries).toHaveLength(1);
      expect(assistantEntries[0]?.text).toBe("canonical final");
      expect(assistantMetaEntries).toHaveLength(1);
      expect(metricSpy).toHaveBeenCalledWith(
        "lifecycle_fallback_replaced_by_chat_final",
        expect.objectContaining({ runId: "run-1" })
      );
    } finally {
      metricSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("ignores terminal chat events with same-or-lower payload sequence for a run", () => {
    const metricSpy = vi
      .spyOn(transcriptState, "logTranscriptDebugMetric")
      .mockImplementation(() => {});
    try {
      const agents = [createAgent({ status: "running", runId: "run-1", runStartedAt: 900 })];
      const dispatched: Array<Record<string, unknown>> = [];
      const dispatch = vi.fn((action) => {
        dispatched.push(action as never);
      });
      const handler = createGatewayRuntimeEventHandler({
        getAgents: () => agents,
        dispatch,
        queueLivePatch: vi.fn(),
        clearPendingLivePatch: vi.fn(),
        now: () => 1000,
        requestHistoryRefresh: vi.fn(async () => {}),
        setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
        clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
        logWarn: vi.fn(),
        updateSpecialLatestUpdate: vi.fn(),
      });

      handler.handleEvent({
        type: "event",
        event: "chat",
        payload: {
          runId: "run-1",
          seq: 4,
          sessionKey: agents[0]!.sessionKey,
          state: "final",
          message: { role: "assistant", content: "final seq 4" },
        },
      });
      handler.handleEvent({
        type: "event",
        event: "chat",
        payload: {
          runId: "run-1",
          seq: 4,
          sessionKey: agents[0]!.sessionKey,
          state: "final",
          message: { role: "assistant", content: "final seq 4 replay" },
        },
      });
      handler.handleEvent({
        type: "event",
        event: "chat",
        payload: {
          runId: "run-1",
          seq: 3,
          sessionKey: agents[0]!.sessionKey,
          state: "final",
          message: { role: "assistant", content: "final seq 3 stale" },
        },
      });

      const seed: AgentStoreSeed = {
        agentId: "agent-1",
        name: "Agent One",
        sessionKey: agents[0]!.sessionKey,
      };
      let state = agentStoreReducer(initialAgentStoreState, {
        type: "hydrateAgents",
        agents: [seed],
      });
      state = agentStoreReducer(state, {
        type: "updateAgent",
        agentId: "agent-1",
        patch: {
          status: "running",
          runId: "run-1",
          runStartedAt: 900,
        },
      });
      for (const action of dispatched) {
        if (!action || typeof action !== "object") continue;
        if (typeof (action as { type?: unknown }).type !== "string") continue;
        state = agentStoreReducer(state, action as never);
      }
      const agentState = state.agents.find((entry) => entry.agentId === "agent-1");
      const assistantEntries = (agentState?.transcriptEntries ?? []).filter(
        (entry) => entry.kind === "assistant"
      );

      expect(assistantEntries).toHaveLength(1);
      expect(assistantEntries[0]?.text).toBe("final seq 4");
      const staleCalls = metricSpy.mock.calls.filter(
        (call) => call[0] === "stale_terminal_chat_event_ignored"
      );
      expect(staleCalls).toHaveLength(2);
      expect(staleCalls[0]?.[1]).toEqual(
        expect.objectContaining({
          runId: "run-1",
          seq: 4,
          lastTerminalSeq: 4,
          commitSource: "chat-final",
        })
      );
      expect(staleCalls[1]?.[1]).toEqual(
        expect.objectContaining({
          runId: "run-1",
          seq: 3,
          lastTerminalSeq: 4,
          commitSource: "chat-final",
        })
      );
    } finally {
      metricSpy.mockRestore();
    }
  });

  it("accepts higher-sequence terminal chat events and keeps newest final text", () => {
    const agents = [createAgent({ status: "running", runId: "run-1", runStartedAt: 900 })];
    const dispatched: Array<Record<string, unknown>> = [];
    const dispatch = vi.fn((action) => {
      dispatched.push(action as never);
    });
    const handler = createGatewayRuntimeEventHandler({
      getAgents: () => agents,
      dispatch,
      queueLivePatch: vi.fn(),
      clearPendingLivePatch: vi.fn(),
      now: () => 1000,
      requestHistoryRefresh: vi.fn(async () => {}),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
      logWarn: vi.fn(),
      updateSpecialLatestUpdate: vi.fn(),
    });

    handler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        seq: 2,
        sessionKey: agents[0]!.sessionKey,
        state: "final",
        message: { role: "assistant", content: "final seq 2" },
      },
    });
    handler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        seq: 3,
        sessionKey: agents[0]!.sessionKey,
        state: "final",
        message: { role: "assistant", content: "final seq 3" },
      },
    });

    const seed: AgentStoreSeed = {
      agentId: "agent-1",
      name: "Agent One",
      sessionKey: agents[0]!.sessionKey,
    };
    let state = agentStoreReducer(initialAgentStoreState, {
      type: "hydrateAgents",
      agents: [seed],
    });
    state = agentStoreReducer(state, {
      type: "updateAgent",
      agentId: "agent-1",
      patch: {
        status: "running",
        runId: "run-1",
        runStartedAt: 900,
      },
    });
    for (const action of dispatched) {
      if (!action || typeof action !== "object") continue;
      if (typeof (action as { type?: unknown }).type !== "string") continue;
      state = agentStoreReducer(state, action as never);
    }
    const agentState = state.agents.find((entry) => entry.agentId === "agent-1");
    const assistantEntries = (agentState?.transcriptEntries ?? []).filter(
      (entry) => entry.kind === "assistant"
    );

    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0]?.text).toBe("final seq 3");
  });

  it("ignores terminal chat events for non-active runIds", () => {
    const agents = [
      createAgent({
        status: "running",
        runId: "run-2",
        runStartedAt: 900,
        streamText: "still streaming",
        thinkingTrace: "t",
      }),
    ];
    const dispatched: Array<{ type: string; agentId: string; patch?: unknown }> = [];
    const dispatch = vi.fn((action) => {
      if (action && typeof action === "object") {
        dispatched.push(action as never);
      }
    });
    const requestHistoryRefresh = vi.fn(async () => {});
    const handler = createGatewayRuntimeEventHandler({
      getAgents: () => agents,
      dispatch,
      queueLivePatch: vi.fn(),
      clearPendingLivePatch: vi.fn(),
      now: () => 1000,
      requestHistoryRefresh,
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
      logWarn: vi.fn(),
      updateSpecialLatestUpdate: vi.fn(),
    });

    handler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: agents[0]!.sessionKey,
        state: "final",
        message: { role: "assistant", content: "old done" },
      },
    });

    const terminalClears = dispatched.filter((entry) => {
      if (entry.type !== "updateAgent") return false;
      const patch = entry.patch as Record<string, unknown>;
      return patch.streamText === null || patch.thinkingTrace === null || patch.runStartedAt === null;
    });
    expect(terminalClears.length).toBe(0);
    expect(requestHistoryRefresh).not.toHaveBeenCalled();
  });

  it("ignores stale aborted terminal events for non-active runIds", () => {
    const agents = [
      createAgent({
        status: "running",
        runId: "run-active",
        runStartedAt: 900,
        streamText: "still streaming",
        thinkingTrace: "t",
      }),
    ];
    const dispatch = vi.fn();
    const queueLivePatch = vi.fn();
    const handler = createGatewayRuntimeEventHandler({
      getAgents: () => agents,
      dispatch,
      queueLivePatch,
      clearPendingLivePatch: vi.fn(),
      now: () => 1000,
      requestHistoryRefresh: vi.fn(async () => {}),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
      logWarn: vi.fn(),
      updateSpecialLatestUpdate: vi.fn(),
    });

    handler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-old",
        sessionKey: agents[0]!.sessionKey,
        state: "aborted",
        message: { role: "assistant", content: "" },
      },
    });

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "appendOutput", agentId: "agent-1", line: "Run aborted." })
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "updateAgent",
        agentId: "agent-1",
        patch: expect.objectContaining({ status: "idle", runId: null }),
      })
    );

    handler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-active",
        sessionKey: agents[0]!.sessionKey,
        state: "delta",
        message: { role: "assistant", content: "still active" },
      },
    });

    expect(queueLivePatch).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        runId: "run-active",
        streamText: "still active",
        status: "running",
      })
    );
  });

  it("handles aborted/error by appending output and clearing stream fields", () => {
    const agents = [createAgent({ status: "running", runId: "run-1", runStartedAt: 900 })];
    const dispatch = vi.fn();
    const handler = createGatewayRuntimeEventHandler({
      getAgents: () => agents,
      dispatch,
      queueLivePatch: vi.fn(),
      clearPendingLivePatch: vi.fn(),
      now: () => 1000,
      requestHistoryRefresh: vi.fn(async () => {}),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
      logWarn: vi.fn(),
      updateSpecialLatestUpdate: vi.fn(),
    });

    handler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: agents[0]!.sessionKey,
        state: "aborted",
        message: { role: "assistant", content: "" },
      },
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "appendOutput", agentId: "agent-1", line: "Run aborted." })
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "updateAgent",
        agentId: "agent-1",
        patch: expect.objectContaining({ status: "idle" }),
      })
    );

    const errorDispatch = vi.fn();
    const errorHandler = createGatewayRuntimeEventHandler({
      getAgents: () => agents,
      dispatch: errorDispatch,
      queueLivePatch: vi.fn(),
      clearPendingLivePatch: vi.fn(),
      now: () => 1000,
      requestHistoryRefresh: vi.fn(async () => {}),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
      logWarn: vi.fn(),
      updateSpecialLatestUpdate: vi.fn(),
    });

    errorHandler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: agents[0]!.sessionKey,
        state: "error",
        errorMessage: "bad",
        message: { role: "assistant", content: "" },
      },
    });

    expect(errorDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "appendOutput", agentId: "agent-1", line: "Error: bad" })
    );
    expect(errorDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "updateAgent",
        agentId: "agent-1",
        patch: expect.objectContaining({ status: "error" }),
      })
    );
  });

  it("suppresses aborted status line when abort is an approval pause", () => {
    const agents = [createAgent({ status: "running", runId: "run-1", runStartedAt: 900 })];
    const dispatch = vi.fn();
    const shouldSuppressRunAbortedLine = vi.fn(({ runId, stopReason }) => {
      return runId === "run-1" && stopReason === "rpc";
    });
    const handler = createGatewayRuntimeEventHandler({
      getAgents: () => agents,
      dispatch,
      queueLivePatch: vi.fn(),
      clearPendingLivePatch: vi.fn(),
      now: () => 1000,
      requestHistoryRefresh: vi.fn(async () => {}),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
      logWarn: vi.fn(),
      shouldSuppressRunAbortedLine,
      updateSpecialLatestUpdate: vi.fn(),
    });

    handler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: agents[0]!.sessionKey,
        state: "aborted",
        stopReason: "rpc",
        message: { role: "assistant", content: "" },
      },
    });

    expect(shouldSuppressRunAbortedLine).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        runId: "run-1",
        stopReason: "rpc",
      })
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "appendOutput", agentId: "agent-1", line: "Run aborted." })
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "updateAgent",
        agentId: "agent-1",
        patch: expect.objectContaining({ status: "idle" }),
      })
    );
  });

  it("ignores late delta chat events after a run has already finalized", () => {
    const agents = [createAgent({ status: "running", runId: "run-1", runStartedAt: 900 })];
    const queueLivePatch = vi.fn();
    const handler = createGatewayRuntimeEventHandler({
      getAgents: () => agents,
      dispatch: vi.fn(),
      queueLivePatch,
      clearPendingLivePatch: vi.fn(),
      now: () => 1000,
      requestHistoryRefresh: vi.fn(async () => {}),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id as unknown as NodeJS.Timeout),
      logWarn: vi.fn(),
      updateSpecialLatestUpdate: vi.fn(),
    });

    handler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: agents[0]!.sessionKey,
        state: "final",
        message: { role: "assistant", content: "done" },
      },
    });

    queueLivePatch.mockClear();

    handler.handleEvent({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: agents[0]!.sessionKey,
        state: "delta",
        message: { role: "assistant", content: "late text" },
      },
    });

    expect(queueLivePatch).not.toHaveBeenCalled();
  });
});
