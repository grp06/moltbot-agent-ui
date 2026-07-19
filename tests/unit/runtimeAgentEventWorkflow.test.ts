import { describe, expect, it } from "vitest";

import type { AgentState } from "@/features/agents/state/store";
import {
  planRuntimeAgentEvent,
  type RuntimeAgentWorkflowCommand,
  type RuntimeAgentWorkflowInput,
} from "@/features/agents/state/runtimeAgentEventWorkflow";
import type { RuntimePolicyIntent } from "@/features/agents/state/runtimeEventPolicy";
import type { AgentEventPayload } from "@/features/agents/state/runtimeEventBridge";
import {
  createRuntimeTerminalState,
  markClosedRun,
  type RuntimeTerminalCommand,
  type RuntimeTerminalState,
} from "@/features/agents/state/runtimeTerminalWorkflow";

type InputOverrides = Partial<Omit<RuntimeAgentWorkflowInput, "payload" | "agent">> & {
  payload?: AgentEventPayload;
  agent?: AgentState;
};

const createAgent = (overrides?: Partial<AgentState>): AgentState => ({
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
  ...(overrides ?? {}),
});

const createPayload = (overrides?: Partial<AgentEventPayload>): AgentEventPayload => ({
  runId: "run-1",
  sessionKey: "agent:agent-1:studio:test-session",
  stream: "assistant",
  data: { delta: "hello" },
  ...(overrides ?? {}),
});

const createInput = (overrides?: InputOverrides): RuntimeAgentWorkflowInput => ({
  payload: overrides?.payload ?? createPayload(),
  agent: overrides?.agent ?? createAgent(),
  activeRunId: "run-1",
  nowMs: 1000,
  runtimeTerminalState:
    overrides?.runtimeTerminalState ?? (createRuntimeTerminalState() as RuntimeTerminalState),
  hasChatEvents: false,
  hasPendingFallbackTimer: false,
  previousThinkingRaw: null,
  previousAssistantRaw: null,
  thinkingStartedAtMs: null,
  lifecycleFallbackDelayMs: 0,
  ...(overrides ?? {}),
});

const findCommand = <TKind extends RuntimeAgentWorkflowCommand["kind"]>(
  commands: RuntimeAgentWorkflowCommand[],
  kind: TKind
): Extract<RuntimeAgentWorkflowCommand, { kind: TKind }> | undefined =>
  commands.find((command) => command.kind === kind) as
    | Extract<RuntimeAgentWorkflowCommand, { kind: TKind }>
    | undefined;

const findIntent = <TKind extends RuntimePolicyIntent["kind"]>(
  intents: RuntimePolicyIntent[],
  kind: TKind
): Extract<RuntimePolicyIntent, { kind: TKind }> | undefined =>
  intents.find((intent) => intent.kind === kind) as
    | Extract<RuntimePolicyIntent, { kind: TKind }>
    | undefined;

const hasTerminalCommand = (
  commands: RuntimeTerminalCommand[],
  kind: RuntimeTerminalCommand["kind"]
): boolean => commands.some((command) => command.kind === kind);

