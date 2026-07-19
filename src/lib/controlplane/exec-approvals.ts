import type { ControlPlaneRuntime } from "@/lib/controlplane/runtime";
import { ControlPlaneGatewayError } from "@/lib/controlplane/openclaw-adapter";
import { resolveSafeAgentId } from "@/lib/agents/agentIds";

type GatewayExecApprovalSecurity = "deny" | "allowlist" | "full";
type GatewayExecApprovalAsk = "off" | "on-miss" | "always";
export type ExecutionRoleId = "conservative" | "collaborative" | "autonomous";

type ExecAllowlistEntry = {
  pattern: string;
};

type ExecApprovalsAgent = {
  security?: GatewayExecApprovalSecurity;
  ask?: GatewayExecApprovalAsk;
  askFallback?: string;
  autoAllowSkills?: boolean;
  allowlist?: ExecAllowlistEntry[];
};

type ExecApprovalsFile = {
  version: 1;
  socket?: {
    path?: string;
    token?: string;
  };
  defaults?: {
    security?: string;
    ask?: string;
    askFallback?: string;
    autoAllowSkills?: boolean;
  };
  agents?: Record<string, ExecApprovalsAgent>;
};

type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  hash: string;
  file?: ExecApprovalsFile;
};

const normalizeAllowlist = (patterns: Array<{ pattern: string }>): Array<{ pattern: string }> => {
  const next = patterns
    .map((entry) => entry.pattern.trim())
    .filter((pattern) => pattern.length > 0);
  return Array.from(new Set(next)).map((pattern) => ({ pattern }));
};

const resolvePolicyForRole = (params: {
  role: ExecutionRoleId;
  allowlist: Array<{ pattern: string }>;
}):
  | {
      security: "full" | "allowlist";
      ask: "off" | "always";
      allowlist: Array<{ pattern: string }>;
    }
  | null => {
  if (params.role === "conservative") return null;
  if (params.role === "autonomous") {
    return { security: "full", ask: "off", allowlist: params.allowlist };
  }
  return { security: "allowlist", ask: "always", allowlist: params.allowlist };
};

const isRetryableSetError = (err: unknown): boolean => {
  if (!(err instanceof ControlPlaneGatewayError)) return false;
  const message = err.message.toLowerCase();
  if (err.code.trim().toUpperCase() !== "INVALID_REQUEST") return false;
  if (!message.includes("exec approvals")) return false;
  return (
    message.includes("re-run exec.approvals.get") ||
    message.includes("reload and retry") ||
    message.includes("base hash unavailable") ||
    message.includes("base hash required") ||
    message.includes("changed since last load") ||
    message.includes("exec approvals changed")
  );
};

const buildNextExecApprovalsFile = (
  snapshotFile: ExecApprovalsFile | undefined,
  agentId: string,
  role: ExecutionRoleId
): ExecApprovalsFile => {
  const baseFile: ExecApprovalsFile =
    snapshotFile && typeof snapshotFile === "object"
      ? {
          version: 1,
          socket: snapshotFile.socket,
          defaults: snapshotFile.defaults,
          agents: { ...(snapshotFile.agents ?? {}) },
        }
      : { version: 1, agents: {} };

  const existingAllowlist = Array.isArray(baseFile.agents?.[agentId]?.allowlist)
    ? baseFile.agents?.[agentId]?.allowlist?.filter(
        (entry): entry is ExecAllowlistEntry =>
          Boolean(entry && typeof entry.pattern === "string" && entry.pattern.trim().length > 0)
      ) ?? []
    : [];
  const policy = resolvePolicyForRole({
    role,
    allowlist: existingAllowlist.map((entry) => ({ pattern: entry.pattern })),
  });

  const nextAgents = { ...(baseFile.agents ?? {}) };
  if (!policy) {
    delete nextAgents[agentId];
  } else {
    const existing = nextAgents[agentId] ?? {};
    nextAgents[agentId] = {
      ...existing,
      security: policy.security,
      ask: policy.ask,
      allowlist: normalizeAllowlist(policy.allowlist),
    };
  }

  return {
    ...baseFile,
    version: 1,
    agents: nextAgents,
  };
};

const resolveAgentId = (value: string) => {
  const agentId = resolveSafeAgentId(value);
  if (!agentId) {
    const trimmed = value.trim();
    throw new Error(trimmed ? `Invalid agentId: ${trimmed}` : "Agent id is required.");
  }
  return agentId;
};

const buildExecApprovalsSetPayload = (
  snapshot: ExecApprovalsSnapshot,
  file: ExecApprovalsFile
) => {
  const requiresBaseHash = snapshot.exists !== false;
  const baseHash = requiresBaseHash ? snapshot.hash?.trim() : undefined;
  if (requiresBaseHash && !baseHash) {
    throw new Error("Exec approvals hash unavailable; re-run exec.approvals.get.");
  }
  return {
    file,
    ...(baseHash ? { baseHash } : {}),
  };
};

export const upsertAgentExecApprovalsPolicyViaRuntime = async (params: {
  runtime: ControlPlaneRuntime;
  agentId: string;
  role: ExecutionRoleId;
}): Promise<void> => {
  const agentId = resolveAgentId(params.agentId);

  const snapshot = await params.runtime.callGateway<ExecApprovalsSnapshot>("exec.approvals.get", {});
  const nextFile = buildNextExecApprovalsFile(snapshot.file, agentId, params.role);

  const setPayload = buildExecApprovalsSetPayload(snapshot, nextFile);
  try {
    await params.runtime.callGateway("exec.approvals.set", setPayload);
  } catch (err) {
    if (!isRetryableSetError(err)) throw err;
    const retrySnapshot = await params.runtime.callGateway<ExecApprovalsSnapshot>("exec.approvals.get", {});
    const retryNextFile = buildNextExecApprovalsFile(retrySnapshot.file, agentId, params.role);
    await params.runtime.callGateway(
      "exec.approvals.set",
      buildExecApprovalsSetPayload(retrySnapshot, retryNextFile)
    );
  }
};
