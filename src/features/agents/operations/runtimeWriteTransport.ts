import { postStudioIntent } from "@/lib/controlplane/intents-client";
import type { ExecApprovalDecision } from "@/features/agents/approvals/types";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";
import { syncGatewaySessionSettings } from "@/lib/gateway/session-settings-sync";
import { createGatewayAgent, deleteGatewayAgent, renameGatewayAgent } from "@/lib/gateway/agentConfig";
import { hasMalformedAgentSessionKey } from "@/lib/gateway/session-keys";
import { resolveSafeAgentId } from "@/lib/agents/agentIds";
import {
  readGatewayAgentExecApprovals,
  upsertGatewayAgentExecApprovals,
} from "@/lib/gateway/execApprovals";

type RuntimeWriteExecutionRole = "conservative" | "collaborative" | "autonomous";

export type RuntimeWriteTransport = {
  useDomainIntents?: boolean;
  chatSend: (params: {
    sessionKey: string;
    message: string;
    deliver: boolean;
    idempotencyKey: string;
  }) => Promise<unknown>;
  sessionSettingsSync: (params: {
    sessionKey: string;
    model?: string | null;
    thinkingLevel?: string | null;
    execHost?: "sandbox" | "gateway" | "node" | null;
    execSecurity?: "deny" | "allowlist" | "full" | null;
    execAsk?: "off" | "on-miss" | "always" | null;
  }) => Promise<unknown>;
  agentCreate: (params: { name: string }) => Promise<{ id: string; name: string }>;
  chatAbort: (params: { sessionKey: string; runId?: string }) => Promise<void>;
  sessionsReset: (params: { key: string }) => Promise<void>;
  agentRename: (params: { agentId: string; name: string }) => Promise<void>;
  agentDelete: (params: { agentId: string }) => Promise<void>;
  execApprovalResolve: (params: { id: string; decision: ExecApprovalDecision }) => Promise<void>;
  execApprovalsSet: (params: { agentId: string; role: RuntimeWriteExecutionRole }) => Promise<void>;
  agentPermissionsUpdate: (params: {
    agentId: string;
    sessionKey: string;
    commandMode: "off" | "ask" | "auto";
    webAccess: boolean;
    fileTools: boolean;
  }) => Promise<void>;
  agentWait: (params: { runId: string; timeoutMs?: number }) => Promise<unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const requireNonEmpty = (value: string, fieldLabel: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldLabel} is required.`);
  }
  return trimmed;
};

const requireSafeSessionKey = (value: string): string => {
  const sessionKey = requireNonEmpty(value, "Session key");
  if (hasMalformedAgentSessionKey(sessionKey)) {
    throw new Error("Invalid sessionKey.");
  }
  return sessionKey;
};

const resolveExecApprovalDecision = (value: string): ExecApprovalDecision => {
  const decision = value.trim();
  if (decision === "allow-once" || decision === "allow-always" || decision === "deny") {
    return decision;
  }
  throw new Error("Exec approval decision must be allow-once, allow-always, or deny.");
};

const callLegacyGateway = async <T>(
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

const unwrapIntentPayload = <T>(result: unknown): T => {
  if (isRecord(result) && "payload" in result) {
    return result.payload as T;
  }
  return result as T;
};

const resolveExecApprovalsPolicyForRole = (params: {
  role: RuntimeWriteExecutionRole;
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

export function createRuntimeWriteTransport(params: {
  client: GatewayClient;
  useDomainIntents: boolean;
  postIntent?: (path: string, body: Record<string, unknown>) => Promise<unknown>;
}): RuntimeWriteTransport {
  const postIntent = params.postIntent ?? postStudioIntent;

  return {
    useDomainIntents: params.useDomainIntents,
    chatSend: async (input) => {
      const normalizedSessionKey = requireSafeSessionKey(input.sessionKey);
      const normalizedIdempotencyKey = requireNonEmpty(input.idempotencyKey, "Idempotency key");
      const payload = {
        ...input,
        sessionKey: normalizedSessionKey,
        idempotencyKey: normalizedIdempotencyKey,
      };
      if (params.useDomainIntents) {
        const result = await postIntent("/api/intents/chat-send", payload);
        return unwrapIntentPayload<unknown>(result);
      }
      return await callLegacyGateway(params.client, "chat.send", payload);
    },
    sessionSettingsSync: async ({
      sessionKey,
      model,
      thinkingLevel,
      execHost,
      execSecurity,
      execAsk,
    }) => {
      const normalizedSessionKey = requireSafeSessionKey(sessionKey);
      const includeModel = model !== undefined;
      const includeThinkingLevel = thinkingLevel !== undefined;
      const includeExecHost = execHost !== undefined;
      const includeExecSecurity = execSecurity !== undefined;
      const includeExecAsk = execAsk !== undefined;
      if (
        !includeModel &&
        !includeThinkingLevel &&
        !includeExecHost &&
        !includeExecSecurity &&
        !includeExecAsk
      ) {
        throw new Error("At least one session setting must be provided.");
      }
      if (params.useDomainIntents) {
        const result = await postIntent("/api/intents/session-settings-sync", {
          sessionKey: normalizedSessionKey,
          ...(includeModel ? { model } : {}),
          ...(includeThinkingLevel ? { thinkingLevel } : {}),
          ...(includeExecHost ? { execHost } : {}),
          ...(includeExecSecurity ? { execSecurity } : {}),
          ...(includeExecAsk ? { execAsk } : {}),
        });
        return unwrapIntentPayload<unknown>(result);
      }
      return await syncGatewaySessionSettings({
        client: params.client,
        sessionKey: normalizedSessionKey,
        ...(includeModel ? { model } : {}),
        ...(includeThinkingLevel ? { thinkingLevel } : {}),
        ...(includeExecHost ? { execHost } : {}),
        ...(includeExecSecurity ? { execSecurity } : {}),
        ...(includeExecAsk ? { execAsk } : {}),
      });
    },
    agentCreate: async ({ name }) => {
      const normalizedName = requireNonEmpty(name, "Agent name");
      if (params.useDomainIntents) {
        const payload = unwrapIntentPayload<{ agentId?: unknown; name?: unknown }>(
          await postIntent("/api/intents/agent-create", { name: normalizedName })
        );
        const agentId = resolveSafeAgentId(payload?.agentId) ?? "";
        if (!agentId) {
          throw new Error("Agent create response missing or invalid agentId.");
        }
        const resolvedName =
          typeof payload?.name === "string" && payload.name.trim()
            ? payload.name.trim()
            : normalizedName;
        return { id: agentId, name: resolvedName };
      }
      const created = await createGatewayAgent({
        client: params.client,
        name: normalizedName,
      });
      const createdName =
        typeof created.name === "string" && created.name.trim()
          ? created.name.trim()
          : normalizedName;
      return { id: created.id, name: createdName };
    },
    chatAbort: async ({ sessionKey, runId }) => {
      const normalizedSessionKey = requireSafeSessionKey(sessionKey);
      const normalizedRunId = typeof runId === "string" ? runId.trim() : "";
      const payload = normalizedRunId
        ? { sessionKey: normalizedSessionKey, runId: normalizedRunId }
        : { sessionKey: normalizedSessionKey };
      if (params.useDomainIntents) {
        await postIntent("/api/intents/chat-abort", payload);
        return;
      }
      await callLegacyGateway(params.client, "chat.abort", payload);
    },
    sessionsReset: async ({ key }) => {
      const normalizedSessionKey = requireSafeSessionKey(key);
      if (params.useDomainIntents) {
        await postIntent("/api/intents/sessions-reset", { key: normalizedSessionKey });
        return;
      }
      await callLegacyGateway(params.client, "sessions.reset", { key: normalizedSessionKey });
    },
    agentRename: async ({ agentId, name }) => {
      const normalizedAgentId = requireNonEmpty(agentId, "Agent id");
      const normalizedName = requireNonEmpty(name, "Agent name");
      if (params.useDomainIntents) {
        await postIntent("/api/intents/agent-rename", {
          agentId: normalizedAgentId,
          name: normalizedName,
        });
        return;
      }
      await renameGatewayAgent({
        client: params.client,
        agentId: normalizedAgentId,
        name: normalizedName,
      });
    },
    agentDelete: async ({ agentId }) => {
      const normalizedAgentId = requireNonEmpty(agentId, "Agent id");
      if (params.useDomainIntents) {
        await postIntent("/api/intents/agent-delete", { agentId: normalizedAgentId });
        return;
      }
      await deleteGatewayAgent({ client: params.client, agentId: normalizedAgentId });
    },
    execApprovalResolve: async ({ id, decision }) => {
      const normalizedId = requireNonEmpty(id, "Approval id");
      const normalizedDecision = resolveExecApprovalDecision(decision);
      if (params.useDomainIntents) {
        await postIntent("/api/intents/exec-approval-resolve", {
          id: normalizedId,
          decision: normalizedDecision,
        });
        return;
      }
      await callLegacyGateway(params.client, "exec.approval.resolve", {
        id: normalizedId,
        decision: normalizedDecision,
      });
    },
    execApprovalsSet: async ({ agentId, role }) => {
      const normalizedAgentId = requireNonEmpty(agentId, "Agent id");

      if (params.useDomainIntents) {
        throw new Error(
          "execApprovalsSet is not supported in domain intent mode; use agentPermissionsUpdate."
        );
      }

      const existingPolicy = await readGatewayAgentExecApprovals({
        client: params.client,
        agentId: normalizedAgentId,
      });
      const allowlist = existingPolicy?.allowlist ?? [];
      const nextPolicy = resolveExecApprovalsPolicyForRole({ role, allowlist });

      await upsertGatewayAgentExecApprovals({
        client: params.client,
        agentId: normalizedAgentId,
        policy: nextPolicy,
      });
    },
    agentPermissionsUpdate: async ({ agentId, sessionKey, commandMode, webAccess, fileTools }) => {
      const normalizedAgentId = requireNonEmpty(agentId, "Agent id");
      const normalizedSessionKey = requireSafeSessionKey(sessionKey);
      if (params.useDomainIntents) {
        await postIntent("/api/intents/agent-permissions-update", {
          agentId: normalizedAgentId,
          sessionKey: normalizedSessionKey,
          commandMode,
          webAccess,
          fileTools,
        });
        return;
      }
      throw new Error("agentPermissionsUpdate is only available in domain intent mode.");
    },
    agentWait: async ({ runId, timeoutMs }) => {
      const normalizedRunId = requireNonEmpty(runId, "Run id");
      if (params.useDomainIntents) {
        return unwrapIntentPayload<unknown>(
          await postIntent("/api/intents/agent-wait", {
            runId: normalizedRunId,
            ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
          })
        );
      }
      return await callLegacyGateway(params.client, "agent.wait", {
        runId: normalizedRunId,
        ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      });
    },
  };
}
