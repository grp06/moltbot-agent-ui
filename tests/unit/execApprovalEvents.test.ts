import { describe, expect, it } from "vitest";

import type { AgentState } from "@/features/agents/state/store";
import {
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  resolveExecApprovalAgentId,
} from "@/features/agents/approvals/execApprovalEvents";
import type { EventFrame } from "@/lib/gateway/GatewayClient";

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

describe("execApprovalEvents", () => {
  it("parses exec.approval.requested payload", () => {
    const event: EventFrame = {
      type: "event",
      event: "exec.approval.requested",
      payload: {
        id: "approval-1",
        request: {
          command: "npm run test",
          cwd: "/repo",
          host: "gateway",
          security: "allowlist",
          ask: "always",
          agentId: "agent-1",
          resolvedPath: "/bin/npm",
          sessionKey: "agent:agent-1:main",
        },
        createdAtMs: 123,
        expiresAtMs: 456,
      },
    };

    expect(parseExecApprovalRequested(event)).toEqual({
      id: "approval-1",
      request: {
        command: "npm run test",
        cwd: "/repo",
        host: "gateway",
        security: "allowlist",
        ask: "always",
        agentId: "agent-1",
        resolvedPath: "/bin/npm",
        sessionKey: "agent:agent-1:main",
      },
      createdAtMs: 123,
      expiresAtMs: 456,
    });
  });

  it("returns null for invalid requested payload", () => {
    const event: EventFrame = {
      type: "event",
      event: "exec.approval.requested",
      payload: {
        id: "approval-1",
        request: { command: "" },
        createdAtMs: 0,
        expiresAtMs: 0,
      },
    };
    expect(parseExecApprovalRequested(event)).toBeNull();
  });

  it("drops unsafe agent ids and malformed agent session keys from requested payloads", () => {
    const event: EventFrame = {
      type: "event",
      event: "exec.approval.requested",
      payload: {
        id: "approval-1",
        request: {
          command: "npm run test",
          cwd: "/repo",
          host: "gateway",
          security: "allowlist",
          ask: "always",
          agentId: "../agent-1",
          resolvedPath: "/bin/npm",
          sessionKey: "agent:../agent-1:main",
        },
        createdAtMs: 123,
        expiresAtMs: 456,
      },
    };

    expect(parseExecApprovalRequested(event)).toEqual({
      id: "approval-1",
      request: {
        command: "npm run test",
        cwd: "/repo",
        host: "gateway",
        security: "allowlist",
        ask: "always",
        agentId: null,
        resolvedPath: "/bin/npm",
        sessionKey: null,
      },
      createdAtMs: 123,
      expiresAtMs: 456,
    });
  });


  it("parses exec.approval.resolved payload", () => {
    const event: EventFrame = {
      type: "event",
      event: "exec.approval.resolved",
      payload: {
        id: "approval-1",
        decision: "allow-once",
        resolvedBy: "studio",
        ts: 987,
      },
    };
    expect(parseExecApprovalResolved(event)).toEqual({
      id: "approval-1",
      decision: "allow-once",
      resolvedBy: "studio",
      ts: 987,
    });
  });

  it("returns null for unknown resolved decision", () => {
    const event: EventFrame = {
      type: "event",
      event: "exec.approval.resolved",
      payload: {
        id: "approval-1",
        decision: "approve",
        ts: 987,
      },
    };
    expect(parseExecApprovalResolved(event)).toBeNull();
  });

  it("resolves approval agent by explicit agent id", () => {
    const requested = {
      id: "approval-1",
      request: {
        command: "pwd",
        cwd: null,
        host: "gateway",
        security: null,
        ask: null,
        agentId: "agent-2",
        resolvedPath: null,
        sessionKey: "agent:agent-2:main",
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    };
    const agents = [
      createAgent("agent-1", "agent:agent-1:main"),
      createAgent("agent-2", "agent:agent-2:main"),
    ];
    expect(resolveExecApprovalAgentId({ requested, agents })).toBe("agent-2");
  });

  it("does not resolve explicit agent id until the local agent list has hydrated it", () => {
    const requested = {
      id: "approval-1",
      request: {
        command: "pwd",
        cwd: null,
        host: "gateway",
        security: null,
        ask: null,
        agentId: "agent-prehydration",
        resolvedPath: null,
        sessionKey: "agent:agent-prehydration:main",
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    };
    const agents = [createAgent("agent-1", "agent:agent-1:main")];
    expect(resolveExecApprovalAgentId({ requested, agents })).toBeNull();
  });

  it("falls back to session key when agent id missing", () => {
    const requested = {
      id: "approval-1",
      request: {
        command: "pwd",
        cwd: null,
        host: "gateway",
        security: null,
        ask: null,
        agentId: null,
        resolvedPath: null,
        sessionKey: "agent:agent-3:main",
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    };
    const agents = [createAgent("agent-3", "agent:agent-3:main")];
    expect(resolveExecApprovalAgentId({ requested, agents })).toBe("agent-3");
  });

  it("returns null when no agent mapping matches", () => {
    const requested = {
      id: "approval-1",
      request: {
        command: "pwd",
        cwd: null,
        host: "gateway",
        security: null,
        ask: null,
        agentId: null,
        resolvedPath: null,
        sessionKey: "agent:missing:main",
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    };
    const agents = [createAgent("agent-1", "agent:agent-1:main")];
    expect(resolveExecApprovalAgentId({ requested, agents })).toBeNull();
  });
});
