import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { deriveRuntimeFreshness } from "@/lib/controlplane/degraded-read";
import { ControlPlaneGatewayError } from "@/lib/controlplane/openclaw-adapter";
import { serializeRuntimeInitFailure } from "@/lib/controlplane/runtime-init-errors";
import { bootstrapDomainRuntime } from "@/lib/controlplane/runtime-route-bootstrap";
import {
  countSemanticTurns,
  selectSemanticHistoryWindow,
  type SemanticHistoryMessage,
} from "@/lib/controlplane/semantic-history-window";
import {
  clampGatewayChatHistoryLimit,
  GATEWAY_CHAT_HISTORY_MAX_LIMIT,
} from "@/lib/gateway/chatHistoryLimits";
import { isSafeAgentId } from "@/lib/agents/agentIds";
import { sessionKeyBelongsToAgent } from "@/lib/gateway/session-keys";
import { loadStudioSettings } from "@/lib/studio/settings-store";

export const runtime = "nodejs";

type HistoryView = "raw" | "semantic";
type GatewayChatHistoryPayload = {
  messages?: unknown[];
};
type HistorySelectionPayload = {
  messages: SemanticHistoryMessage[];
  hasMore: boolean;
  semanticTurnsIncluded: number;
  windowTruncated: boolean;
  gatewayLimit: number;
  gatewayCapped: boolean;
  gatewayDurationMs: number;
};
type HistoryCacheEntry = {
  key: string;
  agentRevision: number;
  cachedAtMs: number;
  payload: HistorySelectionPayload;
};
type HistoryCacheStatus = "hit" | "miss" | "coalesced";

const DEFAULT_RAW_LIMIT = 200;
const DEFAULT_TURN_LIMIT = 50;
const MAX_TURN_LIMIT = 400;
const DEFAULT_SCAN_LIMIT = 800;
const HISTORY_CACHE_TTL_MS = 20_000;
const HISTORY_CACHE_MAX_ENTRIES = 48;
const HISTORY_CACHE_AGENT_REVISION_BEFORE = Number.MAX_SAFE_INTEGER;
const HISTORY_CACHE_AGENT_REVISION_LIMIT = 1;
const historyCache = new Map<string, HistoryCacheEntry>();
const historyInFlight = new Map<string, Promise<HistoryCacheEntry>>();

const HISTORY_DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(
  (process.env.NEXT_PUBLIC_STUDIO_TRANSCRIPT_DEBUG ?? "").trim()
);

const hashCacheSecret = (value: string): string =>
  value ? createHash("sha256").update(value).digest("hex") : "";

const logHistoryRouteMetric = (metric: string, meta: Record<string, unknown>) => {
  if (!HISTORY_DEBUG_ENABLED) return;
  console.debug(`[history-route] ${metric}`, meta);
};

const resolveBoundedPositiveInt = (params: {
  raw: string | null;
  fallback: number;
  max: number;
}): number => {
  if (!params.raw) return params.fallback;
  const parsed = Number(params.raw);
  if (!Number.isFinite(parsed)) return params.fallback;
  if (parsed <= 0) return params.fallback;
  return Math.min(Math.floor(parsed), params.max);
};

const resolveRawLimit = (raw: string | null): number =>
  clampGatewayChatHistoryLimit(
    resolveBoundedPositiveInt({
      raw,
      fallback: DEFAULT_RAW_LIMIT,
      max: Number.MAX_SAFE_INTEGER,
    })
  ) ?? DEFAULT_RAW_LIMIT;

const resolveTurnLimit = (raw: string | null): number =>
  resolveBoundedPositiveInt({
    raw,
    fallback: DEFAULT_TURN_LIMIT,
    max: MAX_TURN_LIMIT,
  });

const resolveScanLimit = (raw: string | null): number =>
  clampGatewayChatHistoryLimit(
    resolveBoundedPositiveInt({
      raw,
      fallback: DEFAULT_SCAN_LIMIT,
      max: Number.MAX_SAFE_INTEGER,
    })
  ) ?? DEFAULT_SCAN_LIMIT;

const resolveView = (raw: string | null): HistoryView => {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (normalized === "raw") return "raw";
  if (normalized === "semantic") return "semantic";
  return "semantic";
};

