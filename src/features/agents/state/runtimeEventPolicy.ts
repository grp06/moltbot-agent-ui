import type { AgentState } from "@/features/agents/state/store";
import type { ChatEventPayload } from "@/features/agents/state/runtimeEventBridge";

type ConnectionStatus = "disconnected" | "connecting" | "connected";

export type RuntimePolicyIntent =
  | { kind: "ignore"; reason: string }
  | { kind: "clearRunTracking"; runId: string }
  | { kind: "markRunClosed"; runId: string }
  | { kind: "markThinkingStarted"; runId: string; at: number }
  | { kind: "clearPendingLivePatch"; agentId: string }
  | { kind: "queueLivePatch"; agentId: string; patch: Partial<AgentState> }
  | { kind: "dispatchUpdateAgent"; agentId: string; patch: Partial<AgentState> }
  | { kind: "queueLatestUpdate"; agentId: string; message: string };

type RuntimeChatPolicyInput = {
  agentId: string;
  state: ChatEventPayload["state"];
  runId: string | null;
  role: unknown;
  activeRunId: string | null;
  agentStatus: AgentState["status"];
  now: number;
  agentRunStartedAt: number | null;
  nextThinking: string | null;
  nextText: string | null;
  hasThinkingStarted: boolean;
  isClosedRun: boolean;
  isStaleTerminal: boolean;
  shouldRequestHistoryRefresh?: boolean;
  shouldUpdateLastResult: boolean;
  shouldSetRunIdle: boolean;
  shouldSetRunError: boolean;
  lastResultText: string | null;
  assistantCompletionAt: number | null;
  shouldQueueLatestUpdate: boolean;
  latestUpdateMessage: string | null;
};

type RuntimeAgentPolicyInput = {
  runId: string;
  stream: string;
  phase: string;
  activeRunId: string | null;
  agentStatus: AgentState["status"];
  isClosedRun: boolean;
};

type RuntimeSummaryPolicyInput = {
  event: string;
  status: ConnectionStatus;
};

const isLifecycleStart = (stream: string, phase: string): boolean =>
  stream === "lifecycle" && phase === "start";

const toRunId = (runId: string | null | undefined): string => runId?.trim() ?? "";

export const decideRuntimeChatEvent = (
  input: RuntimeChatPolicyInput
): RuntimePolicyIntent[] => {
  const runId = toRunId(input.runId);
  const activeRunId = toRunId(input.activeRunId);
  const role = input.role;

  if (input.state === "delta") {
    if (runId && input.isClosedRun) {
      return [{ kind: "ignore", reason: "closed-run-delta" }];
    }
    if (runId && activeRunId && activeRunId !== runId) {
      return [{ kind: "clearRunTracking", runId }];
    }
    if (
      !activeRunId &&
      input.agentStatus !== "running" &&
      role !== "user" &&
      role !== "system"
    ) {
      return runId
        ? [{ kind: "clearRunTracking", runId }]
        : [{ kind: "ignore", reason: "inactive-agent-delta" }];
    }
    if (role === "user" || role === "system") {
      return [];
    }
    const patch: Partial<AgentState> = {};
    const intents: RuntimePolicyIntent[] = [];
    if (input.nextThinking) {
      if (runId && !input.hasThinkingStarted) {
        intents.push({ kind: "markThinkingStarted", runId, at: input.now });
      }
      patch.thinkingTrace = input.nextThinking;
      patch.status = "running";
    }
    if (typeof input.nextText === "string") {
      patch.streamText = input.nextText;
      patch.status = "running";
    }
    if (runId) {
      patch.runId = runId;
    }
    if (input.agentRunStartedAt === null) {
      patch.runStartedAt = input.now;
    }
    if (Object.keys(patch).length > 0) {
      intents.push({
        kind: "queueLivePatch",
        agentId: input.agentId,
        patch,
      });
    }
    return intents;
  }

  if (runId && activeRunId && activeRunId !== runId) {
    return [{ kind: "clearRunTracking", runId }];
  }
  if (runId && input.isStaleTerminal) {
    return [{ kind: "ignore", reason: "stale-terminal-event" }];
  }

  const intents: RuntimePolicyIntent[] = [
    { kind: "clearPendingLivePatch", agentId: input.agentId },
  ];
  if (runId) {
    intents.push({ kind: "clearRunTracking", runId });
    intents.push({ kind: "markRunClosed", runId });
  }

  if (input.state === "final") {
    if (input.shouldUpdateLastResult && input.lastResultText) {
      intents.push({
        kind: "dispatchUpdateAgent",
        agentId: input.agentId,
        patch: { lastResult: input.lastResultText },
      });
    }
    if (input.shouldQueueLatestUpdate && input.latestUpdateMessage) {
      intents.push({
        kind: "queueLatestUpdate",
        agentId: input.agentId,
        message: input.latestUpdateMessage,
      });
    }
  }

  const patch: Partial<AgentState> = {
    streamText: null,
    thinkingTrace: null,
    runStartedAt: null,
  };
  if (typeof input.assistantCompletionAt === "number") {
    patch.lastAssistantMessageAt = input.assistantCompletionAt;
  }
  if (input.shouldSetRunIdle) {
    patch.status = "idle";
    patch.runId = null;
  } else if (input.shouldSetRunError) {
    patch.status = "error";
    patch.runId = null;
  }

  intents.push({
    kind: "dispatchUpdateAgent",
    agentId: input.agentId,
    patch,
  });

  return intents;
};

export const decideRuntimeAgentEvent = (
  input: RuntimeAgentPolicyInput
): RuntimePolicyIntent[] => {
  const lifecycleStart = isLifecycleStart(input.stream, input.phase);
  if (input.isClosedRun) {
    return [{ kind: "ignore", reason: "closed-run-event" }];
  }
  if (lifecycleStart) {
    if (input.activeRunId && input.activeRunId !== input.runId) {
      return [{ kind: "clearRunTracking", runId: input.runId }];
    }
    return [];
  }
  if (input.activeRunId && input.activeRunId !== input.runId) {
    return [{ kind: "clearRunTracking", runId: input.runId }];
  }
  if (!input.activeRunId && input.agentStatus !== "running") {
    return [{ kind: "clearRunTracking", runId: input.runId }];
  }
  return [];
};

export const decideSummaryRefreshEvent = (
  input: RuntimeSummaryPolicyInput
): RuntimePolicyIntent[] => {
  void input;
  return [];
};
