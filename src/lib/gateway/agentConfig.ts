import { isSafeAgentId, resolveCreatableOpenClawAgentId } from "@/lib/agents/agentIds";
import { GatewayResponseError, type GatewayClient } from "@/lib/gateway/GatewayClient";

type AgentHeartbeatActiveHours = {
  start: string;
  end: string;
};

type AgentHeartbeat = {
  every: string;
  target: string;
  includeReasoning: boolean;
  ackMaxChars?: number | null;
  activeHours?: AgentHeartbeatActiveHours | null;
};

type AgentHeartbeatResult = {
  heartbeat: AgentHeartbeat;
  hasOverride: boolean;
};

type AgentHeartbeatUpdatePayload = {
  override: boolean;
  heartbeat: AgentHeartbeat;
};

type AgentHeartbeatSummary = {
  id: string;
  agentId: string;
  source: "override" | "default";
  enabled: boolean;
  heartbeat: AgentHeartbeat;
};

type HeartbeatListResult = {
  heartbeats: AgentHeartbeatSummary[];
};

type HeartbeatWakeResult = { ok: true } | { ok: false };

type GatewayConfigSnapshot = {
  config?: Record<string, unknown>;
  hash?: string;
  exists?: boolean;
  path?: string | null;
};

type HeartbeatBlock = Record<string, unknown> | null | undefined;

const DEFAULT_EVERY = "30m";
const DEFAULT_TARGET = "last";
const DEFAULT_ACK_MAX_CHARS = 300;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

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

export type ConfigAgentEntry = Record<string, unknown> & { id: string };

type GatewayAgentSandboxOverrides = {
  mode?: "off" | "non-main" | "all";
  workspaceAccess?: "none" | "ro" | "rw";
};

type GatewayAgentToolsOverrides = {
  profile?: "minimal" | "coding" | "messaging" | "full";
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  sandbox?: {
    tools?: {
      allow?: string[];
      deny?: string[];
    };
  };
};

type GatewayAgentOverrides = {
  sandbox?: GatewayAgentSandboxOverrides;
  tools?: GatewayAgentToolsOverrides;
};

const DEFAULT_AGENT_ID = "main";

export const readConfigAgentList = (
  config: Record<string, unknown> | undefined
): ConfigAgentEntry[] => {
  if (!config) return [];
  const agents = isRecord(config.agents) ? config.agents : null;
  const list = Array.isArray(agents?.list) ? agents.list : [];
  return list.filter((entry): entry is ConfigAgentEntry => {
    if (!isRecord(entry)) return false;
    if (typeof entry.id !== "string") return false;
    return entry.id.trim().length > 0;
  });
};

export const resolveDefaultConfigAgentId = (
  config: Record<string, unknown> | undefined
): string => {
  const list = readConfigAgentList(config);
  if (list.length === 0) {
    return DEFAULT_AGENT_ID;
  }
  const defaults = list.filter((entry) => entry.default === true);
  const selected = defaults[0] ?? list[0];
  const resolved = selected.id.trim();
  return resolved || DEFAULT_AGENT_ID;
};

export const writeConfigAgentList = (
  config: Record<string, unknown>,
  list: ConfigAgentEntry[]
): Record<string, unknown> => {
  const agents = isRecord(config.agents) ? { ...config.agents } : {};
  return { ...config, agents: { ...agents, list } };
};

export const upsertConfigAgentEntry = (
  list: ConfigAgentEntry[],
  agentId: string,
  updater: (entry: ConfigAgentEntry) => ConfigAgentEntry
): { list: ConfigAgentEntry[]; entry: ConfigAgentEntry } => {
  let updatedEntry: ConfigAgentEntry | null = null;
  const nextList = list.map((entry) => {
    if (entry.id !== agentId) return entry;
    const next = updater({ ...entry, id: agentId });
    updatedEntry = next;
    return next;
  });
  if (!updatedEntry) {
    updatedEntry = updater({ id: agentId });
    nextList.push(updatedEntry);
  }
  return { list: nextList, entry: updatedEntry };
};

export const slugifyAgentName = (name: string): string => {
  return resolveCreatableOpenClawAgentId(name);
};

const coerceString = (value: unknown) => (typeof value === "string" ? value : undefined);
const coerceBoolean = (value: unknown) =>
  typeof value === "boolean" ? value : undefined;
const coerceNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const coerceActiveHours = (value: unknown) => {
  if (!isRecord(value)) return undefined;
  const start = coerceString(value.start);
  const end = coerceString(value.end);
  if (!start || !end) return undefined;
  return { start, end };
};

const mergeHeartbeat = (defaults: HeartbeatBlock, override: HeartbeatBlock) => {
  const merged = {
    ...(defaults ?? {}),
    ...(override ?? {}),
  } as Record<string, unknown>;
  if (override && typeof override === "object" && "activeHours" in override) {
    merged.activeHours = (override as Record<string, unknown>).activeHours;
  } else if (defaults && typeof defaults === "object" && "activeHours" in defaults) {
    merged.activeHours = (defaults as Record<string, unknown>).activeHours;
  }
  return merged;
};

const normalizeHeartbeat = (
  defaults: HeartbeatBlock,
  override: HeartbeatBlock
): AgentHeartbeatResult => {
  const resolved = mergeHeartbeat(defaults, override);
  const every = coerceString(resolved.every) ?? DEFAULT_EVERY;
  const target = coerceString(resolved.target) ?? DEFAULT_TARGET;
  const includeReasoning = coerceBoolean(resolved.includeReasoning) ?? false;
  const ackMaxChars = coerceNumber(resolved.ackMaxChars) ?? DEFAULT_ACK_MAX_CHARS;
  const activeHours = coerceActiveHours(resolved.activeHours) ?? null;
  return {
    heartbeat: {
      every,
      target,
      includeReasoning,
      ackMaxChars,
      activeHours,
    },
    hasOverride: Boolean(override && typeof override === "object"),
  };
};

const readHeartbeatDefaults = (config: Record<string, unknown>): HeartbeatBlock => {
  const agents = isRecord(config.agents) ? config.agents : null;
  const defaults = agents && isRecord(agents.defaults) ? agents.defaults : null;
  return (defaults?.heartbeat ?? null) as HeartbeatBlock;
};

const buildHeartbeatOverride = (payload: AgentHeartbeat): Record<string, unknown> => {
  const nextHeartbeat: Record<string, unknown> = {
    every: payload.every,
    target: payload.target,
    includeReasoning: payload.includeReasoning,
  };
  if (payload.ackMaxChars !== undefined && payload.ackMaxChars !== null) {
    nextHeartbeat.ackMaxChars = payload.ackMaxChars;
  }
  if (payload.activeHours) {
    nextHeartbeat.activeHours = {
      start: payload.activeHours.start,
      end: payload.activeHours.end,
    };
  }
  return nextHeartbeat;
};

export const resolveHeartbeatSettings = (
  config: Record<string, unknown>,
  agentId: string
): AgentHeartbeatResult => {
  const list = readConfigAgentList(config);
  const entry = list.find((item) => item.id === agentId) ?? null;
  const defaults = readHeartbeatDefaults(config);
  const override =
    entry && typeof entry === "object"
      ? ((entry as Record<string, unknown>).heartbeat as HeartbeatBlock)
      : null;
  return normalizeHeartbeat(defaults, override);
};

type GatewayStatusHeartbeatAgent = {
  agentId?: string;
  enabled?: boolean;
  every?: string;
  everyMs?: number | null;
};

type GatewayStatusSnapshot = {
  heartbeat?: {
    agents?: GatewayStatusHeartbeatAgent[];
  };
};

const resolveGatewayAgentId = (agentId: string) => {
  const trimmed = agentId.trim();
  if (!trimmed) {
    throw new Error("Agent id is required.");
  }
  if (!isSafeAgentId(trimmed)) {
    throw new Error(`Invalid agentId: ${trimmed}`);
  }
  return trimmed;
};

const resolveStatusHeartbeatAgent = (
  status: GatewayStatusSnapshot,
  agentId: string
): GatewayStatusHeartbeatAgent | null => {
  const list = Array.isArray(status.heartbeat?.agents) ? status.heartbeat?.agents : [];
  for (const entry of list) {
    if (!entry || typeof entry.agentId !== "string") continue;
    if (entry.agentId.trim() !== agentId) continue;
    return entry;
  }
  return null;
};