describe("runtime agent event workflow", () => {
  it("returns preflight cleanup intents when incoming run is stale", () => {
    const result = planRuntimeAgentEvent(
      createInput({
        payload: createPayload({ runId: "run-stale", stream: "assistant", data: { delta: "x" } }),
        activeRunId: "run-active",
      })
    );

    expect(result.commands).toEqual([
      {
        kind: "applyPolicyIntents",
        intents: [{ kind: "clearRunTracking", runId: "run-stale" }],
      },
    ]);
  });

  it("logs late-event metric for closed-run preflight ignore", () => {
    const closedState = markClosedRun(createRuntimeTerminalState(), {
      runId: "run-1",
      now: 500,
      ttlMs: 10_000,
    });
    const result = planRuntimeAgentEvent(
      createInput({
        runtimeTerminalState: closedState,
      })
    );

    expect(result.commands).toEqual([
      {
        kind: "logMetric",
        metric: "late_event_ignored_closed_run",
        meta: {
          stream: "assistant",
          runId: "run-1",
        },
      },
    ]);
  });

  it("plans reasoning stream cache update and thinking live patch", () => {
    const result = planRuntimeAgentEvent(
      createInput({
        payload: createPayload({ stream: "reasoning", data: { text: "thinking out loud" } }),
        agent: createAgent({ runStartedAt: null }),
      })
    );

    expect(findCommand(result.commands, "markActivity")).toEqual({
      kind: "markActivity",
      at: 1000,
    });
    expect(findCommand(result.commands, "setThinkingStreamRaw")).toEqual({
      kind: "setThinkingStreamRaw",
      runId: "run-1",
      raw: "thinking out loud",
    });
    expect(findCommand(result.commands, "markThinkingStarted")).toEqual({
      kind: "markThinkingStarted",
      runId: "run-1",
      at: 1000,
    });
    expect(findCommand(result.commands, "queueAgentPatch")).toEqual({
      kind: "queueAgentPatch",
      patch: {
        status: "running",
        runId: "run-1",
        runStartedAt: 1000,
        sessionCreated: true,
        lastActivityAt: 1000,
        thinkingTrace: "thinking out loud",
      },
    });
  });

  it("suppresses assistant streamText patch when chat stream owns transcript", () => {
    const result = planRuntimeAgentEvent(
      createInput({
        payload: createPayload({ stream: "assistant", data: { delta: "hello" } }),
        agent: createAgent({ streamText: "already streaming" }),
        hasChatEvents: true,
      })
    );

    const queue = findCommand(result.commands, "queueAgentPatch");
    expect(queue).toBeDefined();
    expect(queue?.patch.status).toBe("running");
    expect(queue?.patch.runId).toBe("run-1");
    expect("streamText" in (queue?.patch ?? {})).toBe(false);
  });

  it("extends assistant streamText when incoming stream advances current text", () => {
    const result = planRuntimeAgentEvent(
      createInput({
        payload: createPayload({ stream: "assistant", data: { delta: "hello world" } }),
        agent: createAgent({ streamText: "hello" }),
        hasChatEvents: true,
        previousAssistantRaw: "hello",
      })
    );

    const queue = findCommand(result.commands, "queueAgentPatch");
    expect(queue).toBeDefined();
    expect(queue?.patch.streamText).toBe("hello world");
  });

  it("does not publish assistant streamText for open thinking chunk", () => {
    const result = planRuntimeAgentEvent(
      createInput({
        payload: createPayload({
          stream: "assistant",
          data: { text: "<thinking>planning" },
        }),
      })
    );

    const queue = findCommand(result.commands, "queueAgentPatch");
    expect(queue).toBeDefined();
    expect(queue?.patch.thinkingTrace).toBe("planning");
    expect("streamText" in (queue?.patch ?? {})).toBe(false);
  });

  it("publishes assistant streamText once answer appears after closing thinking tag", () => {
    const result = planRuntimeAgentEvent(
      createInput({
        payload: createPayload({
          stream: "assistant",
          data: { delta: "</thinking>Answer" },
        }),
        previousAssistantRaw: "<thinking>planning",
      })
    );

    const queue = findCommand(result.commands, "queueAgentPatch");
    expect(queue).toBeDefined();
    expect(queue?.patch.thinkingTrace).toBe("planning");
    expect(queue?.patch.streamText).toBe("Answer");
  });

  it("does not leak open thinking chunk into streamText when thinking traces are hidden", () => {
    const result = planRuntimeAgentEvent(
      createInput({
        payload: createPayload({
          stream: "assistant",
          data: { text: "<thinking>planning" },
        }),
        agent: createAgent({ showThinkingTraces: false }),
      })
    );

    const queue = findCommand(result.commands, "queueAgentPatch");
    expect(queue).toBeDefined();
    expect("streamText" in (queue?.patch ?? {})).toBe(false);
  });

  it("publishes visible assistant text when thinking block is closed even if text matches", () => {
    const result = planRuntimeAgentEvent(
      createInput({
        payload: createPayload({
          stream: "assistant",
          data: { text: "<thinking>same</thinking>same" },
        }),
      })
    );

    const queue = findCommand(result.commands, "queueAgentPatch");
    expect(queue).toBeDefined();
    expect(queue?.patch.thinkingTrace).toBe("same");
    expect(queue?.patch.streamText).toBe("same");
  });

  it("does not publish assistant streamText for reasoning-prefixed content", () => {
    const result = planRuntimeAgentEvent(
      createInput({
        payload: createPayload({
          stream: "assistant",
          data: { text: "reasoning: planning" },
        }),
      })
    );

    const queue = findCommand(result.commands, "queueAgentPatch");
    expect(queue).toBeDefined();
    expect(queue?.patch.thinkingTrace).toBe("planning");
    expect("streamText" in (queue?.patch ?? {})).toBe(false);
  });

  it("plans tool call line append", () => {
    const result = planRuntimeAgentEvent(
      createInput({
        payload: createPayload({
          stream: "tool",
          data: {
            phase: "call",
            name: "myTool",
            toolCallId: "tool-1",
            arguments: { a: 1 },
          },
        }),
      })
    );

    const append = findCommand(result.commands, "appendToolLines");
    expect(append).toBeDefined();
    expect(append?.lines).toHaveLength(1);
    expect(append?.lines[0]).toContain("[[tool]] myTool (tool-1)");
  });

  it("plans tool result append without implicit history refresh", () => {
    const result = planRuntimeAgentEvent(
      createInput({
        payload: createPayload({
          stream: "tool",
          data: {
            phase: "result",
            name: "exec",
            toolCallId: "tool-2",
            result: { content: [{ type: "text", text: "ok" }] },
          },
        }),
      })
    );

    const append = findCommand(result.commands, "appendToolLines");
    expect(append).toBeDefined();
    expect(append?.lines.some((line) => line.startsWith("[[tool-result]]"))).toBe(true);
    expect(result.commands.some((command) => command.kind === "applyPolicyIntents")).toBe(false);
  });

  it("plans lifecycle decision with deferred transition patch when fallback is scheduled", () => {
    const result = planRuntimeAgentEvent(
      createInput({
        payload: createPayload({
          stream: "lifecycle",
          data: { phase: "end" },
        }),
        agent: createAgent({ streamText: "final text", runId: "run-1" }),
      })
    );

    const lifecycle = findCommand(result.commands, "applyLifecycleDecision");
    expect(lifecycle).toBeDefined();
    expect(lifecycle?.shouldClearPendingLivePatch).toBe(true);
    expect(lifecycle?.decision.deferTransitionPatch).toBe(true);
    expect(hasTerminalCommand(lifecycle?.decision.commands ?? [], "cancelLifecycleFallback")).toBe(
      true
    );
    expect(
      hasTerminalCommand(
        lifecycle?.decision.commands ?? [],
        "scheduleLifecycleFallback"
      )
    ).toBe(true);
  });

  it("keeps tool result flow free from refresh scheduling commands", () => {
    const result = planRuntimeAgentEvent(
      createInput({
        payload: createPayload({
          stream: "tool",
          data: {
            phase: "result",
            name: "exec",
            toolCallId: "tool-3",
            result: { content: [{ type: "text", text: "ok" }] },
          },
        }),
      })
    );

    expect(result.commands.some((command) => command.kind === "applyPolicyIntents")).toBe(false);
  });

  it("keeps preflight intents empty for active lifecycle start and emits activity command", () => {
    const result = planRuntimeAgentEvent(
      createInput({
        payload: createPayload({
          stream: "lifecycle",
          data: { phase: "start" },
        }),
      })
    );

    expect(findCommand(result.commands, "markActivity")).toEqual({
      kind: "markActivity",
      at: 1000,
    });

    const lifecycle = findCommand(result.commands, "applyLifecycleDecision");
    expect(lifecycle).toBeDefined();
    expect(findIntent([], "clearRunTracking")).toBeUndefined();
  });

  it("does not let a mismatched lifecycle start replace the active run", () => {
    const result = planRuntimeAgentEvent(
      createInput({
        payload: createPayload({
          runId: "run-old",
          stream: "lifecycle",
          data: { phase: "start" },
        }),
        agent: createAgent({ runId: "run-new", status: "running" }),
        activeRunId: "run-new",
      })
    );

    expect(result.commands).toEqual([
      {
        kind: "applyPolicyIntents",
        intents: [{ kind: "clearRunTracking", runId: "run-old" }],
      },
    ]);
  });
});
