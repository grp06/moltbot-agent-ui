import type { AgentState } from "@/features/agents/state/store";
import {
  buildReconcileTerminalPatch,
  resolveReconcileEligibility,
  resolveReconcileWaitOutcome,
} from "@/features/agents/operations/fleetLifecycleWorkflow";

type AgentRunWaiter = (params: { runId: string; timeoutMs: number }) => Promise<unknown>;

type ReconcileCommand =
  | { kind: "clearRunTracking"; runId: string }
  | { kind: "dispatchUpdateAgent"; agentId: string; patch: Partial<AgentState> }
  | { kind: "requestHistoryRefresh"; agentId: string }
  | { kind: "logInfo"; message: string }
  | { kind: "logWarn"; message: string; error: unknown };

type ReconcileDispatchAction = {
  type: "updateAgent";
  agentId: string;
  patch: Partial<AgentState>;
};

export const executeAgentReconcileCommands = (params: {
  commands: ReconcileCommand[];
  dispatch: (action: ReconcileDispatchAction) => void;
  clearRunTracking: (runId: string) => void;
  requestHistoryRefresh: (agentId: string) => void;
  logInfo: (message: string) => void;
  logWarn: (message: string, error: unknown) => void;
}) => {
  for (const command of params.commands) {
    if (command.kind === "clearRunTracking") {
      params.clearRunTracking(command.runId);
      continue;
    }
    if (command.kind === "dispatchUpdateAgent") {
      params.dispatch({
        type: "updateAgent",
        agentId: command.agentId,
        patch: command.patch,
      });
      continue;
    }
    if (command.kind === "requestHistoryRefresh") {
      params.requestHistoryRefresh(command.agentId);
      continue;
    }
    if (command.kind === "logInfo") {
      params.logInfo(command.message);
      continue;
    }
    if (command.kind === "logWarn") {
      params.logWarn(command.message, command.error);
    }
  }
};

export const runAgentReconcileOperation = async (params: {
  waitForAgentRun: AgentRunWaiter;
  agents: AgentState[];
  getLatestAgent: (agentId: string) => AgentState | null;
  claimRunId: (runId: string) => boolean;
  releaseRunId: (runId: string) => void;
  isDisconnectLikeError: (error: unknown) => boolean;
}): Promise<ReconcileCommand[]> => {
  const commands: ReconcileCommand[] = [];

  for (const agent of params.agents) {
    const eligibility = resolveReconcileEligibility({
      status: agent.status,
      sessionCreated: agent.sessionCreated,
      runId: agent.runId,
    });
    if (!eligibility.shouldCheck) continue;

    const runId = agent.runId?.trim() ?? "";
    if (!runId) continue;

    if (!params.claimRunId(runId)) continue;

    try {
      const result = (await params.waitForAgentRun({
        runId,
        timeoutMs: 1,
      })) as { status?: unknown } | null;
      const outcome = resolveReconcileWaitOutcome(result?.status);
      if (!outcome) {
        continue;
      }

      const latest = params.getLatestAgent(agent.agentId);
      if (!latest || latest.runId !== runId || latest.status !== "running") {
        continue;
      }

      commands.push({ kind: "clearRunTracking", runId });
      commands.push({
        kind: "dispatchUpdateAgent",
        agentId: agent.agentId,
        patch: buildReconcileTerminalPatch({ outcome }),
      });
      commands.push({
        kind: "logInfo",
        message: `[agent-reconcile] ${agent.agentId} run ${runId} resolved as ${outcome}.`,
      });
      commands.push({
        kind: "requestHistoryRefresh",
        agentId: agent.agentId,
      });
    } catch (err) {
      if (!params.isDisconnectLikeError(err)) {
        commands.push({
          kind: "logWarn",
          message: "Failed to reconcile running agent.",
          error: err,
        });
      }
    } finally {
      params.releaseRunId(runId);
    }
  }

  return commands;
};