export const listHeartbeatsForAgent = async (
  client: GatewayClient,
  agentId: string
): Promise<HeartbeatListResult> => {
  const resolvedAgentId = resolveGatewayAgentId(agentId);
  const [snapshot, status] = await Promise.all([
    callGateway<GatewayConfigSnapshot>(client, "config.get", {}),
    callGateway<GatewayStatusSnapshot>(client, "status", {}),
  ]);
  const config = isRecord(snapshot.config) ? snapshot.config : {};
  const resolved = resolveHeartbeatSettings(config, resolvedAgentId);
  const statusHeartbeat = resolveStatusHeartbeatAgent(status, resolvedAgentId);
  const enabled = Boolean(statusHeartbeat?.enabled);
  const every = typeof statusHeartbeat?.every === "string" ? statusHeartbeat.every.trim() : "";
  const heartbeat = every ? { ...resolved.heartbeat, every } : resolved.heartbeat;
  if (!enabled && !resolved.hasOverride) {
    return { heartbeats: [] };
  }
  return {
    heartbeats: [
      {
        id: resolvedAgentId,
        agentId: resolvedAgentId,
        source: resolved.hasOverride ? "override" : "default",
        enabled,
        heartbeat,
      },
    ],
  };
};

export const triggerHeartbeatNow = async (
  client: GatewayClient,
  agentId: string
): Promise<HeartbeatWakeResult> => {
  const resolvedAgentId = resolveGatewayAgentId(agentId);
  return callGateway<HeartbeatWakeResult>(client, "wake", {
    mode: "now",
    text: `OpenClaw Studio heartbeat trigger (${resolvedAgentId}).`,
  });
};

const shouldRetryConfigWrite = (err: unknown) => {
  if (!(err instanceof GatewayResponseError)) return false;
  return /re-run config\.get|config changed since last load/i.test(err.message);
};

const applyGatewayConfigPatch = async (params: {
  client: GatewayClient;
  buildPatch: (snapshot: GatewayConfigSnapshot) => {
    patch: Record<string, unknown>;
    resolvedConfig: Record<string, unknown>;
  } | null;
  attempt?: number;
}): Promise<Record<string, unknown> | null> => {
  const attempt = params.attempt ?? 0;
  const snapshot = await callGateway<GatewayConfigSnapshot>(params.client, "config.get", {});
  const snapshotConfig = isRecord(snapshot.config) ? snapshot.config : {};
  const plan = params.buildPatch(snapshot);
  if (!plan) return snapshotConfig;
  const requiresBaseHash = snapshot.exists !== false;
  const baseHash = requiresBaseHash ? snapshot.hash?.trim() : undefined;
  if (requiresBaseHash && !baseHash) {
    throw new Error("Gateway config hash unavailable; re-run config.get.");
  }
  const payload: Record<string, unknown> = {
    raw: JSON.stringify(plan.patch, null, 2),
  };
  if (baseHash) payload.baseHash = baseHash;
  try {
    await callGateway(params.client, "config.patch", payload);
    return plan.resolvedConfig;
  } catch (err) {
    if (attempt < 1 && shouldRetryConfigWrite(err)) {
      return applyGatewayConfigPatch({
        ...params,
        attempt: attempt + 1,
      });
    }
    throw err;
  }
};

export const renameGatewayAgent = async (params: {
  client: GatewayClient;
  agentId: string;
  name: string;
}) => {
  const agentId = resolveGatewayAgentId(params.agentId);
  const trimmed = params.name.trim();
  if (!trimmed) {
    throw new Error("Agent name is required.");
  }
  await callGateway(params.client, "agents.update", {
    agentId,
    name: trimmed,
  });
  return { id: agentId, name: trimmed };
};

const dirnameLike = (value: string): string => {
  const lastSlash = value.lastIndexOf("/");
  const lastBackslash = value.lastIndexOf("\\");
  const idx = Math.max(lastSlash, lastBackslash);
  if (idx < 0) return "";
  return value.slice(0, idx);
};

const joinPathLike = (dir: string, leaf: string): string => {
  const sep = dir.includes("\\") ? "\\" : "/";
  const trimmedDir = dir.endsWith("/") || dir.endsWith("\\") ? dir.slice(0, -1) : dir;
  return `${trimmedDir}${sep}${leaf}`;
};

