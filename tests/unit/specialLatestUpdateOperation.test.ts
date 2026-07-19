import { describe, expect, it, vi } from "vitest";

import { buildLatestUpdatePatch } from "@/features/agents/operations/latestUpdateWorkflow";
import { createSpecialLatestUpdateOperation } from "@/features/agents/operations/specialLatestUpdateOperation";
import type { AgentState } from "@/features/agents/state/store";
import { resolveLatestCronJobForAgent, type CronJobSummary } from "@/lib/cron/types";
import type { DomainAgentHistoryResult } from "@/lib/controlplane/domain-runtime-client";

const makeAgent = (
  overrides?: Partial<
    Pick<AgentState, "agentId" | "sessionKey" | "latestOverride" | "latestOverrideKind">
  >
) => {
  return {
    agentId: "agent-1",
    sessionKey: "agent:agent-1:main",
    latestOverride: null,
    latestOverrideKind: null,
    ...overrides,
  } as unknown as AgentState;
};

const makeHistoryResult = (messages: Record<string, unknown>[]): DomainAgentHistoryResult => ({
  enabled: true,
  agentId: "agent-1",
  view: "raw",
  messages,
  hasMore: false,
  semanticTurnsIncluded: messages.length,
  windowTruncated: false,
  gatewayLimit: 200,
  gatewayCapped: false,
});

