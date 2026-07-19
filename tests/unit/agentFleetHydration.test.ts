import { describe, expect, it, vi } from "vitest";

import { hydrateAgentFleetFromGateway } from "@/features/agents/operations/agentFleetHydration";
import type { StudioSettings } from "@/lib/studio/settings";

describe("hydrateAgentFleetFromGateway", () => {
  it("maps_gateway_results_into_seeds_and_selects_latest_assistant_agent", async () => {
    const gatewayUrl = "ws://127.0.0.1:18789";

    const settings: StudioSettings = {
      version: 1,
      gateway: null,
      gatewayAutoStart: true,
      focused: {},
      avatars: {
        "ws://localhost:18789": {
          "agent-1": "persisted-seed",
        },
      },
    };

    const call = vi.fn(async (method: string, params: unknown) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            agents: {
              defaults: {
                model: "openai/gpt-5",
              },
              list: [],
            },
          },
        };
      }
      if (method === "agents.list") {
        return {
          defaultId: "agent-1",
          mainKey: "main",
          agents: [
            {
              id: "agent-1",
              name: "One",
              identity: { avatarUrl: "https://example.com/one.png" },
            },
            {
              id: "agent-2",
              name: "Two",
              identity: { avatarUrl: "https://example.com/two.png" },
            },
          ],
        };
      }
      if (method === "exec.approvals.get") {
        return {
          file: {
            agents: {
              "agent-1": { security: "allowlist", ask: "always" },
              "agent-2": { security: "full", ask: "off" },
            },
          },
        };
      }
      if (method === "sessions.list") {
        const query = params as Record<string, unknown>;
        expect(query.includeGlobal).toBe(false);
        expect(query.includeUnknown).toBe(false);
        expect(query.search).toBe(":main");
        expect("limit" in query).toBe(false);
        expect("includeDerivedTitles" in query).toBe(false);
        expect("includeLastMessage" in query).toBe(false);
        return {
          sessions: [
            {
              key: "agent:agent-2:main",
              updatedAt: 1,
              displayName: "Main",
              thinkingLevel: "medium",
              modelProvider: "openai",
              model: "gpt-5",
            },
            {
              key: "agent:agent-1:main",
              updatedAt: 1,
              displayName: "Main",
              thinkingLevel: "medium",
              modelProvider: "openai",
              model: "gpt-4.1",
            },
            {
              key: "agent:agent-3:work",
              updatedAt: 1,
              displayName: "Noise",
              thinkingLevel: "low",
              modelProvider: "openai",
              model: "gpt-4.1",
            },
          ],
        };
      }
      if (method === "status") {
        return {
          sessions: {
            recent: [],
            byAgent: [],
          },
        };
      }
      if (method === "sessions.preview") {
        expect(params).toEqual({
          keys: ["agent:agent-1:main", "agent:agent-2:main"],
          limit: 8,
          maxChars: 240,
        });
        return {
          ts: 1,
          previews: [
            {
              key: "agent:agent-1:main",
              status: "ok",
              items: [
                { role: "assistant", text: "one", timestamp: "2026-02-10T00:00:00Z" },
              ],
            },
            {
              key: "agent:agent-2:main",
              status: "ok",
              items: [
                { role: "assistant", text: "two", timestamp: "2026-02-10T01:00:00Z" },
              ],
            },
          ],
        };
      }
      throw new Error(`Unhandled method: ${method}`);
    });

    const result = await hydrateAgentFleetFromGateway({
      client: { call },
      gatewayUrl,
      cachedConfigSnapshot: null,
      loadStudioSettings: async () => settings,
      isDisconnectLikeError: () => false,
    });

    expect(call).toHaveBeenCalledWith("agents.list", {});
    expect(call).toHaveBeenCalledWith("exec.approvals.get", {});
    expect(call).toHaveBeenCalledTimes(6);
    expect(call.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(1);
    expect(result.seeds).toHaveLength(2);
    expect(result.seeds[0]).toEqual(
      expect.objectContaining({
        agentId: "agent-1",
        name: "One",
        sessionKey: "agent:agent-1:main",
        avatarSeed: "persisted-seed",
        avatarUrl: "https://example.com/one.png",
        model: "openai/gpt-4.1",
        thinkingLevel: "medium",
        sessionExecHost: "gateway",
        sessionExecSecurity: "allowlist",
        sessionExecAsk: "always",
      })
    );
    expect(result.seeds[1]).toEqual(
      expect.objectContaining({
        agentId: "agent-2",
        sessionExecHost: "gateway",
        sessionExecSecurity: "full",
        sessionExecAsk: "off",
      })
    );
    expect(result.sessionCreatedAgentIds).toEqual(["agent-1", "agent-2"]);
    expect(result.sessionSettingsSyncedAgentIds).toEqual([]);
    expect(result.suggestedSelectedAgentId).toBe("agent-2");
    expect(result.summaryPatches.length).toBeGreaterThan(0);
  });

  it("hydrates many agents with one sessions.list call", async () => {
    const agentCount = 25;
    const agents = Array.from({ length: agentCount }, (_, index) => ({
      id: `agent-${index + 1}`,
      name: `Agent ${index + 1}`,
      identity: { avatarUrl: `https://example.com/${index + 1}.png` },
    }));
    const sessions = agents.map((agent) => ({
      key: `agent:${agent.id}:main`,
      updatedAt: 1,
      displayName: `${agent.name} Main`,
      thinkingLevel: "medium",
      modelProvider: "openai",
      model: "gpt-5",
    }));
    const call = vi.fn(async (method: string, params: unknown) => {
      if (method === "agents.list") {
        return {
          defaultId: "agent-1",
          mainKey: "main",
          agents,
        };
      }
      if (method === "sessions.list") {
        const query = params as Record<string, unknown>;
        expect(query).toEqual({
          includeGlobal: false,
          includeUnknown: false,
          search: ":main",
        });
        return { sessions };
      }
      if (method === "exec.approvals.get") {
        return { file: { agents: {} } };
      }
      if (method === "status") {
        return {
          sessions: {
            recent: [],
            byAgent: [],
          },
        };
      }
      if (method === "sessions.preview") {
        expect(params).toEqual({
          keys: sessions.map((entry) => entry.key),
          limit: 8,
          maxChars: 240,
        });
        return {
          ts: 1,
          previews: sessions.map((entry) => ({
            key: entry.key,
            status: "ok",
            items: [{ role: "assistant", text: "ok", timestamp: "2026-03-01T00:00:00Z" }],
          })),
        };
      }
      if (method === "config.get") {
        return {
          hash: "hash-many",
          config: { agents: { defaults: { model: "openai/gpt-5" }, list: [] } },
        };
      }
      throw new Error(`Unhandled method: ${method}`);
    });

    const result = await hydrateAgentFleetFromGateway({
      client: { call },
      gatewayUrl: "ws://127.0.0.1:18789",
      cachedConfigSnapshot: null,
      loadStudioSettings: async () => ({
        version: 1,
        gateway: null,
        gatewayAutoStart: true,
        focused: {},
        avatars: {},
      }),
      isDisconnectLikeError: () => false,
    });

    expect(call.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(1);
    expect(result.seeds).toHaveLength(agentCount);
    expect(result.sessionCreatedAgentIds).toHaveLength(agentCount);
    expect(result.sessionSettingsSyncedAgentIds).toHaveLength(agentCount);
  });

  it("filters malformed gateway agent ids before listing previews", async () => {
    const call = vi.fn(async (method: string, params: unknown) => {
      if (method === "agents.list") {
        return {
          defaultId: "../agent-1",
          mainKey: "main",
          agents: [
            { id: "../agent-1", name: "Bad" },
            { id: " agent-1 ", name: "One" },
            { id: "AGENT-1", name: "Duplicate" },
          ],
        };
      }
      if (method === "sessions.list") {
        expect(params).toEqual({
          includeGlobal: false,
          includeUnknown: false,
          search: ":main",
        });
        return {
          sessions: [
            { key: "agent:../agent-1:main", modelProvider: "openai", model: "bad" },
            { key: "agent:agent-1:main", modelProvider: "openai", model: "gpt-5" },
          ],
        };
      }
      if (method === "exec.approvals.get") {
        return { file: { agents: {} } };
      }
      if (method === "status") {
        return { sessions: { recent: [], byAgent: [] } };
      }
      if (method === "sessions.preview") {
        expect(params).toEqual({
          keys: ["agent:agent-1:main"],
          limit: 8,
          maxChars: 240,
        });
        return {
          ts: 1,
          previews: [
            {
              key: "agent:agent-1:main",
              status: "ok",
              items: [{ role: "assistant", text: "ok", timestamp: 1 }],
            },
          ],
        };
      }
      if (method === "config.get") {
        return {
          hash: "hash-safe",
          config: { agents: { defaults: { model: "openai/gpt-5" }, list: [] } },
        };
      }
      throw new Error(`Unhandled method: ${method}`);
    });

    const result = await hydrateAgentFleetFromGateway({
      client: { call },
      gatewayUrl: "ws://127.0.0.1:18789",
      cachedConfigSnapshot: null,
      loadStudioSettings: async () => ({
        version: 1,
        gateway: null,
        gatewayAutoStart: true,
        focused: {},
        avatars: {},
      }),
      isDisconnectLikeError: () => false,
    });

    expect(result.seeds.map((seed) => seed.agentId)).toEqual(["agent-1"]);
    expect(result.sessionCreatedAgentIds).toEqual(["agent-1"]);
  });

  it("returns safely when batched sessions.list fails", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "agents.list") {
        return {
          defaultId: "agent-1",
          mainKey: "main",
          agents: [
            { id: "agent-1", name: "One" },
            { id: "agent-2", name: "Two" },
          ],
        };
      }
      if (method === "sessions.list") {
        throw new Error("sessions list failed");
      }
      if (method === "exec.approvals.get") {
        return { file: { agents: {} } };
      }
      if (method === "config.get") {
        return {
          hash: "hash-failure",
          config: { agents: { defaults: { model: "openai/gpt-5" }, list: [] } },
        };
      }
      throw new Error(`Unhandled method: ${method}`);
    });
    const logError = vi.fn();

    const result = await hydrateAgentFleetFromGateway({
      client: { call },
      gatewayUrl: "ws://127.0.0.1:18789",
      cachedConfigSnapshot: null,
      loadStudioSettings: async () => ({
        version: 1,
        gateway: null,
        gatewayAutoStart: true,
        focused: {},
        avatars: {},
      }),
      isDisconnectLikeError: () => false,
      logError,
    });

    expect(call.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(1);
    expect(logError).toHaveBeenCalledWith(
      "Failed to list sessions while resolving fleet sessions.",
      expect.any(Error)
    );
    expect(result.sessionCreatedAgentIds).toEqual([]);
    expect(result.sessionSettingsSyncedAgentIds).toEqual([]);
    expect(result.summaryPatches).toEqual([]);
    expect(result.suggestedSelectedAgentId).toBeNull();
    expect(result.seeds).toHaveLength(2);
  });

  it("skips sessions.list when no agents are returned", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "agents.list") {
        return {
          defaultId: "main",
          mainKey: "main",
          agents: [],
        };
      }
      if (method === "exec.approvals.get") {
        return { file: { agents: {} } };
      }
      if (method === "config.get") {
        return {
          hash: "hash-empty",
          config: { agents: { defaults: { model: "openai/gpt-5" }, list: [] } },
        };
      }
      throw new Error(`Unhandled method: ${method}`);
    });

    const result = await hydrateAgentFleetFromGateway({
      client: { call },
      gatewayUrl: "ws://127.0.0.1:18789",
      cachedConfigSnapshot: null,
      loadStudioSettings: async () => ({
        version: 1,
        gateway: null,
        gatewayAutoStart: true,
        focused: {},
        avatars: {},
      }),
      isDisconnectLikeError: () => false,
    });

    expect(call.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(0);
    expect(result.seeds).toEqual([]);
    expect(result.sessionCreatedAgentIds).toEqual([]);
    expect(result.sessionSettingsSyncedAgentIds).toEqual([]);
    expect(result.summaryPatches).toEqual([]);
    expect(result.suggestedSelectedAgentId).toBeNull();
  });
});