export const createGatewayAgent = async (params: {
  client: GatewayClient;
  name: string;
}): Promise<ConfigAgentEntry> => {
  const trimmed = params.name.trim();
  if (!trimmed) {
    throw new Error("Agent name is required.");
  }
  const idGuess = slugifyAgentName(trimmed);

  const snapshot = await callGateway<GatewayConfigSnapshot>(params.client, "config.get", {});
  const configPath = typeof snapshot.path === "string" ? snapshot.path.trim() : "";
  if (!configPath) {
    throw new Error(
      'Gateway did not return a config path; cannot compute a default workspace for "agents.create".',
    );
  }
  const stateDir = dirnameLike(configPath);
  if (!stateDir) {
    throw new Error(
      `Gateway config path "${configPath}" is missing a directory; cannot compute workspace.`,
    );
  }
  const workspace = joinPathLike(stateDir, `workspace-${idGuess}`);

  const result = await callGateway<{ ok?: boolean; agentId?: string; name?: string; workspace?: string }>(
    params.client,
    "agents.create",
    {
      name: trimmed,
      workspace,
    }
  );
  const agentIdRaw = typeof result?.agentId === "string" ? result.agentId.trim() : "";
  if (!agentIdRaw) {
    throw new Error("Gateway returned an invalid agents.create response (missing agentId).");
  }
  const agentId = resolveGatewayAgentId(agentIdRaw);
  return { id: agentId, name: trimmed };
};

export const deleteGatewayAgent = async (params: {
  client: GatewayClient;
  agentId: string;
}) => {
  const agentId = resolveGatewayAgentId(params.agentId);
  try {
    const result = await callGateway<{ ok?: boolean; removedBindings?: unknown }>(params.client, "agents.delete", {
      agentId,
    });
    const removedBindings =
      typeof result?.removedBindings === "number" && Number.isFinite(result.removedBindings)
        ? Math.max(0, Math.floor(result.removedBindings))
        : 0;
    return { removed: true, removedBindings };
  } catch (err) {
    if (err instanceof GatewayResponseError && /not found/i.test(err.message)) {
      return { removed: false, removedBindings: 0 };
    }
    throw err;
  }
};

export const updateGatewayHeartbeat = async (params: {
  client: GatewayClient;
  agentId: string;
  payload: AgentHeartbeatUpdatePayload;
}): Promise<AgentHeartbeatResult> => {
  const agentId = resolveGatewayAgentId(params.agentId);
  const nextConfig = await applyGatewayConfigPatch({
    client: params.client,
    buildPatch: (snapshot) => {
      const baseConfig = isRecord(snapshot.config) ? snapshot.config : {};
      const list = readConfigAgentList(baseConfig);
      const { list: nextList } = upsertConfigAgentEntry(list, agentId, (entry) => {
        const next = { ...entry };
        if (params.payload.override) {
          next.heartbeat = buildHeartbeatOverride(params.payload.heartbeat);
        } else if ("heartbeat" in next) {
          delete next.heartbeat;
        }
        return next;
      });
      return {
        patch: { agents: { list: nextList } },
        resolvedConfig: writeConfigAgentList(baseConfig, nextList),
      };
    },
  });
  return resolveHeartbeatSettings(nextConfig ?? {}, agentId);
};

export const removeGatewayHeartbeatOverride = async (params: {
  client: GatewayClient;
  agentId: string;
}): Promise<AgentHeartbeatResult> => {
  const agentId = resolveGatewayAgentId(params.agentId);
  const nextConfig = await applyGatewayConfigPatch({
    client: params.client,
    buildPatch: (currentSnapshot) => {
      const baseConfig = isRecord(currentSnapshot.config) ? currentSnapshot.config : {};
      const list = readConfigAgentList(baseConfig);
      const nextList = list.map((entry) => {
        if (entry.id !== agentId) return entry;
        if (!("heartbeat" in entry)) return entry;
        const next = { ...entry };
        delete next.heartbeat;
        return next;
      });
      const changed = nextList.some((entry, index) => entry !== list[index]);
      if (!changed) return null;
      return {
        patch: { agents: { list: nextList } },
        resolvedConfig: writeConfigAgentList(baseConfig, nextList),
      };
    },
  });
  return resolveHeartbeatSettings(nextConfig ?? {}, agentId);
};

const normalizeToolList = (values: string[] | undefined): string[] | undefined => {
  if (!values) return undefined;
  const next = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(next));
};

