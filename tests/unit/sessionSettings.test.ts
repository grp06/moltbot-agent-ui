import { describe, expect, it, vi } from "vitest";

import type { GatewayClient } from "@/lib/gateway/GatewayClient";
import { isWebchatSessionMutationBlockedError } from "@/lib/gateway/gateway-disconnect";
import { syncGatewaySessionSettings } from "@/lib/gateway/session-settings-sync";
import { GatewayResponseError } from "@/lib/gateway/errors";

describe("session settings sync helper", () => {
  it("detects webchat session mutation blocked gateway errors", () => {
    const blocked = new GatewayResponseError({
      code: "INVALID_REQUEST",
      message: "webchat clients cannot patch sessions; use chat.send for session-scoped updates",
    });
    expect(isWebchatSessionMutationBlockedError(blocked)).toBe(true);
  });

  it("does not misclassify unrelated invalid request errors", () => {
    const invalid = new GatewayResponseError({
      code: "INVALID_REQUEST",
      message: "invalid model ref",
    });
    expect(isWebchatSessionMutationBlockedError(invalid)).toBe(false);
  });

  it("does not misclassify non-gateway errors", () => {
    expect(
      isWebchatSessionMutationBlockedError(
        new Error("webchat clients cannot patch sessions; use chat.send for session-scoped updates")
      )
    ).toBe(false);
  });

  it("throws when session key is missing", async () => {
    const client = { call: vi.fn() } as unknown as GatewayClient;
    await expect(
      syncGatewaySessionSettings({
        client,
        sessionKey: "",
        model: "openai/gpt-5",
      })
    ).rejects.toThrow("Session key is required.");
  });

  it("throws when no settings are provided", async () => {
    const client = { call: vi.fn() } as unknown as GatewayClient;
    await expect(
      syncGatewaySessionSettings({
        client,
        sessionKey: "agent:1:studio:abc",
      })
    ).rejects.toThrow("At least one session setting must be provided.");
  });

  it("throws when an agent-prefixed session key has an unsafe agent id", async () => {
    const client = { call: vi.fn() } as unknown as GatewayClient;
    await expect(
      syncGatewaySessionSettings({
        client,
        sessionKey: "agent:../agent-1:main",
        model: "openai/gpt-5",
      })
    ).rejects.toThrow("Invalid sessionKey.");
    expect(client.call).not.toHaveBeenCalled();
  });

  it("patches model and thinking level together", async () => {
    const client = {
      call: vi.fn(async () => ({ ok: true })),
    } as unknown as GatewayClient;

    await syncGatewaySessionSettings({
      client,
      sessionKey: "agent:1:studio:abc",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
    });

    expect(client.call).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:1:studio:abc",
      model: "openai/gpt-5",
      thinkingLevel: "medium",
    });
  });

  it("patches only model when thinking is omitted", async () => {
    const client = {
      call: vi.fn(async () => ({ ok: true })),
    } as unknown as GatewayClient;

    await syncGatewaySessionSettings({
      client,
      sessionKey: "agent:1:studio:abc",
      model: null,
    });

    expect(client.call).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:1:studio:abc",
      model: null,
    });
  });

  it("patches exec session overrides without model settings", async () => {
    const client = {
      call: vi.fn(async () => ({ ok: true })),
    } as unknown as GatewayClient;

    await syncGatewaySessionSettings({
      client,
      sessionKey: "agent:1:studio:abc",
      execHost: "gateway",
      execSecurity: "allowlist",
      execAsk: "always",
    });

    expect(client.call).toHaveBeenCalledWith("sessions.patch", {
      key: "agent:1:studio:abc",
      execHost: "gateway",
      execSecurity: "allowlist",
      execAsk: "always",
    });
  });
});