const resolveBooleanQueryParam = (raw: string | null, fallback: boolean): boolean => {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const resolveSemanticRole = (message: SemanticHistoryMessage): "user" | "assistant" | null => {
  const role = typeof message.role === "string" ? message.role.trim().toLowerCase() : "";
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  const stopReason =
    typeof message.stopReason === "string" ? message.stopReason.trim().toLowerCase() : "";
  if (stopReason === "aborted" || stopReason === "error") return "assistant";
  const errorMessage =
    typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  if (errorMessage) return "assistant";
  return null;
};

const extractMessageTextContent = (message: SemanticHistoryMessage): string => {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const record = asRecord(item);
      if (!record) continue;
      if (record.type !== "text") continue;
      if (typeof record.text !== "string") continue;
      parts.push(record.text);
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return typeof message.text === "string" ? message.text : "";
};

const compactConversationMessages = (messages: SemanticHistoryMessage[]): SemanticHistoryMessage[] => {
  const compacted: SemanticHistoryMessage[] = [];
  for (const message of messages) {
    const role = resolveSemanticRole(message);
    if (!role) continue;
    const compact: Record<string, unknown> = { role };
    if (typeof message.timestamp === "number" || typeof message.timestamp === "string") {
      compact.timestamp = message.timestamp;
    }
    if (typeof message.createdAt === "number" || typeof message.createdAt === "string") {
      compact.createdAt = message.createdAt;
    }
    if (typeof message.at === "number" || typeof message.at === "string") {
      compact.at = message.at;
    }
    if (typeof message.stopReason === "string") {
      compact.stopReason = message.stopReason;
    }
    if (typeof message.errorMessage === "string") {
      compact.errorMessage = message.errorMessage;
    }
    const text = extractMessageTextContent(message).trim();
    if (text) {
      compact.content = text;
    }
    compacted.push(compact);
  }
  return compacted;
};

const buildHistoryCacheKey = (params: {
  gatewayScope: string;
  agentId: string;
  sessionKey: string;
  view: HistoryView;
  limit: number;
  turnLimit: number;
  scanLimit: number;
  includeThinking: boolean;
  includeTools: boolean;
}): string => {
  return [
    params.gatewayScope,
    params.agentId,
    params.sessionKey,
    params.view,
    String(params.limit),
    String(params.turnLimit),
    String(params.scanLimit),
    params.includeThinking ? "thinking:1" : "thinking:0",
    params.includeTools ? "tools:1" : "tools:0",
  ].join("\u001f");
};

const touchHistoryCacheEntry = (entry: HistoryCacheEntry): void => {
  historyCache.delete(entry.key);
  historyCache.set(entry.key, entry);
};

const writeHistoryCacheEntry = (entry: HistoryCacheEntry): void => {
  touchHistoryCacheEntry(entry);
  while (historyCache.size > HISTORY_CACHE_MAX_ENTRIES) {
    const oldestKey = historyCache.keys().next().value;
    if (typeof oldestKey !== "string" || !oldestKey) break;
    historyCache.delete(oldestKey);
  }
};

const resolveAgentRevision = (params: {
  controlPlane: {
    eventsBeforeForAgent: (
      agentId: string,
      beforeOutboxId: number,
      limit?: number
    ) => Array<{ id: number }>;
  };
  agentId: string;
  fallback: number;
}): number => {
  const normalizedAgentId = params.agentId.trim().toLowerCase();
  if (!normalizedAgentId) return params.fallback;
  const latest = params.controlPlane.eventsBeforeForAgent(
    normalizedAgentId,
    HISTORY_CACHE_AGENT_REVISION_BEFORE,
    HISTORY_CACHE_AGENT_REVISION_LIMIT
  );
  const latestEntry = latest.at(-1);
  if (!latestEntry || !Number.isFinite(latestEntry.id)) {
    return params.fallback;
  }
  return Math.max(0, Math.trunc(latestEntry.id));
};

const readHistoryCacheEntry = (params: {
  key: string;
  agentRevision: number;
  nowMs: number;
}): HistoryCacheEntry | null => {
  const entry = historyCache.get(params.key) ?? null;
  if (!entry) return null;
  if (entry.agentRevision !== params.agentRevision) {
    historyCache.delete(params.key);
    return null;
  }
  if (params.nowMs - entry.cachedAtMs > HISTORY_CACHE_TTL_MS) {
    historyCache.delete(params.key);
    return null;
  }
  touchHistoryCacheEntry(entry);
  return entry;
};

const resolveHistoryCacheAgeMs = (entry: HistoryCacheEntry, nowMs: number): number =>
  Math.max(0, nowMs - entry.cachedAtMs);

const mapGatewayError = (error: unknown): NextResponse => {
  if (error instanceof ControlPlaneGatewayError) {
    if (error.code.trim().toUpperCase() === "GATEWAY_UNAVAILABLE") {
      return NextResponse.json(
        {
          error: error.message,
          code: "GATEWAY_UNAVAILABLE",
          reason: "gateway_unavailable",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        details: error.details,
      },
      { status: 400 }
    );
  }

  const message = error instanceof Error ? error.message : "runtime_read_failed";
  return NextResponse.json({ error: message }, { status: 500 });
};

const loadHistorySelectionPayload = async (params: {
  controlPlane: {
    callGateway: <T = unknown>(method: string, payload: unknown) => Promise<T>;
  };
  sessionKey: string;
  view: HistoryView;
  limit: number;
  turnLimit: number;
  scanLimit: number;
  includeThinking: boolean;
  includeTools: boolean;
}): Promise<HistorySelectionPayload> => {
  const gatewayLimit = params.view === "semantic" ? params.scanLimit : params.limit;
  const gatewayCapped = gatewayLimit >= GATEWAY_CHAT_HISTORY_MAX_LIMIT;

  const gatewayStartedAt = Date.now();
  const history = await params.controlPlane.callGateway<GatewayChatHistoryPayload>("chat.history", {
    sessionKey: params.sessionKey,
    limit: gatewayLimit,
  });
  const gatewayDurationMs = Date.now() - gatewayStartedAt;

  const rawMessages = Array.isArray(history?.messages) ? history.messages : [];
  const messages = rawMessages
    .map((message) => asRecord(message))
    .filter((message): message is SemanticHistoryMessage => message !== null);
  const hasMoreBefore = messages.length >= gatewayLimit;

  if (params.view === "semantic") {
    const semanticWindow = selectSemanticHistoryWindow({
      messages,
      turnLimit: params.turnLimit,
      hasMoreBefore,
    });
    const conversationOnly = !params.includeThinking && !params.includeTools;
    const selectedMessages = conversationOnly
      ? compactConversationMessages(semanticWindow.messages)
      : semanticWindow.messages;
    return {
      messages: selectedMessages,
      hasMore: semanticWindow.windowTruncated,
      semanticTurnsIncluded: countSemanticTurns(selectedMessages),
      windowTruncated: semanticWindow.windowTruncated,
      gatewayLimit,
      gatewayCapped,
      gatewayDurationMs,
    };
  }

  return {
    messages,
    hasMore: hasMoreBefore,
    semanticTurnsIncluded: countSemanticTurns(messages),
    windowTruncated: hasMoreBefore,
    gatewayLimit,
    gatewayCapped,
    gatewayDurationMs,
  };
};

const resolveHistorySelectionPayload = async (params: {
  controlPlane: {
    callGateway: <T = unknown>(method: string, payload: unknown) => Promise<T>;
    eventsBeforeForAgent: (
      agentId: string,
      beforeOutboxId: number,
      limit?: number
    ) => Array<{ id: number }>;
  };
  agentId: string;
  gatewayScope: string;
  fallbackRevision: number;
  sessionKey: string;
  view: HistoryView;
  limit: number;
  turnLimit: number;
  scanLimit: number;
  includeThinking: boolean;
  includeTools: boolean;
}): Promise<{
  payload: HistorySelectionPayload;
  cacheStatus: HistoryCacheStatus;
  cacheAgeMs: number | null;
}> => {
  const cacheKey = buildHistoryCacheKey({
    gatewayScope: params.gatewayScope,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    view: params.view,
    limit: params.limit,
    turnLimit: params.turnLimit,
    scanLimit: params.scanLimit,
    includeThinking: params.includeThinking,
    includeTools: params.includeTools,
  });
  const nowMs = Date.now();
  const agentRevision = resolveAgentRevision({
    controlPlane: params.controlPlane,
    agentId: params.agentId,
    fallback: params.fallbackRevision,
  });

  const cached = readHistoryCacheEntry({
    key: cacheKey,
    agentRevision,
    nowMs,
  });
  if (cached) {
    return {
      payload: cached.payload,
      cacheStatus: "hit",
      cacheAgeMs: resolveHistoryCacheAgeMs(cached, nowMs),
    };
  }

  const inFlight = historyInFlight.get(cacheKey) ?? null;
  if (inFlight) {
    const shared = await inFlight;
    const sharedNowMs = Date.now();
    const sharedAgeMs = resolveHistoryCacheAgeMs(shared, sharedNowMs);
    if (shared.agentRevision === agentRevision && sharedAgeMs <= HISTORY_CACHE_TTL_MS) {
      return {
        payload: shared.payload,
        cacheStatus: "coalesced",
        cacheAgeMs: sharedAgeMs,
      };
    }
  }

  const fetchPromise = (async (): Promise<HistoryCacheEntry> => {
    const payload = await loadHistorySelectionPayload({
      controlPlane: params.controlPlane,
      sessionKey: params.sessionKey,
      view: params.view,
      limit: params.limit,
      turnLimit: params.turnLimit,
      scanLimit: params.scanLimit,
      includeThinking: params.includeThinking,
      includeTools: params.includeTools,
    });
    const nextEntry: HistoryCacheEntry = {
      key: cacheKey,
      agentRevision,
      cachedAtMs: Date.now(),
      payload,
    };
    writeHistoryCacheEntry(nextEntry);
    return nextEntry;
  })();
  historyInFlight.set(cacheKey, fetchPromise);

  try {
    const entry = await fetchPromise;
    return {
      payload: entry.payload,
      cacheStatus: "miss",
      cacheAgeMs: 0,
    };
  } finally {
    const current = historyInFlight.get(cacheKey);
    if (current === fetchPromise) {
      historyInFlight.delete(cacheKey);
    }
  }
};

export async function GET(
  request: Request,
  context: { params: Promise<{ agentId: string }> }
) {
  const routeStartedAt = Date.now();
  const { agentId } = await context.params;
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return NextResponse.json({ error: "agentId is required." }, { status: 400 });
  }
  if (!isSafeAgentId(normalizedAgentId)) {
    return NextResponse.json({ error: `Invalid agentId: ${normalizedAgentId}` }, { status: 400 });
  }

  const bootstrap = await bootstrapDomainRuntime();
  if (bootstrap.kind === "mode-disabled") {
    return NextResponse.json({ enabled: false, error: "domain_api_mode_disabled" }, { status: 404 });
  }

  if (bootstrap.kind === "runtime-init-failed") {
    return NextResponse.json(
      {
        enabled: true,
        ...serializeRuntimeInitFailure(bootstrap.failure),
      },
      { status: 503 }
    );
  }
  const controlPlane = bootstrap.runtime;
  const startError = bootstrap.kind === "start-failed" ? bootstrap.message : null;

  const url = new URL(request.url);
  const sessionKeyRaw = (url.searchParams.get("sessionKey") ?? "").trim();
  const sessionKey = sessionKeyRaw || `agent:${normalizedAgentId}:main`;
  if (!sessionKeyBelongsToAgent(sessionKey, normalizedAgentId)) {
    return NextResponse.json(
      { error: "sessionKey does not match agentId." },
      { status: 400 }
    );
  }
  const view = resolveView(url.searchParams.get("view"));
  const limit = resolveRawLimit(url.searchParams.get("limit"));
  const turnLimit = resolveTurnLimit(url.searchParams.get("turnLimit"));
  const scanLimit = resolveScanLimit(url.searchParams.get("scanLimit"));
  const includeThinking = resolveBooleanQueryParam(
    url.searchParams.get("includeThinking"),
    true
  );
  const includeTools = resolveBooleanQueryParam(url.searchParams.get("includeTools"), true);
  const snapshot = controlPlane.snapshot();
  const settings = loadStudioSettings();
  const gatewayUrl = settings.gateway?.url?.trim() ?? "";
  const gatewayToken = settings.gateway?.token?.trim() ?? "";
  const gatewayScope = `${gatewayUrl}\u001f${hashCacheSecret(gatewayToken)}`;
  let payload: HistorySelectionPayload;
  let cacheStatus: HistoryCacheStatus = "miss";
  let cacheAgeMs: number | null = null;
  try {
    const result = await resolveHistorySelectionPayload({
      controlPlane,
      agentId: normalizedAgentId,
      gatewayScope,
      fallbackRevision: snapshot.outboxHead,
      sessionKey,
      view,
      limit,
      turnLimit,
      scanLimit,
      includeThinking,
      includeTools,
    });
    payload = result.payload;
    cacheStatus = result.cacheStatus;
    cacheAgeMs = result.cacheAgeMs;
  } catch (error) {
    return mapGatewayError(error);
  }

  if (HISTORY_DEBUG_ENABLED) {
    const payloadBytes = (() => {
      try {
        return JSON.stringify(payload.messages).length;
      } catch {
        return 0;
      }
    })();
    logHistoryRouteMetric("history_window", {
      agentId: normalizedAgentId,
      sessionKey,
      view,
      turnLimit,
      limit,
      scanLimit,
      includeThinking,
      includeTools,
      gatewayLimit: payload.gatewayLimit,
      gatewayCapped: payload.gatewayCapped,
      selectedMessageCount: payload.messages.length,
      payloadBytes,
      hasMore: payload.hasMore,
      windowTruncated: payload.windowTruncated,
      semanticTurnsIncluded: payload.semanticTurnsIncluded,
      gatewayDurationMs: payload.gatewayDurationMs,
      cacheStatus,
      cacheAgeMs,
      routeDurationMs: Date.now() - routeStartedAt,
    });
  }

  return NextResponse.json({
    enabled: true,
    agentId: normalizedAgentId,
    ...(startError ? { error: startError } : {}),
    view,
    messages: payload.messages,
    hasMore: payload.hasMore,
    semanticTurnsIncluded: payload.semanticTurnsIncluded,
    windowTruncated: payload.windowTruncated,
    gatewayLimit: payload.gatewayLimit,
    gatewayCapped: payload.gatewayCapped,
    gatewayDurationMs: payload.gatewayDurationMs,
    cacheStatus,
    cacheAgeMs,
    freshness: deriveRuntimeFreshness(snapshot, null),
  });
}
