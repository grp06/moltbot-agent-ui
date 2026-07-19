import { describe, expect, it, vi } from "vitest";
import { GatewayResponseError, type GatewayClient } from "@/lib/gateway/GatewayClient";
import {
  readGatewayAgentExecApprovals,
  upsertGatewayAgentExecApprovals,
} from "@/lib/gateway/execApprovals";

describe("upsertGatewayAgentExecApprovals", () => {
  it("writes per-agent policy with base hash", async () => {
    const client = {
      call: vi.fn(async (method: string, params?: unknown) => {
        if (method === "exec.approvals.get") {
          return {
            exists: true,
            hash: "hash-1",
            file: {
              version: 1,
              agents: {
                main: {
                  security: "allowlist",
                  ask: "always",
                  allowlist: [{ pattern: "/bin/main" }],
                },
              },
            },
          };
        }
        if (method === "exec.approvals.set") {
          const payload = params as {
            baseHash?: string;
            file?: {
              agents?: Record<string, { security?: string; ask?: string; allowlist?: Array<{ pattern: string }> }>;
            };
          };
          expect(payload.baseHash).toBe("hash-1");
          expect(payload.file?.agents?.["agent-2"]).toEqual({
            security: "allowlist",
            ask: "always",
            allowlist: [{ pattern: "/usr/bin/git" }],
          });
          return { ok: true };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
    } as unknown as GatewayClient;

    await upsertGatewayAgentExecApprovals({
      client,
      agentId: "agent-2",
      policy: {
        security: "allowlist",
        ask: "always",
        allowlist: [{ pattern: "/usr/bin/git" }],
      },
    });
  });

  it("rejects unsafe agent ids before reading or writing approval policy", async () => {
    const client = {
      call: vi.fn(),
    } as unknown as GatewayClient;

    await expect(
      upsertGatewayAgentExecApprovals({
        client,
        agentId: "../agent-1",
        policy: {
          security: "allowlist",
          ask: "always",
          allowlist: [],
        },
      })
    ).rejects.toThrow("Invalid agentId: ../agent-1");

    await expect(
      readGatewayAgentExecApprovals({
        client,
        agentId: "agent.1",
      })
    ).rejects.toThrow("Invalid agentId: agent.1");

    expect(client.call).not.toHaveBeenCalled();
  });

  it("removes per-agent policy when policy is null", async () => {
    const client = {
      call: vi.fn(async (method: string, params?: unknown) => {
        if (method === "exec.approvals.get") {
          return {
            exists: true,
            hash: "hash-2",
            file: {
              version: 1,
              agents: {
                "agent-1": {
                  security: "allowlist",
                  ask: "always",
                  allowlist: [{ pattern: "/bin/echo" }],
                },
              },
            },
          };
        }
        if (method === "exec.approvals.set") {
          const payload = params as {
            file?: { agents?: Record<string, unknown> };
          };
          expect(payload.file?.agents?.["agent-1"]).toBeUndefined();
          return { ok: true };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
    } as unknown as GatewayClient;

    await upsertGatewayAgentExecApprovals({
      client,
      agentId: "agent-1",
      policy: null,
    });
  });

  it("retries once when gateway reports stale base hash", async () => {
    let setAttempts = 0;
    const client = {
      call: vi.fn(async (method: string, params?: unknown) => {
        if (method === "exec.approvals.get") {
          return {
            exists: true,
            hash: setAttempts === 0 ? "hash-old" : "hash-new",
            file: {
              version: 1,
              agents: {},
            },
          };
        }
        if (method === "exec.approvals.set") {
          setAttempts += 1;
          const payload = params as { baseHash?: string };
          if (setAttempts === 1) {
            expect(payload.baseHash).toBe("hash-old");
            throw new GatewayResponseError({
              code: "INVALID_REQUEST",
              message: "exec approvals changed since last load; re-run exec.approvals.get and retry",
            });
          }
          expect(payload.baseHash).toBe("hash-new");
          return { ok: true };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
    } as unknown as GatewayClient;

    await upsertGatewayAgentExecApprovals({
      client,
      agentId: "agent-3",
      policy: {
        security: "full",
        ask: "off",
        allowlist: [],
      },
    });

    expect(setAttempts).toBe(2);
  });

  it("rebuilds retry payload from the latest exec approvals snapshot", async () => {
    let getCount = 0;
    let setCount = 0;
    const client = {
      call: vi.fn(async (method: string, params?: unknown) => {
        if (method === "exec.approvals.get") {
          getCount += 1;
          if (getCount === 1) {
            return {
              exists: true,
              hash: "hash-1",
              file: {
                version: 1,
                agents: {
                  "agent-1": {
                    security: "allowlist",
                    ask: "always",
                    allowlist: [{ pattern: "/bin/old" }],
                  },
                  "agent-2": {
                    security: "allowlist",
                    ask: "always",
                    allowlist: [{ pattern: "/bin/shared" }],
                  },
                },
              },
            };
          }
          return {
            exists: true,
            hash: "hash-2",
            file: {
              version: 1,
              agents: {
                "agent-1": {
                  security: "allowlist",
                  ask: "always",
                  allowlist: [{ pattern: "/bin/new" }],
                },
                "agent-2": {
                  security: "full",
                  ask: "off",
                  allowlist: [{ pattern: "/bin/shared" }, { pattern: "/bin/extra" }],
                },
                "agent-3": {
                  security: "allowlist",
                  ask: "always",
                  allowlist: [{ pattern: "/bin/third" }],
                },
              },
            },
          };
        }
        if (method === "exec.approvals.set") {
          setCount += 1;
          const payload = params as {
            baseHash?: string;
            file?: { agents?: Record<string, unknown> };
          };
          if (setCount === 1) {
            expect(payload.baseHash).toBe("hash-1");
            throw new GatewayResponseError({
              code: "INVALID_REQUEST",
              message: "exec approvals changed since last load; re-run exec.approvals.get and retry",
            });
          }
          expect(payload.baseHash).toBe("hash-2");
          expect(payload.file?.agents?.["agent-1"]).toBeUndefined();
          expect(payload.file?.agents?.["agent-2"]).toEqual({
            security: "full",
            ask: "off",
            allowlist: [{ pattern: "/bin/shared" }, { pattern: "/bin/extra" }],
          });
          expect(payload.file?.agents?.["agent-3"]).toEqual({
            security: "allowlist",
            ask: "always",
            allowlist: [{ pattern: "/bin/third" }],
          });
          return { ok: true };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
    } as unknown as GatewayClient;

    await upsertGatewayAgentExecApprovals({
      client,
      agentId: "agent-1",
      policy: null,
    });

    expect(setCount).toBe(2);
  });
});
