import type { ExecApprovalDecision, PendingExecApproval } from "@/features/agents/approvals/types";
import {
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  resolveExecApprovalAgentId,
} from "@/features/agents/approvals/execApprovalEvents";
import type { AgentState } from "@/features/agents/state/store";
import type { EventFrame } from "@/lib/gateway/gateway-frames";
import { GatewayResponseError } from "@/lib/gateway/errors";
import { resolveSafeAgentId } from "@/lib/agents/agentIds";
import { resolveSafeSessionKey } from "@/lib/gateway/session-keys";

export type ExecApprovalEventEffects = {
  scopedUpserts: Array<{ agentId: string; approval: PendingExecApproval }>;
  unscopedUpserts: PendingExecApproval[];
  removals: string[];
  markActivityAgentIds: string[];
};

type ExecApprovalFollowUpIntent = {
  shouldSend: boolean;
  agentId: string | null;
  sessionKey: string | null;
  message: string | null;
};

const EMPTY_EVENT_EFFECTS: ExecApprovalEventEffects = {
  scopedUpserts: [],
  unscopedUpserts: [],
  removals: [],
  markActivityAgentIds: [],
};

const NO_FOLLOW_UP_INTENT: ExecApprovalFollowUpIntent = {
  shouldSend: false,
  agentId: null,
  sessionKey: null,
  message: null,
};

export const resolveExecApprovalEventEffects = (params: {
  event: EventFrame;
  agents: AgentState[];
}): ExecApprovalEventEffects | null => {
  const requested = parseExecApprovalRequested(params.event);
  if (requested) {
    const resolvedAgentId = resolveExecApprovalAgentId({
      requested,
      agents: params.agents,
    });
    const approval: PendingExecApproval = {
      id: requested.id,
      agentId: resolvedAgentId,
      sessionKey: requested.request.sessionKey,
      command: requested.request.command,
      cwd: requested.request.cwd,
      host: requested.request.host,
      security: requested.request.security,
      ask: requested.request.ask,
      resolvedPath: requested.request.resolvedPath,
      createdAtMs: requested.createdAtMs,
      expiresAtMs: requested.expiresAtMs,
      resolving: false,
      error: null,
    };
    if (!resolvedAgentId) {
      return {
        ...EMPTY_EVENT_EFFECTS,
        unscopedUpserts: [approval],
      };
    }
    return {
      ...EMPTY_EVENT_EFFECTS,
      scopedUpserts: [{ agentId: resolvedAgentId, approval }],
      markActivityAgentIds: [resolvedAgentId],
    };
  }

  const resolved = parseExecApprovalResolved(params.event);
  if (!resolved) {
    return null;
  }
  return {
    ...EMPTY_EVENT_EFFECTS,
    removals: [resolved.id],
  };
};

export const resolveExecApprovalFollowUpIntent = (params: {
  decision: ExecApprovalDecision;
  approval: PendingExecApproval | null;
  agents: AgentState[];
  followUpMessage: string;
}): ExecApprovalFollowUpIntent => {
  if (params.decision !== "allow-once" && params.decision !== "allow-always") {
    return NO_FOLLOW_UP_INTENT;
  }
  if (!params.approval) {
    return NO_FOLLOW_UP_INTENT;
  }
  const scopedAgentId = resolveSafeAgentId(params.approval.agentId) ?? "";
  const scopedAgent =
    scopedAgentId ? params.agents.find((agent) => agent.agentId === scopedAgentId) ?? null : null;
  const approvalSessionKey = resolveSafeSessionKey(params.approval.sessionKey) ?? "";
  const sessionAgentId =
    approvalSessionKey
      ? (params.agents.find(
          (agent) => agent.sessionKey.trim() === approvalSessionKey
        )?.agentId ?? "")
      : "";
  const targetAgentId = scopedAgent?.agentId ?? sessionAgentId;
  if (!targetAgentId) {
    return NO_FOLLOW_UP_INTENT;
  }
  const targetSessionKey =
    approvalSessionKey ||
    params.agents.find((agent) => agent.agentId === targetAgentId)?.sessionKey?.trim() ||
    "";
  const followUpMessage = params.followUpMessage.trim();
  if (!targetSessionKey || !followUpMessage) {
    return NO_FOLLOW_UP_INTENT;
  }
  return {
    shouldSend: true,
    agentId: targetAgentId,
    sessionKey: targetSessionKey,
    message: followUpMessage,
  };
};

export const shouldTreatExecApprovalResolveErrorAsUnknownId = (error: unknown): boolean =>
  error instanceof GatewayResponseError && /unknown approval id/i.test(error.message);
