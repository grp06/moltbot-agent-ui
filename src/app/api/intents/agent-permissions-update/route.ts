import { NextResponse } from "next/server";

import {
  ensureDomainIntentRuntime,
  parseIntentBody,
} from "@/lib/controlplane/intent-route";
import { isSafeAgentId } from "@/lib/agents/agentIds";
import {
  upsertAgentExecApprovalsPolicyViaRuntime,
  type ExecutionRoleId,
} from "@/lib/controlplane/exec-approvals";
import { ControlPlaneGatewayError } from "@/lib/controlplane/openclaw-adapter";
import type { ControlPlaneRuntime } from "@/lib/controlplane/runtime";
import { sessionKeyBelongsToAgent } from "@/lib/gateway/session-keys";

export const runtime = "nodejs";

type CommandModeId = "off" | "ask" | "auto";
type GatewayConfigSnapshot = {
  config?: unknown;
  hash?: string;
  exists?: boolean;
};
type ConfigAgentEntry = Record<string, unknown> & { id: string };
type GatewayAgentToolsOverrides = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
};
type ToolGroupOverrideInput = {
  runtimeEnabled: boolean;
  webEnabled: boolean;
  fsEnabled: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const coerceStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const normalizeToolList = (values: string[] | undefined): string[] | undefined => {
  if (!values) return undefined;
  const next = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(next));
};

const readConfigAgentList = (config: Record<string, unknown> | undefined): ConfigAgentEntry[] => {
  if (!config) return [];
  const agentsRaw = config.agents;
  const agents = isRecord(agentsRaw) ? agentsRaw : null;
  const list = Array.isArray(agents?.list) ? agents.list : [];
  return list.filter((entry): entry is ConfigAgentEntry => {
    if (!isRecord(entry)) return false;
    if (typeof entry.id !== "string") return false;
    return entry.id.trim().length > 0;
  });
};

const writeConfigAgentList = (
  config: Record<string, unknown>,
  list: ConfigAgentEntry[]
): Record<string, unknown> => {
  const agents = isRecord(config.agents) ? { ...config.agents } : {};
  return { ...config, agents: { ...agents, list } };
};

const upsertConfigAgentEntry = (
  list: ConfigAgentEntry[],
  agentId: string,
  updater: (entry: ConfigAgentEntry) => ConfigAgentEntry
): ConfigAgentEntry[] => {
  let found = false;
  const nextList = list.map((entry) => {
    if (entry.id !== agentId) return entry;
    found = true;
    return updater({ ...entry, id: agentId });
  });
  if (!found) {
    nextList.push(updater({ id: agentId }));
  }
  return nextList;
};

const resolveRoleForCommandMode = (mode: CommandModeId): ExecutionRoleId => {
  if (mode === "auto") return "autonomous";
  if (mode === "ask") return "collaborative";
  return "conservative";
};

const resolveToolGroupOverrides = (params: {
  existingTools: unknown;
  runtimeEnabled: boolean;
  webEnabled: boolean;
  fsEnabled: boolean;
}): { tools: GatewayAgentToolsOverrides } => {
  const tools = isRecord(params.existingTools) ? params.existingTools : null;
  const existingAllow = coerceStringArray(tools?.allow);
  const existingAlsoAllow = coerceStringArray(tools?.alsoAllow);
  const existingDeny = coerceStringArray(tools?.deny) ?? [];

  const usesAllow = existingAllow !== null;
  const allowed = new Set(usesAllow ? existingAllow : existingAlsoAllow ?? []);
  const denied = new Set(existingDeny);

  const applyGroup = (group: "group:runtime" | "group:web" | "group:fs", enabled: boolean) => {
    if (enabled) {
      allowed.add(group);
      denied.delete(group);
      return;
    }
    allowed.delete(group);
    denied.add(group);
  };

  applyGroup("group:runtime", params.runtimeEnabled);
  applyGroup("group:web", params.webEnabled);
  applyGroup("group:fs", params.fsEnabled);

  const allowedList = Array.from(allowed);
  const denyList = Array.from(denied).filter((entry) => !allowed.has(entry));
  return {
    tools: usesAllow
      ? { allow: allowedList, deny: denyList }
      : { alsoAllow: allowedList, deny: denyList },
  };
};

