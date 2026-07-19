import { describe, expect, it } from "vitest";

import {
  decideRuntimeAgentEvent,
  decideRuntimeChatEvent,
  decideSummaryRefreshEvent,
  type RuntimePolicyIntent,
} from "@/features/agents/state/runtimeEventPolicy";

const findIntent = <TKind extends RuntimePolicyIntent["kind"]>(
  intents: RuntimePolicyIntent[],
  kind: TKind
): Extract<RuntimePolicyIntent, { kind: TKind }> | undefined =>
  intents.find((intent) => intent.kind === kind) as
    | Extract<RuntimePolicyIntent, { kind: TKind }>
    | undefined;

describe("runtime event policy", () => {
  it("returns_noop_for_stale_chat_delta_run", () => {
    const intents = decideRuntimeChatEvent({
      agentId: "agent-1",
      state: "delta",
      runId: "run-stale",
      role: "assistant",
      activeRunId: "run-active",
      agentStatus: "running",
      now: 1000,
      agentRunStartedAt: 900,
      nextThinking: null,
      nextText: "hello",
      hasThinkingStarted: false,
      isClosedRun: false,
      isStaleTerminal: false,
      shouldRequestHistoryRefresh: false,
      shouldUpdateLastResult: false,
      shouldSetRunIdle: false,
      shouldSetRunError: false,
      lastResultText: null,
      assistantCompletionAt: null,
      shouldQueueLatestUpdate: false,
      latestUpdateMessage: null,
    });

    expect(intents).toEqual([{ kind: "clearRunTracking", runId: "run-stale" }]);
  });

  it("returns_live_patch_intent_for_assistant_delta", () => {
    const intents = decideRuntimeChatEvent({
      agentId: "agent-1",
      state: "delta",
      runId: "run-1",
      role: "assistant",
      activeRunId: "run-1",
      agentStatus: "running",
      now: 1000,
      agentRunStartedAt: null,
      nextThinking: "thinking",
      nextText: "answer",
      hasThinkingStarted: false,
      isClosedRun: false,
      isStaleTerminal: false,
      shouldRequestHistoryRefresh: false,
      shouldUpdateLastResult: false,
      shouldSetRunIdle: false,
      shouldSetRunError: false,
      lastResultText: null,
      assistantCompletionAt: null,
      shouldQueueLatestUpdate: false,
      latestUpdateMessage: null,
    });

    expect(findIntent(intents, "markThinkingStarted")).toEqual({
      kind: "markThinkingStarted",
      runId: "run-1",
      at: 1000,
    });
    expect(findIntent(intents, "queueLivePatch")).toEqual({
      kind: "queueLivePatch",
      agentId: "agent-1",
      patch: {
        thinkingTrace: "thinking",
        streamText: "answer",
        runId: "run-1",
        status: "running",
        runStartedAt: 1000,
      },
    });
  });

  it("returns_terminal_intents_for_chat_final_assistant", () => {
    const intents = decideRuntimeChatEvent({
      agentId: "agent-1",
      state: "final",
      runId: "run-1",
      role: "assistant",
      activeRunId: "run-1",
      agentStatus: "running",
      now: 2000,
      agentRunStartedAt: 900,
      nextThinking: null,
      nextText: "Done",
      hasThinkingStarted: true,
      isClosedRun: false,
      isStaleTerminal: false,
      shouldRequestHistoryRefresh: true,
      shouldUpdateLastResult: true,
      shouldSetRunIdle: true,
      shouldSetRunError: false,
      lastResultText: "Done",
      assistantCompletionAt: 1900,
      shouldQueueLatestUpdate: true,
      latestUpdateMessage: "hello",
    });

    expect(findIntent(intents, "clearPendingLivePatch")).toEqual({
      kind: "clearPendingLivePatch",
      agentId: "agent-1",
    });
    expect(findIntent(intents, "markRunClosed")).toEqual({
      kind: "markRunClosed",
      runId: "run-1",
    });
    expect(intents.some((intent) => intent.kind === "queueLatestUpdate")).toBe(true);
    const updates = intents.filter(
      (intent): intent is Extract<RuntimePolicyIntent, { kind: "dispatchUpdateAgent" }> =>
        intent.kind === "dispatchUpdateAgent"
    );
    expect(updates).toContainEqual({
      kind: "dispatchUpdateAgent",
      agentId: "agent-1",
      patch: { lastResult: "Done" },
    });
    expect(updates).toContainEqual({
      kind: "dispatchUpdateAgent",
      agentId: "agent-1",
      patch: {
        streamText: null,
        thinkingTrace: null,
        runStartedAt: null,
        lastAssistantMessageAt: 1900,
        status: "idle",
        runId: null,
      },
    });
  });

  it("returns_ignore_for_stale_terminal_chat_event", () => {
    const intents = decideRuntimeChatEvent({
      agentId: "agent-1",
      state: "final",
      runId: "run-1",
      role: "assistant",
      activeRunId: "run-1",
      agentStatus: "running",
      now: 2000,
      agentRunStartedAt: 900,
      nextThinking: null,
      nextText: "Done",
      hasThinkingStarted: true,
      isClosedRun: false,
      isStaleTerminal: true,
      shouldRequestHistoryRefresh: false,
      shouldUpdateLastResult: false,
      shouldSetRunIdle: true,
      shouldSetRunError: false,
      lastResultText: null,
      assistantCompletionAt: 1900,
      shouldQueueLatestUpdate: false,
      latestUpdateMessage: null,
    });

    expect(intents).toEqual([{ kind: "ignore", reason: "stale-terminal-event" }]);
  });

  it("returns_only_stale_run_cleanup_for_aborted_mismatched_run_when_agent_is_running", () => {
    const intents = decideRuntimeChatEvent({
      agentId: "agent-1",
      state: "aborted",
      runId: "run-old",
      role: "assistant",
      activeRunId: "run-active",
      agentStatus: "running",
      now: 2000,
      agentRunStartedAt: 900,
      nextThinking: null,
      nextText: null,
      hasThinkingStarted: true,
      isClosedRun: false,
      isStaleTerminal: false,
      shouldRequestHistoryRefresh: false,
      shouldUpdateLastResult: false,
      shouldSetRunIdle: true,
      shouldSetRunError: false,
      lastResultText: null,
      assistantCompletionAt: null,
      shouldQueueLatestUpdate: false,
      latestUpdateMessage: null,
    });

    expect(intents).toEqual([{ kind: "clearRunTracking", runId: "run-old" }]);
  });

  it("returns_agent_preflight_intents_for_closed_or_stale_runs", () => {
    const closed = decideRuntimeAgentEvent({
      runId: "run-1",
      stream: "assistant",
      phase: "",
      activeRunId: "run-1",
      agentStatus: "running",
      isClosedRun: true,
    });
    const stale = decideRuntimeAgentEvent({
      runId: "run-1",
      stream: "assistant",
      phase: "",
      activeRunId: "run-2",
      agentStatus: "running",
      isClosedRun: false,
    });

    expect(closed).toEqual([{ kind: "ignore", reason: "closed-run-event" }]);
    expect(stale).toEqual([{ kind: "clearRunTracking", runId: "run-1" }]);
  });

  it("guards lifecycle starts for closed and mismatched active runs", () => {
    const closedStart = decideRuntimeAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      phase: "start",
      activeRunId: "run-1",
      agentStatus: "running",
      isClosedRun: true,
    });
    const mismatchedStart = decideRuntimeAgentEvent({
      runId: "run-old",
      stream: "lifecycle",
      phase: "start",
      activeRunId: "run-new",
      agentStatus: "running",
      isClosedRun: false,
    });
    const idleStart = decideRuntimeAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      phase: "start",
      activeRunId: null,
      agentStatus: "idle",
      isClosedRun: false,
    });

    expect(closedStart).toEqual([{ kind: "ignore", reason: "closed-run-event" }]);
    expect(mismatchedStart).toEqual([{ kind: "clearRunTracking", runId: "run-old" }]);
    expect(idleStart).toEqual([]);
  });

  it("returns_no_summary_refresh_intent_for_presence_and_heartbeat", () => {
    const presence = decideSummaryRefreshEvent({
      event: "presence",
      status: "connected",
    });
    const heartbeat = decideSummaryRefreshEvent({
      event: "heartbeat",
      status: "connected",
    });
    const disconnected = decideSummaryRefreshEvent({
      event: "presence",
      status: "disconnected",
    });

    expect(presence).toEqual([]);
    expect(heartbeat).toEqual([]);
    expect(disconnected).toEqual([]);
  });
});
