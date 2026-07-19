import type { AgentState } from "@/features/agents/state/store";
import type { TranscriptAppendMeta } from "@/features/agents/state/transcript";
import type { ChatEventPayload } from "@/features/agents/state/runtimeEventBridge";
import { decideRuntimeChatEvent, type RuntimePolicyIntent } from "@/features/agents/state/runtimeEventPolicy";
import {
  deriveChatTerminalDecision,
  type ChatTerminalDecision,
  type RuntimeTerminalState,
} from "@/features/agents/state/runtimeTerminalWorkflow";
import {
  formatMetaMarkdown,
  formatThinkingMarkdown,
  isUiMetadataPrefix,
} from "@/lib/text/message-extract";

export type RuntimeChatWorkflowCommand =
  | { kind: "applyChatTerminalDecision"; decision: ChatTerminalDecision }
  | { kind: "applyPolicyIntents"; intents: RuntimePolicyIntent[] }
  | { kind: "appendOutput"; line: string; transcript: TranscriptAppendMeta }
  | { kind: "appendToolLines"; lines: string[]; timestampMs: number }
  | { kind: "applyTerminalCommit"; runId: string; seq: number | null }
  | { kind: "appendAbortedIfNotSuppressed"; timestampMs: number }
  | { kind: "logMetric"; metric: string; meta: Record<string, unknown> }
  | { kind: "markThinkingDebugSession"; sessionKey: string }
  | { kind: "logWarn"; message: string; meta?: unknown };

export type RuntimeChatWorkflowInput = {
  payload: ChatEventPayload;
  agentId: string;
  agent: AgentState | undefined;
  activeRunId: string | null;
  runtimeTerminalState: RuntimeTerminalState;
  role: unknown;
  nowMs: number;
  nextTextRaw: string | null;
  nextText: string | null;
  nextThinking: string | null;
  toolLines: string[];
  isToolRole: boolean;
  assistantCompletionAt: number | null;
  finalAssistantText: string | null;
  hasThinkingStarted: boolean;
  hasTraceInOutput: boolean;
  isThinkingDebugSessionSeen: boolean;
  thinkingStartedAtMs: number | null;
};

type RuntimeChatWorkflowResult = {
  commands: RuntimeChatWorkflowCommand[];
};

const terminalAssistantMetaEntryId = (runId?: string | null) => {
  const key = runId?.trim() ?? "";
  return key ? `run:${key}:assistant:meta` : undefined;
};

const terminalAssistantFinalEntryId = (runId?: string | null) => {
  const key = runId?.trim() ?? "";
  return key ? `run:${key}:assistant:final` : undefined;
};

const resolveTerminalSeq = (payload: ChatEventPayload): number | null => {
  const seq = payload.seq;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return null;
  return seq;
};

const summarizeThinkingMessage = (message: unknown) => {
  if (!message || typeof message !== "object") {
    return { type: typeof message };
  }
  const record = message as Record<string, unknown>;
  const summary: Record<string, unknown> = { keys: Object.keys(record) };
  const content = record.content;
  if (Array.isArray(content)) {
    summary.contentTypes = content.map((item) => {
      if (item && typeof item === "object") {
        const entry = item as Record<string, unknown>;
        return typeof entry.type === "string" ? entry.type : "object";
      }
      return typeof item;
    });
  } else if (typeof content === "string") {
    summary.contentLength = content.length;
  }
  if (typeof record.text === "string") {
    summary.textLength = record.text.length;
  }
  for (const key of ["analysis", "reasoning", "thinking"]) {
    const value = record[key];
    if (typeof value === "string") {
      summary[`${key}Length`] = value.length;
    } else if (value && typeof value === "object") {
      summary[`${key}Keys`] = Object.keys(value as Record<string, unknown>);
    }
  }
  return summary;
};