describe("specialLatestUpdateOperation", () => {
  it("dispatches reset patch when intent resolves to reset", async () => {
    const agent = makeAgent({ latestOverrideKind: "cron" });

    const dispatchUpdateAgent = vi.fn();
    const operation = createSpecialLatestUpdateOperation({
      loadAgentHistoryWindow: async () => {
        throw new Error("loadAgentHistoryWindow should not be invoked for reset intent");
      },
      listCronJobs: async () => ({ jobs: [] }),
      resolveCronJobForAgent: () => null,
      formatCronJobDisplay: () => "",
      dispatchUpdateAgent,
      isDisconnectLikeError: () => false,
      logError: () => {},
    });

    await operation.update(agent.agentId, agent, "plain user prompt");

    expect(dispatchUpdateAgent).toHaveBeenCalledTimes(1);
    expect(dispatchUpdateAgent).toHaveBeenCalledWith(agent.agentId, buildLatestUpdatePatch(""));
  });

  it("reads raw domain history and stores latest assistant response after heartbeat prompt", async () => {
    const agent = makeAgent();

    const loadAgentHistoryWindow = vi.fn(async () =>
      makeHistoryResult([
        { role: "user", content: "Read HEARTBEAT.md if it exists" },
        { role: "assistant", content: "First response" },
        { role: "assistant", content: "Second response" },
      ])
    );

    const dispatchUpdateAgent = vi.fn();
    const operation = createSpecialLatestUpdateOperation({
      loadAgentHistoryWindow,
      listCronJobs: async () => ({ jobs: [] }),
      resolveCronJobForAgent: () => null,
      formatCronJobDisplay: () => "",
      dispatchUpdateAgent,
      isDisconnectLikeError: () => false,
      logError: () => {},
    });

    await operation.update(agent.agentId, agent, "heartbeat please");

    expect(loadAgentHistoryWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        sessionKey: "agent:agent-1:main",
        view: "raw",
      })
    );
    expect(dispatchUpdateAgent).toHaveBeenCalledWith(
      agent.agentId,
      buildLatestUpdatePatch("Second response", "heartbeat")
    );
  });

  it("fetches cron jobs, selects latest cron for agentId, and stores formatted cron display", async () => {
    const agent = makeAgent();

    const jobs: CronJobSummary[] = [
      {
        id: "job-1",
        name: "Older",
        agentId: "agent-1",
        enabled: true,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "one" },
        state: {},
      },
      {
        id: "job-2",
        name: "Newer",
        agentId: "agent-1",
        enabled: true,
        updatedAtMs: 2,
        schedule: { kind: "every", everyMs: 60000 },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "two" },
        state: {},
      },
    ];

    const dispatchUpdateAgent = vi.fn();
    const operation = createSpecialLatestUpdateOperation({
      loadAgentHistoryWindow: async () => {
        throw new Error("loadAgentHistoryWindow should not be invoked for cron intent");
      },
      listCronJobs: async () => ({ jobs }),
      resolveCronJobForAgent: resolveLatestCronJobForAgent,
      formatCronJobDisplay: (job) => `formatted:${job.id}`,
      dispatchUpdateAgent,
      isDisconnectLikeError: () => false,
      logError: () => {},
    });

    await operation.update(agent.agentId, agent, "cron report pending");

    expect(dispatchUpdateAgent).toHaveBeenCalledWith(
      agent.agentId,
      buildLatestUpdatePatch("formatted:job-2", "cron")
    );
  });

  it("dedupes concurrent updates for same agentId while first is in flight", async () => {
    const agent = makeAgent();

    let resolveHistory!: (value: DomainAgentHistoryResult) => void;
    const historyPromise = new Promise<DomainAgentHistoryResult>((resolve) => {
      resolveHistory = resolve;
    });

    const loadAgentHistoryWindow = vi.fn(() => historyPromise);
    const dispatchUpdateAgent = vi.fn();
    const operation = createSpecialLatestUpdateOperation({
      loadAgentHistoryWindow,
      listCronJobs: async () => ({ jobs: [] }),
      resolveCronJobForAgent: () => null,
      formatCronJobDisplay: () => "",
      dispatchUpdateAgent,
      isDisconnectLikeError: () => false,
      logError: () => {},
    });

    const first = operation.update(agent.agentId, agent, "heartbeat please");
    const second = operation.update(agent.agentId, agent, "heartbeat please");
    await second;

    expect(loadAgentHistoryWindow).toHaveBeenCalledTimes(1);

    resolveHistory(
      makeHistoryResult([
        { role: "user", content: "Read HEARTBEAT.md if it exists" },
        { role: "assistant", content: "ok" },
      ])
    );
    await first;

    expect(loadAgentHistoryWindow).toHaveBeenCalledTimes(1);
    expect(dispatchUpdateAgent).toHaveBeenCalledWith(
      agent.agentId,
      buildLatestUpdatePatch("ok", "heartbeat")
    );
  });

  it("invalidates pending async updates when in-flight state is cleared", async () => {
    const agent = makeAgent();

    let resolveOldHistory!: (value: DomainAgentHistoryResult) => void;
    const oldHistoryPromise = new Promise<DomainAgentHistoryResult>((resolve) => {
      resolveOldHistory = resolve;
    });

    const loadAgentHistoryWindow = vi
      .fn()
      .mockImplementationOnce(() => oldHistoryPromise)
      .mockResolvedValueOnce(
        makeHistoryResult([
          { role: "user", content: "Read HEARTBEAT.md if it exists" },
          { role: "assistant", content: "new response" },
        ])
      );
    const dispatchUpdateAgent = vi.fn();
    const operation = createSpecialLatestUpdateOperation({
      loadAgentHistoryWindow,
      listCronJobs: async () => ({ jobs: [] }),
      resolveCronJobForAgent: () => null,
      formatCronJobDisplay: () => "",
      dispatchUpdateAgent,
      isDisconnectLikeError: () => false,
      logError: () => {},
    });

    const oldUpdate = operation.update(agent.agentId, agent, "heartbeat please");
    operation.clearInFlight(agent.agentId);
    await operation.update(agent.agentId, agent, "heartbeat please");

    resolveOldHistory(
      makeHistoryResult([
        { role: "user", content: "Read HEARTBEAT.md if it exists" },
        { role: "assistant", content: "stale response" },
      ])
    );
    await oldUpdate;

    expect(loadAgentHistoryWindow).toHaveBeenCalledTimes(2);
    expect(dispatchUpdateAgent).toHaveBeenCalledTimes(1);
    expect(dispatchUpdateAgent).toHaveBeenCalledWith(
      agent.agentId,
      buildLatestUpdatePatch("new response", "heartbeat")
    );
  });

  it("invalidates pending async updates when a reset intent is applied", async () => {
    const agent = makeAgent();
    const resetAgent = makeAgent({
      latestOverride: "old visible override",
      latestOverrideKind: "heartbeat",
    });

    let resolveHistory!: (value: DomainAgentHistoryResult) => void;
    const historyPromise = new Promise<DomainAgentHistoryResult>((resolve) => {
      resolveHistory = resolve;
    });

    const loadAgentHistoryWindow = vi.fn(() => historyPromise);
    const dispatchUpdateAgent = vi.fn();
    const operation = createSpecialLatestUpdateOperation({
      loadAgentHistoryWindow,
      listCronJobs: async () => ({ jobs: [] }),
      resolveCronJobForAgent: () => null,
      formatCronJobDisplay: () => "",
      dispatchUpdateAgent,
      isDisconnectLikeError: () => false,
      logError: () => {},
    });

    const pending = operation.update(agent.agentId, agent, "heartbeat please");
    await operation.update(resetAgent.agentId, resetAgent, "plain user prompt");

    resolveHistory(
      makeHistoryResult([
        { role: "user", content: "Read HEARTBEAT.md if it exists" },
        { role: "assistant", content: "stale response" },
      ])
    );
    await pending;

    expect(loadAgentHistoryWindow).toHaveBeenCalledTimes(1);
    expect(dispatchUpdateAgent).toHaveBeenCalledTimes(1);
    expect(dispatchUpdateAgent).toHaveBeenCalledWith(
      resetAgent.agentId,
      buildLatestUpdatePatch("")
    );
  });
});
