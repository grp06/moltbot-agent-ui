import { GatewayResponseError, type GatewayClient } from "@/lib/gateway/GatewayClient";
import { resolveSafeAgentId } from "@/lib/agents/agentIds";

type GatewayExecApprovalSecurity = "deny" | "allowlist" | "full";
type GatewayExecApprovalAsk = "off" | "on-miss" | "always";

type ExecAllowlistEntry = {
  id?: string;
  pattern: string;
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
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

const callGateway = async <T>(
  client: GatewayClient,
  method: string,
  params: unknown
): Promise<T> => {
  const invoke = (
    client as unknown as { call?: (nextMethod: string, nextParams: unknown) => Promise<unknown> }
  ).call;
  if (typeof invoke !== "function") {
    throw new Error("Legacy gateway client call transport is unavailable.");
  }
  return (await invoke(method, params)) as T;
};

const shouldRetrySet = (err: unknown): boolean => {
  if (!(err instanceof GatewayResponseError)) return false;
  return /re-run exec\.approvals\.get|changed since last load/i.test(err.message);
};

const normalizeAllowlist = (patterns: Array<{ pattern: string }>): Array<{ pattern: string }> => {
  const next = patterns
    .map((entry) => entry.pattern.trim())
    .filter((pattern) => pattern.length > 0);
  return Array.from(new Set(next)).map((pattern) => ({ pattern }));
};

const resolveAgentId = (value: string) => {
  const agentId = resolveSafeAgentId(value);
  if (!agentId) {
    const trimmed = value.trim();
    throw new Error(trimmed ? `Invalid agentId: ${trimmed}` : "Agent id is required.");
  }
  return agentId;
};

const buildNextExecApprovalsFile = (params: {
  snapshotFile?: ExecApprovalsFile;
  agentId: string;
  policy: {
    security: GatewayExecApprovalSecurity;
    ask: GatewayExecApprovalAsk;
    allowlist: Array<{ pattern: string }>;
  } | null;
}): ExecApprovalsFile | null => {
  const baseFile: ExecApprovalsFile =
    params.snapshotFile && typeof params.snapshotFile === "object"
      ? {
          version: 1,
          socket: params.snapshotFile.socket,
          defaults: params.snapshotFile.defaults,
          agents: { ...(params.snapshotFile.agents ?? {}) },
        }
      : { version: 1, agents: {} };

  const nextAgents = { ...(baseFile.agents ?? {}) };
  if (!params.policy) {
    if (!(params.agentId in nextAgents)) {
      return null;
    }
    delete nextAgents[params.agentId];
  } else {
    const existing = nextAgents[params.agentId] ?? {};
    nextAgents[params.agentId] = {
      ...existing,
      security: params.policy.security,
      ask: params.policy.ask,
      allowlist: normalizeAllowlist(params.policy.allowlist),
    };
  }

  return {
    ...baseFile,
    version: 1,
    agents: nextAgents,
  };
};

const setExecApprovalsWithRetry = async (params: {
  client: GatewayClient;
  snapshot: ExecApprovalsSnapshot;
  agentId: string;
  policy: {
    security: GatewayExecApprovalSecurity;
    ask: GatewayExecApprovalAsk;
    allowlist: Array<{ pattern: string }>;
  } | null;
  attempt?: number;
}): Promise<void> => {
  const attempt = params.attempt ?? 0;
  const file = buildNextExecApprovalsFile({
    snapshotFile: params.snapshot.file,
    agentId: params.agentId,
    policy: params.policy,
  });
  if (!file) return;

  const requiresBaseHash = params.snapshot.exists !== false;
  const baseHash = requiresBaseHash ? params.snapshot.hash?.trim() : undefined;
  if (requiresBaseHash && !baseHash) {
    throw new Error("Exec approvals hash unavailable; re-run exec.approvals.get.");
  }
  const payload: Record<string, unknown> = { file };
  if (baseHash) payload.baseHash = baseHash;
  try {
    await callGateway(params.client, "exec.approvals.set", payload);
  } catch (err) {
    if (attempt < 1 && shouldRetrySet(err)) {
      const snapshot = await callGateway<ExecApprovalsSnapshot>(
        params.client,
        "exec.approvals.get",
        {}
      );
      return setExecApprovalsWithRetry({
        client: params.client,
        snapshot,
        agentId: params.agentId,
        policy: params.policy,
        attempt: attempt + 1,
      });
    }
    throw err;
  }
};

export async function upsertGatewayAgentExecApprovals(params: {
  client: GatewayClient;
  agentId: string;
  policy: {
    security: GatewayExecApprovalSecurity;
    ask: GatewayExecApprovalAsk;
    allowlist: Array<{ pattern: string }>;
} | null;
}): Promise<void> {
  const agentId = resolveAgentId(params.agentId);

  const snapshot = await callGateway<ExecApprovalsSnapshot>(
    params.client,
    "exec.approvals.get",
    {}
  );
  await setExecApprovalsWithRetry({
    client: params.client,
    snapshot,
    agentId,
    policy: params.policy,
  });
}

export async function readGatewayAgentExecApprovals(params: {
  client: GatewayClient;
  agentId: string;
}): Promise<{
  security: GatewayExecApprovalSecurity | null;
  ask: GatewayExecApprovalAsk | null;
  allowlist: Array<{ pattern: string }>;
} | null> {
  const agentId = resolveAgentId(params.agentId);

  const snapshot = await callGateway<ExecApprovalsSnapshot>(
    params.client,
    "exec.approvals.get",
    {}
  );
  const entry = snapshot.file?.agents?.[agentId];
  if (!entry) return null;

  const security =
    entry.security === "deny" || entry.security === "allowlist" || entry.security === "full"
      ? entry.security
      : null;
  const ask = entry.ask === "off" || entry.ask === "on-miss" || entry.ask === "always" ? entry.ask : null;
  const allowlist = Array.isArray(entry.allowlist)
    ? entry.allowlist
        .map((item) => (item && typeof item === "object" ? (item as ExecAllowlistEntry).pattern : ""))
        .filter((pattern): pattern is string => typeof pattern === "string")
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0)
        .map((pattern) => ({ pattern }))
    : [];

  return {
    security,
    ask,
    allowlist,
  };
}
