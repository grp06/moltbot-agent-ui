import { useCallback, useEffect, useRef } from "react";

import { hydrateDomainHistoryWindow } from "@/features/agents/operations/domainHistoryHydration";
import {
  executeAgentReconcileCommands,
  runAgentReconcileOperation,
} from "@/features/agents/operations/agentReconcileOperation";
import {
  buildCachedHistoryWindowKey,
  readCachedHistoryWindow,
  writeCachedHistoryWindow,
} from "@/features/agents/operations/historyWindowCache";
import {
  RUNTIME_SYNC_DEFAULT_HISTORY_LIMIT,
  RUNTIME_SYNC_MAX_HISTORY_LIMIT,
  resolveRuntimeSyncBootstrapHistoryAgentIds,
  resolveRuntimeSyncLoadMoreHistoryLimit,
  resolveRuntimeSyncReconcilePollingIntent,
} from "@/features/agents/operations/runtimeSyncControlWorkflow";
import type { RuntimeWriteTransport } from "@/features/agents/operations/runtimeWriteTransport";
import type { AgentState } from "@/features/agents/state/store";
import { logTranscriptDebugMetric } from "@/features/agents/state/transcript";
import {
  loadDomainAgentHistoryWindow,
  loadDomainAgentPreviewWindow,
  type DomainAgentHistoryResult,
} from "@/lib/controlplane/domain-runtime-client";
import { fetchJson } from "@/lib/http";
import { randomUUID } from "@/lib/uuid";

type RuntimeSyncDispatchAction = {
  type: "updateAgent";
  agentId: string;
  patch: Partial<AgentState>;
};

type HistoryLoadReason = "bootstrap" | "load-more" | "refresh" | "prefetch";

type UseRuntimeSyncControllerParams = {
  status: "disconnected" | "connecting" | "connected";
  gatewayUrl?: string;
  agents: AgentState[];
  focusedAgentId: string | null;
  dispatch: (action: RuntimeSyncDispatchAction) => void;
  runtimeWriteTransport: Pick<RuntimeWriteTransport, "agentWait">;
  clearRunTracking: (runId: string) => void;
  isDisconnectLikeError: (error: unknown) => boolean;
  defaultHistoryLimit?: number;
  maxHistoryLimit?: number;
};

type RuntimeSyncController = {
  loadSummarySnapshot: () => Promise<void>;
  loadAgentHistory: (
    agentId: string,
    options?: { limit?: number; reason?: HistoryLoadReason }
  ) => Promise<void>;
  loadMoreAgentHistory: (agentId: string) => void;
  reconcileRunningAgents: () => Promise<void>;
  clearHistoryInFlight: (sessionKey: string) => void;
};

type HistoryCacheEntry = {
  requestedLimit: number;
  fetchedAt: number;
  history: DomainAgentHistoryResult;
};

type ScheduledPrefetchHandle = { kind: "idle"; id: number } | { kind: "timeout"; id: number };

type ScheduledPrefetchEntry = {
  agentId: string;
  sessionEpoch: number;
  targetLimit: number;
  handle: ScheduledPrefetchHandle;
};

type HistoryRequestContext = {
  agentId: string;
  sessionKey: string;
  sessionEpoch: number;
  requestId: string;
  controller: AbortController;
  reason: HistoryLoadReason;
};

const normalizeSessionEpoch = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
};

const normalizePositiveInt = (value: number | null | undefined): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(1, Math.floor(value));
};

const isAbortError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  if ("name" in error && (error as { name?: unknown }).name === "AbortError") return true;
  if (
    "cause" in error &&
    (error as { cause?: unknown }).cause &&
    typeof (error as { cause?: unknown }).cause === "object" &&
    "name" in ((error as { cause?: unknown }).cause as Record<string, unknown>) &&
    ((error as { cause?: unknown }).cause as Record<string, unknown>).name === "AbortError"
  ) {
    return true;
  }
  return false;
};

const resolveScanLimitForReason = (params: {
  reason: HistoryLoadReason;
  requestedLimit: number;
  maxHistoryLimit: number;
}): number => {
  const floor =
    params.reason === "bootstrap"
      ? 200
      : params.reason === "load-more" || params.reason === "prefetch"
        ? 400
        : 300;
  return Math.min(params.maxHistoryLimit, Math.max(floor, params.requestedLimit * 3));
};

const HISTORY_MEMORY_CACHE_KEY_SEPARATOR = "\u001f";

const buildHistoryMemoryCacheKey = (params: {
  gatewayUrl: string;
  sessionKey: string;
  sessionEpoch: number;
  includeTraceHistory: boolean;
  includeTools: boolean;
}): string => {
  return [
    params.gatewayUrl.trim(),
    params.sessionKey.trim(),
    String(normalizeSessionEpoch(params.sessionEpoch)),
    params.includeTraceHistory ? "trace:1" : "trace:0",
    params.includeTools ? "tools:1" : "tools:0",
  ].join(HISTORY_MEMORY_CACHE_KEY_SEPARATOR);
};

