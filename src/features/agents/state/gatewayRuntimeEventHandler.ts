import type { AgentState } from "@/features/agents/state/store";
import { logTranscriptDebugMetric } from "@/features/agents/state/transcript";
import {
  classifyGatewayEventKind,
  getChatSummaryPatch,
  resolveAssistantCompletionTimestamp,
  type AgentEventPayload,
  type ChatEventPayload,
} from "@/features/agents/state/runtimeEventBridge";
import { isClosedRun } from "@/features/agents/state/runtimeTerminalWorkflow";
import {
  createRuntimeEventCoordinatorState,
  markChatRunSeen,
  pruneRuntimeEventCoordinatorState,
  reduceClearRunTracking,
  reduceLifecycleFallbackFired,
  reduceMarkActivityThrottled,
  reduceRuntimeAgentWorkflowCommands,
  reduceRuntimeChatWorkflowCommands,
  type RuntimeCoordinatorDispatchAction,
  type RuntimeCoordinatorEffectCommand,
} from "@/features/agents/state/runtimeEventCoordinatorWorkflow";
import type { EventFrame } from "@/lib/gateway/gateway-frames";
import { isSameSessionKey } from "@/lib/gateway/session-keys";
import { normalizeAssistantDisplayText } from "@/lib/text/assistantText";
import {
  extractText,
  extractThinking,
  extractToolLines,
  formatMetaMarkdown,
  isTraceMarkdown,
  isUiMetadataPrefix,
  stripUiMetadata,
} from "@/lib/text/message-extract";
import { planRuntimeChatEvent } from "@/features/agents/state/runtimeChatEventWorkflow";
import { planRuntimeAgentEvent } from "@/features/agents/state/runtimeAgentEventWorkflow";

type GatewayRuntimeEventHandlerDeps = {
  getAgents: () => AgentState[];
  dispatch: (action: RuntimeCoordinatorDispatchAction) => void;
  queueLivePatch: (agentId: string, patch: Partial<AgentState>) => void;
  clearPendingLivePatch: (agentId: string) => void;
  now?: () => number;
  requestHistoryRefresh?: (command: {
    agentId: string;
    reason: "chat-final-no-trace";
  }) => Promise<void> | void;

  setTimeout: (fn: () => void, delayMs: number) => number;
  clearTimeout: (id: number) => void;

  logWarn?: (message: string, meta?: unknown) => void;
  shouldSuppressRunAbortedLine?: (params: {
    agentId: string;
    runId: string | null;
    sessionKey: string;
    stopReason: string | null;
  }) => boolean;

  updateSpecialLatestUpdate: (agentId: string, agent: AgentState, message: string) => void;
};

type GatewayRuntimeEventHandler = {
  handleEvent: (event: EventFrame) => void;
  clearRunTracking: (runId?: string | null) => void;
  dispose: () => void;
};

const findAgentBySessionKey = (agents: AgentState[], sessionKey: string): string | null => {
  const exact = agents.find((agent) => isSameSessionKey(agent.sessionKey, sessionKey));
  return exact ? exact.agentId : null;
};

const findAgentByRunId = (agents: AgentState[], runId: string): string | null => {
  const match = agents.find((agent) => agent.runId === runId);
  return match ? match.agentId : null;
};

const resolveRole = (message: unknown) =>
  message && typeof message === "object"
    ? (message as Record<string, unknown>).role
    : null;

const toTimestampMs = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
};

const resolveMessageTimestampMs = (message: unknown): number | null => {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  return (
    toTimestampMs(record.timestamp) ??
    toTimestampMs(record.createdAt) ??
    toTimestampMs(record.at)
  );
};

const resolveRuntimeChatUserEntryId = (
  payload: ChatEventPayload,
  suffix: "meta" | "message"
): string | undefined => {
  const normalizedRunId = payload.runId?.trim() ?? "";
  if (normalizedRunId) {
    return suffix === "meta"
      ? `run:${normalizedRunId}:user:meta`
      : `run:${normalizedRunId}:user`;
  }
  if (typeof payload.seq !== "number" || !Number.isFinite(payload.seq)) {
    return undefined;
  }
  const normalizedSessionKey = payload.sessionKey.trim();
  if (!normalizedSessionKey) return undefined;
  const normalizedSeq = Math.floor(payload.seq);
  if (suffix === "meta") {
    return `session:${normalizedSessionKey}:chat-user:${normalizedSeq}:meta`;
  }
  return `session:${normalizedSessionKey}:chat-user:${normalizedSeq}`;
};

