import { describe, expect, it, vi } from "vitest";

import {
  createGatewayAgent,
  deleteGatewayAgent,
  renameGatewayAgent,
  resolveHeartbeatSettings,
  removeGatewayHeartbeatOverride,
  updateGatewayHeartbeat,
} from "@/lib/gateway/agentConfig";
import { GatewayResponseError, type GatewayClient } from "@/lib/gateway/GatewayClient";

describe("gateway agent helpers", () => {
  it("creates a new agent via agents.create and derives workspace from the config path", async () => {
    const client = {
      call: vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.get") {
          return {
            exists: true,
            hash: "hash-create-1",
            path: "/Users/test/.openclaw/openclaw.json",
            config: { agents: { list: [{ id: "agent-1", name: "Agent One" }] } },
          };
        }
        if (method === "agents.create") {
          expect(params).toEqual({
            name: "New Agent",
            workspace: "/Users/test/.openclaw/workspace-new-agent",
          });
          return { ok: true, agentId: "new-agent", name: "New Agent", workspace: "ignored" };
        }
        throw new Error("unexpected method");
      }),
    } as unknown as GatewayClient;

    const entry = await createGatewayAgent({ client, name: "New Agent" });
    expect(entry.id).toBe("new-agent");
    expect(entry.name).toBe("New Agent");
  });

  it("slugifies workspace names from agent names", async () => {
    const client = {
      call: vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.get") {
          return {
            exists: true,
            hash: "hash-create-slug-1",
            path: "/Users/test/.openclaw/openclaw.json",
            config: { agents: { list: [] } },
          };
        }
        if (method === "agents.create") {
          expect(params).toEqual({
            name: "My Project",
            workspace: "/Users/test/.openclaw/workspace-my-project",
          });
          return { ok: true, agentId: "my-project", name: "My Project", workspace: "ignored" };
        }
        throw new Error("unexpected method");
      }),
    } as unknown as GatewayClient;

    const entry = await createGatewayAgent({ client, name: "My Project" });
    expect(entry.id).toBe("my-project");
    expect(entry.name).toBe("My Project");
  });

  it("derives create workspaces from the same normalized id OpenClaw returns", async () => {
    const client = {
      call: vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.get") {
          return {
            exists: true,
            hash: "hash-create-underscore-1",
            path: "/Users/test/.openclaw/openclaw.json",
            config: { agents: { list: [] } },
          };
        }
        if (method === "agents.create") {
          expect(params).toEqual({
            name: "My_Agent",
            workspace: "/Users/test/.openclaw/workspace-my_agent",
          });
          return { ok: true, agentId: "my_agent", name: "My_Agent", workspace: "ignored" };
        }
        throw new Error("unexpected method");
      }),
    } as unknown as GatewayClient;

    const entry = await createGatewayAgent({ client, name: "My_Agent" });
    expect(entry.id).toBe("my_agent");
    expect(entry.name).toBe("My_Agent");
  });

  it("returns no-op on deleting a missing agent", async () => {
    const client = {
      call: vi.fn(async (method: string) => {
        if (method === "agents.delete") {
          throw new GatewayResponseError({
            code: "INVALID_REQUEST",
            message: 'agent "agent-2" not found',
          });
        }
        throw new Error("unexpected method");
      }),
    } as unknown as GatewayClient;

    const result = await deleteGatewayAgent({
      client,
      agentId: "agent-2",
    });

    expect(result).toEqual({ removed: false, removedBindings: 0 });
    expect(client.call).toHaveBeenCalledTimes(1);
    expect((client.call as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("agents.delete");
  });

  it("fails fast on empty create name", async () => {
    const client = {
      call: vi.fn(),
    } as unknown as GatewayClient;

    await expect(createGatewayAgent({ client, name: "   " })).rejects.toThrow(
      "Agent name is required."
    );
    expect(client.call).not.toHaveBeenCalled();
  });

  it("fails when create name resolves to the reserved main agent id", async () => {
    const client = {
      call: vi.fn(async () => {
        throw new Error("unexpected method");
      }),
    } as unknown as GatewayClient;

    await expect(createGatewayAgent({ client, name: "!!!" })).rejects.toThrow(
      'Agent name resolves to reserved agent id "main".'
    );
    expect(client.call).not.toHaveBeenCalled();
  });

  it("rejects unsafe agent ids returned by agents.create", async () => {
    const client = {
      call: vi.fn(async (method: string) => {
        if (method === "config.get") {
          return {
            exists: true,
            hash: "hash-create-unsafe-id-1",
            path: "/Users/test/.openclaw/openclaw.json",
            config: { agents: { list: [] } },
          };
        }
        if (method === "agents.create") {
          return { ok: true, agentId: "../new-agent", name: "New Agent" };
        }
        throw new Error("unexpected method");
      }),
    } as unknown as GatewayClient;

    await expect(createGatewayAgent({ client, name: "New Agent" })).rejects.toThrow(
      "Invalid agentId: ../new-agent"
    );
  });

  it("returns current settings when no heartbeat override exists to remove", async () => {
    const client = {
      call: vi.fn(async (method: string) => {
        if (method === "config.get") {
          return {
            exists: true,
            hash: "hash-remove-1",
            path: "/Users/test/.openclaw/openclaw.json",
            config: {
              agents: {
                defaults: {
                  heartbeat: {
                    every: "10m",
                    target: "last",
                    includeReasoning: false,
                    ackMaxChars: 300,
                  },
                },
                list: [{ id: "agent-1", name: "Agent One" }],
              },
            },
          };
        }
        throw new Error("unexpected method");
      }),
    } as unknown as GatewayClient;

    const result = await removeGatewayHeartbeatOverride({
      client,
      agentId: "agent-1",
    });

    expect(result).toEqual({
      heartbeat: {
        every: "10m",
        target: "last",
        includeReasoning: false,
        ackMaxChars: 300,
        activeHours: null,
      },
      hasOverride: false,
    });
    expect(client.call).toHaveBeenCalledTimes(1);
  });

  it("renames an agent via agents.update", async () => {
    const client = {
      call: vi.fn(async (method: string, params?: unknown) => {
        if (method === "agents.update") {
          expect(params).toEqual({ agentId: "agent-1", name: "New Name" });
          return { ok: true, agentId: "agent-1" };
        }
        throw new Error("unexpected method");
      }),
    } as unknown as GatewayClient;

    await renameGatewayAgent({ client, agentId: "agent-1", name: "New Name" });
  });

  it("resolves heartbeat defaults and overrides", () => {
    const config = {
      agents: {
        defaults: {
          heartbeat: {
            every: "2h",
            target: "last",
            includeReasoning: false,
            ackMaxChars: 200,
          },
        },
        list: [
          {
            id: "agent-1",
            heartbeat: { every: "30m", target: "none", includeReasoning: true },
          },
        ],
      },
    };
    const result = resolveHeartbeatSettings(config, "agent-1");
    expect(result.heartbeat.every).toBe("30m");
    expect(result.heartbeat.target).toBe("none");
    expect(result.heartbeat.includeReasoning).toBe(true);
    expect(result.hasOverride).toBe(true);
  });

  it("updates heartbeat overrides via config.patch", async () => {
    const client = {
      call: vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.get") {
          return {
            exists: true,
            hash: "hash-2",
            path: "/Users/test/.openclaw/openclaw.json",
            config: {
              agents: {
                defaults: {
                  heartbeat: {
                    every: "1h",
                    target: "last",
                    includeReasoning: false,
                    ackMaxChars: 300,
                  },
                },
                list: [{ id: "agent-1" }],
              },
            },
          };
        }
        if (method === "config.patch") {
          const raw = (params as { raw?: string }).raw ?? "";
          const parsed = JSON.parse(raw) as {
            agents?: { list?: Array<{ id?: string; heartbeat?: unknown }> };
          };
          const entry = parsed.agents?.list?.find((item) => item.id === "agent-1");
          expect(entry && typeof entry === "object").toBe(true);
          return { ok: true };
        }
        throw new Error("unexpected method");
      }),
    } as unknown as GatewayClient;

    const result = await updateGatewayHeartbeat({
      client,
      agentId: "agent-1",
      payload: {
        override: true,
        heartbeat: {
          every: "15m",
          target: "none",
          includeReasoning: true,
          ackMaxChars: 120,
          activeHours: { start: "08:00", end: "18:00" },
        },
      },
    });

    expect(result.heartbeat.every).toBe("15m");
    expect(result.heartbeat.target).toBe("none");
    expect(result.heartbeat.includeReasoning).toBe(true);
    expect(result.hasOverride).toBe(true);
  });

  it("normalizes heartbeat agent ids before writing overrides", async () => {
    const client = {
      call: vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.get") {
          return {
            exists: true,
            hash: "hash-trim-update-1",
            config: {
              agents: {
                list: [{ id: "agent-1" }],
              },
            },
          };
        }
        if (method === "config.patch") {
          const raw = (params as { raw?: string }).raw ?? "";
          const parsed = JSON.parse(raw) as {
            agents?: { list?: Array<{ id?: string; heartbeat?: unknown }> };
          };
          expect(parsed.agents?.list?.map((entry) => entry.id)).toEqual(["agent-1"]);
          expect(parsed.agents?.list?.[0]?.heartbeat).toEqual({
            every: "15m",
            target: "last",
            includeReasoning: false,
          });
          return { ok: true };
        }
        throw new Error("unexpected method");
      }),
    } as unknown as GatewayClient;

    const result = await updateGatewayHeartbeat({
      client,
      agentId: "  agent-1  ",
      payload: {
        override: true,
        heartbeat: {
          every: "15m",
          target: "last",
          includeReasoning: false,
        },
      },
    });

    expect(result.hasOverride).toBe(true);
    expect(client.call).toHaveBeenCalledTimes(2);
  });

  it("rejects blank heartbeat update agent ids before touching the gateway", async () => {
    const client = {
      call: vi.fn(),
    } as unknown as GatewayClient;

    await expect(
      updateGatewayHeartbeat({
        client,
        agentId: "   ",
        payload: {
          override: true,
          heartbeat: {
            every: "15m",
            target: "last",
            includeReasoning: false,
          },
        },
      })
    ).rejects.toThrow("Agent id is required.");
    expect(client.call).not.toHaveBeenCalled();
  });

  it("normalizes heartbeat agent ids before removing overrides", async () => {
    const client = {
      call: vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.get") {
          return {
            exists: true,
            hash: "hash-trim-remove-1",
            config: {
              agents: {
                list: [
                  {
                    id: "agent-1",
                    heartbeat: { every: "15m", target: "last", includeReasoning: false },
                  },
                ],
              },
            },
          };
        }
        if (method === "config.patch") {
          const raw = (params as { raw?: string }).raw ?? "";
          const parsed = JSON.parse(raw) as {
            agents?: { list?: Array<{ id?: string; heartbeat?: unknown }> };
          };
          expect(parsed.agents?.list).toEqual([{ id: "agent-1" }]);
          return { ok: true };
        }
        throw new Error("unexpected method");
      }),
    } as unknown as GatewayClient;

    const result = await removeGatewayHeartbeatOverride({
      client,
      agentId: "  agent-1  ",
    });

    expect(result.hasOverride).toBe(false);
    expect(client.call).toHaveBeenCalledTimes(2);
  });

  it("rejects blank heartbeat removal agent ids before touching the gateway", async () => {
    const client = {
      call: vi.fn(),
    } as unknown as GatewayClient;

    await expect(
      removeGatewayHeartbeatOverride({
        client,
        agentId: "   ",
      })
    ).rejects.toThrow("Agent id is required.");
    expect(client.call).not.toHaveBeenCalled();
  });

  it("rebuilds heartbeat retry patches from the latest agent list", async () => {
    let getCount = 0;
    let patchCount = 0;
    const client = {
      call: vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.get") {
          getCount += 1;
          if (getCount === 1) {
            return {
              exists: true,
              hash: "hash-old",
              config: {
                agents: {
                  list: [{ id: "agent-1" }],
                },
              },
            };
          }
          return {
            exists: true,
            hash: "hash-fresh",
            config: {
              agents: {
                list: [
                  { id: "agent-1" },
                  { id: "agent-2", heartbeat: { every: "5m", target: "last", includeReasoning: false } },
                ],
              },
            },
          };
        }
        if (method === "config.patch") {
          patchCount += 1;
          const payload = params as { raw?: string; baseHash?: string };
          if (patchCount === 1) {
            expect(payload.baseHash).toBe("hash-old");
            throw new GatewayResponseError({
              code: "INVALID_REQUEST",
              message: "config changed since last load; re-run config.get and retry",
            });
          }
          expect(payload.baseHash).toBe("hash-fresh");
          const parsed = JSON.parse(payload.raw ?? "{}") as {
            agents?: { list?: Array<{ id?: string; heartbeat?: unknown }> };
          };
          expect(parsed.agents?.list?.find((entry) => entry.id === "agent-2")).toEqual({
            id: "agent-2",
            heartbeat: { every: "5m", target: "last", includeReasoning: false },
          });
          expect(parsed.agents?.list?.find((entry) => entry.id === "agent-1")?.heartbeat).toEqual({
            every: "15m",
            target: "none",
            includeReasoning: true,
          });
          return { ok: true };
        }
        throw new Error("unexpected method");
      }),
    } as unknown as GatewayClient;

    await updateGatewayHeartbeat({
      client,
      agentId: "agent-1",
      payload: {
        override: true,
        heartbeat: {
          every: "15m",
          target: "none",
          includeReasoning: true,
        },
      },
    });

    expect(patchCount).toBe(2);
  });
});