const historyMemoryCacheKeyMatchesSession = (key: string, sessionKey: string): boolean => {
  return key.split(HISTORY_MEMORY_CACHE_KEY_SEPARATOR)[1] === sessionKey;
};

const resolveVisibleHistoryLimit = (params: {
  agent: Pick<AgentState, "historyVisibleTurnLimit" | "historyFetchedCount">;
  fallback: number;
}): number => {
  return (
    normalizePositiveInt(params.agent.historyVisibleTurnLimit) ??
    normalizePositiveInt(params.agent.historyFetchedCount) ??
    Math.max(1, Math.floor(params.fallback))
  );
};

const resolveCachedVisibleHistoryLimit = (params: {
  persistedVisibleTurnLimit: number | null;
  fetchedCount: number | null;
  fallback: number;
  maxVisible: number;
}): number | null => {
  const fetchedCount = normalizePositiveInt(params.fetchedCount);
  if (!fetchedCount) return null;
  const preferredVisibleTurnLimit =
    normalizePositiveInt(params.persistedVisibleTurnLimit) ?? Math.max(1, Math.floor(params.fallback));
  return Math.min(fetchedCount, preferredVisibleTurnLimit, Math.max(1, Math.floor(params.maxVisible)));
};

const scheduleIdlePrefetch = (callback: () => void): ScheduledPrefetchHandle => {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    return { kind: "idle", id: window.requestIdleCallback(() => callback()) };
  }
  return { kind: "timeout", id: window.setTimeout(callback, 120) };
};

const cancelIdlePrefetch = (handle: ScheduledPrefetchHandle): void => {
  if (handle.kind === "idle" && typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
    window.cancelIdleCallback(handle.id);
    return;
  }
  window.clearTimeout(handle.id);
};

const FOCUSED_PREVIEW_LIMIT = 50;
const FOCUSED_PREVIEW_MAX_CHARS = 480;
const FOCUSED_PREVIEW_MIN_ITEMS = 4;
const BOOTSTRAP_HISTORY_LIMIT = 12;

const buildPreviewBootstrapKey = (agent: Pick<AgentState, "sessionKey" | "sessionEpoch">): string =>
  `${agent.sessionKey.trim()}:${normalizeSessionEpoch(agent.sessionEpoch)}`;

