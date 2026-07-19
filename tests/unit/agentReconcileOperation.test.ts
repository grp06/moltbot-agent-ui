import { describe, expect, it, vi } from "vitest";

import type { AgentState } from "@/features/agents/state/store";
import { buildReconcileTerminalPatch } from "@/features/agents/operations/fleetLifecycleWorkflow";
import {
  executeAgentReconcileCommands,
  runAgentReconcileOperation,
} from "@/features/agents/operations/agentReconcileOperation";

describe("agentReconcileOperation", () => {
  it("reconciles terminal runs and requests history refresh", async () => {
    const waitForAgentRun = vi.fn(async () => ({ status: "ok" }));

    const agent = {
      agentId: "a1",
      status: "running",
      sessionCreated: true,
      runId: "run-1",
    } as unknown as AgentState;

    const commands = await runAgentReconcileOperation({
      waitForAgentRun,
      agents: [agent],
      getLatestAgent: () => agent,
      claimRunId: () => true,
      releaseRunId: () => {},
      isDisconnectLikeError: () => false,
    });

    expect(waitForAgentRun).toHaveBeenCalledWith({ runId: "run-1", timeoutMs: 1 });

    expect(commands).toEqual(
      expect.arrayContaining([
        { kind: "clearRunTracking", runId: "run-1" },
        {
          kind: "dispatchUpdateAgent",
          agentId: "a1",
          patch: buildReconcileTerminalPatch({ outcome: "ok" }),
        },
        { kind: "requestHistoryRefresh", agentId: "a1" },
      ])
    );
  });

  it("skips when agent is not eligible", async () => {
    const waitForAgentRun = vi.fn();
    const agent = {
      agentId: "a1",
      status: "idle",
      sessionCreated: true,
      runId: "run-1",
    } as unknown as AgentState;

    const commands = await runAgentReconcileOperation({
      waitForAgentRun,
      agents: [agent],
      getLatestAgent: () => agent,
      claimRunId: () => true,
      releaseRunId: () => {},
      isDisconnectLikeError: () => false,
    });

    expect(waitForAgentRun).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });

  it("reconciles shared run only once and triggers one history refresh", async () => {
    const waitForAgentRun = vi.fn(async () => ({ status: "ok" }));
    const agentOne = {
      agentId: "a1",
      status: "running",
      sessionCreated: true,
      runId: "run-shared",
    } as unknown as AgentState;
    const agentTwo = {
      agentId: "a2",
      status: "running",
      sessionCreated: true,
      runId: "run-shared",
    } as unknown as AgentState;

    let claimed = false;
    const commands = await runAgentReconcileOperation({
      waitForAgentRun,
      agents: [agentOne, agentTwo],
      getLatestAgent: (agentId) => (agentId === "a1" ? agentOne : agentTwo),
      claimRunId: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      releaseRunId: () => {},
      isDisconnectLikeError: () => false,
    });

    const historyRefreshes = commands.filter((entry) => entry.kind === "requestHistoryRefresh");
    expect(waitForAgentRun).toHaveBeenCalledTimes(1);
    expect(historyRefreshes).toEqual([{ kind: "requestHistoryRefresh", agentId: "a1" }]);

    const dispatch = vi.fn();
    const clearRunTracking = vi.fn();
    const requestHistoryRefresh = vi.fn();
    const logInfo = vi.fn();
    const logWarn = vi.fn();
    executeAgentReconcileCommands({
      commands,
      dispatch,
      clearRunTracking,
      requestHistoryRefresh,
      logInfo,
      logWarn,
    });

    expect(requestHistoryRefresh).toHaveBeenCalledTimes(1);
    expect(requestHistoryRefresh).toHaveBeenCalledWith("a1");
  });
});