const resolveSessionExecSettingsForRole = (params: {
  role: ExecutionRoleId;
  sandboxMode: string;
}) => {
  if (params.role === "conservative") {
    return { execHost: null, execSecurity: "deny" as const, execAsk: "off" as const };
  }
  const normalizedMode = params.sandboxMode.trim().toLowerCase();
  const execHost = normalizedMode === "all" ? "sandbox" : "gateway";
  if (params.role === "autonomous") {
    return { execHost, execSecurity: "full" as const, execAsk: "off" as const };
  }
  return { execHost, execSecurity: "allowlist" as const, execAsk: "always" as const };
};

const resolveConfigAgentSandboxMode = (
  config: Record<string, unknown>,
  agentId: string
): string => {
  const list = readConfigAgentList(config);
  const configEntry = list.find((entry) => entry.id === agentId) ?? null;
  const sandboxRaw =
    configEntry && isRecord(configEntry.sandbox)
      ? (configEntry.sandbox as Record<string, unknown>)
      : null;
  return typeof sandboxRaw?.mode === "string" ? sandboxRaw.mode : "";
};

const isConfigConflict = (err: unknown): boolean => {
  if (!(err instanceof ControlPlaneGatewayError)) return false;
  if (err.code.trim().toUpperCase() !== "INVALID_REQUEST") return false;
  const message = err.message.toLowerCase();
  return (
    message.includes("basehash") ||
    message.includes("base hash") ||
    message.includes("changed since last load") ||
    message.includes("re-run config.get")
  );
};

const isGatewayUnavailable = (err: unknown): boolean =>
  err instanceof ControlPlaneGatewayError && err.code.trim().toUpperCase() === "GATEWAY_UNAVAILABLE";

const buildConfigSetPayload = (params: {
  config: Record<string, unknown>;
  hash?: string;
  exists?: boolean;
}): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    raw: JSON.stringify(params.config, null, 2),
  };
  if (params.exists !== false) {
    const baseHash = params.hash?.trim();
    if (!baseHash) {
      throw new Error("Gateway config hash unavailable; re-run config.get.");
    }
    payload.baseHash = baseHash;
  }
  return payload;
};

const applyAgentToolsOverrides = async (params: {
  runtime: ControlPlaneRuntime;
  agentId: string;
  baseConfig: Record<string, unknown>;
  snapshotHash?: string;
  snapshotExists?: boolean;
  toolGroups: ToolGroupOverrideInput;
  attempt?: number;
}): Promise<{ sandboxMode: string }> => {
  const attempt = params.attempt ?? 0;
  const list = readConfigAgentList(params.baseConfig);
  const nextList = upsertConfigAgentEntry(list, params.agentId, (entry) => {
    const next: ConfigAgentEntry = { ...entry, id: params.agentId };
    const overrides = resolveToolGroupOverrides({
      existingTools: next.tools,
      runtimeEnabled: params.toolGroups.runtimeEnabled,
      webEnabled: params.toolGroups.webEnabled,
      fsEnabled: params.toolGroups.fsEnabled,
    }).tools;
    const currentTools = isRecord(next.tools) ? { ...next.tools } : {};
    const allow = normalizeToolList(overrides.allow);
    if (allow !== undefined) {
      currentTools.allow = allow;
      delete currentTools.alsoAllow;
    }
    const alsoAllow = normalizeToolList(overrides.alsoAllow);
    if (alsoAllow !== undefined) {
      currentTools.alsoAllow = alsoAllow;
      delete currentTools.allow;
    }
    const deny = normalizeToolList(overrides.deny);
    if (deny !== undefined) {
      currentTools.deny = deny;
    }
    next.tools = currentTools;
    return next;
  });
  const nextConfig = writeConfigAgentList(params.baseConfig, nextList);
  const payload = buildConfigSetPayload({
    config: nextConfig,
    hash: params.snapshotHash,
    exists: params.snapshotExists,
  });
  try {
    await params.runtime.callGateway("config.set", payload);
    return {
      sandboxMode: resolveConfigAgentSandboxMode(nextConfig, params.agentId),
    };
  } catch (err) {
    if (attempt >= 1 || !isConfigConflict(err)) {
      throw err;
    }
    const retrySnapshot = await params.runtime.callGateway<GatewayConfigSnapshot>("config.get", {});
    const retryConfig = isRecord(retrySnapshot.config)
      ? (retrySnapshot.config as Record<string, unknown>)
      : {};
    return await applyAgentToolsOverrides({
      ...params,
      baseConfig: retryConfig,
      snapshotHash: retrySnapshot.hash,
      snapshotExists: retrySnapshot.exists,
      attempt: attempt + 1,
    });
  }
};

