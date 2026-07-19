import { describe, expect, it, vi } from "vitest";

import { upsertAgentExecApprovalsPolicyViaRuntime } from "@/lib/controlplane/exec-approvals";
import { ControlPlaneGatewayError } from "@/lib/controlplane/openclaw-adapter";
import type { ControlPlaneRuntime } from "@/lib/controlplane/runtime";

describe("control-plane exec approvals policy upsert", () => {
  it("rejects unsafe agent ids before reading approval policy", async () => {
    const runtime = {
      callGateway: vi.fn(),
    } as unknown as ControlPlaneRuntime;

    await expect(
      upsertAgentExecApprovalsPolicyViaRuntime({
        runtime,
        agentId: "../agent-1",
        role: "autonomous",
      })
    ).rejects.toThrow("Invalid agentId: ../agent-1");

    expect(runtime.callGateway).not.toHaveBeenCalled();
  });

  it("requires a base hash unless the exec approvals file is known missing", async () => {
    const runtime = {
      callGateway: vi.fn(async (method: string) => {
        if (method === "exec.approvals.get") {
          return {
            path: "/tmp/approvals.json",
            file: { version: 1, agents: {} },
          };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
    } as unknown as ControlPlaneRuntime;

    await expect(
      upsertAgentExecApprovalsPolicyViaRuntime({
        runtime,
        agentId: "agent-1",
        role: "autonomous",
      })
    ).rejects.toThrow("Exec approvals hash unavailable; re-run exec.approvals.get.");
  });

  it("rebuilds retry payload from latest snapshot on stale base-hash conflicts", async () => {
    let getCount = 0;
    let setCount = 0;

    const runtime = {
      callGateway: vi.fn(async (method: string, params: unknown) => {
        if (method === "exec.approvals.get") {
          getCount += 1;
          if (getCount === 1) {
            return {
              path: "/tmp/approvals.json",
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
            path: "/tmp/approvals.json",
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
            throw new ControlPlaneGatewayError({
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
    } as unknown as ControlPlaneRuntime;

    await upsertAgentExecApprovalsPolicyViaRuntime({
      runtime,
      agentId: "agent-1",
      role: "conservative",
    });

    expect(setCount).toBe(2);
  });

  it("retries for reload-and-retry INVALID_REQUEST messages from openclaw node host", async () => {
    let setCount = 0;
    const runtime = {
      callGateway: vi.fn(async (method: string, params: unknown) => {
        if (method === "exec.approvals.get") {
          return {
            path: "/tmp/approvals.json",
            exists: true,
            hash: setCount === 0 ? "hash-1" : "hash-2",
            file: {
              version: 1,
              agents: {
                "agent-1": {
                  security: "allowlist",
                  ask: "always",
                  allowlist: [{ pattern: "/bin/tool" }],
                },
              },
            },
          };
        }
        if (method === "exec.approvals.set") {
          setCount += 1;
          const payload = params as { baseHash?: string };
          if (setCount === 1) {
            expect(payload.baseHash).toBe("hash-1");
            throw new ControlPlaneGatewayError({
              code: "INVALID_REQUEST",
              message: "INVALID_REQUEST: exec approvals base hash required; reload and retry",
            });
          }
          expect(payload.baseHash).toBe("hash-2");
          return { ok: true };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
    } as unknown as ControlPlaneRuntime;

    await upsertAgentExecApprovalsPolicyViaRuntime({
      runtime,
      agentId: "agent-1",
      role: "autonomous",
    });

    expect(setCount).toBe(2);
  });
});
