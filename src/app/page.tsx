"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AgentChatPanel } from "@/features/agents/components/AgentChatPanel";
import { AgentCreateModal } from "@/features/agents/components/AgentCreateModal";
import {
  AgentBrainPanel,
  AgentSettingsPanel,
} from "@/features/agents/components/AgentInspectPanels";
import { FleetSidebar } from "@/features/agents/components/FleetSidebar";
import { HeaderBar } from "@/features/agents/components/HeaderBar";
import { ConnectionPanel } from "@/features/agents/components/ConnectionPanel";
import { GatewayConnectScreen } from "@/features/agents/components/GatewayConnectScreen";
import { EmptyStatePanel } from "@/features/agents/components/EmptyStatePanel";
import {
  isHeartbeatPrompt,
} from "@/lib/text/message-extract";
import { useStudioGatewaySettings } from "@/lib/studio/useStudioGatewaySettings";
import { isGatewayConnected, type GatewayStatus } from "@/lib/gateway/gateway-status";
import type { ControlPlaneOutboxEntry } from "@/lib/controlplane/contracts";
import {
  type GatewayModelChoice,
  type GatewayModelPolicySnapshot,
} from "@/lib/gateway/models";
import {
  AgentStoreProvider,
  agentStoreReducer,
  getFilteredAgents,
  getSelectedAgent,
  type FocusFilter,
  useAgentStore,
} from "@/features/agents/state/store";
import type { AgentState } from "@/features/agents/state/store";
import { createGatewayRuntimeEventHandler } from "@/features/agents/state/gatewayRuntimeEventHandler";
import {
  type CronJobSummary,
  formatCronJobDisplay,
  resolveLatestCronJobForAgent,
} from "@/lib/cron/types";
import {
  readConfigAgentList,
  slugifyAgentName,
} from "@/lib/gateway/agentConfig";
import { buildAvatarDataUrl } from "@/lib/avatars/multiavatar";
import { createStudioSettingsCoordinator } from "@/lib/studio/coordinator";
import { applySessionSettingMutation } from "@/features/agents/state/sessionSettingsMutations";
import type { AgentCreateModalSubmitPayload } from "@/features/agents/creation/types";
import {
  isGatewayDisconnectLikeError,
} from "@/lib/gateway/gateway-disconnect";
import type { EventFrame } from "@/lib/gateway/gateway-frames";
import {
  useConfigMutationQueue,
  type ConfigMutationKind,
} from "@/features/agents/operations/useConfigMutationQueue";
import { useGatewayConfigSyncController } from "@/features/agents/operations/useGatewayConfigSyncController";
import { isLocalGatewayUrl } from "@/lib/gateway/local-gateway";
import { randomUUID } from "@/lib/uuid";
import type { ExecApprovalDecision, PendingExecApproval } from "@/features/agents/approvals/types";
import {
  planAwaitingUserInputPatches,
  planPendingPruneDelay,
  planPrunedPendingState,
} from "@/features/agents/approvals/execApprovalControlLoopWorkflow";
import {
  runGatewayEventIngressOperation,
  runPauseRunForExecApprovalOperation,
  runResolveExecApprovalOperation,
} from "@/features/agents/approvals/execApprovalRunControlOperation";
import {
  mergePendingApprovalsForFocusedAgent,
} from "@/features/agents/approvals/pendingStore";
import { createSpecialLatestUpdateOperation } from "@/features/agents/operations/specialLatestUpdateOperation";
import { buildLatestUpdateTriggerMarker } from "@/features/agents/operations/latestUpdateWorkflow";
import {
  resolveAgentPermissionsDraft,
} from "@/features/agents/operations/agentPermissionsOperation";
import {
  executeStudioBootstrapLoadCommands,
  executeStudioFocusedPatchCommands,
  executeStudioFocusedPreferenceLoadCommands,
  runStudioBootstrapLoadOperation,
  runStudioFocusFilterPersistenceOperation,
  runStudioFocusedPreferenceLoadOperation,
  runStudioFocusedSelectionPersistenceOperation,
} from "@/features/agents/operations/studioBootstrapOperation";
import { planStartupFleetBootstrapIntent } from "@/features/agents/operations/studioBootstrapWorkflow";
import {
  CREATE_AGENT_DEFAULT_PERMISSIONS,
  applyCreateAgentBootstrapPermissions,
  executeCreateAgentBootstrapCommands,
  runCreateAgentBootstrapOperation,
} from "@/features/agents/operations/createAgentBootstrapOperation";
import {
  buildQueuedMutationBlock,
  isCreateBlockTimedOut,
  resolveConfigMutationStatusLine,
  runCreateAgentMutationLifecycle,
  type CreateAgentBlockState,
} from "@/features/agents/operations/mutationLifecycleWorkflow";
import { useAgentSettingsMutationController } from "@/features/agents/operations/useAgentSettingsMutationController";
import { createRuntimeWriteTransport } from "@/features/agents/operations/runtimeWriteTransport";
import { useRuntimeSyncController } from "@/features/agents/operations/useRuntimeSyncController";
import { useChatInteractionController } from "@/features/agents/operations/useChatInteractionController";
import {
  SETTINGS_ROUTE_AGENT_ID_QUERY_PARAM,
  parseSettingsRouteAgentIdFromQueryParam,
  parseSettingsRouteAgentIdFromPathname,
  type InspectSidebarState,
  type SettingsRouteTab,
} from "@/features/agents/operations/settingsRouteWorkflow";
import { useSettingsRouteController } from "@/features/agents/operations/useSettingsRouteController";
import {
  loadDomainAgentHistoryWindow,
  listDomainCronJobs,
} from "@/lib/controlplane/domain-runtime-client";
import { useRuntimeEventStream } from "@/features/agents/state/useRuntimeEventStream";
const PENDING_EXEC_APPROVAL_PRUNE_GRACE_MS = 500;

type MobilePane = "fleet" | "chat";

const RESERVED_MAIN_AGENT_ID = "main";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeControlUiBasePath = (basePath: string): string => {
  let normalized = basePath.trim();
  if (!normalized || normalized === "/") return "";
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
};