export const planRuntimeChatEvent = (
  input: RuntimeChatWorkflowInput
): RuntimeChatWorkflowResult => {
  const commands: RuntimeChatWorkflowCommand[] = [];
  const {
    payload,
    agentId,
    agent,
    activeRunId,
    runtimeTerminalState,
    role,
    nowMs,
    nextTextRaw,
    nextText,
    nextThinking,
    toolLines,
    isToolRole,
    assistantCompletionAt,
    finalAssistantText,
    hasThinkingStarted,
    isThinkingDebugSessionSeen,
    thinkingStartedAtMs,
  } = input;

  if (payload.state === "delta") {
    if (typeof nextTextRaw === "string" && isUiMetadataPrefix(nextTextRaw.trim())) {
      return { commands };
    }
    const deltaIntents = decideRuntimeChatEvent({
      agentId,
      state: payload.state,
      runId: payload.runId ?? null,
      role,
      activeRunId,
      agentStatus: agent?.status ?? "idle",
      now: nowMs,
      agentRunStartedAt: agent?.runStartedAt ?? null,
      nextThinking,
      nextText,
      hasThinkingStarted,
      isClosedRun: false,
      isStaleTerminal: false,
      shouldUpdateLastResult: false,
      shouldSetRunIdle: false,
      shouldSetRunError: false,
      lastResultText: null,
      assistantCompletionAt: null,
      shouldQueueLatestUpdate: false,
      latestUpdateMessage: null,
    });
    const hasOnlyDeltaCleanup =
      deltaIntents.length > 0 &&
      deltaIntents.every((intent) => intent.kind === "clearRunTracking");
    if (hasOnlyDeltaCleanup) {
      commands.push({ kind: "applyPolicyIntents", intents: deltaIntents });
      return { commands };
    }
    if (deltaIntents.some((intent) => intent.kind === "ignore")) {
      return { commands };
    }
    commands.push({ kind: "applyPolicyIntents", intents: deltaIntents });
    if (toolLines.length > 0) {
      commands.push({
        kind: "appendToolLines",
        lines: toolLines,
        timestampMs: nowMs,
      });
    }
    return { commands };
  }

  const shouldUpdateLastResult =
    payload.state === "final" && !isToolRole && typeof finalAssistantText === "string";
  const shouldQueueLatestUpdate =
    payload.state === "final" &&
    role === "assistant" &&
    !isToolRole &&
    Boolean(agent?.lastUserMessage && !agent.latestOverride);
  const terminalSeq = payload.state === "final" ? resolveTerminalSeq(payload) : null;
  const chatTerminalDecision =
    payload.state === "final"
      ? deriveChatTerminalDecision({
          state: runtimeTerminalState,
          runId: payload.runId,
          isFinal: true,
          seq: terminalSeq,
        })
      : null;

  if (chatTerminalDecision) {
    commands.push({
      kind: "applyChatTerminalDecision",
      decision: chatTerminalDecision,
    });
  }

  if (payload.state === "final" && payload.runId && chatTerminalDecision?.isStaleTerminal) {
    commands.push({
      kind: "logMetric",
      metric: "stale_terminal_chat_event_ignored",
      meta: {
        runId: payload.runId,
        seq: terminalSeq,
        lastTerminalSeq: chatTerminalDecision.lastTerminalSeqBeforeFinal,
        commitSource: chatTerminalDecision.commitSourceBeforeFinal,
      },
    });
  }

  const chatIntents = decideRuntimeChatEvent({
    agentId,
    state: payload.state,
    runId: payload.runId ?? null,
    role,
    activeRunId,
    agentStatus: agent?.status ?? "idle",
    now: nowMs,
    agentRunStartedAt: agent?.runStartedAt ?? null,
    nextThinking,
    nextText,
    hasThinkingStarted,
    isClosedRun: false,
    isStaleTerminal: chatTerminalDecision?.isStaleTerminal ?? false,
    shouldUpdateLastResult,
    shouldSetRunIdle:
      payload.state === "aborted"
        ? agent?.status === "running"
        : Boolean(payload.runId && agent?.runId === payload.runId && payload.state !== "error"),
    shouldSetRunError: Boolean(payload.runId && agent?.runId === payload.runId && payload.state === "error"),
    lastResultText: shouldUpdateLastResult ? finalAssistantText : null,
    assistantCompletionAt: payload.state === "final" ? assistantCompletionAt : null,
    shouldQueueLatestUpdate,
    latestUpdateMessage: shouldQueueLatestUpdate ? (agent?.lastUserMessage ?? null) : null,
  });
  const hasOnlyRunCleanup =
    chatIntents.length > 0 &&
    chatIntents.every((intent) => intent.kind === "clearRunTracking");
  if (hasOnlyRunCleanup) {
    commands.push({ kind: "applyPolicyIntents", intents: chatIntents });
    return { commands };
  }
  if (chatIntents.some((intent) => intent.kind === "ignore")) {
    return { commands };
  }

  if (payload.state === "final") {
    if (payload.runId && chatTerminalDecision?.fallbackCommittedBeforeFinal && role === "assistant" && !isToolRole) {
      commands.push({
        kind: "logMetric",
        metric: "lifecycle_fallback_replaced_by_chat_final",
        meta: {
          runId: payload.runId,
          seq: terminalSeq,
          lastTerminalSeq: chatTerminalDecision.lastTerminalSeqBeforeFinal ?? null,
        },
      });
    }
    if (!nextThinking && role === "assistant" && !isThinkingDebugSessionSeen) {
      commands.push({
        kind: "markThinkingDebugSession",
        sessionKey: payload.sessionKey,
      });
      commands.push({
        kind: "logWarn",
        message: "No thinking trace extracted from chat event.",
        meta: {
          sessionKey: payload.sessionKey,
          message: summarizeThinkingMessage(payload.message ?? payload),
        },
      });
    }
    const thinkingText = nextThinking ?? agent?.thinkingTrace ?? null;
    const thinkingLine = thinkingText ? formatThinkingMarkdown(thinkingText) : "";
    if (role === "assistant" && typeof assistantCompletionAt === "number") {
      const thinkingDurationMs =
        typeof thinkingStartedAtMs === "number"
          ? Math.max(0, assistantCompletionAt - thinkingStartedAtMs)
          : null;
      commands.push({
        kind: "appendOutput",
        line: formatMetaMarkdown({
          role: "assistant",
          timestamp: assistantCompletionAt,
          thinkingDurationMs,
        }),
        transcript: {
          source: "runtime-chat",
          runId: payload.runId ?? null,
          sessionKey: payload.sessionKey,
          timestampMs: assistantCompletionAt,
          role: "assistant",
          kind: "meta",
          entryId: terminalAssistantMetaEntryId(payload.runId ?? null),
          confirmed: true,
        },
      });
    }
    if (thinkingLine) {
      commands.push({
        kind: "appendOutput",
        line: thinkingLine,
        transcript: {
          source: "runtime-chat",
          runId: payload.runId ?? null,
          sessionKey: payload.sessionKey,
          timestampMs: assistantCompletionAt ?? nowMs,
          role: "assistant",
          kind: "thinking",
        },
      });
    }
    if (toolLines.length > 0) {
      commands.push({
        kind: "appendToolLines",
        lines: toolLines,
        timestampMs: assistantCompletionAt ?? nowMs,
      });
    }
    if (!isToolRole && typeof finalAssistantText === "string") {
      commands.push({
        kind: "appendOutput",
        line: finalAssistantText,
        transcript: {
          source: "runtime-chat",
          runId: payload.runId ?? null,
          sessionKey: payload.sessionKey,
          timestampMs: assistantCompletionAt ?? nowMs,
          role: "assistant",
          kind: "assistant",
          entryId: terminalAssistantFinalEntryId(payload.runId ?? null),
          confirmed: true,
        },
      });
    }
    if (payload.runId) {
      commands.push({
        kind: "applyTerminalCommit",
        runId: payload.runId,
        seq: terminalSeq,
      });
    }
    commands.push({ kind: "applyPolicyIntents", intents: chatIntents });
    return { commands };
  }

  if (payload.state === "aborted") {
    commands.push({
      kind: "appendAbortedIfNotSuppressed",
      timestampMs: nowMs,
    });
    commands.push({ kind: "applyPolicyIntents", intents: chatIntents });
    return { commands };
  }

  if (payload.state === "error") {
    commands.push({
      kind: "appendOutput",
      line: payload.errorMessage ? `Error: ${payload.errorMessage}` : "Run error.",
      transcript: {
        source: "runtime-chat",
        runId: payload.runId ?? null,
        sessionKey: payload.sessionKey,
        timestampMs: nowMs,
        role: "assistant",
        kind: "assistant",
      },
    });
    commands.push({ kind: "applyPolicyIntents", intents: chatIntents });
  }

  return { commands };
};
