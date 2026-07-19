import { describe, expect, it } from "vitest";

import type { PendingExecApproval } from "@/features/agents/approvals/types";
import {
  resolveExecApprovalEventEffects,
  resolveExecApprovalFollowUpIntent,
  shouldTreatExecApprovalResolveErrorAsUnknownId,
} from "@/features/agents/approvals/execApprovalLifecycleWorkflow";
import type { AgentState } from "@/features/agents/state/store";
import { GatewayResponseError, type EventFrame } from "@/lib/gateway/GatewayClient";

const createAgent = (agentId: string, sessionKey: string): AgentState => ({
  agentId,
  name: agentId,
  sessionKey,
  status: "idle",
  sessionCreated: true,
  awaitingUserInput: false,
  hasUnseenActivity: false,
  outputLines: [],
  lastResult: null,
  lastDiff: null,
  runId: null,
  runStartedAt: null,
  streamText: null,
  thinkingTrace: null,
  latestOverride: null,
  latestOverrideKind: null,
  lastAssistantMessageAt: null,
  lastActivityAt: null,
  latestPreview: null,
  lastUserMessage: null,
  draft: "",
  sessionSettingsSynced: true,
  historyLoadedAt: null,
  historyFetchLimit: null,
  historyFetchedCount: null,
  historyMaybeTruncated: false,
  toolCallingEnabled: true,
  showThinkingTraces: true,
  model: "openai/gpt-5",
  thinkingLevel: "medium",
  avatarSeed: agentId,
  avatarUrl: null,
});

const createApproval = (params?: Partial<PendingExecApproval>): PendingExecApproval => ({
  id: "approval-1",
  agentId: "agent-1",
  sessionKey: "agent:agent-1:main",
  command: "npm test",
  cwd: "/repo",
  host: "gateway",
  security: "allowlist",
  ask: "always",
  resolvedPath: "/usr/bin/npm",
  createdAtMs: 1,
  expiresAtMs: 2,
  resolving: false,
  error: null,
  ...params,
});