const resolveControlUiUrl = (params: {
  gatewayUrl: string;
  configSnapshot: GatewayModelPolicySnapshot | null;
}): string | null => {
  const rawGatewayUrl = params.gatewayUrl.trim();
  if (!rawGatewayUrl) return null;

  let controlUiEnabled = true;
  let controlUiBasePath = "";

  const config = params.configSnapshot?.config;
  if (isRecord(config)) {
    const configRecord = config as Record<string, unknown>;
    const gateway = isRecord(configRecord["gateway"])
      ? (configRecord["gateway"] as Record<string, unknown>)
      : null;
    const controlUi = gateway && isRecord(gateway.controlUi) ? gateway.controlUi : null;
    if (controlUi && typeof controlUi.enabled === "boolean") {
      controlUiEnabled = controlUi.enabled;
    }
    if (typeof controlUi?.basePath === "string") {
      controlUiBasePath = normalizeControlUiBasePath(controlUi.basePath);
    }
  }

  if (!controlUiEnabled) return null;

  try {
    const url = new URL(rawGatewayUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = controlUiBasePath ? `${controlUiBasePath}/` : "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
};

const resolveNextNewAgentName = (agents: AgentState[]) => {
  const baseName = "New Agent";
  const existingNames = new Set(
    agents.map((agent) => agent.name.trim().toLowerCase()).filter((name) => name.length > 0)
  );
  const existingIds = new Set(
    agents
      .map((agent) => agent.agentId.trim().toLowerCase())
      .filter((agentId) => agentId.length > 0)
  );
  const baseLower = baseName.toLowerCase();
  if (!existingNames.has(baseLower) && !existingIds.has(slugifyAgentName(baseName))) return baseName;
  for (let index = 2; index < 10000; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (existingNames.has(candidate.toLowerCase())) continue;
    if (existingIds.has(slugifyAgentName(candidate))) continue;
    return candidate;
  }
  throw new Error("Unable to allocate a unique agent name.");
};

const AgentStudioPage = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const settingsRouteAgentId = useMemo(
    () =>
      parseSettingsRouteAgentIdFromQueryParam(
        searchParams.get(SETTINGS_ROUTE_AGENT_ID_QUERY_PARAM)
      ) ?? parseSettingsRouteAgentIdFromPathname(pathname ?? ""),
    [pathname, searchParams]
  );
  const settingsRouteActive = settingsRouteAgentId !== null;
  const [settingsCoordinator] = useState(() => createStudioSettingsCoordinator());
  const {
    client,
    status,
    gatewayUrl,
    draftGatewayUrl,
    token,
    localGatewayDefaults,
    localGatewayDefaultsHasToken,
    hasStoredToken,
    gatewayCredentialScope,
    hasUnsavedChanges,
    installContext,
    statusReason,
    error: gatewayError,
    testResult,
    saving: gatewaySaving,
    testing: gatewayTesting,
    disconnecting: gatewayDisconnecting,
    saveSettings,
    testConnection,
    disconnect,
    useLocalGatewayDefaults,
    setGatewayUrl,
    setToken,
    applyRuntimeStatusEvent,
  } = useStudioGatewaySettings(settingsCoordinator);
  const gatewayStatus: GatewayStatus = status;
  const gatewayConnected = isGatewayConnected(gatewayStatus);
  const gatewayConnectionStatus: "disconnected" | "connecting" | "connected" = gatewayConnected
    ? "connected"
    : gatewayStatus === "connecting" || gatewayStatus === "reconnecting"
      ? "connecting"
      : "disconnected";
  const coreConnected = gatewayConnected;
  const coreStatus = gatewayConnectionStatus;
  const runtimeStreamResumeKey = useMemo(() => {
    const normalizedGatewayUrl = gatewayUrl.trim();
    if (!normalizedGatewayUrl) return null;
    const credentialScope = gatewayCredentialScope.trim();
    return `domain:${normalizedGatewayUrl}:${credentialScope || "anonymous"}`;
  }, [gatewayCredentialScope, gatewayUrl]);
  const runtimeHistoryCacheScope = useMemo(() => {
    const normalizedGatewayUrl = gatewayUrl.trim();
    if (!normalizedGatewayUrl) return "";
    const credentialScope = gatewayCredentialScope.trim();
    return `${normalizedGatewayUrl}\u001f${credentialScope || "anonymous"}`;
  }, [gatewayCredentialScope, gatewayUrl]);
  const runtimeWriteTransport = useMemo(
    () =>
      createRuntimeWriteTransport({
        client,
        useDomainIntents: true,
      }),
    [client]
  );

  const { state, dispatch, hydrateAgents, setError, setLoading } = useAgentStore();
  const [showConnectionPanel, setShowConnectionPanel] = useState(false);
  const [showConnectSetup, setShowConnectSetup] = useState(false);
  const [focusFilter, setFocusFilter] = useState<FocusFilter>("all");
  const [focusedPreferencesLoaded, setFocusedPreferencesLoaded] = useState(false);
  const [agentsLoadedOnce, setAgentsLoadedOnce] = useState(false);
  const [didAttemptGatewayConnect, setDidAttemptGatewayConnect] = useState(false);
  const stateRef = useRef(state);
  const dispatchAgentStoreAction = useCallback(
    (action: Parameters<typeof agentStoreReducer>[1]) => {
      stateRef.current = agentStoreReducer(stateRef.current, action);
      dispatch(action);
    },
    [dispatch]
  );
  const focusFilterTouchedRef = useRef(false);
  const [gatewayModels, setGatewayModels] = useState<GatewayModelChoice[]>([]);
  const [gatewayModelsError, setGatewayModelsError] = useState<string | null>(null);
  const [gatewayConfigSnapshot, setGatewayConfigSnapshot] =
    useState<GatewayModelPolicySnapshot | null>(null);
  const [createAgentBusy, setCreateAgentBusy] = useState(false);
  const [createAgentModalOpen, setCreateAgentModalOpen] = useState(false);
  const [createAgentModalError, setCreateAgentModalError] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>("chat");
  const [inspectSidebar, setInspectSidebar] = useState<InspectSidebarState>(null);
  const [personalityHasUnsavedChanges, setPersonalityHasUnsavedChanges] = useState(false);
  const [createAgentBlock, setCreateAgentBlock] = useState<CreateAgentBlockState | null>(null);
  const [pendingExecApprovalsByAgentId, setPendingExecApprovalsByAgentId] = useState<
    Record<string, PendingExecApproval[]>
  >({});
  const [unscopedPendingExecApprovals, setUnscopedPendingExecApprovals] = useState<
    PendingExecApproval[]
  >([]);
  const pendingExecApprovalsByAgentIdRef = useRef(pendingExecApprovalsByAgentId);
  const unscopedPendingExecApprovalsRef = useRef(unscopedPendingExecApprovals);
  const specialUpdateRef = useRef<Map<string, string>>(new Map());
  const seenCronEventIdsRef = useRef<Set<string>>(new Set());
  const preferredSelectedAgentIdRef = useRef<string | null>(null);
  const lastPersistedFocusedSelectionRef = useRef<{
    gatewayKey: string;
    selectedAgentId: string | null;
  } | null>(null);
  const runtimeEventHandlerRef = useRef<ReturnType<typeof createGatewayRuntimeEventHandler> | null>(
    null
  );
  const enqueueConfigMutationRef = useRef<
    (params: {
      kind: ConfigMutationKind;
      label: string;
      run: () => Promise<void>;
      requiresIdleAgents?: boolean;
    }) => Promise<void>
  >((input) => Promise.reject(new Error(`Config mutation queue not ready for "${input.kind}".`)));
  const approvalPausedRunIdByAgentRef = useRef<Map<string, string>>(new Map());
  const domainEventIngressRef = useRef<(event: EventFrame) => void>(() => {});
  const pendingDomainOutboxEntriesRef = useRef<ControlPlaneOutboxEntry[]>([]);
  const loadAgentsInFlightRef = useRef<Promise<void> | null>(null);
  const startupFleetBootstrapCompletedKeyRef = useRef<string | null>(null);
  const startupFleetBootstrapInFlightKeyRef = useRef<string | null>(null);

  const agents = state.agents;
  const selectedAgent = useMemo(() => getSelectedAgent(state), [state]);
  const filteredAgents = useMemo(
    () => getFilteredAgents(state, focusFilter),
    [focusFilter, state]
  );
  const focusedAgent = useMemo(() => {
    if (filteredAgents.length === 0) return null;
    const selectedInFilter = selectedAgent
      ? filteredAgents.find((entry) => entry.agentId === selectedAgent.agentId)
      : null;
    return selectedInFilter ?? filteredAgents[0] ?? null;
  }, [filteredAgents, selectedAgent]);
  const focusedAgentId = focusedAgent?.agentId ?? null;
  const focusedAgentStopDisabledReason = useMemo(() => {
    if (!focusedAgent) return null;
    if (focusedAgent.status !== "running") return null;
    const lastMessage = focusedAgent.lastUserMessage?.trim() ?? "";
    if (!lastMessage || !isHeartbeatPrompt(lastMessage)) return null;
    return "This task is running as an automatic heartbeat check. Stopping heartbeat runs from Studio isn't available yet (coming soon).";
  }, [focusedAgent]);
  const inspectSidebarAgentId = inspectSidebar?.agentId ?? null;
  const inspectSidebarTab = inspectSidebar?.tab ?? null;
  const effectiveSettingsTab: SettingsRouteTab = inspectSidebarTab ?? "personality";
  const inspectSidebarAgent = useMemo(() => {
    if (!inspectSidebarAgentId) return null;
    return agents.find((entry) => entry.agentId === inspectSidebarAgentId) ?? null;
  }, [agents, inspectSidebarAgentId]);
  const settingsAgentPermissionsDraft = useMemo(() => {
    if (!inspectSidebarAgent) return null;
    const baseConfig =
      gatewayConfigSnapshot?.config &&
      typeof gatewayConfigSnapshot.config === "object" &&
      !Array.isArray(gatewayConfigSnapshot.config)
        ? (gatewayConfigSnapshot.config as Record<string, unknown>)
        : undefined;
    const list = readConfigAgentList(baseConfig);
    const configEntry = list.find((entry) => entry.id === inspectSidebarAgent.agentId) ?? null;
    const toolsRaw =
      configEntry && typeof (configEntry as Record<string, unknown>).tools === "object"
        ? ((configEntry as Record<string, unknown>).tools as unknown)
        : null;
    const tools =
      toolsRaw && typeof toolsRaw === "object" && !Array.isArray(toolsRaw)
        ? (toolsRaw as Record<string, unknown>)
        : null;
    return resolveAgentPermissionsDraft({
      agent: inspectSidebarAgent,
      existingTools: tools,
    });
  }, [gatewayConfigSnapshot, inspectSidebarAgent]);
  const focusedPendingExecApprovals = useMemo(() => {
    if (!focusedAgentId) return unscopedPendingExecApprovals;
    const scoped = pendingExecApprovalsByAgentId[focusedAgentId] ?? [];
    return mergePendingApprovalsForFocusedAgent({
      scopedApprovals: scoped,
      unscopedApprovals: unscopedPendingExecApprovals,
    });
  }, [focusedAgentId, pendingExecApprovalsByAgentId, unscopedPendingExecApprovals]);
  const suggestedCreateAgentName = useMemo(() => {
    try {
      return resolveNextNewAgentName(state.agents);
    } catch {
      return "New Agent";
    }
  }, [state.agents]);
  const faviconSeed = useMemo(() => {
    const firstAgent = agents[0];
    const seed = firstAgent?.avatarSeed ?? firstAgent?.agentId ?? "";
    return seed.trim() || null;
  }, [agents]);
  const faviconHref = useMemo(
    () => (faviconSeed ? buildAvatarDataUrl(faviconSeed) : null),
    [faviconSeed]
  );
  const errorMessage = state.error ?? gatewayError ?? gatewayModelsError;
  const studioCliUpdateWarning = useMemo(() => {
    const studioCli = installContext.studioCli;
    if (!studioCli.installed || !studioCli.updateAvailable) return null;
    const current = studioCli.currentVersion?.trim() || "current";
    const latest = studioCli.latestVersion?.trim() || "latest";
    return `openclaw-studio CLI ${current} is installed on this host, but ${latest} is available. Run npx -y openclaw-studio@latest to update.`;
  }, [installContext]);
  const runningAgentCount = useMemo(
    () => agents.filter((agent) => agent.status === "running").length,
    [agents]
  );
  const hasRunningAgents = runningAgentCount > 0;
  const isLocalGateway = useMemo(() => isLocalGatewayUrl(gatewayUrl), [gatewayUrl]);
  const controlUiUrl = useMemo(
    () => resolveControlUiUrl({ gatewayUrl, configSnapshot: gatewayConfigSnapshot }),
    [gatewayConfigSnapshot, gatewayUrl]
  );
  const settingsHeaderModel = (inspectSidebarAgent?.model ?? "").trim() || "Default";
  const settingsHeaderThinkingRaw = (inspectSidebarAgent?.thinkingLevel ?? "").trim() || "low";
  const settingsHeaderThinking =
    settingsHeaderThinkingRaw.charAt(0).toUpperCase() + settingsHeaderThinkingRaw.slice(1);

  useEffect(() => {
    const selector = 'link[data-agent-favicon="true"]';
    const existing = document.querySelector(selector) as HTMLLinkElement | null;
    if (!faviconHref) {
      existing?.remove();
      return;
    }
    if (existing) {
      if (existing.href !== faviconHref) {
        existing.href = faviconHref;
      }
      return;
    }
    const link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.href = faviconHref;
    link.setAttribute("data-agent-favicon", "true");
    document.head.appendChild(link);
  }, [faviconHref]);


  const resolveCronJobForAgent = useCallback((jobs: CronJobSummary[], agentId: string) => {
    return resolveLatestCronJobForAgent(jobs, agentId);
  }, []);

  const specialLatestUpdate = useMemo(() => {
    return createSpecialLatestUpdateOperation({
      loadAgentHistoryWindow: loadDomainAgentHistoryWindow,
      listCronJobs: () => listDomainCronJobs({ includeDisabled: true }),
      resolveCronJobForAgent,
      formatCronJobDisplay,
      dispatchUpdateAgent: (agentId, patch) => {
        dispatch({ type: "updateAgent", agentId, patch });
      },
      isDisconnectLikeError: isGatewayDisconnectLikeError,
      logError: (message) => console.error(message),
    });
  }, [dispatch, resolveCronJobForAgent]);

  const loadAgents = useCallback(async () => {
    const inFlight = loadAgentsInFlightRef.current;
    if (inFlight) {
      await inFlight;
      return;
    }
    const run = (async () => {
      if (!coreConnected) return;
      setLoading(true);
      try {
        const commands = await runStudioBootstrapLoadOperation({
          cachedConfigSnapshot: gatewayConfigSnapshot,
          preferredSelectedAgentId: preferredSelectedAgentIdRef.current,
          hasCurrentSelection: Boolean(stateRef.current.selectedAgentId),
        });
        executeStudioBootstrapLoadCommands({
          commands,
          setGatewayConfigSnapshot,
          hydrateAgents,
          dispatchUpdateAgent: (agentId, patch) => {
            dispatch({ type: "updateAgent", agentId, patch });
          },
          setError,
        });
      } finally {
        setLoading(false);
        setAgentsLoadedOnce(true);
      }
    })();
    loadAgentsInFlightRef.current = run;
    try {
      await run;
    } finally {
      if (loadAgentsInFlightRef.current === run) {
        loadAgentsInFlightRef.current = null;
      }
    }
  }, [
    dispatch,
    hydrateAgents,
    setError,
    setLoading,
    gatewayConfigSnapshot,
    coreConnected,
  ]);

  const enqueueConfigMutationFromRef = useCallback(
    (mutation: { kind: ConfigMutationKind; label: string; run: () => Promise<void> }) => {
      return enqueueConfigMutationRef.current(mutation);
    },
    []
  );

  const { refreshGatewayConfigSnapshot } = useGatewayConfigSyncController({
    status: gatewayConnectionStatus,
    settingsRouteActive,
    inspectSidebarAgentId,
    setGatewayConfigSnapshot,
    setGatewayModels,
    setGatewayModelsError,
    isDisconnectLikeError: isGatewayDisconnectLikeError,
  });

  const settingsMutationController = useAgentSettingsMutationController({
    client,
    runtimeWriteTransport,
    status: gatewayConnectionStatus,
    isLocalGateway,
    agents,
    hasCreateBlock: Boolean(createAgentBlock),
    enqueueConfigMutation: enqueueConfigMutationFromRef,
    gatewayConfigSnapshot,
    settingsRouteActive,
    inspectSidebarAgentId,
    inspectSidebarTab,
    loadAgents,
    refreshGatewayConfigSnapshot,
    clearInspectSidebar: () => {
      setInspectSidebar(null);
    },
    setInspectSidebarCapabilities: (agentId) => {
      setInspectSidebar((current) => {
        if (current?.agentId === agentId) return current;
        return { agentId, tab: "capabilities" };
      });
    },
    dispatchUpdateAgent: (agentId, patch) => {
      dispatch({
        type: "updateAgent",
        agentId,
        patch,
      });
    },
    setMobilePaneChat: () => {
      setMobilePane("chat");
    },
    setError,
    useDomainIntents: true,
  });

  const hasRenameMutationBlock = settingsMutationController.hasRenameMutationBlock;
  const hasDeleteMutationBlock = settingsMutationController.hasDeleteMutationBlock;
  const restartingMutationBlock = settingsMutationController.restartingMutationBlock;
  const hasRestartBlockInProgress = Boolean(
    settingsMutationController.hasRestartBlockInProgress ||
      (createAgentBlock && createAgentBlock.phase !== "queued")
  );

  const {
    enqueueConfigMutation,
    queuedCount: queuedConfigMutationCount,
    queuedBlockedByRunningAgents,
    activeConfigMutation,
  } = useConfigMutationQueue({
    status: gatewayConnectionStatus,
    hasRunningAgents,
    hasRestartBlockInProgress,
  });
  enqueueConfigMutationRef.current = enqueueConfigMutation;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    pendingExecApprovalsByAgentIdRef.current = pendingExecApprovalsByAgentId;
  }, [pendingExecApprovalsByAgentId]);

  useEffect(() => {
    unscopedPendingExecApprovalsRef.current = unscopedPendingExecApprovals;
  }, [unscopedPendingExecApprovals]);

  useEffect(() => {
    if (coreConnected) return;
    setAgentsLoadedOnce(false);
  }, [coreConnected, gatewayUrl]);

  useEffect(() => {
    let cancelled = false;
    const key = gatewayUrl.trim();
    if (!key) {
      preferredSelectedAgentIdRef.current = null;
      lastPersistedFocusedSelectionRef.current = null;
      setFocusedPreferencesLoaded(true);
      return;
    }
    setFocusedPreferencesLoaded(false);
    focusFilterTouchedRef.current = false;
    preferredSelectedAgentIdRef.current = null;
    lastPersistedFocusedSelectionRef.current = null;
    const loadFocusedPreferences = async () => {
      const commands = await runStudioFocusedPreferenceLoadOperation({
        gatewayUrl,
        loadStudioSettings: settingsCoordinator.loadSettings.bind(settingsCoordinator),
        isFocusFilterTouched: () => focusFilterTouchedRef.current,
      });
      if (cancelled) return;
      executeStudioFocusedPreferenceLoadCommands({
        commands,
        setFocusedPreferencesLoaded,
        setPreferredSelectedAgentId: (agentId) => {
          preferredSelectedAgentIdRef.current = agentId;
          const normalizedAgentId = agentId?.trim() ?? "";
          lastPersistedFocusedSelectionRef.current = {
            gatewayKey: key,
            selectedAgentId: normalizedAgentId.length > 0 ? normalizedAgentId : null,
          };
        },
        setFocusFilter,
        logError: (message, error) => console.error(message, error),
      });
    };
    void loadFocusedPreferences();
    return () => {
      cancelled = true;
    };
  }, [gatewayUrl, settingsCoordinator]);

  useEffect(() => {
    const flushPending = () => {
      void settingsCoordinator.flushPending();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      flushPending();
    };
    window.addEventListener("pagehide", flushPending);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushPending);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      flushPending();
    };
  }, [settingsCoordinator]);

  useEffect(() => {
    const commands = runStudioFocusFilterPersistenceOperation({
      gatewayUrl,
      focusFilterTouched: focusFilterTouchedRef.current,
      focusFilter,
    });
    executeStudioFocusedPatchCommands({
      commands,
      schedulePatch: settingsCoordinator.schedulePatch.bind(settingsCoordinator),
      applyPatchNow: settingsCoordinator.applyPatchNow.bind(settingsCoordinator),
      logError: (message, error) => console.error(message, error),
    });
  }, [focusFilter, gatewayUrl, settingsCoordinator]);

  useEffect(() => {
    const normalizedGatewayKey = gatewayUrl.trim();
    const normalizedSelectedAgentId = (state.selectedAgentId?.trim() ?? "") || null;
    const lastPersistedSelection = lastPersistedFocusedSelectionRef.current;
    const lastPersistedSelectedAgentId =
      lastPersistedSelection && lastPersistedSelection.gatewayKey === normalizedGatewayKey
        ? lastPersistedSelection.selectedAgentId
        : null;
    const commands = runStudioFocusedSelectionPersistenceOperation({
      gatewayUrl,
      status: coreStatus,
      focusedPreferencesLoaded,
      agentsLoadedOnce,
      selectedAgentId: state.selectedAgentId,
      lastPersistedSelectedAgentId,
    });
    executeStudioFocusedPatchCommands({
      commands,
      schedulePatch: settingsCoordinator.schedulePatch.bind(settingsCoordinator),
      applyPatchNow: async (patch) => {
        await settingsCoordinator.applyPatchNow(patch);
        lastPersistedFocusedSelectionRef.current = {
          gatewayKey: normalizedGatewayKey,
          selectedAgentId: normalizedSelectedAgentId,
        };
      },
      logError: (message, error) => console.error(message, error),
    });
  }, [
    agentsLoadedOnce,
    focusedPreferencesLoaded,
    gatewayUrl,
    settingsCoordinator,
    coreStatus,
    state.selectedAgentId,
  ]);

  useEffect(() => {
    const intent = planStartupFleetBootstrapIntent({
      coreConnected,
      focusedPreferencesLoaded,
      hasRestartingMutationBlock: Boolean(
        restartingMutationBlock && restartingMutationBlock.phase !== "queued"
      ),
      hasCreateAgentBlock: Boolean(createAgentBlock && createAgentBlock.phase !== "queued"),
      gatewayUrl,
      lastCompletedKey: startupFleetBootstrapCompletedKeyRef.current,
      inFlightKey: startupFleetBootstrapInFlightKeyRef.current,
    });
    if (intent.kind !== "load") return;
    startupFleetBootstrapInFlightKeyRef.current = intent.key;
    void (async () => {
      try {
        await loadAgents();
        startupFleetBootstrapCompletedKeyRef.current = intent.key;
      } finally {
        if (startupFleetBootstrapInFlightKeyRef.current === intent.key) {
          startupFleetBootstrapInFlightKeyRef.current = null;
        }
      }
    })();
  }, [
    coreConnected,
    createAgentBlock,
    focusedPreferencesLoaded,
    gatewayUrl,
    loadAgents,
    restartingMutationBlock,
  ]);

  useEffect(() => {
    if (coreConnected && focusedPreferencesLoaded) return;
    startupFleetBootstrapCompletedKeyRef.current = null;
    startupFleetBootstrapInFlightKeyRef.current = null;
  }, [coreConnected, focusedPreferencesLoaded]);

  useEffect(() => {
    startupFleetBootstrapCompletedKeyRef.current = null;
    startupFleetBootstrapInFlightKeyRef.current = null;
  }, [gatewayUrl]);

  useEffect(() => {
    if (!coreConnected) {
      setLoading(false);
    }
  }, [coreConnected, setLoading]);

  useEffect(() => {
    const nowMs = Date.now();
    const delayMs = planPendingPruneDelay({
      pendingState: {
        approvalsByAgentId: pendingExecApprovalsByAgentId,
        unscopedApprovals: unscopedPendingExecApprovals,
      },
      nowMs,
      graceMs: PENDING_EXEC_APPROVAL_PRUNE_GRACE_MS,
    });
    if (delayMs === null) return;
    const timerId = window.setTimeout(() => {
      const pendingState = planPrunedPendingState({
        pendingState: {
          approvalsByAgentId: pendingExecApprovalsByAgentIdRef.current,
          unscopedApprovals: unscopedPendingExecApprovalsRef.current,
        },
        nowMs: Date.now(),
        graceMs: PENDING_EXEC_APPROVAL_PRUNE_GRACE_MS,
      });
      pendingExecApprovalsByAgentIdRef.current = pendingState.approvalsByAgentId;
      unscopedPendingExecApprovalsRef.current = pendingState.unscopedApprovals;
      setPendingExecApprovalsByAgentId(pendingState.approvalsByAgentId);
      setUnscopedPendingExecApprovals(pendingState.unscopedApprovals);
    }, delayMs);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [pendingExecApprovalsByAgentId, unscopedPendingExecApprovals]);

  useEffect(() => {
    const patches = planAwaitingUserInputPatches({
      agents,
      approvalsByAgentId: pendingExecApprovalsByAgentId,
    });
    for (const patch of patches) {
      dispatch({
        type: "updateAgent",
        agentId: patch.agentId,
        patch: { awaitingUserInput: patch.awaitingUserInput },
      });
    }
  }, [agents, dispatch, pendingExecApprovalsByAgentId]);

  useEffect(() => {
    for (const agent of agents) {
      const lastMessage = agent.lastUserMessage?.trim() ?? "";
      const key = agent.agentId;
      const marker = buildLatestUpdateTriggerMarker({
        message: lastMessage,
        lastAssistantMessageAt: agent.lastAssistantMessageAt,
      });
      const previous = specialUpdateRef.current.get(key);
      if (previous === marker) continue;
      specialUpdateRef.current.set(key, marker);
      void specialLatestUpdate.update(agent.agentId, agent, lastMessage);
    }
  }, [agents, specialLatestUpdate]);

  const ingestDomainOutboxEntries = useCallback((entries: ControlPlaneOutboxEntry[]) => {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const handler = runtimeEventHandlerRef.current;
    const ingestEvent = domainEventIngressRef.current;
    if (!handler) {
      pendingDomainOutboxEntriesRef.current.push(...entries);
      const overflow = pendingDomainOutboxEntriesRef.current.length - 5_000;
      if (overflow > 0) {
        pendingDomainOutboxEntriesRef.current.splice(0, overflow);
      }
      return;
    }
    for (const entry of entries) {
      if (entry.event.type !== "gateway.event") continue;
      const frame: EventFrame = {
        type: "event",
        event: entry.event.event,
        payload: entry.event.payload,
        ...(typeof entry.event.seq === "number" ? { seq: entry.event.seq } : {}),
      };
      handler.handleEvent(frame);
      ingestEvent(frame);
    }
  }, []);

  const { loadAgentHistory, loadMoreAgentHistory, clearHistoryInFlight } = useRuntimeSyncController({
    status: coreStatus,
    gatewayUrl: runtimeHistoryCacheScope,
    agents,
    focusedAgentId,
    dispatch,
    runtimeWriteTransport,
    clearRunTracking: (runId) => {
      runtimeEventHandlerRef.current?.clearRunTracking(runId);
    },
    isDisconnectLikeError: isGatewayDisconnectLikeError,
  });

  const {
    stopBusyAgentId,
    flushPendingDraft,
    handleDraftChange,
    handleSend,
    removeQueuedMessage,
    handleNewSession,
    handleStopRun,
    queueLivePatch,
    clearPendingLivePatch,
  } = useChatInteractionController({
    client,
    runtimeWriteTransport,
    status: gatewayConnectionStatus,
    agents,
    dispatch,
    setError,
    getAgents: () => stateRef.current.agents,
    clearRunTracking: (runId) => {
      runtimeEventHandlerRef.current?.clearRunTracking(runId);
    },
    clearHistoryInFlight,
    clearSpecialUpdateMarker: (agentId) => {
      specialUpdateRef.current.delete(agentId);
    },
    clearSpecialLatestUpdateInFlight: (agentId) => {
      specialLatestUpdate.clearInFlight(agentId);
    },
    setInspectSidebarNull: () => {
      setInspectSidebar(null);
    },
    setMobilePaneChat: () => {
      setMobilePane("chat");
    },
  });

  const handleFocusFilterChange = useCallback(
    (next: FocusFilter) => {
      flushPendingDraft(focusedAgent?.agentId ?? null);
      focusFilterTouchedRef.current = true;
      setFocusFilter(next);
    },
    [flushPendingDraft, focusedAgent]
  );

  const {
    handleBackToChat,
    handleSettingsRouteTabChange,
    handleOpenAgentSettingsRoute,
    handleFleetSelectAgent,
  } = useSettingsRouteController({
    settingsRouteActive,
    settingsRouteAgentId,
    status: gatewayConnectionStatus,
    agentsLoadedOnce,
    selectedAgentId: state.selectedAgentId,
    focusedAgentId: focusedAgent?.agentId ?? null,
    personalityHasUnsavedChanges,
    activeTab: effectiveSettingsTab,
    inspectSidebar,
    agents,
    flushPendingDraft,
    dispatchSelectAgent: (agentId) => {
      dispatch({ type: "selectAgent", agentId });
    },
    setInspectSidebar,
    setMobilePaneChat: () => {
      setMobilePane("chat");
    },
    setPersonalityHasUnsavedChanges,
    push: router.push,
    replace: router.replace,
    confirmDiscard: () => window.confirm("Discard changes?"),
  });
  const handleOpenCreateAgentModal = useCallback(() => {
    if (createAgentBusy) return;
    if (createAgentBlock) return;
    if (restartingMutationBlock) return;
    setCreateAgentModalError(null);
    setCreateAgentModalOpen(true);
  }, [createAgentBlock, createAgentBusy, restartingMutationBlock]);

  const persistAvatarSeed = useCallback(
    (agentId: string, avatarSeed: string) => {
      const resolvedAgentId = agentId.trim();
      const resolvedAvatarSeed = avatarSeed.trim();
      const key = gatewayUrl.trim();
      if (!resolvedAgentId || !resolvedAvatarSeed || !key) return;
      settingsCoordinator.schedulePatch(
        {
          avatars: {
            [key]: {
              [resolvedAgentId]: resolvedAvatarSeed,
            },
          },
        },
        0
      );
    },
    [gatewayUrl, settingsCoordinator]
  );

  const handleCreateAgentSubmit = useCallback(
    async (payload: AgentCreateModalSubmitPayload) => {
      await runCreateAgentMutationLifecycle(
        {
          payload,
          status: gatewayConnectionStatus,
          hasCreateBlock: Boolean(createAgentBlock),
          hasRenameBlock: hasRenameMutationBlock,
          hasDeleteBlock: hasDeleteMutationBlock,
          createAgentBusy,
        },
        {
          enqueueConfigMutation,
          createAgent: async (name, avatarSeed) => {
            const created = await runtimeWriteTransport.agentCreate({ name });
            if (avatarSeed) {
              persistAvatarSeed(created.id, avatarSeed);
            }
            flushPendingDraft(focusedAgent?.agentId ?? null);
            focusFilterTouchedRef.current = true;
            setFocusFilter("all");
            dispatch({ type: "selectAgent", agentId: created.id });
            return { id: created.id };
          },
          setQueuedBlock: ({ agentName, startedAt }) => {
            const queuedCreateBlock = buildQueuedMutationBlock({
              kind: "create-agent",
              agentId: "",
              agentName,
              startedAt,
            });
            setCreateAgentBlock({
              agentName: queuedCreateBlock.agentName,
              phase: "queued",
              startedAt: queuedCreateBlock.startedAt,
            });
          },
          setCreatingBlock: (agentName) => {
            setCreateAgentBlock((current) => {
              if (!current || current.agentName !== agentName) return current;
              return { ...current, phase: "creating" };
            });
          },
          onCompletion: async (completion) => {
            const commands = await runCreateAgentBootstrapOperation({
              completion,
              focusedAgentId: focusedAgent?.agentId ?? null,
              loadAgents,
              findAgentById: (agentId) =>
                stateRef.current.agents.find((entry) => entry.agentId === agentId) ?? null,
              applyDefaultPermissions: async ({ agentId, sessionKey }) => {
                await applyCreateAgentBootstrapPermissions({
                  client,
                  runtimeWriteTransport,
                  agentId,
                  sessionKey,
                  draft: { ...CREATE_AGENT_DEFAULT_PERMISSIONS },
                  loadAgents,
                });
              },
              refreshGatewayConfigSnapshot,
            });
            executeCreateAgentBootstrapCommands({
              commands,
              setCreateAgentModalError,
              setGlobalError: setError,
              setCreateAgentBlock: (value) => {
                setCreateAgentBlock(value);
              },
              setCreateAgentModalOpen,
              flushPendingDraft,
              selectAgent: (agentId) => {
                dispatch({ type: "selectAgent", agentId });
              },
              setInspectSidebarCapabilities: (agentId) => {
                setInspectSidebar({ agentId, tab: "capabilities" });
              },
              setMobilePaneChat: () => {
                setMobilePane("chat");
              },
            });
          },
          setCreateAgentModalError,
          setCreateAgentBusy,
          clearCreateBlock: () => {
            setCreateAgentBlock(null);
          },
          onError: setError,
        }
      );
    },
    [
      client,
      createAgentBusy,
      createAgentBlock,
      dispatch,
      enqueueConfigMutation,
      flushPendingDraft,
      focusedAgent,
      hasDeleteMutationBlock,
      hasRenameMutationBlock,
      loadAgents,
      persistAvatarSeed,
      refreshGatewayConfigSnapshot,
      runtimeWriteTransport,
      setError,
      gatewayConnectionStatus,
    ]
  );

  useEffect(() => {
    if (!createAgentBlock || createAgentBlock.phase === "queued") return;
    const maxWaitMs = 90_000;
    const timeoutNow = isCreateBlockTimedOut({
      block: createAgentBlock,
      nowMs: Date.now(),
      maxWaitMs,
    });
    const handleTimeout = () => {
      setCreateAgentBlock(null);
      setCreateAgentModalOpen(false);
      void loadAgents();
      setError("Agent creation timed out.");
    };
    if (timeoutNow) {
      handleTimeout();
      return;
    }
    const elapsed = Date.now() - createAgentBlock.startedAt;
    const remaining = Math.max(0, maxWaitMs - elapsed);
    const timeoutId = window.setTimeout(() => {
      if (
        !isCreateBlockTimedOut({
          block: createAgentBlock,
          nowMs: Date.now(),
          maxWaitMs,
        })
      ) {
        return;
      }
      handleTimeout();
    }, remaining);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [createAgentBlock, loadAgents, setError]);

  const handleSessionSettingChange = useCallback(
    async (
      agentId: string,
      sessionKey: string,
      field: "model" | "thinkingLevel",
      value: string | null
    ) => {
      await applySessionSettingMutation({
        agents: stateRef.current.agents,
        dispatch,
        client,
        runtimeWriteTransport,
        agentId,
        sessionKey,
        field,
        value,
      });
    },
    [client, dispatch, runtimeWriteTransport]
  );

  const handleModelChange = useCallback(
    async (agentId: string, sessionKey: string, value: string | null) => {
      await handleSessionSettingChange(agentId, sessionKey, "model", value);
    },
    [handleSessionSettingChange]
  );

  const handleThinkingChange = useCallback(
    async (agentId: string, sessionKey: string, value: string | null) => {
      await handleSessionSettingChange(agentId, sessionKey, "thinkingLevel", value);
    },
    [handleSessionSettingChange]
  );


  const handleToolCallingToggle = useCallback(
    (agentId: string, enabled: boolean) => {
      dispatch({
        type: "updateAgent",
        agentId,
        patch: { toolCallingEnabled: enabled },
      });
    },
    [dispatch]
  );

  const handleThinkingTracesToggle = useCallback(
    (agentId: string, enabled: boolean) => {
      dispatch({
        type: "updateAgent",
        agentId,
        patch: { showThinkingTraces: enabled },
      });
      if (enabled) {
        void loadAgentHistory(agentId, { reason: "refresh" });
      }
    },
    [dispatch, loadAgentHistory]
  );

  const handleResolveExecApproval = useCallback(
    async (approvalId: string, decision: ExecApprovalDecision) => {
      await runResolveExecApprovalOperation({
        client,
        runtimeWriteTransport,
        approvalId,
        decision,
        getAgents: () => stateRef.current.agents,
        getPendingState: () => ({
          approvalsByAgentId: pendingExecApprovalsByAgentIdRef.current,
          unscopedApprovals: unscopedPendingExecApprovalsRef.current,
        }),
        setPendingExecApprovalsByAgentId: (next) => {
          setPendingExecApprovalsByAgentId((current) => {
            const resolved = typeof next === "function" ? next(current) : next;
            pendingExecApprovalsByAgentIdRef.current = resolved;
            return resolved;
          });
        },
        setUnscopedPendingExecApprovals: (next) => {
          setUnscopedPendingExecApprovals((current) => {
            const resolved = typeof next === "function" ? next(current) : next;
            unscopedPendingExecApprovalsRef.current = resolved;
            return resolved;
          });
        },
        requestHistoryRefresh: (agentId) => loadAgentHistory(agentId),
        pausedRunIdByAgentId: approvalPausedRunIdByAgentRef.current,
        dispatch: dispatchAgentStoreAction,
        isDisconnectLikeError: isGatewayDisconnectLikeError,
        logWarn: (message, error) => console.warn(message, error),
        clearRunTracking: (runId) => runtimeEventHandlerRef.current?.clearRunTracking(runId),
      });
    },
    [client, dispatchAgentStoreAction, loadAgentHistory, runtimeWriteTransport]
  );

  const pauseRunForExecApproval = useCallback(
    async (approval: PendingExecApproval, preferredAgentId?: string | null) => {
      await runPauseRunForExecApprovalOperation({
        status: gatewayStatus,
        runtimeWriteTransport,
        approval,
        preferredAgentId: preferredAgentId ?? null,
        getAgents: () => stateRef.current.agents,
        pausedRunIdByAgentId: approvalPausedRunIdByAgentRef.current,
        isDisconnectLikeError: isGatewayDisconnectLikeError,
        logWarn: (message, error) => console.warn(message, error),
      });
    },
    [gatewayStatus, runtimeWriteTransport]
  );

  const handleGatewayEventIngress = useCallback(
    (event: EventFrame) => {
      runGatewayEventIngressOperation({
        event,
        getAgents: () => stateRef.current.agents,
        getPendingState: () => ({
          approvalsByAgentId: pendingExecApprovalsByAgentIdRef.current,
          unscopedApprovals: unscopedPendingExecApprovalsRef.current,
        }),
        pausedRunIdByAgentId: approvalPausedRunIdByAgentRef.current,
        seenCronDedupeKeys: seenCronEventIdsRef.current,
        nowMs: Date.now(),
        replacePendingState: (pendingState) => {
          if (
            pendingState.approvalsByAgentId !==
            pendingExecApprovalsByAgentIdRef.current
          ) {
            pendingExecApprovalsByAgentIdRef.current =
              pendingState.approvalsByAgentId;
            setPendingExecApprovalsByAgentId(pendingState.approvalsByAgentId);
          }
          if (
            pendingState.unscopedApprovals !==
            unscopedPendingExecApprovalsRef.current
          ) {
            unscopedPendingExecApprovalsRef.current =
              pendingState.unscopedApprovals;
            setUnscopedPendingExecApprovals(pendingState.unscopedApprovals);
          }
        },
        pauseRunForApproval: (approval, commandPreferredAgentId) =>
          pauseRunForExecApproval(approval, commandPreferredAgentId),
        dispatch: dispatchAgentStoreAction,
        recordCronDedupeKey: (dedupeKey) => seenCronEventIdsRef.current.add(dedupeKey),
      });
    },
    [dispatchAgentStoreAction, pauseRunForExecApproval]
  );
  domainEventIngressRef.current = handleGatewayEventIngress;

  useEffect(() => {
    const handler = createGatewayRuntimeEventHandler({
      getAgents: () => stateRef.current.agents,
      dispatch: dispatchAgentStoreAction,
      queueLivePatch,
      clearPendingLivePatch,
      setTimeout: (fn, delayMs) => window.setTimeout(fn, delayMs),
      clearTimeout: (id) => window.clearTimeout(id),
      logWarn: (message, meta) => console.warn(message, meta),
      shouldSuppressRunAbortedLine: ({ agentId, runId, stopReason }) => {
        if (stopReason !== "rpc") return false;
        const normalizedRunId = runId?.trim() ?? "";
        if (!normalizedRunId) return false;
        const pausedRunId = approvalPausedRunIdByAgentRef.current.get(agentId)?.trim() ?? "";
        return pausedRunId.length > 0 && pausedRunId === normalizedRunId;
      },
      updateSpecialLatestUpdate: (agentId, agent, message) => {
        void specialLatestUpdate.update(agentId, agent, message);
      },
    });
    runtimeEventHandlerRef.current = handler;
    if (pendingDomainOutboxEntriesRef.current.length > 0) {
      const pendingEntries = pendingDomainOutboxEntriesRef.current;
      pendingDomainOutboxEntriesRef.current = [];
      ingestDomainOutboxEntries(pendingEntries);
    }
    return () => {
      runtimeEventHandlerRef.current = null;
      handler.dispose();
    };
  }, [
    dispatchAgentStoreAction,
    clearPendingLivePatch,
    queueLivePatch,
    specialLatestUpdate,
    ingestDomainOutboxEntries,
  ]);

  const gatewayConnecting = gatewayStatus === "connecting" || gatewayStatus === "reconnecting";

  useRuntimeEventStream({
    onGatewayEvent: (event) => {
      runtimeEventHandlerRef.current?.handleEvent(event);
      domainEventIngressRef.current(event);
    },
    onRuntimeStatus: (event) => {
      applyRuntimeStatusEvent(event);
    },
    resumeKey: runtimeStreamResumeKey ?? undefined,
  });

  const handleAvatarShuffle = useCallback(
    async (agentId: string) => {
      const avatarSeed = randomUUID();
      dispatch({
        type: "updateAgent",
        agentId,
        patch: { avatarSeed },
      });
      persistAvatarSeed(agentId, avatarSeed);
    },
    [dispatch, persistAvatarSeed]
  );

  const connectionPanelVisible = showConnectionPanel;
  const hasAnyAgents = agents.length > 0;
  const configMutationStatusLine = activeConfigMutation
    ? `Applying config change: ${activeConfigMutation.label}`
    : queuedConfigMutationCount > 0
      ? queuedBlockedByRunningAgents
        ? `Queued ${queuedConfigMutationCount} config change${queuedConfigMutationCount === 1 ? "" : "s"}; waiting for ${runningAgentCount} running agent${runningAgentCount === 1 ? "" : "s"} to finish`
        : !gatewayConnected
          ? `Queued ${queuedConfigMutationCount} config change${queuedConfigMutationCount === 1 ? "" : "s"}; waiting for gateway connection`
          : `Queued ${queuedConfigMutationCount} config change${queuedConfigMutationCount === 1 ? "" : "s"}`
      : null;
  const createBlockStatusLine = createAgentBlock
    ? createAgentBlock.phase === "queued"
      ? "Waiting for active runs to finish"
      : createAgentBlock.phase === "creating"
      ? "Submitting config change"
      : null
    : null;
  const restartingMutationStatusLine = resolveConfigMutationStatusLine({
    block: restartingMutationBlock
      ? {
          phase: restartingMutationBlock.phase,
          sawDisconnect: restartingMutationBlock.sawDisconnect,
        }
      : null,
    status: gatewayStatus,
  });
  const restartingMutationModalTestId = restartingMutationBlock
    ? restartingMutationBlock.kind === "delete-agent"
      ? "agent-delete-restart-modal"
      : "agent-rename-restart-modal"
    : null;
  const restartingMutationAriaLabel = restartingMutationBlock
    ? restartingMutationBlock.kind === "delete-agent"
      ? "Deleting agent and restarting gateway"
      : "Renaming agent and restarting gateway"
    : null;
  const restartingMutationHeading = restartingMutationBlock
    ? restartingMutationBlock.kind === "delete-agent"
      ? "Agent delete in progress"
      : "Agent rename in progress"
    : null;

  useEffect(() => {
    if (gatewayStatus === "connecting" || gatewayStatus === "reconnecting") {
      setDidAttemptGatewayConnect(true);
    }
  }, [gatewayStatus]);

  useEffect(() => {
    if (gatewayError) {
      setDidAttemptGatewayConnect(true);
    }
  }, [gatewayError]);

  if (
    !agentsLoadedOnce &&
    !coreConnected &&
    !showConnectSetup &&
    (!didAttemptGatewayConnect || gatewayConnecting)
  ) {
    return (
      <div className="relative min-h-dvh w-screen overflow-hidden bg-background">
        <div className="flex min-h-dvh items-center justify-center px-6">
          <div className="glass-panel ui-panel flex w-full max-w-md flex-col items-center px-6 py-6 text-center">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              OpenClaw Studio
            </div>
            <div className="mt-3 text-sm text-muted-foreground">
              {gatewayConnecting ? "Connecting to gateway…" : "Booting Studio…"}
            </div>
            <button
              type="button"
              className="ui-btn-secondary mt-4 px-4 py-2 text-xs font-semibold tracking-[0.05em] text-foreground"
              onClick={() => setShowConnectSetup(true)}
            >
              Edit connection settings
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!coreConnected && !agentsLoadedOnce && (didAttemptGatewayConnect || showConnectSetup)) {
    return (
      <div className="relative min-h-dvh w-screen overflow-y-auto bg-background">
        <div className="relative z-10 flex min-h-dvh flex-col">
          <HeaderBar
            status={gatewayStatus}
            onConnectionSettings={() => setShowConnectionPanel(true)}
          />
          <div className="flex flex-1 flex-col gap-4 px-3 pb-6 pt-3 sm:px-4 sm:pb-6 sm:pt-4 md:px-6 md:pt-4">
            {settingsRouteActive ? (
              <div className="w-full">
                <button
                  type="button"
                  className="ui-btn-secondary px-3 py-1.5 font-mono text-[10px] font-semibold tracking-[0.06em]"
                  onClick={handleBackToChat}
                >
                  Back to chat
                </button>
              </div>
            ) : null}
            <GatewayConnectScreen
              savedGatewayUrl={gatewayUrl}
              draftGatewayUrl={draftGatewayUrl}
              token={token}
              localGatewayDefaults={localGatewayDefaults}
              localGatewayDefaultsHasToken={localGatewayDefaultsHasToken}
              hasStoredToken={hasStoredToken}
              hasUnsavedChanges={hasUnsavedChanges}
              installContext={installContext}
              status={gatewayStatus}
              statusReason={statusReason}
              error={gatewayError}
              testResult={testResult}
              saving={gatewaySaving}
              testing={gatewayTesting}
              disconnecting={gatewayDisconnecting}
              onGatewayUrlChange={setGatewayUrl}
              onTokenChange={setToken}
              onUseLocalDefaults={useLocalGatewayDefaults}
              onSaveSettings={() => void saveSettings()}
              onTestConnection={() => void testConnection()}
              onDisconnect={() => void disconnect()}
            />
          </div>
        </div>
      </div>
    );
  }

  if (coreConnected && !agentsLoadedOnce) {
    return (
      <div className="relative min-h-dvh w-screen overflow-hidden bg-background">
        <div className="flex min-h-dvh items-center justify-center px-6">
          <div className="glass-panel ui-panel w-full max-w-md px-6 py-6 text-center">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              OpenClaw Studio
            </div>
            <div className="mt-3 text-sm text-muted-foreground">Loading agents…</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-dvh w-screen overflow-hidden bg-background">
      {state.loading ? (
        <div className="pointer-events-none fixed bottom-4 left-0 right-0 z-50 flex justify-center px-3">
          <div className="glass-panel ui-card px-6 py-3 font-mono text-[11px] tracking-[0.08em] text-muted-foreground">
            Loading agents…
          </div>
        </div>
      ) : null}
      <div className="relative z-10 flex h-dvh flex-col">
        <HeaderBar
          status={gatewayStatus}
          onConnectionSettings={() => setShowConnectionPanel(true)}
        />
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-3 pt-2 sm:px-4 sm:pb-4 sm:pt-3 md:px-5 md:pb-5 md:pt-3">
          {connectionPanelVisible ? (
            <div className="fixed inset-0 z-[140]" data-testid="gateway-connection-overlay">
              <div
                className="absolute inset-0 bg-transparent"
                onClick={() => setShowConnectionPanel(false)}
              />
              <div className="pointer-events-none absolute inset-x-0 top-12 flex justify-center px-3 sm:px-4 md:px-5">
                <div className="glass-panel pointer-events-auto w-full max-w-4xl !bg-card px-4 py-4 sm:px-6 sm:py-6">
                  <ConnectionPanel
                    savedGatewayUrl={gatewayUrl}
                    draftGatewayUrl={draftGatewayUrl}
                    token={token}
                    hasStoredToken={hasStoredToken}
                    localGatewayDefaults={localGatewayDefaults}
                    localGatewayDefaultsHasToken={localGatewayDefaultsHasToken}
                    hasUnsavedChanges={hasUnsavedChanges}
                    status={gatewayStatus}
                    statusReason={statusReason}
                    error={gatewayError}
                    testResult={testResult}
                    saving={gatewaySaving}
                    testing={gatewayTesting}
                    disconnecting={gatewayDisconnecting}
                    onGatewayUrlChange={setGatewayUrl}
                    onTokenChange={setToken}
                    onSaveSettings={() => void saveSettings()}
                    onTestConnection={() => void testConnection()}
                    onDisconnect={() => void disconnect()}
                    onClose={() => setShowConnectionPanel(false)}
                  />
                </div>
              </div>
            </div>
          ) : null}

          {studioCliUpdateWarning ? (
            <div className="w-full">
              <div className="ui-alert-danger rounded-md px-4 py-2 text-sm">
                {studioCliUpdateWarning}
              </div>
            </div>
          ) : null}

          {errorMessage ? (
            <div className="w-full">
              <div className="ui-alert-danger rounded-md px-4 py-2 text-sm">
                {errorMessage}
              </div>
            </div>
          ) : null}
          {configMutationStatusLine ? (
            <div className="w-full">
              <div className="ui-card px-4 py-2 font-mono text-[11px] tracking-[0.07em] text-muted-foreground">
                {configMutationStatusLine}
              </div>
            </div>
          ) : null}

          {settingsRouteActive ? (
            <div
              className="ui-panel ui-depth-workspace flex min-h-0 flex-1 overflow-hidden"
              data-testid="agent-settings-route-panel"
            >
              <aside className="w-[240px] shrink-0 border-r border-border/60">
                <div className="border-b border-border/60 px-4 py-3">
                  <button
                    type="button"
                    className="ui-btn-secondary w-full px-3 py-1.5 font-mono text-[10px] font-semibold tracking-[0.06em]"
                    onClick={handleBackToChat}
                  >
                    Back to chat
                  </button>
                </div>
                <nav className="py-3">
                  {(
                    [
                      { id: "personality", label: "Behavior" },
                      { id: "capabilities", label: "Capabilities" },
                      { id: "automations", label: "Automations" },
                      { id: "advanced", label: "Advanced" },
                    ] as const
                  ).map((entry) => {
                    const active = effectiveSettingsTab === entry.id;
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        className={`relative w-full px-5 py-3 text-left text-sm transition ${
                          active
                            ? "bg-surface-2/55 font-medium text-foreground"
                            : "font-normal text-muted-foreground hover:bg-surface-2/35 hover:text-foreground"
                        }`}
                        onClick={() => {
                          handleSettingsRouteTabChange(entry.id);
                        }}
                      >
                        {active ? (
                          <span
                            className="absolute inset-y-2 left-0 w-0.5 rounded-r bg-primary"
                            aria-hidden="true"
                          />
                        ) : null}
                        {entry.label}
                      </button>
                    );
                  })}
                </nav>
              </aside>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <div className="flex items-start justify-between border-b border-border/60 px-6 py-4">
                  <div>
                    <div className="text-lg font-semibold text-foreground">
                      {inspectSidebarAgent?.name ?? settingsRouteAgentId ?? "Agent settings"}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                      Model: {settingsHeaderModel}{" "}
                      <span className="mx-2 text-border">|</span>
                      Thinking: {settingsHeaderThinking}
                    </div>
                  </div>
                  <div className="rounded-md border border-border/70 bg-surface-1 px-3 py-1 font-mono text-[11px] text-muted-foreground">
                    [{personalityHasUnsavedChanges ? "Unsaved" : "Saved ✓"}]
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  {inspectSidebarAgent ? (
                    effectiveSettingsTab === "personality" ? (
                      <AgentBrainPanel
                        gatewayStatus={gatewayStatus}
                        agents={agents}
                        selectedAgentId={inspectSidebarAgent.agentId}
                        onUnsavedChangesChange={setPersonalityHasUnsavedChanges}
                      />
                    ) : (
                      <div className="h-full overflow-y-auto px-6 py-6">
                        <div className="mx-auto w-full max-w-[920px]">
                          <AgentSettingsPanel
                            key={`${inspectSidebarAgent.agentId}:${effectiveSettingsTab}`}
                            mode={
                              effectiveSettingsTab === "automations"
                                ? "automations"
                                : effectiveSettingsTab === "advanced"
                                  ? "advanced"
                                  : "capabilities"
                            }
                            showHeader={false}
                            agent={inspectSidebarAgent}
                            onClose={handleBackToChat}
                            permissionsDraft={settingsAgentPermissionsDraft ?? undefined}
                            onUpdateAgentPermissions={(draft) =>
                              settingsMutationController.handleUpdateAgentPermissions(
                                inspectSidebarAgent.agentId,
                                draft
                              )
                            }
                            onDelete={() =>
                              settingsMutationController.handleDeleteAgent(inspectSidebarAgent.agentId)
                            }
                            canDelete={inspectSidebarAgent.agentId !== RESERVED_MAIN_AGENT_ID}
                            cronJobs={settingsMutationController.settingsCronJobs}
                            cronLoading={settingsMutationController.settingsCronLoading}
                            cronError={settingsMutationController.settingsCronError}
                            cronCreateBusy={settingsMutationController.cronCreateBusy}
                            cronRunBusyJobId={settingsMutationController.cronRunBusyJobId}
                            cronDeleteBusyJobId={settingsMutationController.cronDeleteBusyJobId}
                            onCreateCronJob={(draft) =>
                              settingsMutationController.handleCreateCronJob(inspectSidebarAgent.agentId, draft)
                            }
                            onRunCronJob={(jobId) =>
                              settingsMutationController.handleRunCronJob(inspectSidebarAgent.agentId, jobId)
                            }
                            onDeleteCronJob={(jobId) =>
                              settingsMutationController.handleDeleteCronJob(inspectSidebarAgent.agentId, jobId)
                            }
                            controlUiUrl={controlUiUrl}
                          />
                        </div>
                      </div>
                    )
                  ) : (
                    <EmptyStatePanel
                      title="Agent not found."
                      description="Back to chat and select an available agent."
                      fillHeight
                      className="items-center p-6 text-center text-sm"
                    />
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-4 xl:flex-row">
              <div className="glass-panel ui-panel p-2 xl:hidden" data-testid="mobile-pane-toggle">
                <div className="ui-segment grid-cols-2">
                  <button
                    type="button"
                    className="ui-segment-item px-2 py-2 font-mono text-[12px] font-medium tracking-[0.02em]"
                    data-active={mobilePane === "fleet" ? "true" : "false"}
                    onClick={() => setMobilePane("fleet")}
                  >
                    Fleet
                  </button>
                  <button
                    type="button"
                    className="ui-segment-item px-2 py-2 font-mono text-[12px] font-medium tracking-[0.02em]"
                    data-active={mobilePane === "chat" ? "true" : "false"}
                    onClick={() => setMobilePane("chat")}
                  >
                    Chat
                  </button>
                </div>
              </div>
              <div
                className={`${mobilePane === "fleet" ? "block" : "hidden"} min-h-0 xl:block xl:min-h-0`}
              >
                <FleetSidebar
                  agents={filteredAgents}
                  selectedAgentId={focusedAgent?.agentId ?? state.selectedAgentId}
                  filter={focusFilter}
                  onFilterChange={handleFocusFilterChange}
                  onCreateAgent={() => {
                    handleOpenCreateAgentModal();
                  }}
                  createDisabled={!gatewayConnected || createAgentBusy || state.loading}
                  createBusy={createAgentBusy}
                  onSelectAgent={handleFleetSelectAgent}
                />
              </div>
              <div
                className={`${mobilePane === "chat" ? "flex" : "hidden"} ui-panel ui-depth-workspace min-h-0 flex-1 overflow-hidden xl:flex`}
                data-testid="focused-agent-panel"
              >
                {focusedAgent ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="min-h-0 flex-1">
                      <AgentChatPanel
                        agent={focusedAgent}
                        isSelected={false}
                        canSend={gatewayConnected}
                        models={gatewayModels}
                        stopBusy={stopBusyAgentId === focusedAgent.agentId}
                        stopDisabledReason={focusedAgentStopDisabledReason}
                        onLoadMoreHistory={() => loadMoreAgentHistory(focusedAgent.agentId)}
                        onOpenSettings={() => handleOpenAgentSettingsRoute(focusedAgent.agentId)}
                        onRename={(name) =>
                          settingsMutationController.handleRenameAgent(focusedAgent.agentId, name)
                        }
                        onNewSession={() => handleNewSession(focusedAgent.agentId)}
                        onModelChange={(value) =>
                          handleModelChange(focusedAgent.agentId, focusedAgent.sessionKey, value)
                        }
                        onThinkingChange={(value) =>
                          handleThinkingChange(focusedAgent.agentId, focusedAgent.sessionKey, value)
                        }
                        onToolCallingToggle={(enabled) =>
                          handleToolCallingToggle(focusedAgent.agentId, enabled)
                        }
                        onThinkingTracesToggle={(enabled) =>
                          handleThinkingTracesToggle(focusedAgent.agentId, enabled)
                        }
                        onDraftChange={(value) => handleDraftChange(focusedAgent.agentId, value)}
                        onSend={(message) =>
                          handleSend(focusedAgent.agentId, focusedAgent.sessionKey, message)
                        }
                        onRemoveQueuedMessage={(index) =>
                          removeQueuedMessage(focusedAgent.agentId, index)
                        }
                        onStopRun={() =>
                          handleStopRun(
                            focusedAgent.agentId,
                            focusedAgent.sessionKey,
                            focusedAgent.runId
                          )
                        }
                        onAvatarShuffle={() => handleAvatarShuffle(focusedAgent.agentId)}
                        pendingExecApprovals={focusedPendingExecApprovals}
                        onResolveExecApproval={(id, decision) => {
                          void handleResolveExecApproval(id, decision);
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <EmptyStatePanel
                    title={hasAnyAgents ? "No agents match this filter." : "No agents available."}
                    description={
                      hasAnyAgents
                        ? undefined
                        : gatewayConnected
                          ? "Use New Agent in the sidebar to add your first agent."
                          : "Connect to your gateway to load agents into the studio."
                    }
                    fillHeight
                    className="items-center p-6 text-center text-sm"
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {createAgentModalOpen ? (
        <AgentCreateModal
          open={createAgentModalOpen}
          suggestedName={suggestedCreateAgentName}
          busy={createAgentBusy}
          submitError={createAgentModalError}
          onClose={() => {
            if (createAgentBusy) return;
            setCreateAgentModalError(null);
            setCreateAgentModalOpen(false);
          }}
          onSubmit={(payload) => {
            void handleCreateAgentSubmit(payload);
          }}
        />
      ) : null}
      {createAgentBlock && createAgentBlock.phase !== "queued" ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80"
          data-testid="agent-create-restart-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Creating agent"
        >
          <div className="ui-panel w-full max-w-md p-6">
            <div className="font-mono text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
              Agent create in progress
            </div>
            <div className="mt-2 text-base font-semibold text-foreground">
              {createAgentBlock.agentName}
            </div>
            <div className="mt-3 text-sm text-muted-foreground">
              Studio is temporarily locked until creation finishes.
            </div>
            {createBlockStatusLine ? (
              <div className="ui-card mt-4 px-3 py-2 font-mono text-[11px] tracking-[0.06em] text-foreground">
                {createBlockStatusLine}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {restartingMutationBlock && restartingMutationBlock.phase !== "queued" ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80"
          data-testid={restartingMutationModalTestId ?? undefined}
          role="dialog"
          aria-modal="true"
          aria-label={restartingMutationAriaLabel ?? undefined}
        >
          <div className="ui-panel w-full max-w-md p-6">
            <div className="font-mono text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
              {restartingMutationHeading}
            </div>
            <div className="mt-2 text-base font-semibold text-foreground">
              {restartingMutationBlock.agentName}
            </div>
            <div className="mt-3 text-sm text-muted-foreground">
              Studio is temporarily locked until the gateway restarts.
            </div>
            {restartingMutationStatusLine ? (
              <div className="ui-card mt-4 px-3 py-2 font-mono text-[11px] tracking-[0.06em] text-foreground">
                {restartingMutationStatusLine}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};
export default function Home() {
  return (
    <Suspense>
      <AgentStoreProvider>
        <AgentStudioPage />
      </AgentStoreProvider>
    </Suspense>
  );
}
