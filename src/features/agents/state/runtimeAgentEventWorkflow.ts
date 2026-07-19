import type { AgentState } from "@/features/agents/state/store";
import {
  getAgentSummaryPatch,
  isReasoningRuntimeAgentStream,
  mergeRuntimeStream,
  resolveLifecyclePatch,
  shouldPublishAssistantStream,
  type AgentEventPayload,
} from "@/features/agents/state/runtimeEventBridge";
import {
  decideRuntimeAgentEvent,
  type RuntimePolicyIntent,
} from "@/features/agents/state/runtimeEventPolicy";
import {
  deriveLifecycleTerminalDecision,
  isClosedRun,
  type LifecycleTerminalDecision,
  type RuntimeTerminalState,
} from "@/features/agents/state/runtimeTerminalWorkflow";
import { normalizeAssistantDisplayText } from "@/lib/text/assistantText";
import {
  extractText,
  extractThinking,
  extractThinkingFromTaggedStream,
  extractToolLines,
  formatToolCallMarkdown,
  hasUnclosedThinkingTag,
  isUiMetadataPrefix,
  stripUiMetadata,
} from "@/lib/text/message-extract";

export type RuntimeAgentWorkflowCommand =
  | { kind: "applyPolicyIntents"; intents: RuntimePolicyIntent[] }
  | { kind: "logMetric"; metric: string; meta: Record<string, unknown> }
  | { kind: "markActivity"; at: number }
  | { kind: "setThinkingStreamRaw"; runId: string; raw: string }
  | { kind: "setAssistantStreamRaw"; runId: string; raw: string }
  | { kind: "markThinkingStarted"; runId: string; at: number }
  | { kind: "queueAgentPatch"; patch: Partial<AgentState> }
  | { kind: "appendToolLines"; lines: string[]; timestampMs: number }
  | {
      kind: "applyLifecycleDecision";
      decision: LifecycleTerminalDecision;
      transitionPatch: Partial<AgentState>;
      shouldClearPendingLivePatch: boolean;
    };

export type RuntimeAgentWorkflowInput = {
  payload: AgentEventPayload;
  agent: AgentState;
  activeRunId: string | null;
  nowMs: number;
  runtimeTerminalState: RuntimeTerminalState;
  hasChatEvents: boolean;
  hasPendingFallbackTimer: boolean;
  previousThinkingRaw: string | null;
  previousAssistantRaw: string | null;
  thinkingStartedAtMs: number | null;
  historyRefreshRequested?: boolean;
  lifecycleFallbackDelayMs: number;
};

type RuntimeAgentWorkflowResult = {
  commands: RuntimeAgentWorkflowCommand[];
};

const extractReasoningBody = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^reasoning:\s*([\s\S]*)$/i);
  if (!match) return null;
  const body = (match[1] ?? "").trim();
  return body || null;
};

const normalizeReasoningComparable = (value: string): string =>
  normalizeAssistantDisplayText(value).trim().toLowerCase();

const hasReasoningSignal = ({
  rawText,
  rawDelta,
  mergedRaw,
}: {
  rawText: string;
  rawDelta: string;
  mergedRaw: string;
}): boolean => {
  if (hasUnclosedThinkingTag(mergedRaw)) return true;
  return Boolean(extractReasoningBody(rawText) ?? extractReasoningBody(rawDelta));
};

const isReasoningOnlyAssistantChunk = ({
  rawText,
  rawDelta,
  mergedRaw,
  cleaned,
  liveThinking,
}: {
  rawText: string;
  rawDelta: string;
  mergedRaw: string;
  cleaned: string;
  liveThinking: string | null;
}): boolean => {
  if (!liveThinking) return false;
  const normalizedCleaned = normalizeReasoningComparable(cleaned);
  const normalizedThinking = normalizeReasoningComparable(liveThinking);
  const normalizedCleanedReasoningBody = normalizeReasoningComparable(
    extractReasoningBody(cleaned) ?? ""
  );
  const cleanedMatchesReasoning =
    !normalizedCleaned ||
    normalizedCleaned === normalizedThinking ||
    (normalizedCleanedReasoningBody.length > 0 &&
      normalizedCleanedReasoningBody === normalizedThinking);
  if (!cleanedMatchesReasoning) return false;
  return hasReasoningSignal({ rawText, rawDelta, mergedRaw });
};