describe("execApprovalLifecycleWorkflow", () => {
  it("maps requested approval into scoped or unscoped upsert effect", () => {
    const agents = [createAgent("agent-1", "agent:agent-1:main")];
    const scopedEvent: EventFrame = {
      type: "event",
      event: "exec.approval.requested",
      payload: {
        id: "approval-scoped",
        request: {
          command: "npm run test",
          cwd: "/repo",
          host: "gateway",
          security: "allowlist",
          ask: "always",
          agentId: "agent-1",
          resolvedPath: "/usr/bin/npm",
          sessionKey: "agent:agent-1:main",
        },
        createdAtMs: 123,
        expiresAtMs: 456,
      },
    };
    const unscopedEvent: EventFrame = {
      type: "event",
      event: "exec.approval.requested",
      payload: {
        id: "approval-unscoped",
        request: {
          command: "npm run lint",
          cwd: "/repo",
          host: "gateway",
          security: "allowlist",
          ask: "always",
          agentId: null,
          resolvedPath: "/usr/bin/npm",
          sessionKey: "agent:missing:main",
        },
        createdAtMs: 222,
        expiresAtMs: 333,
      },
    };

    const scopedEffects = resolveExecApprovalEventEffects({
      event: scopedEvent,
      agents,
    });
    expect(scopedEffects?.scopedUpserts.map((entry) => entry.agentId)).toEqual(["agent-1"]);
    expect(scopedEffects?.unscopedUpserts).toEqual([]);
    expect(scopedEffects?.markActivityAgentIds).toEqual(["agent-1"]);

    const unscopedEffects = resolveExecApprovalEventEffects({
      event: unscopedEvent,
      agents,
    });
    expect(unscopedEffects?.scopedUpserts).toEqual([]);
    expect(unscopedEffects?.unscopedUpserts).toHaveLength(1);
    expect(unscopedEffects?.markActivityAgentIds).toEqual([]);
  });

  it("does not scope requested approvals to unsafe or unknown agent ids", () => {
    const agents = [createAgent("agent-1", "agent:agent-1:main")];
    const unsafeEvent: EventFrame = {
      type: "event",
      event: "exec.approval.requested",
      payload: {
        id: "approval-unsafe",
        request: {
          command: "npm run test",
          cwd: "/repo",
          host: "gateway",
          security: "allowlist",
          ask: "always",
          agentId: "../agent-1",
          resolvedPath: "/usr/bin/npm",
          sessionKey: "agent:../agent-1:main",
        },
        createdAtMs: 123,
        expiresAtMs: 456,
      },
    };
    const unknownWithMatchingSessionEvent: EventFrame = {
      type: "event",
      event: "exec.approval.requested",
      payload: {
        id: "approval-session",
        request: {
          command: "npm run lint",
          cwd: "/repo",
          host: "gateway",
          security: "allowlist",
          ask: "always",
          agentId: "missing",
          resolvedPath: "/usr/bin/npm",
          sessionKey: "agent:agent-1:main",
        },
        createdAtMs: 223,
        expiresAtMs: 456,
      },
    };

    const unsafeEffects = resolveExecApprovalEventEffects({
      event: unsafeEvent,
      agents,
    });
    expect(unsafeEffects?.scopedUpserts).toEqual([]);
    expect(unsafeEffects?.unscopedUpserts).toEqual([
      expect.objectContaining({ id: "approval-unsafe", agentId: null, sessionKey: null }),
    ]);

    const sessionEffects = resolveExecApprovalEventEffects({
      event: unknownWithMatchingSessionEvent,
      agents,
    });
    expect(sessionEffects?.scopedUpserts.map((entry) => entry.agentId)).toEqual(["agent-1"]);
    expect(sessionEffects?.markActivityAgentIds).toEqual(["agent-1"]);
  });

  it("maps resolved approval event into remove effects", () => {
    const event: EventFrame = {
      type: "event",
      event: "exec.approval.resolved",
      payload: {
        id: "approval-1",
        decision: "allow-once",
        resolvedBy: "studio",
        ts: 999,
      },
    };

    const effects = resolveExecApprovalEventEffects({
      event,
      agents: [createAgent("agent-1", "agent:agent-1:main")],
    });

    expect(effects).toEqual({
      scopedUpserts: [],
      unscopedUpserts: [],
      removals: ["approval-1"],
      markActivityAgentIds: [],
    });
  });

  it("returns follow-up intent only for allow decisions", () => {
    const agents = [createAgent("agent-1", "agent:agent-1:main")];
    const approval = createApproval({ agentId: null, sessionKey: "agent:agent-1:main" });

    expect(
      resolveExecApprovalFollowUpIntent({
        decision: "allow-once",
        approval,
        agents,
        followUpMessage: "approval granted",
      })
    ).toEqual({
      shouldSend: true,
      agentId: "agent-1",
      sessionKey: "agent:agent-1:main",
      message: "approval granted",
    });

    expect(
      resolveExecApprovalFollowUpIntent({
        decision: "deny",
        approval,
        agents,
        followUpMessage: "approval granted",
      })
    ).toEqual({
      shouldSend: false,
      agentId: null,
      sessionKey: null,
      message: null,
    });
  });

  it("does not send follow-up intents to unsafe or unknown scoped agent ids", () => {
    const agents = [createAgent("agent-1", "agent:agent-1:main")];

    expect(
      resolveExecApprovalFollowUpIntent({
        decision: "allow-once",
        approval: createApproval({
          agentId: "../agent-1",
          sessionKey: "agent:../agent-1:main",
        }),
        agents,
        followUpMessage: "approval granted",
      })
    ).toEqual({
      shouldSend: false,
      agentId: null,
      sessionKey: null,
      message: null,
    });

    expect(
      resolveExecApprovalFollowUpIntent({
        decision: "allow-once",
        approval: createApproval({
          agentId: "missing",
          sessionKey: "agent:agent-1:main",
        }),
        agents,
        followUpMessage: "approval granted",
      })
    ).toEqual({
      shouldSend: true,
      agentId: "agent-1",
      sessionKey: "agent:agent-1:main",
      message: "approval granted",
    });
  });

  it("maps unknown approval id gateway error to local removal intent", () => {
    expect(
      shouldTreatExecApprovalResolveErrorAsUnknownId(
        new GatewayResponseError({
          code: "INVALID_REQUEST",
          message: "Unknown approval id",
        })
      )
    ).toBe(true);
    expect(
      shouldTreatExecApprovalResolveErrorAsUnknownId(
        new GatewayResponseError({
          code: "INVALID_REQUEST",
          message: "approval denied by policy",
        })
      )
    ).toBe(false);
  });
});