export async function POST(request: Request) {
  const bodyOrError = await parseIntentBody(request);
  if (bodyOrError instanceof Response) {
    return bodyOrError as NextResponse;
  }

  const agentId = typeof bodyOrError.agentId === "string" ? bodyOrError.agentId.trim() : "";
  const sessionKey =
    typeof bodyOrError.sessionKey === "string" ? bodyOrError.sessionKey.trim() : "";
  const commandMode =
    typeof bodyOrError.commandMode === "string" ? bodyOrError.commandMode.trim() : "";
  const webAccess = typeof bodyOrError.webAccess === "boolean" ? bodyOrError.webAccess : null;
  const fileTools = typeof bodyOrError.fileTools === "boolean" ? bodyOrError.fileTools : null;
  if (!agentId || !sessionKey) {
    return NextResponse.json({ error: "agentId and sessionKey are required." }, { status: 400 });
  }
  if (!isSafeAgentId(agentId)) {
    return NextResponse.json({ error: `Invalid agentId: ${agentId}` }, { status: 400 });
  }
  if (!sessionKeyBelongsToAgent(sessionKey, agentId)) {
    return NextResponse.json(
      { error: "sessionKey does not match agentId." },
      { status: 400 }
    );
  }
  if (commandMode !== "off" && commandMode !== "ask" && commandMode !== "auto") {
    return NextResponse.json({ error: "commandMode must be one of: off, ask, auto." }, { status: 400 });
  }
  if (webAccess === null || fileTools === null) {
    return NextResponse.json({ error: "webAccess and fileTools must be boolean values." }, { status: 400 });
  }

  const runtimeOrError = await ensureDomainIntentRuntime();
  if (runtimeOrError instanceof Response) {
    return runtimeOrError as NextResponse;
  }

  try {
    const role = resolveRoleForCommandMode(commandMode as CommandModeId);
    const snapshot = await runtimeOrError.callGateway<GatewayConfigSnapshot>("config.get", {});
    const baseConfig = isRecord(snapshot.config) ? (snapshot.config as Record<string, unknown>) : {};
    const { sandboxMode } = await applyAgentToolsOverrides({
      runtime: runtimeOrError,
      agentId,
      baseConfig,
      snapshotHash: snapshot.hash,
      snapshotExists: snapshot.exists,
      toolGroups: {
        runtimeEnabled: role !== "conservative",
        webEnabled: webAccess,
        fsEnabled: fileTools,
      },
    });

    const execSettings = resolveSessionExecSettingsForRole({ role, sandboxMode });
    await runtimeOrError.callGateway("sessions.patch", {
      key: sessionKey,
      execHost: execSettings.execHost,
      execSecurity: execSettings.execSecurity,
      execAsk: execSettings.execAsk,
    });
    await upsertAgentExecApprovalsPolicyViaRuntime({
      runtime: runtimeOrError,
      agentId,
      role,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isGatewayUnavailable(err)) {
      return NextResponse.json(
        { error: "Gateway is unavailable.", code: "GATEWAY_UNAVAILABLE", reason: "gateway_unavailable" },
        { status: 503 }
      );
    }
    if (isConfigConflict(err)) {
      const message = err instanceof Error ? err.message : "config conflict";
      return NextResponse.json(
        { error: message, code: "INVALID_REQUEST", conflict: "base_hash_mismatch" },
        { status: 409 }
      );
    }
    const message = err instanceof Error ? err.message : "agent_permissions_update_failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