export function createGatewayRuntimeEventHandler(
  deps: GatewayRuntimeEventHandlerDeps
): GatewayRuntimeEventHandler {
  const now = deps.now ?? (() => Date.now());
  const CLOSED_RUN_TTL_MS = 30_000;
  const LIFECYCLE_FALLBACK_DELAY_MS = 0;

  let coordinatorState = createRuntimeEventCoordinatorState();

  const lifecycleFallbackTimerIdByRun = new Map<string, number>();

  const toRunId = (runId?: string | null): string => runId?.trim() ?? "";

  const logWarn =
    deps.logWarn ??
    ((message: string, meta?: unknown) => {
      console.warn(message, meta);
    });

  const cancelLifecycleFallback = (runId?: string | null) => {
    const key = toRunId(runId);
    if (!key) return;
    const timerId = lifecycleFallbackTimerIdByRun.get(key);
    if (typeof timerId !== "number") return;
    deps.clearTimeout(timerId);
    lifecycleFallbackTimerIdByRun.delete(key);
  };

  const executeCoordinatorEffects = (effects: RuntimeCoordinatorEffectCommand[]) => {
    for (const effect of effects) {
      if (effect.kind === "dispatch") {
        deps.dispatch(effect.action);
        continue;
      }
      if (effect.kind === "queueLivePatch") {
        deps.queueLivePatch(effect.agentId, effect.patch);
        continue;
      }
      if (effect.kind === "clearPendingLivePatch") {
        deps.clearPendingLivePatch(effect.agentId);
        continue;
      }
      if (effect.kind === "cancelLifecycleFallback") {
        cancelLifecycleFallback(effect.runId);
        continue;
      }
      if (effect.kind === "scheduleLifecycleFallback") {
        const fallbackTimerId = deps.setTimeout(() => {
          lifecycleFallbackTimerIdByRun.delete(effect.runId);
          const fallbackReduced = reduceLifecycleFallbackFired({
            state: coordinatorState,
            runId: effect.runId,
            agentId: effect.agentId,
            sessionKey: effect.sessionKey,
            finalText: effect.finalText,
            transitionPatch: effect.transitionPatch,
            nowMs: now(),
            options: { closedRunTtlMs: CLOSED_RUN_TTL_MS },
          });
          coordinatorState = fallbackReduced.state;
          executeCoordinatorEffects(fallbackReduced.effects);
        }, effect.delayMs);
        lifecycleFallbackTimerIdByRun.set(effect.runId, fallbackTimerId);
        continue;
      }
      if (effect.kind === "appendAbortedIfNotSuppressed") {
        const suppressAbortedLine =
          deps.shouldSuppressRunAbortedLine?.({
            agentId: effect.agentId,
            runId: effect.runId,
            sessionKey: effect.sessionKey,
            stopReason: effect.stopReason,
          }) ?? false;
        if (!suppressAbortedLine) {
          deps.dispatch({
            type: "appendOutput",
            agentId: effect.agentId,
            line: "Run aborted.",
            transcript: {
              source: "runtime-chat",
              runId: effect.runId,
              sessionKey: effect.sessionKey,
              timestampMs: effect.timestampMs,
              role: "assistant",
              kind: "assistant",
            },
          });
        }
        continue;
      }
      if (effect.kind === "logMetric") {
        logTranscriptDebugMetric(effect.metric, effect.meta);
        continue;
      }
      if (effect.kind === "logWarn") {
        logWarn(effect.message, effect.meta);
        continue;
      }
      if (effect.kind === "updateSpecialLatest") {
        const agent =
          effect.agentSnapshot?.agentId === effect.agentId
            ? effect.agentSnapshot
            : deps.getAgents().find((entry) => entry.agentId === effect.agentId);
        if (agent) {
          void deps.updateSpecialLatestUpdate(effect.agentId, agent, effect.message);
        }
      }
    }
  };

  const clearRunTracking = (runId?: string | null) => {
    const cleared = reduceClearRunTracking({
      state: coordinatorState,
      runId,
    });
    coordinatorState = cleared.state;
    executeCoordinatorEffects(cleared.effects);
  };

  const pruneCoordinatorState = (at: number = now()) => {
    const pruned = pruneRuntimeEventCoordinatorState({
      state: coordinatorState,
      at,
    });
    coordinatorState = pruned.state;
    executeCoordinatorEffects(pruned.effects);
  };

  const dispose = () => {
    for (const timerId of lifecycleFallbackTimerIdByRun.values()) {
      deps.clearTimeout(timerId);
    }
    lifecycleFallbackTimerIdByRun.clear();
    coordinatorState = createRuntimeEventCoordinatorState();
  };

  const handleRuntimeChatEvent = (payload: ChatEventPayload) => {
    if (!payload.sessionKey) return;
    pruneCoordinatorState();

    if (
      payload.runId &&
      payload.state === "delta" &&
      isClosedRun(coordinatorState.runtimeTerminalState, payload.runId)
    ) {
      logTranscriptDebugMetric("late_event_ignored_closed_run", {
        stream: "chat",
        state: payload.state,
        runId: payload.runId,
      });
      return;
    }

    coordinatorState = markChatRunSeen(coordinatorState, payload.runId);

    const agentsSnapshot = deps.getAgents();
    const agentId = findAgentBySessionKey(agentsSnapshot, payload.sessionKey);
    if (!agentId) return;
    const agent = agentsSnapshot.find((entry) => entry.agentId === agentId);
    const activeRunId = agent?.runId?.trim() ?? "";
    const role = resolveRole(payload.message);
    const nowMs = now();

    if (
      payload.runId &&
      activeRunId &&
      activeRunId !== payload.runId
    ) {
      clearRunTracking(payload.runId);
      return;
    }
    if (
      !activeRunId &&
      agent?.status !== "running" &&
      payload.state === "delta" &&
      role !== "user" &&
      role !== "system"
    ) {
      clearRunTracking(payload.runId ?? null);
      return;
    }

    const summaryPatch = getChatSummaryPatch(payload, nowMs);
    if (summaryPatch) {
      deps.dispatch({
        type: "updateAgent",
        agentId,
        patch: {
          ...summaryPatch,
          sessionCreated: true,
        },
      });
    }

    if (role === "user") {
      if (payload.state !== "delta") {
        const rawUserText = extractText(payload.message);
        const trimmedRawUserText = rawUserText?.trim() ?? "";
        if (trimmedRawUserText && !isUiMetadataPrefix(trimmedRawUserText)) {
          const normalizedUserText = stripUiMetadata(trimmedRawUserText).trim();
          if (normalizedUserText) {
            const timestampMs = resolveMessageTimestampMs(payload.message) ?? nowMs;
            deps.dispatch({
              type: "appendOutput",
              agentId,
              line: formatMetaMarkdown({
                role: "user",
                timestamp: timestampMs,
              }),
              transcript: {
                source: "runtime-chat",
                runId: payload.runId ?? null,
                sessionKey: payload.sessionKey,
                timestampMs,
                role: "user",
                kind: "meta",
                entryId: resolveRuntimeChatUserEntryId(payload, "meta"),
                confirmed: true,
              },
            });
            deps.dispatch({
              type: "appendOutput",
              agentId,
              line: `> ${normalizedUserText}`,
              transcript: {
                source: "runtime-chat",
                runId: payload.runId ?? null,
                sessionKey: payload.sessionKey,
                timestampMs,
                role: "user",
                kind: "user",
                entryId: resolveRuntimeChatUserEntryId(payload, "message"),
                confirmed: true,
              },
            });
          }
        }
      }
      return;
    }

    if (role === "system") {
      return;
    }

    const activityReduced = reduceMarkActivityThrottled({
      state: coordinatorState,
      agentId,
      at: nowMs,
    });
    coordinatorState = activityReduced.state;
    executeCoordinatorEffects(activityReduced.effects);

    const nextTextRaw = extractText(payload.message);
    const nextText = nextTextRaw ? stripUiMetadata(nextTextRaw) : null;
    const nextThinking = extractThinking(payload.message ?? payload);
    const toolLines = extractToolLines(payload.message ?? payload);
    const isToolRole = role === "tool" || role === "toolResult";
    const assistantCompletionAt = resolveAssistantCompletionTimestamp({
      role,
      state: payload.state,
      message: payload.message,
      now: now(),
    });
    const normalizedAssistantFinalText =
      payload.state === "final" &&
      role === "assistant" &&
      !isToolRole &&
      typeof nextText === "string"
        ? normalizeAssistantDisplayText(nextText)
        : null;
    const finalAssistantText =
      normalizedAssistantFinalText && normalizedAssistantFinalText.length > 0
        ? normalizedAssistantFinalText
        : null;

    const chatWorkflow = planRuntimeChatEvent({
      payload,
      agentId,
      agent,
      activeRunId: activeRunId || null,
      runtimeTerminalState: coordinatorState.runtimeTerminalState,
      role,
      nowMs,
      nextTextRaw,
      nextText,
      nextThinking,
      toolLines,
      isToolRole,
      assistantCompletionAt,
      finalAssistantText,
      hasThinkingStarted: payload.runId
        ? coordinatorState.thinkingStartedAtByRun.has(payload.runId)
        : false,
      hasTraceInOutput:
        agent?.outputLines.some((line) => isTraceMarkdown(line.trim())) ?? false,
      isThinkingDebugSessionSeen: coordinatorState.thinkingDebugBySession.has(
        payload.sessionKey
      ),
      thinkingStartedAtMs: payload.runId
        ? (coordinatorState.thinkingStartedAtByRun.get(payload.runId) ?? null)
        : null,
    });

    const reduced = reduceRuntimeChatWorkflowCommands({
      state: coordinatorState,
      payload,
      agentId,
      agent,
      commands: chatWorkflow.commands,
      nowMs,
      options: { closedRunTtlMs: CLOSED_RUN_TTL_MS },
    });
    coordinatorState = reduced.state;
    executeCoordinatorEffects(reduced.effects);
  };

  const handleRuntimeAgentEvent = (payload: AgentEventPayload) => {
    if (!payload.runId) return;
    pruneCoordinatorState();

    const agentsSnapshot = deps.getAgents();
    const directMatch = payload.sessionKey
      ? findAgentBySessionKey(agentsSnapshot, payload.sessionKey)
      : null;
    const agentId = directMatch ?? findAgentByRunId(agentsSnapshot, payload.runId);
    if (!agentId) return;
    const agent = agentsSnapshot.find((entry) => entry.agentId === agentId);
    if (!agent) return;

    const nowMs = now();
    const agentWorkflow = planRuntimeAgentEvent({
      payload,
      agent,
      activeRunId: agent.runId?.trim() || null,
      nowMs,
      runtimeTerminalState: coordinatorState.runtimeTerminalState,
      hasChatEvents: coordinatorState.chatRunSeen.has(payload.runId),
      hasPendingFallbackTimer: lifecycleFallbackTimerIdByRun.has(
        toRunId(payload.runId)
      ),
      previousThinkingRaw: coordinatorState.thinkingStreamByRun.get(payload.runId) ?? null,
      previousAssistantRaw:
        coordinatorState.assistantStreamByRun.get(payload.runId) ?? null,
      thinkingStartedAtMs:
        coordinatorState.thinkingStartedAtByRun.get(payload.runId) ?? null,
      lifecycleFallbackDelayMs: LIFECYCLE_FALLBACK_DELAY_MS,
    });

    const reduced = reduceRuntimeAgentWorkflowCommands({
      state: coordinatorState,
      payload,
      agentId,
      agent,
      commands: agentWorkflow.commands,
      nowMs,
      options: { closedRunTtlMs: CLOSED_RUN_TTL_MS },
    });
    coordinatorState = reduced.state;
    executeCoordinatorEffects(reduced.effects);
  };

  const handleEvent = (event: EventFrame) => {
    const eventKind = classifyGatewayEventKind(event.event);
    if (eventKind === "summary-refresh") return;

    if (eventKind === "runtime-chat") {
      const payload = event.payload as ChatEventPayload | undefined;
      if (!payload) return;
      handleRuntimeChatEvent(payload);
      return;
    }

    if (eventKind === "runtime-agent") {
      const payload = event.payload as AgentEventPayload | undefined;
      if (!payload) return;
      handleRuntimeAgentEvent(payload);
    }
  };

  return { handleEvent, clearRunTracking, dispose };
}
