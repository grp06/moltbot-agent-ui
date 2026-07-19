import type { AgentState } from "@/features/agents/state/store";
import type { ExecApprovalDecision, PendingExecApproval } from "@/features/agents/approvals/types";
import {
  removePendingApprovalEverywhere,
  updatePendingApprovalById,
} from "@/features/agents/approvals/pendingStore";
import { shouldTreatExecApprovalResolveErrorAsUnknownId } from "@/features/agents/approvals/execApprovalLifecycleWorkflow";
import type { RuntimeWriteTransport } from "@/features/agents/operations/runtimeWriteTransport";
import { resolveSafeAgentId } from "@/lib/agents/agentIds";
import { resolveSafeSessionKey } from "@/lib/gateway/session-keys";

type SetState<T> = (next: T | ((current: T) => T)) => void;

export const resolveExecApprovalViaStudio = async (params: {
  runtimeWriteTransport: RuntimeWriteTransport;
  approvalId: string;
  decision: ExecApprovalDecision;
  getAgents: () => AgentState[];
  getLatestAgent: (agentId: string) => AgentState | null;
  getPendingState: () => {
    approvalsByAgentId: Record<string, PendingExecApproval[]>;
    unscopedApprovals: PendingExecApproval[];
  };
  setPendingExecApprovalsByAgentId: SetState<Record<string, PendingExecApproval[]>>;
  setUnscopedPendingExecApprovals: SetState<PendingExecApproval[]>;
  requestHistoryRefresh: (agentId: string) => Promise<void> | void;
  onAllowResolved?: (params: {
    approval: PendingExecApproval;
    targetAgentId: string;
  }) => Promise<void> | void;
  onAllowed?: (params: { approval: PendingExecApproval; targetAgentId: string }) => Promise<void> | void;
  isDisconnectLikeError: (error: unknown) => boolean;
  shouldTreatUnknownId?: (error: unknown) => boolean;
  logWarn?: (message: string, error: unknown) => void;
}): Promise<void> => {
  const id = params.approvalId.trim();
  if (!id) return;

  const resolvePendingApproval = (
    approvalId: string,
    state: {
      approvalsByAgentId: Record<string, PendingExecApproval[]>;
      unscopedApprovals: PendingExecApproval[];
    }
  ): PendingExecApproval | null => {
    for (const approvals of Object.values(state.approvalsByAgentId)) {
      const found = approvals.find((approval) => approval.id === approvalId);
      if (found) return found;
    }
    return state.unscopedApprovals.find((approval) => approval.id === approvalId) ?? null;
  };

  const resolveApprovalTargetAgentId = (approval: PendingExecApproval | null): string | null => {
    if (!approval) return null;
    const agents = params.getAgents();
    const scopedAgentId = resolveSafeAgentId(approval.agentId) ?? "";
    if (scopedAgentId && agents.some((agent) => agent.agentId === scopedAgentId)) {
      return scopedAgentId;
    }
    const scopedSessionKey = resolveSafeSessionKey(approval.sessionKey) ?? "";
    if (!scopedSessionKey) return null;
    const matched = agents.find((agent) => agent.sessionKey.trim() === scopedSessionKey);
    return matched?.agentId ?? null;
  };

  const snapshot = params.getPendingState();
  const approval = resolvePendingApproval(id, snapshot);

  const removeLocalApproval = (approvalId: string) => {
    params.setPendingExecApprovalsByAgentId((current) => {
      return removePendingApprovalEverywhere({
        approvalsByAgentId: current,
        unscopedApprovals: [],
        approvalId,
      }).approvalsByAgentId;
    });
    params.setUnscopedPendingExecApprovals((current) => {
      return removePendingApprovalEverywhere({
        approvalsByAgentId: {},
        unscopedApprovals: current,
        approvalId,
      }).unscopedApprovals;
    });
  };

  const setLocalApprovalState = (resolving: boolean, error: string | null) => {
    params.setPendingExecApprovalsByAgentId((current) => {
      let changed = false;
      const next: Record<string, PendingExecApproval[]> = {};
      for (const [agentId, approvals] of Object.entries(current)) {
        const updated = updatePendingApprovalById(approvals, id, (approval) => ({
          ...approval,
          resolving,
          error,
        }));
        if (updated !== approvals) {
          changed = true;
        }
        if (updated.length > 0) {
          next[agentId] = updated;
        }
      }
      return changed ? next : current;
    });
    params.setUnscopedPendingExecApprovals((current) =>
      updatePendingApprovalById(current, id, (approval) => ({
        ...approval,
        resolving,
        error,
      }))
    );
  };

  setLocalApprovalState(true, null);

  try {
    await params.runtimeWriteTransport.execApprovalResolve({ id, decision: params.decision });
    removeLocalApproval(id);

    if (params.decision !== "allow-once" && params.decision !== "allow-always") {
      return;
    }

    if (!approval) return;
    const targetAgentId = resolveApprovalTargetAgentId(approval);
    if (!targetAgentId) return;
    await params.onAllowResolved?.({ approval, targetAgentId });

    const latest = params.getLatestAgent(targetAgentId);
    const activeRunId = latest?.runId?.trim() ?? "";
    if (activeRunId) {
      try {
        await params.runtimeWriteTransport.agentWait({ runId: activeRunId, timeoutMs: 15_000 });
      } catch (waitError) {
        if (!params.isDisconnectLikeError(waitError)) {
          (params.logWarn ?? ((message, error) => console.warn(message, error)))(
            "Failed to wait for run after exec approval resolve.",
            waitError
          );
        }
      }
    }

    await params.requestHistoryRefresh(targetAgentId);
    await params.onAllowed?.({ approval, targetAgentId });
  } catch (err) {
    const shouldTreatUnknownId = params.shouldTreatUnknownId ?? shouldTreatExecApprovalResolveErrorAsUnknownId;
    if (shouldTreatUnknownId(err)) {
      removeLocalApproval(id);
      return;
    }
    const message = err instanceof Error ? err.message : "Failed to resolve exec approval.";
    setLocalApprovalState(false, message);
  }
};