const resolveThinkingFromAgentStream = (
  data: Record<string, unknown> | null,
  rawStream: string,
  opts?: { treatPlainTextAsThinking?: boolean }
): string | null => {
  if (data) {
    const extracted = extractThinking(data);
    if (extracted) return extracted;
    const text = typeof data.text === "string" ? data.text : "";
    const delta = typeof data.delta === "string" ? data.delta : "";
    const prefixed = extractReasoningBody(text) ?? extractReasoningBody(delta);
    if (prefixed) return prefixed;
    if (opts?.treatPlainTextAsThinking) {
      const cleanedDelta = delta.trim();
      if (cleanedDelta) return cleanedDelta;
      const cleanedText = text.trim();
      if (cleanedText) return cleanedText;
    }
  }
  const tagged = extractThinkingFromTaggedStream(rawStream);
  return tagged || null;
};

export const planRuntimeAgentEvent = (
  input: RuntimeAgentWorkflowInput
): RuntimeAgentWorkflowResult => {
  const commands: RuntimeAgentWorkflowCommand[] = [];
  const {
    payload,
    agent,
    activeRunId,
    nowMs,
    runtimeTerminalState,
    hasChatEvents,
    hasPendingFallbackTimer,
    previousThinkingRaw,
    previousAssistantRaw,
    thinkingStartedAtMs,
    lifecycleFallbackDelayMs,
  } = input;
  const runId = payload.runId?.trim() ?? "";
  if (!runId) return { commands };
  const stream = typeof payload.stream === "string" ? payload.stream : "";
  const data =
    payload.data && typeof payload.data === "object"
      ? (payload.data as Record<string, unknown>)
      : null;
  const phase = typeof data?.phase === "string" ? data.phase : "";

  const preflightIntents = decideRuntimeAgentEvent({
    runId,
    stream,
    phase,
    activeRunId,
    agentStatus: agent.status,
    isClosedRun: isClosedRun(runtimeTerminalState, runId),
  });
  const hasOnlyPreflightCleanup =
    preflightIntents.length > 0 &&
    preflightIntents.every((intent) => intent.kind === "clearRunTracking");
  if (hasOnlyPreflightCleanup) {
    commands.push({ kind: "applyPolicyIntents", intents: preflightIntents });
    return { commands };
  }
  if (preflightIntents.some((intent) => intent.kind === "ignore")) {
    if (
      preflightIntents.some(
        (intent) =>
          intent.kind === "ignore" && intent.reason === "closed-run-event"
      )
    ) {
      commands.push({
        kind: "logMetric",
        metric: "late_event_ignored_closed_run",
        meta: {
          stream: payload.stream,
          runId,
        },
      });
    }
    return { commands };
  }

  commands.push({ kind: "markActivity", at: nowMs });

  if (isReasoningRuntimeAgentStream(stream)) {
    const rawText = typeof data?.text === "string" ? data.text : "";
    const rawDelta = typeof data?.delta === "string" ? data.delta : "";
    const previousRaw = previousThinkingRaw ?? "";
    let mergedRaw = previousRaw;
    if (rawText) {
      mergedRaw = rawText;
    } else if (rawDelta) {
      mergedRaw = mergeRuntimeStream(previousRaw, rawDelta);
    }
    if (mergedRaw) {
      commands.push({ kind: "setThinkingStreamRaw", runId, raw: mergedRaw });
    }
    const liveThinking =
      resolveThinkingFromAgentStream(data, mergedRaw, {
        treatPlainTextAsThinking: true,
      }) ?? (mergedRaw.trim() ? mergedRaw.trim() : null);
    if (liveThinking) {
      if (typeof thinkingStartedAtMs !== "number") {
        commands.push({ kind: "markThinkingStarted", runId, at: nowMs });
      }
      commands.push({
        kind: "queueAgentPatch",
        patch: {
          status: "running",
          runId,
          ...(agent.runStartedAt === null ? { runStartedAt: nowMs } : {}),
          sessionCreated: true,
          lastActivityAt: nowMs,
          thinkingTrace: liveThinking,
        },
      });
    }
    return { commands };
  }

  if (stream === "assistant") {
    const rawText = typeof data?.text === "string" ? data.text : "";
    const rawDelta = typeof data?.delta === "string" ? data.delta : "";
    const previousRaw = previousAssistantRaw ?? "";
    let mergedRaw = previousRaw;
    if (rawText) {
      mergedRaw = rawText;
    } else if (rawDelta) {
      mergedRaw = mergeRuntimeStream(previousRaw, rawDelta);
    }
    if (mergedRaw) {
      commands.push({ kind: "setAssistantStreamRaw", runId, raw: mergedRaw });
    }

    const liveThinking = resolveThinkingFromAgentStream(data, mergedRaw);
    const patch: Partial<AgentState> = {
      status: "running",
      runId,
      lastActivityAt: nowMs,
      sessionCreated: true,
    };
    if (liveThinking) {
      if (typeof thinkingStartedAtMs !== "number") {
        commands.push({ kind: "markThinkingStarted", runId, at: nowMs });
      }
      patch.thinkingTrace = liveThinking;
    }
    if (agent.runStartedAt === null) {
      patch.runStartedAt = nowMs;
    }
    if (mergedRaw && (!rawText || !isUiMetadataPrefix(rawText.trim()))) {
      const visibleText =
        extractText({ role: "assistant", content: mergedRaw }) ?? mergedRaw;
      const cleaned = stripUiMetadata(visibleText);
      const reasoningOnlyChunk = isReasoningOnlyAssistantChunk({
        rawText,
        rawDelta,
        mergedRaw,
        cleaned,
        liveThinking,
      });
      if (
        cleaned &&
        !reasoningOnlyChunk &&
        shouldPublishAssistantStream({
          nextText: cleaned,
          rawText,
          hasChatEvents,
          currentStreamText: agent.streamText ?? null,
        })
      ) {
        patch.streamText = cleaned;
      }
    }
    commands.push({ kind: "queueAgentPatch", patch });
    return { commands };
  }

  if (stream === "tool") {
    const name = typeof data?.name === "string" ? data.name : "tool";
    const toolCallId =
      typeof data?.toolCallId === "string" ? data.toolCallId : "";
    if (phase && phase !== "result") {
      const args =
        (data?.arguments as unknown) ??
        (data?.args as unknown) ??
        (data?.input as unknown) ??
        (data?.parameters as unknown) ??
        null;
      const line = formatToolCallMarkdown({
        id: toolCallId || undefined,
        name,
        arguments: args,
      });
      if (line) {
        commands.push({
          kind: "appendToolLines",
          lines: [line],
          timestampMs: nowMs,
        });
      }
      return { commands };
    }

    if (phase !== "result") {
      return { commands };
    }

    const result = data?.result;
    const isError =
      typeof data?.isError === "boolean" ? data.isError : undefined;
    const resultRecord =
      result && typeof result === "object"
        ? (result as Record<string, unknown>)
        : null;
    const details =
      resultRecord && "details" in resultRecord ? resultRecord.details : undefined;
    let content: unknown = result;
    if (resultRecord) {
      if (Array.isArray(resultRecord.content)) {
        content = resultRecord.content;
      } else if (typeof resultRecord.text === "string") {
        content = resultRecord.text;
      }
    }

    const lines = extractToolLines({
      role: "tool",
      toolName: name,
      toolCallId,
      isError,
      details,
      content,
    });
    if (lines.length > 0) {
      commands.push({ kind: "appendToolLines", lines, timestampMs: nowMs });
    }

    return { commands };
  }

  if (stream !== "lifecycle") {
    return { commands };
  }

  const summaryPatch = getAgentSummaryPatch(payload, nowMs);
  if (!summaryPatch) {
    return { commands };
  }
  if (phase !== "start" && phase !== "end" && phase !== "error") {
    return { commands };
  }

  const transition = resolveLifecyclePatch({
    phase,
    incomingRunId: runId,
    currentRunId: agent.runId,
    lastActivityAt: summaryPatch.lastActivityAt ?? nowMs,
  });
  if (transition.kind === "ignore") {
    return { commands };
  }

  const normalizedStreamText = agent.streamText
    ? normalizeAssistantDisplayText(agent.streamText)
    : "";
  const lifecycleDecision = deriveLifecycleTerminalDecision({
    mode: "event",
    state: runtimeTerminalState,
    runId,
    phase,
    hasPendingFallbackTimer,
    fallbackDelayMs: lifecycleFallbackDelayMs,
    fallbackFinalText:
      normalizedStreamText.length > 0 ? normalizedStreamText : null,
    transitionClearsRunTracking: transition.clearRunTracking,
  });

  commands.push({
    kind: "applyLifecycleDecision",
    decision: lifecycleDecision,
    transitionPatch: transition.patch,
    shouldClearPendingLivePatch: transition.kind === "terminal",
  });

  return { commands };
};