export const updateGatewayAgentOverrides = async (params: {
  client: GatewayClient;
  agentId: string;
  overrides: GatewayAgentOverrides;
}): Promise<void> => {
  const agentId = resolveGatewayAgentId(params.agentId);
  if (params.overrides.tools?.allow !== undefined && params.overrides.tools?.alsoAllow !== undefined) {
    throw new Error("Agent tools overrides cannot set both allow and alsoAllow.");
  }
  const hasSandboxOverrides =
    Boolean(params.overrides.sandbox?.mode) || Boolean(params.overrides.sandbox?.workspaceAccess);
  const hasToolsOverrides =
    Boolean(params.overrides.tools?.profile) ||
    params.overrides.tools?.allow !== undefined ||
    params.overrides.tools?.alsoAllow !== undefined ||
    params.overrides.tools?.deny !== undefined ||
    params.overrides.tools?.sandbox?.tools?.allow !== undefined ||
    params.overrides.tools?.sandbox?.tools?.deny !== undefined;
  if (!hasSandboxOverrides && !hasToolsOverrides) {
    return;
  }

  const buildNextConfig = (baseConfig: Record<string, unknown>): Record<string, unknown> => {
    const list = readConfigAgentList(baseConfig);
    const { list: nextList } = upsertConfigAgentEntry(list, agentId, (entry) => {
      const next: ConfigAgentEntry = { ...entry, id: agentId };

      if (hasSandboxOverrides) {
        const currentSandbox = isRecord(next.sandbox) ? { ...next.sandbox } : {};
        if (params.overrides.sandbox?.mode) {
          currentSandbox.mode = params.overrides.sandbox.mode;
        }
        if (params.overrides.sandbox?.workspaceAccess) {
          currentSandbox.workspaceAccess = params.overrides.sandbox.workspaceAccess;
        }
        next.sandbox = currentSandbox;
      }

      if (hasToolsOverrides) {
        const currentTools = isRecord(next.tools) ? { ...next.tools } : {};
        if (params.overrides.tools?.profile) {
          currentTools.profile = params.overrides.tools.profile;
        }
        const allow = normalizeToolList(params.overrides.tools?.allow);
        if (allow !== undefined) {
          currentTools.allow = allow;
          delete currentTools.alsoAllow;
        }
        const alsoAllow = normalizeToolList(params.overrides.tools?.alsoAllow);
        if (alsoAllow !== undefined) {
          currentTools.alsoAllow = alsoAllow;
          delete currentTools.allow;
        }
        const deny = normalizeToolList(params.overrides.tools?.deny);
        if (deny !== undefined) {
          currentTools.deny = deny;
        }

        const sandboxAllow = normalizeToolList(params.overrides.tools?.sandbox?.tools?.allow);
        const sandboxDeny = normalizeToolList(params.overrides.tools?.sandbox?.tools?.deny);
        if (sandboxAllow !== undefined || sandboxDeny !== undefined) {
          const sandboxRaw = (currentTools as Record<string, unknown>).sandbox;
          const sandbox = isRecord(sandboxRaw) ? { ...sandboxRaw } : {};
          const sandboxToolsRaw = (sandbox as Record<string, unknown>).tools;
          const sandboxTools = isRecord(sandboxToolsRaw) ? { ...sandboxToolsRaw } : {};
          if (sandboxAllow !== undefined) {
            (sandboxTools as Record<string, unknown>).allow = sandboxAllow;
          }
          if (sandboxDeny !== undefined) {
            (sandboxTools as Record<string, unknown>).deny = sandboxDeny;
          }
          (sandbox as Record<string, unknown>).tools = sandboxTools;
          (currentTools as Record<string, unknown>).sandbox = sandbox;
        }
        next.tools = currentTools;
      }

      return next;
    });
    return writeConfigAgentList(baseConfig, nextList);
  };

  const attemptWrite = async (attempt: number): Promise<void> => {
    const snapshot = await callGateway<GatewayConfigSnapshot>(params.client, "config.get", {});
    const baseConfig = isRecord(snapshot.config) ? snapshot.config : {};
    const nextConfig = buildNextConfig(baseConfig);
    const payload: Record<string, unknown> = {
      raw: JSON.stringify(nextConfig, null, 2),
    };
    const requiresBaseHash = snapshot.exists !== false;
    const baseHash = requiresBaseHash ? snapshot.hash?.trim() : undefined;
    if (requiresBaseHash && !baseHash) {
      throw new Error("Gateway config hash unavailable; re-run config.get.");
    }
    if (baseHash) payload.baseHash = baseHash;
    try {
      await callGateway(params.client, "config.set", payload);
    } catch (err) {
      if (attempt < 1 && shouldRetryConfigWrite(err)) {
        return attemptWrite(attempt + 1);
      }
      throw err;
    }
  };

  await attemptWrite(0);
};
