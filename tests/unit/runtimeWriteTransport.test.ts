import { beforeEach, describe, expect, it, vi } from "vitest";

import { postStudioIntent } from "@/lib/controlplane/intents-client";
import { createGatewayAgent, deleteGatewayAgent, renameGatewayAgent } from "@/lib/gateway/agentConfig";
import {
  readGatewayAgentExecApprovals,
  upsertGatewayAgentExecApprovals,
} from "@/lib/gateway/execApprovals";
import { createRuntimeWriteTransport } from "@/features/agents/operations/runtimeWriteTransport";

vi.mock("@/lib/controlplane/intents-client", () => ({
  postStudioIntent: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/gateway/agentConfig", async () => {
  const actual = await vi.importActual<typeof import("@/lib/gateway/agentConfig")>(
    "@/lib/gateway/agentConfig"
  );
  return {
    ...actual,
    createGatewayAgent: vi.fn(async () => ({ id: "agent-1", name: "Agent One" })),
    deleteGatewayAgent: vi.fn(async () => ({ removed: true, removedBindings: 0 })),
    renameGatewayAgent: vi.fn(async () => ({ id: "agent-1", name: "Agent One" })),
  };
});

vi.mock("@/lib/gateway/execApprovals", async () => {
  const actual = await vi.importActual<typeof import("@/lib/gateway/execApprovals")>(
    "@/lib/gateway/execApprovals"
  );
  return {
    ...actual,
    readGatewayAgentExecApprovals: vi.fn(async () => null),
    upsertGatewayAgentExecApprovals: vi.fn(async () => undefined),
  };
});

describe("runtimeWriteTransport", () => {
  const mockedPostStudioIntent = vi.mocked(postStudioIntent);
  const mockedCreateGatewayAgent = vi.mocked(createGatewayAgent);
  const mockedDeleteGatewayAgent = vi.mocked(deleteGatewayAgent);
  const mockedRenameGatewayAgent = vi.mocked(renameGatewayAgent);
  const mockedReadGatewayAgentExecApprovals = vi.mocked(readGatewayAgentExecApprovals);
  const mockedUpsertGatewayAgentExecApprovals = vi.mocked(upsertGatewayAgentExecApprovals);

  beforeEach(() => {
    mockedPostStudioIntent.mockReset();
    mockedPostStudioIntent.mockResolvedValue({ ok: true });
    mockedCreateGatewayAgent.mockReset();
    mockedCreateGatewayAgent.mockResolvedValue({ id: "agent-1", name: "Agent One" });
    mockedDeleteGatewayAgent.mockReset();
    mockedDeleteGatewayAgent.mockResolvedValue({ removed: true, removedBindings: 0 });
    mockedRenameGatewayAgent.mockReset();
    mockedRenameGatewayAgent.mockResolvedValue({ id: "agent-1", name: "Agent One" });
    mockedReadGatewayAgentExecApprovals.mockReset();
    mockedReadGatewayAgentExecApprovals.mockResolvedValue(null);
    mockedUpsertGatewayAgentExecApprovals.mockReset();
    mockedUpsertGatewayAgentExecApprovals.mockResolvedValue(undefined);
  });

  it("routes chat send through domain intent and unwraps payload envelopes", async () => {
    mockedPostStudioIntent.mockResolvedValue({
      ok: true,
      payload: { runId: "run-1", status: "started" },
    });
    const call = vi.fn(async () => {
      throw new Error("gateway chat.send should not be called");
    });
    const transport = createRuntimeWriteTransport({
      client: { call } as never,
      useDomainIntents: true,
    });

    const result = await transport.chatSend({
      sessionKey: "agent:agent-1:main",
      message: "hello",
      deliver: false,
      idempotencyKey: "run-1",
    });

    expect(mockedPostStudioIntent).toHaveBeenCalledWith("/api/intents/chat-send", {
      sessionKey: "agent:agent-1:main",
      message: "hello",
      deliver: false,
      idempotencyKey: "run-1",
    });
    expect(call).not.toHaveBeenCalled();
    expect(result).toEqual({ runId: "run-1", status: "started" });
  });

  it("routes chat send through gateway rpc when domain mode is disabled", async () => {
    const call = vi.fn(async () => ({ runId: "run-1", status: "started" }));
    const transport = createRuntimeWriteTransport({
      client: { call } as never,
      useDomainIntents: false,
    });

    const result = await transport.chatSend({
      sessionKey: "agent:agent-1:main",
      message: "hello",
      deliver: false,
      idempotencyKey: "run-1",
    });

    expect(call).toHaveBeenCalledWith("chat.send", {
      sessionKey: "agent:agent-1:main",
      message: "hello",
      deliver: false,
      idempotencyKey: "run-1",
    });
    expect(mockedPostStudioIntent).not.toHaveBeenCalled();
    expect(result).toEqual({ runId: "run-1", status: "started" });
  });

  it("routes abort and reset actions by mode", async () => {
    const domainCall = vi.fn(async () => ({}));
    const domainTransport = createRuntimeWriteTransport({
      client: { call: domainCall } as never,
      useDomainIntents: true,
    });

    await domainTransport.chatAbort({ sessionKey: "agent:agent-1:main" });
    await domainTransport.sessionsReset({ key: "agent:agent-1:main" });
    await domainTransport.sessionSettingsSync({
      sessionKey: "agent:agent-1:main",
      model: "openai/gpt-5",
    });

    expect(mockedPostStudioIntent).toHaveBeenNthCalledWith(1, "/api/intents/chat-abort", {
      sessionKey: "agent:agent-1:main",
    });
    expect(mockedPostStudioIntent).toHaveBeenNthCalledWith(2, "/api/intents/sessions-reset", {
      key: "agent:agent-1:main",
    });
    expect(mockedPostStudioIntent).toHaveBeenNthCalledWith(3, "/api/intents/session-settings-sync", {
      sessionKey: "agent:agent-1:main",
      model: "openai/gpt-5",
    });
    expect(domainCall).not.toHaveBeenCalled();

    mockedPostStudioIntent.mockReset();
    const gatewayCall = vi.fn(async () => ({}));
    const gatewayTransport = createRuntimeWriteTransport({
      client: { call: gatewayCall } as never,
      useDomainIntents: false,
    });

    await gatewayTransport.chatAbort({ sessionKey: "agent:agent-2:main" });
    await gatewayTransport.sessionsReset({ key: "agent:agent-2:main" });
    await gatewayTransport.sessionSettingsSync({
      sessionKey: "agent:agent-2:main",
      thinkingLevel: "high",
    });

    expect(gatewayCall).toHaveBeenNthCalledWith(1, "chat.abort", { sessionKey: "agent:agent-2:main" });
    expect(gatewayCall).toHaveBeenNthCalledWith(2, "sessions.reset", { key: "agent:agent-2:main" });
    expect(gatewayCall).toHaveBeenNthCalledWith(3, "sessions.patch", {
      key: "agent:agent-2:main",
      thinkingLevel: "high",
    });
    expect(mockedPostStudioIntent).not.toHaveBeenCalled();
  });

  it("propagates runId on chat-abort when provided", async () => {
    const domainCall = vi.fn(async () => ({}));
    const domainTransport = createRuntimeWriteTransport({
      client: { call: domainCall } as never,
      useDomainIntents: true,
    });

    await domainTransport.chatAbort({ sessionKey: " agent:agent-3:main ", runId: " run-3 " });

    expect(mockedPostStudioIntent).toHaveBeenCalledWith("/api/intents/chat-abort", {
      sessionKey: "agent:agent-3:main",
      runId: "run-3",
    });
    expect(domainCall).not.toHaveBeenCalled();

    mockedPostStudioIntent.mockReset();
    const gatewayCall = vi.fn(async () => ({}));
    const gatewayTransport = createRuntimeWriteTransport({
      client: { call: gatewayCall } as never,
      useDomainIntents: false,
    });

    await gatewayTransport.chatAbort({ sessionKey: " agent:agent-4:main ", runId: " run-4 " });

    expect(gatewayCall).toHaveBeenCalledWith("chat.abort", {
      sessionKey: "agent:agent-4:main",
      runId: "run-4",
    });
    expect(mockedPostStudioIntent).not.toHaveBeenCalled();
  });

  it("routes rename and delete by mode", async () => {
    const call = vi.fn(async () => ({}));
    const gatewayTransport = createRuntimeWriteTransport({
      client: { call } as never,
      useDomainIntents: false,
    });
    await gatewayTransport.agentRename({ agentId: "agent-1", name: "Agent One" });
    await gatewayTransport.agentDelete({ agentId: "agent-1" });

    expect(mockedRenameGatewayAgent).toHaveBeenCalledWith({
      client: { call },
      agentId: "agent-1",
      name: "Agent One",
    });
    expect(mockedDeleteGatewayAgent).toHaveBeenCalledWith({
      client: { call },
      agentId: "agent-1",
    });

    mockedRenameGatewayAgent.mockReset();
    mockedDeleteGatewayAgent.mockReset();
    const domainTransport = createRuntimeWriteTransport({
      client: { call } as never,
      useDomainIntents: true,
    });
    await domainTransport.agentRename({ agentId: "agent-2", name: "Agent Two" });
    await domainTransport.agentDelete({ agentId: "agent-2" });

    expect(mockedPostStudioIntent).toHaveBeenCalledWith("/api/intents/agent-rename", {
      agentId: "agent-2",
      name: "Agent Two",
    });
    expect(mockedPostStudioIntent).toHaveBeenCalledWith("/api/intents/agent-delete", {
      agentId: "agent-2",
    });
    expect(mockedRenameGatewayAgent).not.toHaveBeenCalled();
    expect(mockedDeleteGatewayAgent).not.toHaveBeenCalled();
  });

  it("routes create agent by mode", async () => {
    const call = vi.fn(async () => ({}));
    const gatewayTransport = createRuntimeWriteTransport({
      client: { call } as never,
      useDomainIntents: false,
    });
    await expect(gatewayTransport.agentCreate({ name: "Agent One" })).resolves.toEqual({
      id: "agent-1",
      name: "Agent One",
    });
    expect(mockedCreateGatewayAgent).toHaveBeenCalledWith({
      client: { call },
      name: "Agent One",
    });

    mockedCreateGatewayAgent.mockReset();
    mockedPostStudioIntent.mockReset();
    mockedPostStudioIntent.mockResolvedValue({
      ok: true,
      payload: { ok: true, agentId: "agent-2", name: "Agent Two" },
    });
    const domainTransport = createRuntimeWriteTransport({
      client: { call: vi.fn(async () => ({})) } as never,
      useDomainIntents: true,
    });
    await expect(domainTransport.agentCreate({ name: "Agent Two" })).resolves.toEqual({
      id: "agent-2",
      name: "Agent Two",
    });
    expect(mockedPostStudioIntent).toHaveBeenCalledWith("/api/intents/agent-create", {
      name: "Agent Two",
    });
    expect(mockedCreateGatewayAgent).not.toHaveBeenCalled();
  });

  it("rejects unsafe created agent ids from domain intent mode", async () => {
    mockedPostStudioIntent.mockResolvedValue({
      ok: true,
      payload: { ok: true, agentId: "../agent-2", name: "Agent Two" },
    });
    const domainTransport = createRuntimeWriteTransport({
      client: { call: vi.fn(async () => ({})) } as never,
      useDomainIntents: true,
    });

    await expect(domainTransport.agentCreate({ name: "Agent Two" })).rejects.toThrow(
      "Agent create response missing or invalid agentId."
    );
  });

  it("normalizes rename inputs consistently across modes", async () => {
    const gatewayTransport = createRuntimeWriteTransport({
      client: { call: vi.fn(async () => ({})) } as never,
      useDomainIntents: false,
    });
    await gatewayTransport.agentRename({ agentId: "  agent-1  ", name: "  Agent One  " });
    expect(mockedRenameGatewayAgent).toHaveBeenCalledWith({
      client: expect.any(Object),
      agentId: "agent-1",
      name: "Agent One",
    });

    mockedRenameGatewayAgent.mockReset();
    mockedPostStudioIntent.mockReset();
    const domainTransport = createRuntimeWriteTransport({
      client: { call: vi.fn(async () => ({})) } as never,
      useDomainIntents: true,
    });
    await domainTransport.agentRename({ agentId: "  agent-2  ", name: "  Agent Two  " });
    expect(mockedPostStudioIntent).toHaveBeenCalledWith("/api/intents/agent-rename", {
      agentId: "agent-2",
      name: "Agent Two",
    });
    expect(mockedRenameGatewayAgent).not.toHaveBeenCalled();
  });

  it("routes exec approval resolve by mode", async () => {
    const call = vi.fn(async () => ({}));
    const gatewayTransport = createRuntimeWriteTransport({
      client: { call } as never,
      useDomainIntents: false,
    });

    await gatewayTransport.execApprovalResolve({ id: "approval-1", decision: "allow-once" });
    expect(call).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-1",
      decision: "allow-once",
    });

    call.mockReset();
    mockedPostStudioIntent.mockReset();
    const domainTransport = createRuntimeWriteTransport({
      client: { call } as never,
      useDomainIntents: true,
    });
    await domainTransport.execApprovalResolve({ id: "approval-2", decision: "deny" });
    expect(mockedPostStudioIntent).toHaveBeenCalledWith("/api/intents/exec-approval-resolve", {
      id: "approval-2",
      decision: "deny",
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects invalid exec approval decisions before writing", async () => {
    const call = vi.fn(async () => ({}));
    const transport = createRuntimeWriteTransport({
      client: { call } as never,
      useDomainIntents: false,
    });

    await expect(
      transport.execApprovalResolve({ id: "approval-1", decision: "allow" as never })
    ).rejects.toThrow("Exec approval decision must be allow-once, allow-always, or deny.");

    expect(call).not.toHaveBeenCalled();
  });

  it("sets exec approval policy in gateway mode using existing allowlist", async () => {
    const call = vi.fn(async () => ({}));
    mockedReadGatewayAgentExecApprovals.mockResolvedValue({
      security: "allowlist",
      ask: "always",
      allowlist: [{ pattern: "/tmp/**" }],
    });
    const transport = createRuntimeWriteTransport({
      client: { call } as never,
      useDomainIntents: false,
    });

    await transport.execApprovalsSet({
      agentId: "  agent-1  ",
      role: "autonomous",
    });

    expect(mockedReadGatewayAgentExecApprovals).toHaveBeenCalledWith({
      client: { call },
      agentId: "agent-1",
    });
    expect(mockedUpsertGatewayAgentExecApprovals).toHaveBeenCalledWith({
      client: { call },
      agentId: "agent-1",
      policy: {
        security: "full",
        ask: "off",
        allowlist: [{ pattern: "/tmp/**" }],
      },
    });
  });

  it("rejects exec approvals set in domain mode and directs caller to permissions intent", async () => {
    const call = vi.fn(async () => ({}));
    const transport = createRuntimeWriteTransport({
      client: { call } as never,
      useDomainIntents: true,
    });

    await expect(
      transport.execApprovalsSet({ agentId: "agent-1", role: "collaborative" })
    ).rejects.toThrow(
      "execApprovalsSet is not supported in domain intent mode; use agentPermissionsUpdate."
    );
    expect(mockedPostStudioIntent).not.toHaveBeenCalled();
    expect(mockedReadGatewayAgentExecApprovals).not.toHaveBeenCalled();
    expect(mockedUpsertGatewayAgentExecApprovals).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("routes agent permissions update through domain intent", async () => {
    const transport = createRuntimeWriteTransport({
      client: { call: vi.fn(async () => ({})) } as never,
      useDomainIntents: true,
    });
    await transport.agentPermissionsUpdate({
      agentId: "agent-1",
      sessionKey: "agent:agent-1:main",
      commandMode: "ask",
      webAccess: true,
      fileTools: false,
    });
    expect(mockedPostStudioIntent).toHaveBeenCalledWith("/api/intents/agent-permissions-update", {
      agentId: "agent-1",
      sessionKey: "agent:agent-1:main",
      commandMode: "ask",
      webAccess: true,
      fileTools: false,
    });
  });

  it("rejects exec approval set when agent id is empty", async () => {
    const transport = createRuntimeWriteTransport({
      client: { call: vi.fn(async () => ({})) } as never,
      useDomainIntents: false,
    });

    await expect(transport.execApprovalsSet({ agentId: "   ", role: "conservative" })).rejects.toThrow(
      "Agent id is required."
    );
    expect(mockedReadGatewayAgentExecApprovals).not.toHaveBeenCalled();
    expect(mockedUpsertGatewayAgentExecApprovals).not.toHaveBeenCalled();
  });

  it("rejects agent permissions update when domain mode is disabled", async () => {
    const transport = createRuntimeWriteTransport({
      client: { call: vi.fn(async () => ({})) } as never,
      useDomainIntents: false,
    });
    await expect(
      transport.agentPermissionsUpdate({
        agentId: "agent-1",
        sessionKey: "agent:agent-1:main",
        commandMode: "off",
        webAccess: false,
        fileTools: false,
      })
    ).rejects.toThrow("agentPermissionsUpdate is only available in domain intent mode.");
  });

  it("fails fast on required identifiers before transport calls", async () => {
    const call = vi.fn(async () => ({}));
    const transport = createRuntimeWriteTransport({
      client: { call } as never,
      useDomainIntents: true,
    });

    await expect(
      transport.chatSend({
        sessionKey: "   ",
        message: "hello",
        deliver: false,
        idempotencyKey: "run-1",
      })
    ).rejects.toThrow("Session key is required.");
    await expect(
      transport.chatSend({
        sessionKey: "agent:../agent-1:main",
        message: "hello",
        deliver: false,
        idempotencyKey: "run-1",
      })
    ).rejects.toThrow("Invalid sessionKey.");
    await expect(transport.agentWait({ runId: "   " })).rejects.toThrow("Run id is required.");
    await expect(transport.execApprovalResolve({ id: "   ", decision: "allow-once" })).rejects.toThrow(
      "Approval id is required."
    );
    await expect(transport.agentDelete({ agentId: "   " })).rejects.toThrow("Agent id is required.");
    await expect(transport.agentRename({ agentId: "agent-1", name: "   " })).rejects.toThrow(
      "Agent name is required."
    );
    await expect(transport.agentCreate({ name: "   " })).rejects.toThrow("Agent name is required.");

    expect(call).not.toHaveBeenCalled();
    expect(mockedPostStudioIntent).not.toHaveBeenCalled();
  });

  it("routes agent wait through mode-specific transport with timeout passthrough", async () => {
    const gatewayCall = vi.fn(async () => ({ status: "ok" }));
    const gatewayTransport = createRuntimeWriteTransport({
      client: { call: gatewayCall } as never,
      useDomainIntents: false,
    });
    await expect(gatewayTransport.agentWait({ runId: "run-1", timeoutMs: 2500 })).resolves.toEqual({
      status: "ok",
    });
    expect(gatewayCall).toHaveBeenCalledWith("agent.wait", { runId: "run-1", timeoutMs: 2500 });

    mockedPostStudioIntent.mockReset();
    mockedPostStudioIntent.mockResolvedValue({ ok: true, payload: { status: "error" } });
    const domainTransport = createRuntimeWriteTransport({
      client: { call: vi.fn(async () => ({})) } as never,
      useDomainIntents: true,
    });
    await expect(domainTransport.agentWait({ runId: "run-2", timeoutMs: 3000 })).resolves.toEqual({
      status: "error",
    });
    expect(mockedPostStudioIntent).toHaveBeenCalledWith("/api/intents/agent-wait", {
      runId: "run-2",
      timeoutMs: 3000,
    });
  });
});
