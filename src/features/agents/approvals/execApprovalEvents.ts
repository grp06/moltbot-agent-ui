import type { AgentState } from "@/features/agents/state/store";
import type { EventFrame } from "@/lib/gateway/gateway-frames";
import type { ExecApprovalDecision } from "@/features/agents/approvals/types";
import { resolveSafeAgentId } from "@/lib/agents/agentIds";
import { resolveSafeSessionKey } from "@/lib/gateway/session-keys";

type RequestedPayload = {
  id: string;
  request: {
    command: string;
    cwd: string | null;
    host: string | null;
    security: string | null;
    ask: string | null;
    agentId: string | null;
    resolvedPath: string | null;
    sessionKey: string | null;
  };
  createdAtMs: number;
  expiresAtMs: number;
};

type ResolvedPayload = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy: string | null;
  ts: number;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asOptionalString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asPositiveTimestamp = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

export const parseExecApprovalRequested = (event: EventFrame): RequestedPayload | null => {
  if (event.type !== "event" || event.event !== "exec.approval.requested") return null;
  const payload = asRecord(event.payload);
  if (!payload) return null;
  const id = asNonEmptyString(payload.id);
  const request = asRecord(payload.request);
  const createdAtMs = asPositiveTimestamp(payload.createdAtMs);
  const expiresAtMs = asPositiveTimestamp(payload.expiresAtMs);
  if (!id || !request || !createdAtMs || !expiresAtMs) return null;
  const command = asNonEmptyString(request.command);
  if (!command) return null;
  return {
    id,
    request: {
      command,
      cwd: asOptionalString(request.cwd),
      host: asOptionalString(request.host),
      security: asOptionalString(request.security),
      ask: asOptionalString(request.ask),
      agentId: resolveSafeAgentId(request.agentId),
      resolvedPath: asOptionalString(request.resolvedPath),
      sessionKey: resolveSafeSessionKey(request.sessionKey),
    },
    createdAtMs,
    expiresAtMs,
  };
};

export const parseExecApprovalResolved = (event: EventFrame): ResolvedPayload | null => {
  if (event.type !== "event" || event.event !== "exec.approval.resolved") return null;
  const payload = asRecord(event.payload);
  if (!payload) return null;
  const id = asNonEmptyString(payload.id);
  const decisionRaw = asNonEmptyString(payload.decision);
  const ts = asPositiveTimestamp(payload.ts);
  if (!id || !decisionRaw || !ts) return null;
  if (decisionRaw !== "allow-once" && decisionRaw !== "allow-always" && decisionRaw !== "deny") {
    return null;
  }
  return {
    id,
    decision: decisionRaw,
    resolvedBy: asOptionalString(payload.resolvedBy),
    ts,
  };
};

export const resolveExecApprovalAgentId = (params: {
  requested: RequestedPayload;
  agents: AgentState[];
}): string | null => {
  const requestedAgentId = params.requested.request.agentId;
  if (requestedAgentId) {
    const matchedByAgentId = params.agents.find((agent) => agent.agentId === requestedAgentId);
    if (matchedByAgentId) return matchedByAgentId.agentId;
  }
  const requestedSessionKey = params.requested.request.sessionKey;
  if (!requestedSessionKey) return null;
  const matchedBySession = params.agents.find(
    (agent) => agent.sessionKey.trim() === requestedSessionKey
  );
  return matchedBySession?.agentId ?? null;
};