export function useRuntimeSyncController(
  params: UseRuntimeSyncControllerParams
): RuntimeSyncController {
  const {
    status,
    gatewayUrl = "",
    agents,
    focusedAgentId,
    dispatch,
    runtimeWriteTransport,
    clearRunTracking,
    isDisconnectLikeError,
  } = params;
  const agentsRef = useRef(agents);
  const historyInFlightRef = useRef<Set<string>>(new Set());
  const historyAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const historyRequestContextRef = useRef<Map<string, HistoryRequestContext>>(new Map());
  const historyCacheRef = useRef<Map<string, HistoryCacheEntry>>(new Map());
  const historyPersistedMarkerRef = useRef<Map<string, string>>(new Map());
  const historyPrefetchRef = useRef<Map<string, ScheduledPrefetchEntry>>(new Map());
  const previewInFlightRef = useRef<Set<string>>(new Set());
  const previewBootstrapAttemptedRef = useRef<Set<string>>(new Set());
  const reconcileRunIdsInFlightRef = useRef<Set<string>>(new Set());

  const defaultHistoryLimit = params.defaultHistoryLimit ?? RUNTIME_SYNC_DEFAULT_HISTORY_LIMIT;
  const maxHistoryLimit = params.maxHistoryLimit ?? RUNTIME_SYNC_MAX_HISTORY_LIMIT;

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  const clearSessionHistoryCache = useCallback((sessionKey: string) => {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return;
    for (const key of historyCacheRef.current.keys()) {
      if (!historyMemoryCacheKeyMatchesSession(key, normalizedSessionKey)) continue;
      historyCacheRef.current.delete(key);
    }
  }, []);

  const cancelScheduledPrefetch = useCallback((sessionKey: string) => {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) return;
    const scheduled = historyPrefetchRef.current.get(normalizedSessionKey) ?? null;
    if (!scheduled) return;
    cancelIdlePrefetch(scheduled.handle);
    historyPrefetchRef.current.delete(normalizedSessionKey);
  }, []);

  const clearHistoryInFlight = useCallback((sessionKey: string) => {
    const key = sessionKey.trim();
    if (!key) return;
    cancelScheduledPrefetch(key);
    const controller = historyAbortControllersRef.current.get(key) ?? null;
    if (controller) {
      controller.abort();
      historyAbortControllersRef.current.delete(key);
    }
    historyRequestContextRef.current.delete(key);
    historyInFlightRef.current.delete(key);
    clearSessionHistoryCache(key);
  }, [cancelScheduledPrefetch, clearSessionHistoryCache]);

  const loadSummarySnapshot = useCallback(async () => {
    try {
      await fetchJson<{ summary?: unknown; freshness?: unknown }>("/api/runtime/summary", {
        cache: "no-store",
      });
    } catch (error) {
      if (!isDisconnectLikeError(error)) {
        console.error("Failed to load domain runtime summary.", error);
      }
    }
  }, [isDisconnectLikeError]);

  const loadFocusedAgentPreview = useCallback(
    async (
      agentId: string,
      options?: {
        limit?: number;
        maxChars?: number;
      }
    ) => {
      const targetAgent = agentsRef.current.find((entry) => entry.agentId === agentId) ?? null;
      if (!targetAgent || !targetAgent.sessionCreated) return;
      const sessionKey = targetAgent.sessionKey.trim();
      if (!sessionKey) return;
      if (previewInFlightRef.current.has(sessionKey)) return;

      const requestedLimitRaw =
        typeof options?.limit === "number" && Number.isFinite(options.limit)
          ? Math.floor(options.limit)
          : FOCUSED_PREVIEW_LIMIT;
      const requestedLimit = Math.max(1, Math.min(FOCUSED_PREVIEW_LIMIT, requestedLimitRaw));
      const requestedMaxCharsRaw =
        typeof options?.maxChars === "number" && Number.isFinite(options.maxChars)
          ? Math.floor(options.maxChars)
          : FOCUSED_PREVIEW_MAX_CHARS;
      const requestedMaxChars = Math.max(40, Math.min(2000, requestedMaxCharsRaw));
      const requestStartedAt = Date.now();
      const sessionEpoch = normalizeSessionEpoch(targetAgent.sessionEpoch);

      previewInFlightRef.current.add(sessionKey);
      logTranscriptDebugMetric("preview_load_start", {
        agentId,
        sessionKey,
        requestedLimit,
        requestedMaxChars,
      });

      try {
        const preview = await loadDomainAgentPreviewWindow({
          agentId,
          sessionKey,
          limit: requestedLimit,
          maxChars: requestedMaxChars,
        });
        const latest = agentsRef.current.find((entry) => entry.agentId === agentId) ?? null;
        if (!latest) return;
        if (latest.sessionKey.trim() !== sessionKey) return;
        if (normalizeSessionEpoch(latest.sessionEpoch) !== sessionEpoch) return;
        const nextPreviewItems = Array.isArray(preview.items) ? preview.items : [];
        if (nextPreviewItems.length === 0) return;
        const existingPreviewCount = Array.isArray(latest.previewItems) ? latest.previewItems.length : 0;
        if (nextPreviewItems.length < existingPreviewCount) return;

        const lastAssistant = [...nextPreviewItems]
          .reverse()
          .find((item) => item.role === "assistant");
        const lastUser = [...nextPreviewItems].reverse().find((item) => item.role === "user");
        dispatch({
          type: "updateAgent",
          agentId,
          patch: {
            previewItems: nextPreviewItems,
            ...(lastAssistant?.text ? { latestPreview: lastAssistant.text } : {}),
            ...(lastUser?.text ? { lastUserMessage: lastUser.text } : {}),
          },
        });
        logTranscriptDebugMetric("preview_load_finish", {
          agentId,
          sessionKey,
          requestedLimit,
          requestedMaxChars,
          previewItemCount: nextPreviewItems.length,
          totalDurationMs: Date.now() - requestStartedAt,
        });
      } catch (error) {
        if (!isDisconnectLikeError(error)) {
          console.error("Failed to load focused session preview.", error);
        }
      } finally {
        previewInFlightRef.current.delete(sessionKey);
      }
    },
    [dispatch, isDisconnectLikeError]
  );

  const loadAgentHistory = useCallback(
    async (
      agentId: string,
      options?: { limit?: number; reason?: HistoryLoadReason }
    ) => {
      const targetAgent =
        agentsRef.current.find((entry) => entry.agentId === agentId) ?? null;
      if (!targetAgent || !targetAgent.sessionCreated) return;
      const sessionKey = targetAgent.sessionKey.trim();
      if (!sessionKey) return;
      if (historyInFlightRef.current.has(sessionKey)) return;

      const reason = options?.reason ?? "refresh";
      const requestedLimitRaw =
        typeof options?.limit === "number" && Number.isFinite(options.limit)
          ? Math.floor(options.limit)
          : defaultHistoryLimit;
      const requestedLimit = Math.max(1, Math.min(maxHistoryLimit, requestedLimitRaw));
      const includeTraceHistory = targetAgent.showThinkingTraces === true;
      const memoryCacheKey = buildHistoryMemoryCacheKey({
        gatewayUrl,
        sessionKey,
        sessionEpoch: normalizeSessionEpoch(targetAgent.sessionEpoch),
        includeTraceHistory,
        includeTools: includeTraceHistory,
      });

      if (
        reason === "load-more" &&
        targetAgent.historyGatewayCapReached &&
        typeof targetAgent.historyFetchLimit === "number" &&
        requestedLimit <= targetAgent.historyFetchLimit
      ) {
        logTranscriptDebugMetric("history_load_skipped_gateway_cap", {
          agentId,
          sessionKey,
          reason,
          requestedLimit,
        });
        return;
      }

      cancelScheduledPrefetch(sessionKey);
      historyInFlightRef.current.add(sessionKey);
      const requestId = randomUUID();
      const loadedAt = Date.now();
      const requestStartedAt = Date.now();
      const sessionEpoch = normalizeSessionEpoch(targetAgent.sessionEpoch);
      const abortController = new AbortController();
      historyAbortControllersRef.current.set(sessionKey, abortController);
      historyRequestContextRef.current.set(sessionKey, {
        agentId,
        sessionKey,
        sessionEpoch,
        requestId,
        controller: abortController,
        reason,
      });
      logTranscriptDebugMetric("history_load_start", {
        agentId,
        sessionKey,
        reason,
        requestedLimit,
        includeTraceHistory,
        requestId,
      });

      try {
        let history: DomainAgentHistoryResult;
        let fromCache = false;
        let hydratedFromPersistedCache = false;
        let fetchDurationMs = 0;
        const shouldHydratePersistedCache =
          reason !== "load-more" &&
          targetAgent.historyLoadedAt === null &&
          gatewayUrl.trim().length > 0;

        if (shouldHydratePersistedCache) {
          const cachedWindow = await readCachedHistoryWindow({
            gatewayUrl,
            agentId,
            sessionKey,
            sessionEpoch,
            includeThinking: includeTraceHistory,
            includeTools: includeTraceHistory,
          });
          if (cachedWindow) {
            const latestBeforeCache =
              agentsRef.current.find((entry) => entry.agentId === agentId) ?? null;
            if (
              latestBeforeCache &&
              latestBeforeCache.sessionKey.trim() === sessionKey &&
              normalizeSessionEpoch(latestBeforeCache.sessionEpoch) === sessionEpoch &&
              latestBeforeCache.historyLoadedAt === null
            ) {
              const persistedVisibleTurnLimit = resolveCachedVisibleHistoryLimit({
                persistedVisibleTurnLimit: cachedWindow.historyVisibleTurnLimit,
                fetchedCount: cachedWindow.historyFetchedCount,
                fallback: requestedLimit,
                maxVisible: defaultHistoryLimit,
              });
              dispatch({
                type: "updateAgent",
                agentId,
                patch: {
                  transcriptEntries: cachedWindow.transcriptEntries,
                  historyLoadedAt: cachedWindow.cachedAt,
                  historyFetchLimit: cachedWindow.historyFetchLimit,
                  historyFetchedCount: cachedWindow.historyFetchedCount,
                  historyVisibleTurnLimit: persistedVisibleTurnLimit,
                  historyMaybeTruncated: cachedWindow.historyMaybeTruncated,
                  historyHasMore: cachedWindow.historyHasMore,
                  historyGatewayCapReached: cachedWindow.historyGatewayCapReached,
                  lastResult: cachedWindow.lastResult,
                  latestPreview: cachedWindow.latestPreview,
                  lastAssistantMessageAt: cachedWindow.lastAssistantMessageAt,
                  lastUserMessage: cachedWindow.lastUserMessage,
                },
              });
              hydratedFromPersistedCache = true;
              logTranscriptDebugMetric("history_cache_hydrated", {
                agentId,
                sessionKey,
                requestId,
                requestedLimit,
                cachedAt: cachedWindow.cachedAt,
                cachedFetchedCount: cachedWindow.historyFetchedCount,
                cachedVisibleTurnLimit: persistedVisibleTurnLimit,
              });
            }
          }
        }

        const cached = historyCacheRef.current.get(memoryCacheKey);
        const canUseCache =
          reason !== "refresh" &&
          cached &&
          cached.requestedLimit >= requestedLimit;

        if (canUseCache) {
          history = cached.history;
          fromCache = true;
        } else {
          const fetchStartedAt = Date.now();
          history = await loadDomainAgentHistoryWindow({
            agentId,
            sessionKey,
            view: "semantic",
            turnLimit: requestedLimit,
            scanLimit: resolveScanLimitForReason({
              reason,
              requestedLimit,
              maxHistoryLimit,
            }),
            includeThinking: includeTraceHistory,
            includeTools: includeTraceHistory,
            signal: abortController.signal,
          });
          fetchDurationMs = Date.now() - fetchStartedAt;
          historyCacheRef.current.set(memoryCacheKey, {
            requestedLimit,
            fetchedAt: Date.now(),
            history,
          });
        }

        const latest =
          agentsRef.current.find((entry) => entry.agentId === agentId) ?? null;
        if (!latest) return;
        if (latest.sessionKey.trim() !== sessionKey) {
          logTranscriptDebugMetric("history_load_stale_ignored", {
            agentId,
            sessionKey,
            requestId,
            reason,
            staleCause: "session-key-changed",
          });
          return;
        }
        if (normalizeSessionEpoch(latest.sessionEpoch) !== sessionEpoch) {
          logTranscriptDebugMetric("history_load_stale_ignored", {
            agentId,
            sessionKey,
            requestId,
            reason,
            staleCause: "session-epoch-changed",
          });
          return;
        }

        const hydrateStartedAt = Date.now();
        const patch = hydrateDomainHistoryWindow({
          agent: latest,
          history,
          loadedAt,
          requestId,
          requestedLimit,
          view: "semantic",
          reason,
        });
        const hydrateDurationMs = Date.now() - hydrateStartedAt;

        dispatch({
          type: "updateAgent",
          agentId,
          patch,
        });

        logTranscriptDebugMetric("history_load_finish", {
          agentId,
          sessionKey,
          reason,
          requestedLimit,
          requestId,
          fromCache,
          hydratedFromPersistedCache,
          fetchDurationMs,
          hydrateDurationMs,
          totalDurationMs: Date.now() - requestStartedAt,
          messageCount: history.messages.length,
          includeTraceHistory,
          semanticTurnsIncluded: history.semanticTurnsIncluded,
          windowTruncated: history.windowTruncated,
          gatewayLimit: history.gatewayLimit,
          gatewayCapped: history.gatewayCapped,
          routeGatewayDurationMs: history.gatewayDurationMs,
          routeCacheStatus: history.cacheStatus,
          routeCacheAgeMs: history.cacheAgeMs,
        });
      } catch (error) {
        if (isAbortError(error)) {
          logTranscriptDebugMetric("history_load_aborted", {
            agentId,
            sessionKey,
            reason,
            requestId,
            requestedLimit,
            totalDurationMs: Date.now() - requestStartedAt,
          });
          return;
        }
        if (!isDisconnectLikeError(error)) {
          console.error("Failed to load domain runtime history.", error);
        }
      } finally {
        const activeContext = historyRequestContextRef.current.get(sessionKey) ?? null;
        const isActiveRequest = activeContext?.requestId === requestId;
        const activeController = historyAbortControllersRef.current.get(sessionKey) ?? null;
        const ownsActiveController =
          activeController !== null && activeContext?.controller === activeController;

        if (isActiveRequest) {
          historyRequestContextRef.current.delete(sessionKey);
          historyInFlightRef.current.delete(sessionKey);
        }
        if (ownsActiveController && activeContext?.controller === abortController) {
          historyAbortControllersRef.current.delete(sessionKey);
        }
      }
    },
    [
      cancelScheduledPrefetch,
      defaultHistoryLimit,
      dispatch,
      gatewayUrl,
      isDisconnectLikeError,
      maxHistoryLimit,
    ]
  );

  const loadMoreAgentHistory = useCallback(
    (agentId: string) => {
      const agent = agentsRef.current.find((entry) => entry.agentId === agentId) ?? null;
      if (!agent) return;

      const currentVisibleTurnLimit = resolveVisibleHistoryLimit({
        agent,
        fallback: defaultHistoryLimit,
      });
      const fetchedTurnCount = normalizePositiveInt(agent.historyFetchedCount) ?? 0;
      const hasHiddenFetchedHistory = fetchedTurnCount > currentVisibleTurnLimit;

      if (hasHiddenFetchedHistory) {
        const nextVisibleTurnLimit = Math.min(
          fetchedTurnCount,
          resolveRuntimeSyncLoadMoreHistoryLimit({
            currentLimit: currentVisibleTurnLimit,
            defaultLimit: defaultHistoryLimit,
            maxLimit: maxHistoryLimit,
          })
        );
        dispatch({
          type: "updateAgent",
          agentId,
          patch: {
            historyVisibleTurnLimit: nextVisibleTurnLimit,
          },
        });
        logTranscriptDebugMetric("history_load_more_reveal_cached", {
          agentId,
          currentVisibleTurnLimit,
          nextVisibleTurnLimit,
          fetchedTurnCount,
        });
        return;
      }

      if (!agent.historyMaybeTruncated) return;
      if (agent.historyGatewayCapReached) return;

      const nextLimit = resolveRuntimeSyncLoadMoreHistoryLimit({
        currentLimit: agent.historyFetchLimit,
        defaultLimit: defaultHistoryLimit,
        maxLimit: maxHistoryLimit,
      });

      if (
        typeof agent.historyFetchLimit === "number" &&
        nextLimit <= agent.historyFetchLimit &&
        agent.historyFetchLimit >= maxHistoryLimit
      ) {
        dispatch({
          type: "updateAgent",
          agentId,
          patch: {
            historyGatewayCapReached: true,
          },
        });
        logTranscriptDebugMetric("history_load_more_skipped_reached_max_limit", {
          agentId,
          currentLimit: agent.historyFetchLimit,
          maxHistoryLimit,
        });
        return;
      }

      void loadAgentHistory(agentId, {
        limit: nextLimit,
        reason: "load-more",
      });
    },
    [defaultHistoryLimit, dispatch, loadAgentHistory, maxHistoryLimit]
  );

  const reconcileRunningAgents = useCallback(async () => {
    if (status !== "connected") return;
    const commands = await runAgentReconcileOperation({
      waitForAgentRun: runtimeWriteTransport.agentWait,
      agents: agentsRef.current,
      getLatestAgent: (agentId) =>
        agentsRef.current.find((entry) => entry.agentId === agentId) ?? null,
      claimRunId: (runId) => {
        if (reconcileRunIdsInFlightRef.current.has(runId)) return false;
        reconcileRunIdsInFlightRef.current.add(runId);
        return true;
      },
      releaseRunId: (runId) => {
        reconcileRunIdsInFlightRef.current.delete(runId);
      },
      isDisconnectLikeError,
    });
    executeAgentReconcileCommands({
      commands,
      dispatch,
      clearRunTracking,
      requestHistoryRefresh: (agentId) => {
        void loadAgentHistory(agentId, { reason: "refresh" });
      },
      logInfo: (message) => console.info(message),
      logWarn: (message, error) => console.warn(message, error),
    });
  }, [
    clearRunTracking,
    dispatch,
    isDisconnectLikeError,
    loadAgentHistory,
    runtimeWriteTransport.agentWait,
    status,
  ]);

  useEffect(() => {
    if (status !== "connected") return;
    void loadSummarySnapshot();
  }, [loadSummarySnapshot, status]);

  useEffect(() => {
    const intent = resolveRuntimeSyncReconcilePollingIntent({ status });
    if (intent.kind === "stop") {
      reconcileRunIdsInFlightRef.current.clear();
      return;
    }

    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      void reconcileRunningAgents();
    };
    if (intent.runImmediately) {
      run();
    }
    const intervalId = window.setInterval(run, intent.intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [reconcileRunningAgents, status]);

  useEffect(() => {
    const normalizedFocusedAgentId = focusedAgentId?.trim() ?? "";
    for (const [sessionKey, context] of historyRequestContextRef.current.entries()) {
      const controller = historyAbortControllersRef.current.get(sessionKey) ?? null;
      if (!controller) continue;
      const agent =
        agents.find((entry) => entry.agentId === context.agentId) ?? null;
      const agentSessionKey = agent?.sessionKey.trim() ?? "";
      const agentSessionEpoch = normalizeSessionEpoch(agent?.sessionEpoch);
      const focusChanged =
        normalizedFocusedAgentId.length > 0 && context.agentId !== normalizedFocusedAgentId;
      const sessionInvalid =
        !agent ||
        agentSessionKey !== context.sessionKey ||
        agentSessionEpoch !== context.sessionEpoch;
      if (!focusChanged && !sessionInvalid) continue;

      controller.abort();
      cancelScheduledPrefetch(sessionKey);
      historyAbortControllersRef.current.delete(sessionKey);
      historyRequestContextRef.current.delete(sessionKey);
      historyInFlightRef.current.delete(sessionKey);
      logTranscriptDebugMetric("history_load_cancelled_stale", {
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        requestId: context.requestId,
        reason: context.reason,
        staleCause: sessionInvalid ? "session-invalidated" : "focus-changed",
      });
    }
  }, [agents, cancelScheduledPrefetch, focusedAgentId]);

  useEffect(() => {
    const controllers = historyAbortControllersRef.current;
    const contexts = historyRequestContextRef.current;
    const inFlight = historyInFlightRef.current;
    const prefetches = historyPrefetchRef.current;
    const previewInFlight = previewInFlightRef.current;
    return () => {
      for (const controller of controllers.values()) {
        controller.abort();
      }
      for (const scheduled of prefetches.values()) {
        cancelIdlePrefetch(scheduled.handle);
      }
      controllers.clear();
      contexts.clear();
      inFlight.clear();
      prefetches.clear();
      previewInFlight.clear();
    };
  }, []);

  useEffect(() => {
    if (status !== "connected") return;
    const normalizedFocusedAgentId = focusedAgentId?.trim() ?? "";
    if (!normalizedFocusedAgentId) return;
    const focusedAgent =
      agents.find((entry) => entry.agentId === normalizedFocusedAgentId) ?? null;
    if (!focusedAgent || !focusedAgent.sessionCreated) return;
    if (focusedAgent.historyLoadedAt !== null) return;

    const previewItemCount = Array.isArray(focusedAgent.previewItems)
      ? focusedAgent.previewItems.length
      : 0;
    if (previewItemCount >= FOCUSED_PREVIEW_MIN_ITEMS) return;

    const previewBootstrapKey = buildPreviewBootstrapKey(focusedAgent);
    if (!previewBootstrapKey) return;
    if (previewBootstrapAttemptedRef.current.has(previewBootstrapKey)) return;
    previewBootstrapAttemptedRef.current.add(previewBootstrapKey);
    void loadFocusedAgentPreview(normalizedFocusedAgentId, {
      limit: FOCUSED_PREVIEW_LIMIT,
      maxChars: FOCUSED_PREVIEW_MAX_CHARS,
    });
  }, [agents, focusedAgentId, loadFocusedAgentPreview, status]);

  useEffect(() => {
    const bootstrapAgentIds = resolveRuntimeSyncBootstrapHistoryAgentIds({
      status,
      agents,
    });
    const normalizedFocusedAgentId = focusedAgentId?.trim() ?? "";
    if (!normalizedFocusedAgentId) return;
    if (!bootstrapAgentIds.includes(normalizedFocusedAgentId)) return;
    void loadAgentHistory(normalizedFocusedAgentId, {
      reason: "bootstrap",
      limit: Math.min(defaultHistoryLimit, BOOTSTRAP_HISTORY_LIMIT),
    });
  }, [agents, defaultHistoryLimit, focusedAgentId, loadAgentHistory, status]);

  useEffect(() => {
    const gatewayCacheKey = gatewayUrl.trim();
    if (!gatewayCacheKey) return;
    for (const agent of agents) {
      const sessionKey = agent.sessionKey.trim();
      if (!sessionKey) continue;
      const transcriptEntries = Array.isArray(agent.transcriptEntries) ? agent.transcriptEntries : [];
      if (transcriptEntries.length === 0) continue;
      const sessionEpoch = normalizeSessionEpoch(agent.sessionEpoch);
      const includeThinking = agent.showThinkingTraces === true;
      const includeTools = includeThinking;
      const cacheKey = buildCachedHistoryWindowKey({
        gatewayUrl: gatewayCacheKey,
        agentId: agent.agentId,
        sessionKey,
        sessionEpoch,
        includeThinking,
        includeTools,
      });
      const marker = [
        String(agent.transcriptRevision ?? 0),
        String(normalizePositiveInt(agent.historyFetchLimit) ?? 0),
        String(normalizePositiveInt(agent.historyFetchedCount) ?? 0),
        String(normalizePositiveInt(agent.historyVisibleTurnLimit) ?? 0),
        agent.historyMaybeTruncated ? "truncated:1" : "truncated:0",
        agent.historyHasMore ? "more:1" : "more:0",
        agent.historyGatewayCapReached ? "capped:1" : "capped:0",
      ].join("\u001f");
      if (historyPersistedMarkerRef.current.get(cacheKey) === marker) continue;
      historyPersistedMarkerRef.current.set(cacheKey, marker);
      void writeCachedHistoryWindow({
        gatewayUrl: gatewayCacheKey,
        agentId: agent.agentId,
        sessionKey,
        sessionEpoch,
        includeThinking,
        includeTools,
        cachedAt: Date.now(),
        transcriptEntries,
        historyFetchLimit: normalizePositiveInt(agent.historyFetchLimit),
        historyFetchedCount: normalizePositiveInt(agent.historyFetchedCount),
        historyVisibleTurnLimit: normalizePositiveInt(agent.historyVisibleTurnLimit),
        historyMaybeTruncated: agent.historyMaybeTruncated,
        historyHasMore: agent.historyHasMore ?? false,
        historyGatewayCapReached: agent.historyGatewayCapReached ?? false,
        lastResult: agent.lastResult,
        latestPreview: agent.latestPreview,
        lastAssistantMessageAt: agent.lastAssistantMessageAt,
        lastUserMessage: agent.lastUserMessage,
      });
    }
  }, [agents, gatewayUrl]);

  useEffect(() => {
    const normalizedFocusedAgentId = focusedAgentId?.trim() ?? "";
    const focusedSessionKey =
      normalizedFocusedAgentId.length > 0
        ? agents.find((entry) => entry.agentId === normalizedFocusedAgentId)?.sessionKey.trim() ?? ""
        : "";
    for (const [sessionKey, scheduled] of historyPrefetchRef.current.entries()) {
      if (sessionKey === focusedSessionKey) continue;
      cancelIdlePrefetch(scheduled.handle);
      historyPrefetchRef.current.delete(sessionKey);
    }
    if (status !== "connected") return;
    if (!normalizedFocusedAgentId) return;
    const focusedAgent =
      agents.find((entry) => entry.agentId === normalizedFocusedAgentId) ?? null;
    if (!focusedAgent || !focusedAgent.sessionCreated) return;
    if (!focusedAgent.historyLoadedAt) return;
    if (focusedAgent.historyGatewayCapReached) return;
    const sessionKey = focusedAgent.sessionKey.trim();
    if (!sessionKey) return;
    const visibleTurnLimit = resolveVisibleHistoryLimit({
      agent: focusedAgent,
      fallback: defaultHistoryLimit,
    });
    const fetchedTurnCount = normalizePositiveInt(focusedAgent.historyFetchedCount) ?? 0;
    if (fetchedTurnCount === 0) return;
    if (fetchedTurnCount > visibleTurnLimit) return;
    if (!focusedAgent.historyMaybeTruncated) return;
    const nextLimit = resolveRuntimeSyncLoadMoreHistoryLimit({
      currentLimit: focusedAgent.historyFetchLimit,
      defaultLimit: defaultHistoryLimit,
      maxLimit: maxHistoryLimit,
    });
    if (
      typeof focusedAgent.historyFetchLimit === "number" &&
      Number.isFinite(focusedAgent.historyFetchLimit) &&
      nextLimit <= focusedAgent.historyFetchLimit
    ) {
      return;
    }
    const existingScheduled = historyPrefetchRef.current.get(sessionKey) ?? null;
    if (
      existingScheduled &&
      existingScheduled.targetLimit === nextLimit &&
      existingScheduled.agentId === focusedAgent.agentId &&
      existingScheduled.sessionEpoch === normalizeSessionEpoch(focusedAgent.sessionEpoch)
    ) {
      return;
    }
    if (existingScheduled) {
      cancelIdlePrefetch(existingScheduled.handle);
      historyPrefetchRef.current.delete(sessionKey);
    }
    const scheduled: ScheduledPrefetchEntry = {
      agentId: focusedAgent.agentId,
      sessionEpoch: normalizeSessionEpoch(focusedAgent.sessionEpoch),
      targetLimit: nextLimit,
      handle: scheduleIdlePrefetch(() => {
        const latest =
          agentsRef.current.find((entry) => entry.agentId === normalizedFocusedAgentId) ?? null;
        const currentScheduled = historyPrefetchRef.current.get(sessionKey) ?? null;
        if (currentScheduled?.targetLimit === nextLimit) {
          historyPrefetchRef.current.delete(sessionKey);
        }
        if (!latest || !latest.sessionCreated) return;
        if (latest.sessionKey.trim() !== sessionKey) return;
        if (normalizeSessionEpoch(latest.sessionEpoch) !== normalizeSessionEpoch(focusedAgent.sessionEpoch)) {
          return;
        }
        if (latest.historyGatewayCapReached) return;
        const latestVisibleTurnLimit = resolveVisibleHistoryLimit({
          agent: latest,
          fallback: defaultHistoryLimit,
        });
        const latestFetchedTurnCount = normalizePositiveInt(latest.historyFetchedCount) ?? 0;
        if (latestFetchedTurnCount > latestVisibleTurnLimit) return;
        if (!latest.historyMaybeTruncated) return;
        if (
          typeof latest.historyFetchLimit === "number" &&
          Number.isFinite(latest.historyFetchLimit) &&
          latest.historyFetchLimit >= nextLimit
        ) {
          return;
        }
        void loadAgentHistory(normalizedFocusedAgentId, {
          limit: nextLimit,
          reason: "prefetch",
        });
      }),
    };
    historyPrefetchRef.current.set(sessionKey, scheduled);
    const historyPrefetches = historyPrefetchRef.current;
    return () => {
      const current = historyPrefetches.get(sessionKey) ?? null;
      if (!current || current.targetLimit !== nextLimit) return;
      cancelIdlePrefetch(current.handle);
      historyPrefetches.delete(sessionKey);
    };
  }, [
    agents,
    defaultHistoryLimit,
    focusedAgentId,
    loadAgentHistory,
    maxHistoryLimit,
    status,
  ]);

  return {
    loadSummarySnapshot,
    loadAgentHistory,
    loadMoreAgentHistory,
    reconcileRunningAgents,
    clearHistoryInFlight,
  };
}
