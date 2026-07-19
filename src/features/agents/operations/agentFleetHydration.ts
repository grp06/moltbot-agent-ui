import { buildAgentMainSessionKey } from "@/lib/gateway/session-keys";
import { type GatewayModelPolicySnapshot } from "@/lib/gateway/models";
import { type StudioSettings } from "@/lib/studio/settings";
import {
  type SummaryPreviewSnapshot,
  type SummarySnapshotPatch,
  type SummaryStatusSnapshot,
} from "@/features/agents/state/runtimeEventBridge";
import type { AgentStoreSeed } from "@/features/agents/state/store";
import {
  deriveHydrateAgentFleetResult,
  normalizeAgentsListResultForHydration,
} from "@/features/agents/operations/agentFleetHydrationDerivation";

type GatewayClientLike = {
  call: (method: string, params: unknown) => Promise<unknown>;
};

const callGateway = async <T>(
  client: GatewayClientLike,
  method: string,
  params: unknown
): Promise<T> => {
  const invoke = (
    client as unknown as { call?: (nextMethod: string, nextParams: unknown) => Promise<unknown> }
  ).call;
  if (typeof invoke !== "function") {
    throw new Error("Gateway call transport is unavailable.");
  }
  return (await invoke(method, params)) as T;
};

type AgentsListResult = {
  defaultId: string;
  mainKey: string;
  scope?: string;
  agents: Array<{
    id: string;
    name?: string;
    identity?: {
      name?: string;
      theme?: string;
      emoji?: string;
      avatar?: string;
      avatarUrl?: string;
    };
  }>;
};

type SessionsListEntry = {
  key: string;
  updatedAt?: number | null;
  displayName?: string;
  origin?: { label?: string | null; provider?: string | null } | null;
  thinkingLevel?: string;
  modelProvider?: string;
  model?: string;
  execHost?: string | null;
  execSecurity?: string | null;
  execAsk?: string | null;
};

type SessionsListResult = {
  sessions?: SessionsListEntry[];
};

type ExecApprovalsSnapshot = {
  file?: {
    agents?: Record<string, { security?: string | null; ask?: string | null }>;
  };
};

type HydrateAgentFleetResult = {
  seeds: AgentStoreSeed[];
  sessionCreatedAgentIds: string[];
  sessionSettingsSyncedAgentIds: string[];
  summaryPatches: SummarySnapshotPatch[];
  suggestedSelectedAgentId: string | null;
  configSnapshot: GatewayModelPolicySnapshot | null;
};

const SUMMARY_PREVIEW_LIMIT = 8;
const SUMMARY_PREVIEW_MAX_CHARS = 240;

export async function hydrateAgentFleetFromGateway(params: {
  client: GatewayClientLike;
  gatewayUrl: string;
  cachedConfigSnapshot: GatewayModelPolicySnapshot | null;
  loadStudioSettings: () => Promise<StudioSettings | null>;
  isDisconnectLikeError: (err: unknown) => boolean;
  logError?: (message: string, error: unknown) => void;
}): Promise<HydrateAgentFleetResult> {
  const logError = params.logError ?? ((message, error) => console.error(message, error));

  let configSnapshot = params.cachedConfigSnapshot;
  if (!configSnapshot) {
    try {
      configSnapshot = await callGateway<GatewayModelPolicySnapshot>(
        params.client,
        "config.get",
        {}
      );
    } catch (err) {
      if (!params.isDisconnectLikeError(err)) {
        logError("Failed to load gateway config while loading agents.", err);
      }
    }
  }

  const gatewayKey = params.gatewayUrl.trim();
  let settings: StudioSettings | null = null;
  if (gatewayKey) {
    try {
      settings = await params.loadStudioSettings();
    } catch (err) {
      logError("Failed to load studio settings while loading agents.", err);
    }
  }

  let execApprovalsSnapshot: ExecApprovalsSnapshot | null = null;
  try {
    execApprovalsSnapshot = await callGateway<ExecApprovalsSnapshot>(
      params.client,
      "exec.approvals.get",
      {}
    );
  } catch (err) {
    if (!params.isDisconnectLikeError(err)) {
      logError("Failed to load exec approvals while loading agents.", err);
    }
  }

  const agentsResultRaw = await callGateway<AgentsListResult>(params.client, "agents.list", {});
  const agentsResult = normalizeAgentsListResultForHydration(agentsResultRaw);
  const mainKey = agentsResult.mainKey?.trim() || "main";

  const mainSessionKeyByAgent = new Map<string, SessionsListEntry | null>();
  if (agentsResult.agents.length > 0) {
    try {
      const sessions = await callGateway<SessionsListResult>(params.client, "sessions.list", {
        includeGlobal: false,
        includeUnknown: false,
        search: `:${mainKey}`,
      });
      const entries = Array.isArray(sessions.sessions) ? sessions.sessions : [];
      const bySessionKey = new Map<string, SessionsListEntry>();
      for (const entry of entries) {
        const key = typeof entry.key === "string" ? entry.key.trim() : "";
        if (!key || bySessionKey.has(key)) continue;
        bySessionKey.set(key, entry);
      }
      for (const agent of agentsResult.agents) {
        const expectedMainKey = buildAgentMainSessionKey(agent.id, mainKey);
        mainSessionKeyByAgent.set(agent.id, bySessionKey.get(expectedMainKey) ?? null);
      }
    } catch (err) {
      if (!params.isDisconnectLikeError(err)) {
        logError("Failed to list sessions while resolving fleet sessions.", err);
      }
      for (const agent of agentsResult.agents) {
        mainSessionKeyByAgent.set(agent.id, null);
      }
    }
  }

  let statusSummary: SummaryStatusSnapshot | null = null;
  let previewResult: SummaryPreviewSnapshot | null = null;
  try {
    const sessionKeys = Array.from(
      new Set(
        agentsResult.agents
          .filter((agent) => Boolean(mainSessionKeyByAgent.get(agent.id)))
          .map((agent) => buildAgentMainSessionKey(agent.id, mainKey))
          .filter((key) => key.trim().length > 0)
      )
    ).slice(0, 64);
    if (sessionKeys.length > 0) {
      const snapshot = await Promise.all([
        callGateway<SummaryStatusSnapshot>(params.client, "status", {}),
        callGateway<SummaryPreviewSnapshot>(params.client, "sessions.preview", {
          keys: sessionKeys,
          limit: SUMMARY_PREVIEW_LIMIT,
          maxChars: SUMMARY_PREVIEW_MAX_CHARS,
        }),
      ]);
      statusSummary = snapshot[0] ?? null;
      previewResult = snapshot[1] ?? null;
    }
  } catch (err) {
    if (!params.isDisconnectLikeError(err)) {
      logError("Failed to load initial summary snapshot.", err);
    }
  }

  const derived = deriveHydrateAgentFleetResult({
    gatewayUrl: params.gatewayUrl,
    configSnapshot: configSnapshot ?? null,
    settings,
    execApprovalsSnapshot,
    agentsResult,
    mainSessionByAgentId: mainSessionKeyByAgent,
    statusSummary,
    previewResult,
  });

  return derived;
}
