import { describe, expect, it } from "vitest";

import type { AgentState } from "@/features/agents/state/store";
import {
  planRuntimeChatEvent,
  type RuntimeChatWorkflowCommand,
  type RuntimeChatWorkflowInput,
} from "@/features/agents/state/runtimeChatEventWorkflow";
import type { RuntimePolicyIntent } from "@/features/agents/state/runtimeEventPolicy";
import type { ChatEventPayload } from "@/features/agents/state/runtimeEventBridge";
import {
  applyTerminalCommit,
  createRuntimeTerminalState,
  type RuntimeTerminalState,
} from "@/features/agents/state/runtimeTerminalWorkflow";

type InputOverrides = Partial<Omit<RuntimeChatWorkflowInput, "payload" | "agent">> & {
  payload?: ChatEventPayload;
  agent?: AgentState | undefined;
};

const createAgent = (overrides?: Partial<AgentState>): AgentState => {
  const base: AgentState = {
    agentId: "agent-1",
    name: "Agent One",
    sessionKey: "agent:agent-1:studio:test-session",
    status: "running",
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
  return {
    ...base,
    ...(overrides ?? {}),
  };
};

const createPayload = (overrides?: Partial<ChatEventPayload>): ChatEventPayload => ({
  runId: "run-1",
  sessionKey: "agent:agent-1:studio:test-session",
  state: "delta",
  message: { role: "assistant", content: "Hello" },
  ...(overrides ?? {}),
});

const createInput = (overrides?: InputOverrides): RuntimeChatWorkflowInput => ({
  payload: overrides?.payload ?? createPayload(),
  agentId: "agent-1",
  agent: overrides?.agent ?? createAgent(),
  activeRunId: "run-1",
  runtimeTerminalState:
    overrides?.runtimeTerminalState ?? (createRuntimeTerminalState() as RuntimeTerminalState),
  role: "assistant",
  nowMs: 1000,
  nextTextRaw: "Hello",
  nextText: "Hello",
  nextThinking: null,
  toolLines: [],
  isToolRole: false,
  assistantCompletionAt: null,
  finalAssistantText: null,
  hasThinkingStarted: false,
  hasTraceInOutput: false,
  isThinkingDebugSessionSeen: false,
  thinkingStartedAtMs: null,
  ...(overrides ?? {}),
});

const findCommand = <TKind extends RuntimeChatWorkflowCommand["kind"]>(
  commands: RuntimeChatWorkflowCommand[],
  kind: TKind
): Extract<RuntimeChatWorkflowCommand, { kind: TKind }> | undefined =>
  commands.find((command) => command.kind === kind) as
    | Extract<RuntimeChatWorkflowCommand, { kind: TKind }>
    | undefined;

const findIntent = <TKind extends RuntimePolicyIntent["kind"]>(
  intents: RuntimePolicyIntent[],
  kind: TKind
): Extract<RuntimePolicyIntent, { kind: TKind }> | undefined =>
  intents.find((intent) => intent.kind === kind) as
    | Extract<RuntimePolicyIntent, { kind: TKind }>
    | undefined;

describe("runtime chat event workflow", () => {
  it("ignores delta events that begin with UI metadata", () => {
    const result = planRuntimeChatEvent(
      createInput({
        nextTextRaw: "Project path: /tmp/work",
        nextText: "Project path: /tmp/work",
      })
    );

    expect(result.commands).toEqual([]);
  });

  it("plans delta intents and tool append commands", () => {
    const result = planRuntimeChatEvent(
      createInput({
        nextThinking: "think",
        toolLines: ["[[tool]] call"],
      })
    );

    const policy = findCommand(result.commands, "applyPolicyIntents");
    expect(policy).toBeDefined();
    expect(findIntent(policy?.intents ?? [], "markThinkingStarted")).toEqual({
      kind: "markThinkingStarted",
      runId: "run-1",
      at: 1000,
    });
    expect(findIntent(policy?.intents ?? [], "queueLivePatch")).toEqual({
      kind: "queueLivePatch",
      agentId: "agent-1",
      patch: {
        thinkingTrace: "think",
        streamText: "Hello",
        status: "running",
        runId: "run-1",
        runStartedAt: 1000,
      },
    });

    expect(findCommand(result.commands, "appendToolLines")).toEqual({
      kind: "appendToolLines",
      lines: ["[[tool]] call"],
      timestampMs: 1000,
    });
  });

  it("plans final assistant completion with fallback replacement metrics", () => {
    const runtimeTerminalState = applyTerminalCommit(createRuntimeTerminalState(), {
      runId: "run-1",
      source: "lifecycle-fallback",
      seq: null,
    });

    const result = planRuntimeChatEvent(
      createInput({
        payload: createPayload({ state: "final", seq: 7 }),
        runtimeTerminalState,
        nowMs: 2200,
        nextTextRaw: "Done",
        nextText: "Done",
        nextThinking: "first\nsecond",
        assistantCompletionAt: 2100,
        finalAssistantText: "Done",
        hasThinkingStarted: true,
        thinkingStartedAtMs: 2000,
      })
    );

    const terminalDecision = findCommand(result.commands, "applyChatTerminalDecision");
    expect(terminalDecision?.decision.fallbackCommittedBeforeFinal).toBe(true);

    expect(
      result.commands.some(
        (command) =>
          command.kind === "logMetric" &&
          command.metric === "lifecycle_fallback_replaced_by_chat_final"
      )
    ).toBe(true);

    expect(
      result.commands.some(
        (command) =>
          command.kind === "appendOutput" &&
          command.transcript.kind === "meta" &&
          command.transcript.timestampMs === 2100 &&
          command.line.startsWith("[[meta]]")
      )
    ).toBe(true);

    expect(
      result.commands.some(
        (command) =>
          command.kind === "appendOutput" &&
          command.transcript.kind === "thinking" &&
          command.line.startsWith("[[trace]]")
      )
    ).toBe(true);

    expect(
      result.commands.some(
        (command) =>
          command.kind === "appendOutput" &&
          command.transcript.kind === "assistant" &&
          command.line === "Done"
      )
    ).toBe(true);

    expect(findCommand(result.commands, "applyTerminalCommit")).toEqual({
      kind: "applyTerminalCommit",
      runId: "run-1",
      seq: 7,
    });

    const policy = findCommand(result.commands, "applyPolicyIntents");
    expect(policy).toBeDefined();
    expect(findIntent(policy?.intents ?? [], "clearPendingLivePatch")).toEqual({
      kind: "clearPendingLivePatch",
      agentId: "agent-1",
    });
    expect(findIntent(policy?.intents ?? [], "markRunClosed")).toEqual({
      kind: "markRunClosed",
      runId: "run-1",
    });
  });

  it("returns only stale-terminal diagnostics for stale final events", () => {
    const runtimeTerminalState = applyTerminalCommit(createRuntimeTerminalState(), {
      runId: "run-1",
      source: "chat-final",
      seq: 4,
    });

    const result = planRuntimeChatEvent(
      createInput({
        payload: createPayload({ state: "final", seq: 4 }),
        runtimeTerminalState,
        nextTextRaw: "Done",
        nextText: "Done",
        assistantCompletionAt: 2000,
        finalAssistantText: "Done",
      })
    );

    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]).toMatchObject({ kind: "applyChatTerminalDecision" });
    expect(result.commands[1]).toMatchObject({
      kind: "logMetric",
      metric: "stale_terminal_chat_event_ignored",
    });
  });

  it("plans missing-thinking diagnostics without forcing history refresh", () => {
    const result = planRuntimeChatEvent(
      createInput({
        payload: createPayload({ state: "final", seq: 1 }),
        nextTextRaw: "Done",
        nextText: "Done",
        nextThinking: null,
        assistantCompletionAt: 2000,
        finalAssistantText: "Done",
      })
    );

    expect(findCommand(result.commands, "markThinkingDebugSession")).toEqual({
      kind: "markThinkingDebugSession",
      sessionKey: "agent:agent-1:studio:test-session",
    });

    const warn = findCommand(result.commands, "logWarn");
    expect(warn).toBeDefined();
    expect(warn?.message).toBe("No thinking trace extracted from chat event.");

    const policy = findCommand(result.commands, "applyPolicyIntents");
    expect(policy).toBeDefined();
    expect((policy?.intents ?? []).some((intent) => intent.kind === "queueLatestUpdate")).toBe(
      false
    );
  });

  it("does not queue latest-update refreshes for tool final events", () => {
    const result = planRuntimeChatEvent(
      createInput({
        payload: createPayload({
          state: "final",
          message: { role: "tool", content: "tool output" },
        }),
        agent: createAgent({ lastUserMessage: "heartbeat?", latestOverride: null }),
        role: "tool",
        isToolRole: true,
        nextTextRaw: "tool output",
        nextText: "tool output",
        finalAssistantText: null,
      })
    );

    const policy = findCommand(result.commands, "applyPolicyIntents");
    expect(policy).toBeDefined();
    expect((policy?.intents ?? []).some((intent) => intent.kind === "queueLatestUpdate")).toBe(
      false
    );
  });

  it("plans aborted output command and policy intents", () => {
    const result = planRuntimeChatEvent(
      createInput({
        payload: createPayload({ state: "aborted" }),
      })
    );

    expect(result.commands).toEqual([
      { kind: "appendAbortedIfNotSuppressed", timestampMs: 1000 },
      expect.objectContaining({ kind: "applyPolicyIntents" }),
    ]);
  });

  it("plans error output with error-state policy intents", () => {
    const result = planRuntimeChatEvent(
      createInput({
        payload: createPayload({ state: "error", errorMessage: "boom" }),
      })
    );

    expect(result.commands[0]).toEqual(
      expect.objectContaining({
        kind: "appendOutput",
        line: "Error: boom",
      })
    );
    const policy = findCommand(result.commands, "applyPolicyIntents");
    expect(policy).toBeDefined();
    expect(
      (policy?.intents ?? []).some(
        (intent) =>
          intent.kind === "dispatchUpdateAgent" &&
          intent.patch.status === "error" &&
          intent.patch.runId === null
      )
    ).toBe(true);
  });
});
