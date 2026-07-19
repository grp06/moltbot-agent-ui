// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlaneGatewayConnectError } from "@/lib/controlplane/openclaw-adapter";

type RuntimeMock = {
  ensureStarted: () => Promise<void>;
  snapshot: () => { status: string; reason: string | null; asOf: string | null; outboxHead: number };
  eventsAfter: (lastSeenId: number, limit?: number) => Array<{
    id: number;
    event: unknown;
    createdAt: string;
  }>;
  eventsBefore: (beforeOutboxId: number, limit?: number) => Array<{
    id: number;
    event: unknown;
    createdAt: string;
  }>;
  eventsBeforeForAgent: (agentId: string, beforeOutboxId: number, limit?: number) => Array<{
    id: number;
    event: unknown;
    createdAt: string;
  }>;
  backfillAgentHistoryIndex: (
    beforeOutboxId: number,
    limit?: number
  ) => { scannedRows: number; updatedRows: number; exhausted: boolean };
  subscribe: (handler: (entry: { id: number; event: unknown; createdAt: string }) => void) => () => void;
  callGateway?: <T = unknown>(method: string, params: unknown) => Promise<T>;
};

const loadRouteModule = async <T>(modulePath: string, runtimeMock: RuntimeMock) => {
  vi.resetModules();
  vi.doMock("@/lib/controlplane/runtime", () => ({
    isStudioDomainApiModeEnabled: () => true,
    getControlPlaneRuntime: () => runtimeMock,
  }));
  return await import(modulePath) as T;
};

const readStreamUntil = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  maxReads: number = 20
): Promise<string> => {
  let output = "";
  const decoder = new TextDecoder();
  for (let index = 0; index < maxReads; index += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += decoder.decode(chunk.value);
    if (predicate(output)) break;
  }
  return output;
};

describe("runtime routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("summary route returns projection-backed snapshot and freshness", async () => {
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 12,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
    };

    const mod = await loadRouteModule<{ GET: () => Promise<Response> }>(
      "@/app/api/runtime/summary/route",
      runtimeMock
    );
    const response = await mod.GET();
    expect(response.status).toBe(200);
    const body = await response.json() as {
      enabled: boolean;
      summary: { status: string; outboxHead: number };
      freshness: { stale: boolean; source: string };
    };
    expect(body.enabled).toBe(true);
    expect(body.summary.status).toBe("connected");
    expect(body.summary.outboxHead).toBe(12);
    expect(body.freshness.stale).toBe(false);
    expect(body.freshness.source).toBe("gateway");
  });

  it("agent-file route rejects unsupported file names before gateway reads", async () => {
    const callGateway = vi.fn();
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 12,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
      callGateway: callGateway as RuntimeMock["callGateway"],
    };
    const mod = await loadRouteModule<{ GET: (request: Request) => Promise<Response> }>(
      "@/app/api/runtime/agent-file/route",
      runtimeMock
    );

    const response = await mod.GET(
      new Request("http://localhost/api/runtime/agent-file?agentId=agent-1&name=../profile.json")
    );
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("Unsupported agent file name");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("per-agent runtime routes reject malformed agent ids before gateway reads", async () => {
    const callGateway = vi.fn(async () => ({ previews: [], messages: [] }));
    const ensureStarted = vi.fn(async () => {});
    const runtimeMock: RuntimeMock = {
      ensureStarted,
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 12,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
      callGateway: callGateway as RuntimeMock["callGateway"],
    };
    const agentFileRoute = await loadRouteModule<{ GET: (request: Request) => Promise<Response> }>(
      "@/app/api/runtime/agent-file/route",
      runtimeMock
    );
    const historyRoute = await loadRouteModule<{
      GET: (
        request: Request,
        context: { params: Promise<{ agentId: string }> }
      ) => Promise<Response>;
    }>("@/app/api/runtime/agents/[agentId]/history/route", runtimeMock);
    const previewRoute = await loadRouteModule<{
      GET: (
        request: Request,
        context: { params: Promise<{ agentId: string }> }
      ) => Promise<Response>;
    }>("@/app/api/runtime/agents/[agentId]/preview/route", runtimeMock);

    const invalidAgentId = "../agent-1";
    const fileResponse = await agentFileRoute.GET(
      new Request(
        `http://localhost/api/runtime/agent-file?agentId=${encodeURIComponent(invalidAgentId)}&name=AGENTS.md`
      )
    );
    const historyResponse = await historyRoute.GET(
      new Request("http://localhost/api/runtime/agents/..%2Fagent-1/history"),
      { params: Promise.resolve({ agentId: invalidAgentId }) }
    );
    const previewResponse = await previewRoute.GET(
      new Request("http://localhost/api/runtime/agents/..%2Fagent-1/preview"),
      { params: Promise.resolve({ agentId: invalidAgentId }) }
    );

    expect(fileResponse.status).toBe(400);
    expect(historyResponse.status).toBe(400);
    expect(previewResponse.status).toBe(400);
    expect(ensureStarted).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("summary route returns degraded projection freshness when gateway start fails", async () => {
    vi.resetModules();
    vi.doMock("@/lib/controlplane/runtime", () => ({
      isStudioDomainApiModeEnabled: () => true,
      getControlPlaneRuntime: () => ({
        ensureStarted: async () => {
          throw new Error("gateway offline");
        },
        snapshot: () => ({
          status: "error",
          reason: "gateway_closed",
          asOf: "2026-02-28T02:40:00.000Z",
          outboxHead: 9,
        }),
        eventsAfter: () => [],
        eventsBefore: () => [],
        eventsBeforeForAgent: () => [],
        backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
        subscribe: () => () => {},
      }),
    }));
    vi.doMock("@/lib/controlplane/degraded-read", async () => {
      const actual = await vi.importActual<typeof import("@/lib/controlplane/degraded-read")>(
        "@/lib/controlplane/degraded-read"
      );
      return {
        ...actual,
        probeOpenClawLocalState: vi.fn(async () => ({
          at: "2026-02-28T02:41:00.000Z",
          status: { ok: false, error: "openclaw_cli_not_found" },
          sessions: { ok: false, error: "openclaw_cli_not_found" },
        })),
      };
    });

    const mod = await import("@/app/api/runtime/summary/route");
    const response = await mod.GET();
    expect(response.status).toBe(200);
    const body = await response.json() as {
      error?: string;
      freshness: { stale: boolean; source: string; reason: string | null };
    };
    expect(body.error).toBe("gateway offline");
    expect(body.freshness.stale).toBe(true);
    expect(body.freshness.source).toBe("projection");
    expect(body.freshness.reason).toBe("gateway_unavailable");
  });

  it("summary route includes structured start failure metadata when startup fails with connect metadata", async () => {
    vi.resetModules();
    vi.doMock("@/lib/controlplane/runtime", () => ({
      isStudioDomainApiModeEnabled: () => true,
      getControlPlaneRuntime: () => ({
        ensureStarted: async () => {
          throw new ControlPlaneGatewayConnectError({
            code: "INVALID_REQUEST",
            message:
              "Control-plane connect rejected: INVALID_REQUEST control ui requires device identity (use HTTPS or localhost secure context)",
            profileId: "legacy-control-ui",
            details: { code: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED" },
            rejectedByGateway: true,
          });
        },
        snapshot: () => ({
          status: "error",
          reason: "gateway_closed",
          asOf: "2026-02-28T02:40:00.000Z",
          outboxHead: 9,
        }),
        eventsAfter: () => [],
        eventsBefore: () => [],
        eventsBeforeForAgent: () => [],
        backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
        subscribe: () => () => {},
      }),
    }));

    const mod = await import("@/app/api/runtime/summary/route");
    const response = await mod.GET();
    expect(response.status).toBe(200);
    const body = await response.json() as {
      error?: string;
      startFailure?: {
        code?: string;
        message?: string;
        profileId?: string;
        details?: unknown;
      };
    };
    expect(body.error).toContain("control ui requires device identity");
    expect(body.startFailure).toEqual({
      code: "INVALID_REQUEST",
      message:
        "Control-plane connect rejected: INVALID_REQUEST control ui requires device identity (use HTTPS or localhost secure context)",
      profileId: "legacy-control-ui",
      details: { code: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED" },
    });
  });

  it("summary route returns 503 when runtime initialization fails", async () => {
    vi.resetModules();
    vi.doMock("@/lib/controlplane/runtime", () => ({
      isStudioDomainApiModeEnabled: () => true,
      getControlPlaneRuntime: () => {
        throw new Error("runtime init failed");
      },
    }));

    const mod = await import("@/app/api/runtime/summary/route");
    const response = await mod.GET();
    expect(response.status).toBe(503);
    const body = await response.json() as {
      enabled: boolean;
      error: string;
      code: string;
      reason: string;
    };
    expect(body.enabled).toBe(true);
    expect(body.error).toBe("runtime init failed");
    expect(body.code).toBe("CONTROLPLANE_RUNTIME_INIT_FAILED");
    expect(body.reason).toBe("runtime_init_failed");
  });

  it("summary route returns native mismatch remediation when runtime init fails on ABI drift", async () => {
    vi.resetModules();
    vi.doMock("@/lib/controlplane/runtime", () => ({
      isStudioDomainApiModeEnabled: () => true,
      getControlPlaneRuntime: () => {
        const error = new Error(
          "The module '/tmp/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 141."
        ) as Error & { code: string };
        error.code = "ERR_DLOPEN_FAILED";
        throw error;
      },
    }));

    const mod = await import("@/app/api/runtime/summary/route");
    const response = await mod.GET();
    expect(response.status).toBe(503);
    const body = await response.json() as {
      code: string;
      reason: string;
      remediation?: { commands?: string[] };
    };
    expect(body.code).toBe("NATIVE_MODULE_MISMATCH");
    expect(body.reason).toBe("native_module_mismatch");
    expect(body.remediation?.commands).toEqual([
      "npm rebuild better-sqlite3",
      "npm install",
    ]);
  });

  it("summary route returns 404 when domain mode is disabled", async () => {
    vi.resetModules();
    vi.doMock("@/lib/controlplane/runtime", () => ({
      isStudioDomainApiModeEnabled: () => false,
      getControlPlaneRuntime: vi.fn(),
    }));

    const mod = await import("@/app/api/runtime/summary/route");
    const response = await mod.GET();
    expect(response.status).toBe(404);
    const body = await response.json() as { enabled: boolean; error: string };
    expect(body.enabled).toBe(false);
    expect(body.error).toBe("domain_api_mode_disabled");
  });

  it("agent history route reads chat.history and emits message history", async () => {
    const callGateway = vi.fn().mockResolvedValue({
      messages: [
        {
          role: "user",
          timestamp: "2026-02-28T02:40:01.000Z",
          content: "hello",
        },
        {
          role: "assistant",
          timestamp: "2026-02-28T02:40:02.000Z",
          content: "hi there",
        },
      ],
    });
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 10,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
      callGateway,
    };

    const mod = await loadRouteModule<{
      GET: (
        request: Request,
        context: { params: Promise<{ agentId: string }> }
      ) => Promise<Response>;
    }>("@/app/api/runtime/agents/[agentId]/history/route", runtimeMock);

    const response = await mod.GET(
      new Request(
        "http://localhost/api/runtime/agents/alpha/history?view=raw&limit=2&sessionKey=agent:alpha:main"
      ),
      { params: Promise.resolve({ agentId: "alpha" }) }
    );
    expect(response.status).toBe(200);
    expect(callGateway).toHaveBeenCalledWith("chat.history", {
      sessionKey: "agent:alpha:main",
      limit: 2,
    });
    const body = (await response.json()) as {
      messages: Array<{ role: string }>;
      hasMore: boolean;
      semanticTurnsIncluded: number;
      gatewayLimit: number;
      gatewayCapped: boolean;
    };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.role).toBe("user");
    expect(body.hasMore).toBe(true);
    expect(body.semanticTurnsIncluded).toBe(2);
    expect(body.gatewayLimit).toBe(2);
    expect(body.gatewayCapped).toBe(false);
  });

  it("agent history route defaults sessionKey and applies semantic turn windowing", async () => {
    const callGateway = vi.fn().mockResolvedValue({
      messages: [
        { role: "user", content: "u1", timestamp: "2026-02-28T02:40:01.000Z" },
        { role: "assistant", content: "a1", timestamp: "2026-02-28T02:40:02.000Z" },
        { role: "user", content: "u2", timestamp: "2026-02-28T02:40:03.000Z" },
        { role: "assistant", content: "a2", timestamp: "2026-02-28T02:40:04.000Z" },
      ],
    });
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 10,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
      callGateway,
    };

    const mod = await loadRouteModule<{
      GET: (
        request: Request,
        context: { params: Promise<{ agentId: string }> }
      ) => Promise<Response>;
    }>("@/app/api/runtime/agents/[agentId]/history/route", runtimeMock);

    const response = await mod.GET(
      new Request("http://localhost/api/runtime/agents/alpha/history?view=semantic&turnLimit=2&scanLimit=4"),
      { params: Promise.resolve({ agentId: "alpha" }) }
    );
    expect(response.status).toBe(200);
    expect(callGateway).toHaveBeenCalledWith("chat.history", {
      sessionKey: "agent:alpha:main",
      limit: 4,
    });
    const body = (await response.json()) as {
      messages: Array<{ content: string }>;
      hasMore: boolean;
      semanticTurnsIncluded: number;
      windowTruncated: boolean;
      gatewayLimit: number;
      gatewayCapped: boolean;
    };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.content).toBe("u2");
    expect(body.messages[1]?.content).toBe("a2");
    expect(body.hasMore).toBe(true);
    expect(body.windowTruncated).toBe(true);
    expect(body.semanticTurnsIncluded).toBe(2);
    expect(body.gatewayLimit).toBe(4);
    expect(body.gatewayCapped).toBe(false);
  });

  it("agent history route rejects session keys for another agent", async () => {
    const callGateway = vi.fn().mockResolvedValue({ messages: [] });
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 10,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
      callGateway,
    };

    const mod = await loadRouteModule<{
      GET: (
        request: Request,
        context: { params: Promise<{ agentId: string }> }
      ) => Promise<Response>;
    }>("@/app/api/runtime/agents/[agentId]/history/route", runtimeMock);

    const response = await mod.GET(
      new Request(
        "http://localhost/api/runtime/agents/alpha/history?sessionKey=agent:beta:main"
      ),
      { params: Promise.resolve({ agentId: "alpha" }) }
    );
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("sessionKey does not match agentId.");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("agent history route rejects malformed explicit session keys", async () => {
    const callGateway = vi.fn().mockResolvedValue({ messages: [] });
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 10,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
      callGateway,
    };

    const mod = await loadRouteModule<{
      GET: (
        request: Request,
        context: { params: Promise<{ agentId: string }> }
      ) => Promise<Response>;
    }>("@/app/api/runtime/agents/[agentId]/history/route", runtimeMock);

    const response = await mod.GET(
      new Request(
        "http://localhost/api/runtime/agents/alpha/history?sessionKey=main"
      ),
      { params: Promise.resolve({ agentId: "alpha" }) }
    );
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("sessionKey does not match agentId.");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("agent history route can return compact semantic conversation without thinking/tool payload", async () => {
    const callGateway = vi.fn().mockResolvedValue({
      messages: [
        { role: "user", content: "u1", timestamp: "2026-02-28T02:40:01.000Z" },
        {
          role: "assistant",
          timestamp: "2026-02-28T02:40:02.000Z",
          content: [
            { type: "text", text: "a1" },
            { type: "toolCall", id: "call-1", name: "exec", arguments: { cmd: "ls" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "exec",
          content: [{ type: "text", text: "ok" }],
        },
        { role: "user", content: "u2", timestamp: "2026-02-28T02:40:03.000Z" },
        {
          role: "assistant",
          timestamp: "2026-02-28T02:40:04.000Z",
          content: [
            { type: "thinking", text: "plan" },
            { type: "text", text: "a2" },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call-2",
          toolName: "exec",
          content: [{ type: "text", text: "done" }],
        },
      ],
    });
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 10,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
      callGateway,
    };

    const mod = await loadRouteModule<{
      GET: (
        request: Request,
        context: { params: Promise<{ agentId: string }> }
      ) => Promise<Response>;
    }>("@/app/api/runtime/agents/[agentId]/history/route", runtimeMock);

    const response = await mod.GET(
      new Request(
        "http://localhost/api/runtime/agents/alpha/history?view=semantic&turnLimit=2&scanLimit=6&includeThinking=0&includeTools=0"
      ),
      { params: Promise.resolve({ agentId: "alpha" }) }
    );
    expect(response.status).toBe(200);
    expect(callGateway).toHaveBeenCalledWith("chat.history", {
      sessionKey: "agent:alpha:main",
      limit: 6,
    });

    const body = (await response.json()) as {
      messages: Array<Record<string, unknown>>;
      semanticTurnsIncluded: number;
      windowTruncated: boolean;
      hasMore: boolean;
    };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({ role: "user", content: "u2" });
    expect(body.messages[1]).toMatchObject({ role: "assistant", content: "a2" });
    expect(body.semanticTurnsIncluded).toBe(2);
    expect(body.windowTruncated).toBe(true);
    expect(body.hasMore).toBe(true);
  });

  it("agent history route reuses cached payload when agent revision is unchanged", async () => {
    const callGateway = vi.fn().mockResolvedValue({
      messages: [
        { role: "user", content: "u1", timestamp: "2026-02-28T02:40:01.000Z" },
        { role: "assistant", content: "a1", timestamp: "2026-02-28T02:40:02.000Z" },
      ],
    });
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 24,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [
        {
          id: 24,
          event: { type: "gateway.event", event: "agent" },
          createdAt: "2026-02-28T02:40:00.000Z",
        },
      ],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
      callGateway,
    };

    const mod = await loadRouteModule<{
      GET: (
        request: Request,
        context: { params: Promise<{ agentId: string }> }
      ) => Promise<Response>;
    }>("@/app/api/runtime/agents/[agentId]/history/route", runtimeMock);

    const request = new Request(
      "http://localhost/api/runtime/agents/alpha/history?view=raw&limit=2&sessionKey=agent:alpha:main"
    );
    const firstResponse = await mod.GET(request, {
      params: Promise.resolve({ agentId: "alpha" }),
    });
    const secondResponse = await mod.GET(request, {
      params: Promise.resolve({ agentId: "alpha" }),
    });

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(callGateway).toHaveBeenCalledTimes(1);

    const body = (await secondResponse.json()) as {
      messages: Array<{ content: string }>;
      hasMore: boolean;
      semanticTurnsIncluded: number;
      windowTruncated: boolean;
      gatewayLimit: number;
      gatewayCapped: boolean;
    };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.content).toBe("u1");
    expect(body.messages[1]?.content).toBe("a1");
    expect(body.hasMore).toBe(true);
    expect(body.semanticTurnsIncluded).toBe(2);
    expect(body.windowTruncated).toBe(true);
    expect(body.gatewayLimit).toBe(2);
    expect(body.gatewayCapped).toBe(false);
  });

  it("agent history route reports a non-negative age for coalesced cache reads", async () => {
    let resolveHistory!: (value: {
      messages: Array<{ role: string; content: string; timestamp: string }>;
    }) => void;
    const historyPromise = new Promise<{
      messages: Array<{ role: string; content: string; timestamp: string }>;
    }>((resolve) => {
      resolveHistory = resolve;
    });
    const callGateway = vi.fn().mockReturnValue(historyPromise);
    let nowMs = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 32,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [
        {
          id: 32,
          event: { type: "gateway.event", event: "agent" },
          createdAt: "2026-02-28T02:40:00.000Z",
        },
      ],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
      callGateway,
    };

    const mod = await loadRouteModule<{
      GET: (
        request: Request,
        context: { params: Promise<{ agentId: string }> }
      ) => Promise<Response>;
    }>("@/app/api/runtime/agents/[agentId]/history/route", runtimeMock);

    const requestUrl =
      "http://localhost/api/runtime/agents/alpha/history?view=raw&limit=2&sessionKey=agent:alpha:main";
    const firstResponsePromise = mod.GET(new Request(requestUrl), {
      params: Promise.resolve({ agentId: "alpha" }),
    });
    await vi.waitFor(() => expect(callGateway).toHaveBeenCalledTimes(1));

    nowMs = 1_005;
    const secondResponsePromise = mod.GET(new Request(requestUrl), {
      params: Promise.resolve({ agentId: "alpha" }),
    });
    await vi.waitFor(() => expect(callGateway).toHaveBeenCalledTimes(1));

    nowMs = 1_020;
    resolveHistory({
      messages: [
        { role: "user", content: "u1", timestamp: "2026-02-28T02:40:01.000Z" },
        { role: "assistant", content: "a1", timestamp: "2026-02-28T02:40:02.000Z" },
      ],
    });
    const [firstResponse, secondResponse] = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(callGateway).toHaveBeenCalledTimes(1);

    const firstBody = (await firstResponse.json()) as {
      cacheStatus: string;
      cacheAgeMs: number | null;
    };
    const secondBody = (await secondResponse.json()) as {
      cacheStatus: string;
      cacheAgeMs: number | null;
    };
    expect(firstBody.cacheStatus).toBe("miss");
    expect(firstBody.cacheAgeMs).toBe(0);
    expect(secondBody.cacheStatus).toBe("coalesced");
    expect(secondBody.cacheAgeMs).toBe(0);
  });

  it("agent history route does not reuse cache entries across gateway credentials", async () => {
    const gatewayUrl = "ws://gateway.example/ws";
    let gatewayToken = "token-one";
    vi.doMock("@/lib/studio/settings-store", () => ({
      loadStudioSettings: () => ({
        version: 1,
        gateway: { url: gatewayUrl, token: gatewayToken },
        localGatewayDefaults: { url: "", token: "" },
        focused: {},
        avatars: {},
      }),
    }));
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ role: "assistant", content: "from-one" }],
      })
      .mockResolvedValueOnce({
        messages: [{ role: "assistant", content: "from-two" }],
      });
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 24,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [
        {
          id: 24,
          event: { type: "gateway.event", event: "agent" },
          createdAt: "2026-02-28T02:40:00.000Z",
        },
      ],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
      callGateway,
    };

    try {
      const mod = await loadRouteModule<{
        GET: (
          request: Request,
          context: { params: Promise<{ agentId: string }> }
        ) => Promise<Response>;
      }>("@/app/api/runtime/agents/[agentId]/history/route", runtimeMock);

      const request = new Request(
        "http://localhost/api/runtime/agents/alpha/history?view=raw&limit=2&sessionKey=agent:alpha:main"
      );
      const firstResponse = await mod.GET(request, {
        params: Promise.resolve({ agentId: "alpha" }),
      });
      gatewayToken = "token-two";
      const secondResponse = await mod.GET(request, {
        params: Promise.resolve({ agentId: "alpha" }),
      });

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(callGateway).toHaveBeenCalledTimes(2);
      const body = (await secondResponse.json()) as { messages: Array<{ content: string }> };
      expect(body.messages[0]?.content).toBe("from-two");
    } finally {
      vi.doUnmock("@/lib/studio/settings-store");
    }
  });

  it("agent history route refreshes payload when agent revision advances", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [
          { role: "user", content: "u-old", timestamp: "2026-02-28T02:40:01.000Z" },
          { role: "assistant", content: "a-old", timestamp: "2026-02-28T02:40:02.000Z" },
        ],
      })
      .mockResolvedValueOnce({
        messages: [
          { role: "user", content: "u-new", timestamp: "2026-02-28T02:40:03.000Z" },
          { role: "assistant", content: "a-new", timestamp: "2026-02-28T02:40:04.000Z" },
        ],
      });
    let agentRevision = 24;
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 24,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [
        {
          id: agentRevision,
          event: { type: "gateway.event", event: "agent" },
          createdAt: "2026-02-28T02:40:00.000Z",
        },
      ],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
      callGateway,
    };

    const mod = await loadRouteModule<{
      GET: (
        request: Request,
        context: { params: Promise<{ agentId: string }> }
      ) => Promise<Response>;
    }>("@/app/api/runtime/agents/[agentId]/history/route", runtimeMock);

    const request = new Request(
      "http://localhost/api/runtime/agents/alpha/history?view=raw&limit=2&sessionKey=agent:alpha:main"
    );
    const firstResponse = await mod.GET(request, {
      params: Promise.resolve({ agentId: "alpha" }),
    });
    expect(firstResponse.status).toBe(200);
    agentRevision = 25;
    const secondResponse = await mod.GET(request, {
      params: Promise.resolve({ agentId: "alpha" }),
    });
    expect(secondResponse.status).toBe(200);
    expect(callGateway).toHaveBeenCalledTimes(2);

    const body = (await secondResponse.json()) as { messages: Array<{ content: string }> };
    expect(body.messages[0]?.content).toBe("u-new");
    expect(body.messages[1]?.content).toBe("a-new");
  });

  it("stream route replays from Last-Event-ID and emits live updates", async () => {
    let subscriber: ((entry: { id: number; event: unknown; createdAt: string }) => void) | null = null;
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 4,
      }),
      eventsAfter: (lastSeenId: number) => {
        expect(lastSeenId).toBe(2);
        return [
          {
            id: 3,
            event: {
              type: "gateway.event",
              event: "runtime.delta",
              seq: 20,
              payload: { sessionKey: "agent:alpha:main", delta: "replay" },
              asOf: "2026-02-28T02:40:03.000Z",
            },
            createdAt: "2026-02-28T02:40:03.000Z",
          },
        ];
      },
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: (handler) => {
        subscriber = handler;
        return () => {
          subscriber = null;
        };
      },
    };

    const mod = await loadRouteModule<{ GET: (request: Request) => Promise<Response> }>(
      "@/app/api/runtime/stream/route",
      runtimeMock
    );
    const response = await mod.GET(
      new Request("http://localhost/api/runtime/stream", {
        headers: { "Last-Event-ID": "2" },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();
    const first = await reader.read();
    const firstChunk = new TextDecoder().decode(first.value);
    expect(firstChunk).toContain("id: 3");
    expect(firstChunk).toContain("event: gateway.event");

    const emit = subscriber as ((entry: { id: number; event: unknown; createdAt: string }) => void) | null;
    emit?.({
      id: 4,
      event: {
        type: "runtime.status",
        status: "reconnecting",
        reason: "gateway_closed",
        asOf: "2026-02-28T02:40:04.000Z",
      },
      createdAt: "2026-02-28T02:40:04.000Z",
    });

    const second = await reader.read();
    const secondChunk = new TextDecoder().decode(second.value);
    expect(secondChunk).toContain("id: 4");
    expect(secondChunk).toContain("event: runtime.status");

    await reader.cancel();
    expect(subscriber).toBeNull();
  });

  it("stream route does not subscribe when the request is already aborted", async () => {
    const subscribe = vi.fn(() => () => {});
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 4,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe,
    };

    const mod = await loadRouteModule<{ GET: (request: Request) => Promise<Response> }>(
      "@/app/api/runtime/stream/route",
      runtimeMock
    );
    const abortController = new AbortController();
    abortController.abort();
    const response = await mod.GET(
      new Request("http://localhost/api/runtime/stream", {
        signal: abortController.signal,
      })
    );

    expect(response.status).toBe(200);
    expect(subscribe).not.toHaveBeenCalled();
    const reader = response.body!.getReader();
    const result = await reader.read();
    expect(result.done).toBe(true);
  });

  it("stream route replays reconnect backlog across multiple pages when missed rows exceed replay limit", async () => {
    const subscriberRef: {
      current: ((entry: { id: number; event: unknown; createdAt: string }) => void) | null;
    } = { current: null };
    const eventsAfterCalls: number[] = [];
    const makeDeltaEntry = (id: number) => ({
      id,
      event: {
        type: "gateway.event" as const,
        event: "runtime.delta",
        seq: id,
        payload: { sessionKey: "agent:alpha:main", index: id },
        asOf: "2026-02-28T02:40:03.000Z",
      },
      createdAt: "2026-02-28T02:40:03.000Z",
    });
    const firstPage = Array.from({ length: 2_000 }, (_value, index) => makeDeltaEntry(index + 3));
    const secondPage = [2_003, 2_004, 2_005].map(makeDeltaEntry);

    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 2_005,
      }),
      eventsAfter: (lastSeenId: number, limit?: number) => {
        eventsAfterCalls.push(lastSeenId);
        expect(limit).toBe(2_000);
        if (lastSeenId === 2) {
          return firstPage;
        }
        if (lastSeenId === 2_002) {
          return secondPage;
        }
        return [];
      },
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: (handler) => {
        subscriberRef.current = handler;
        return () => {
          subscriberRef.current = null;
        };
      },
    };

    const mod = await loadRouteModule<{ GET: (request: Request) => Promise<Response> }>(
      "@/app/api/runtime/stream/route",
      runtimeMock
    );
    const response = await mod.GET(
      new Request("http://localhost/api/runtime/stream", {
        headers: { "Last-Event-ID": "2" },
      })
    );
    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();
    const output = await readStreamUntil(reader, (text) => text.includes("id: 2005"), 2_500);
    expect(eventsAfterCalls).toEqual([2, 2_002]);
    expect(output).toContain("id: 2005");
    await reader.cancel();
  });

  it("stream route clamps reconnect cursor when Last-Event-ID is ahead of current outbox head", async () => {
    const subscriberRef: {
      current: ((entry: { id: number; event: unknown; createdAt: string }) => void) | null;
    } = { current: null };
    const eventsAfterCalls: number[] = [];
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 5,
      }),
      eventsAfter: (lastSeenId: number, limit?: number) => {
        eventsAfterCalls.push(lastSeenId);
        expect(limit).toBe(2_000);
        return [];
      },
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: (handler) => {
        subscriberRef.current = handler;
        return () => {
          subscriberRef.current = null;
        };
      },
    };

    const mod = await loadRouteModule<{ GET: (request: Request) => Promise<Response> }>(
      "@/app/api/runtime/stream/route",
      runtimeMock
    );
    const response = await mod.GET(
      new Request("http://localhost/api/runtime/stream", {
        headers: { "Last-Event-ID": "999" },
      })
    );
    expect(response.status).toBe(200);
    expect(eventsAfterCalls).toEqual([5]);
    expect(response.body).toBeTruthy();

    const emit = subscriberRef.current;
    if (!emit) {
      throw new Error("expected runtime stream subscriber to be attached");
    }
    emit({
      id: 6,
      event: {
        type: "runtime.status",
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:06.000Z",
      },
      createdAt: "2026-02-28T02:40:06.000Z",
    });

    const reader = response.body!.getReader();
    const output = await readStreamUntil(reader, (text) => text.includes("id: 6"));
    expect(output).toContain("id: 6");
    await reader.cancel();
  });

  it("stream route does not drop rows committed between reconnect replay and live subscribe", async () => {
    const subscriberRef: {
      current: ((entry: { id: number; event: unknown; createdAt: string }) => void) | null;
    } = { current: null };
    const replayBackedOutbox: Array<{ id: number; event: unknown; createdAt: string }> = [
      {
        id: 3,
        event: {
          type: "gateway.event",
          event: "runtime.delta",
          seq: 20,
          payload: { sessionKey: "agent:alpha:main", delta: "replay" },
          asOf: "2026-02-28T02:40:03.000Z",
        },
        createdAt: "2026-02-28T02:40:03.000Z",
      },
    ];
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 4,
      }),
      eventsAfter: (lastSeenId: number) => {
        expect(lastSeenId).toBe(2);
        return replayBackedOutbox.filter((entry) => entry.id > lastSeenId);
      },
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: (handler) => {
        replayBackedOutbox.push({
          id: 4,
          event: {
            type: "gateway.event",
            event: "runtime.delta",
            seq: 21,
            payload: { sessionKey: "agent:alpha:main", delta: "committed-during-startup" },
            asOf: "2026-02-28T02:40:04.000Z",
          },
          createdAt: "2026-02-28T02:40:04.000Z",
        });
        subscriberRef.current = handler;
        return () => {
          subscriberRef.current = null;
        };
      },
    };

    const mod = await loadRouteModule<{ GET: (request: Request) => Promise<Response> }>(
      "@/app/api/runtime/stream/route",
      runtimeMock
    );
    const response = await mod.GET(
      new Request("http://localhost/api/runtime/stream", {
        headers: { "Last-Event-ID": "2" },
      })
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const emit = subscriberRef.current;
    if (!emit) {
      throw new Error("expected runtime stream subscriber to be attached");
    }
    emit({
      id: 5,
      event: {
        type: "runtime.status",
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:05.000Z",
      },
      createdAt: "2026-02-28T02:40:05.000Z",
    });

    const reader = response.body!.getReader();
    const output = await readStreamUntil(reader, (text) => text.includes("id: 5"));
    expect(output).toContain("id: 3");
    expect(output).toContain("id: 4");
    expect(output).toContain("id: 5");
    expect(output.indexOf("id: 3")).toBeLessThan(output.indexOf("id: 4"));
    expect(output.indexOf("id: 4")).toBeLessThan(output.indexOf("id: 5"));
    await reader.cancel();
  });

  it("stream route deduplicates rows that arrive in both replay and live startup buffer", async () => {
    const subscriberRef: {
      current: ((entry: { id: number; event: unknown; createdAt: string }) => void) | null;
    } = { current: null };
    const overlapEntry = {
      id: 4,
      event: {
        type: "gateway.event",
        event: "runtime.delta",
        seq: 21,
        payload: { sessionKey: "agent:alpha:main", delta: "overlap" },
        asOf: "2026-02-28T02:40:04.000Z",
      },
      createdAt: "2026-02-28T02:40:04.000Z",
    };
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 4,
      }),
      eventsAfter: (lastSeenId: number) => {
        expect(lastSeenId).toBe(2);
        return [
          {
            id: 3,
            event: {
              type: "gateway.event",
              event: "runtime.delta",
              seq: 20,
              payload: { sessionKey: "agent:alpha:main", delta: "replay" },
              asOf: "2026-02-28T02:40:03.000Z",
            },
            createdAt: "2026-02-28T02:40:03.000Z",
          },
          overlapEntry,
        ];
      },
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: (handler) => {
        subscriberRef.current = handler;
        handler(overlapEntry);
        return () => {
          subscriberRef.current = null;
        };
      },
    };

    const mod = await loadRouteModule<{ GET: (request: Request) => Promise<Response> }>(
      "@/app/api/runtime/stream/route",
      runtimeMock
    );
    const response = await mod.GET(
      new Request("http://localhost/api/runtime/stream", {
        headers: { "Last-Event-ID": "2" },
      })
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const emit = subscriberRef.current;
    if (!emit) {
      throw new Error("expected runtime stream subscriber to be attached");
    }
    emit({
      id: 5,
      event: {
        type: "runtime.status",
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:05.000Z",
      },
      createdAt: "2026-02-28T02:40:05.000Z",
    });

    const reader = response.body!.getReader();
    const output = await readStreamUntil(reader, (text) => text.includes("id: 5"));
    const duplicateCount = (output.match(/(^|\n)id: 4\n/gm) ?? []).length;
    expect(output).toContain("id: 3");
    expect(output).toContain("id: 4");
    expect(output).toContain("id: 5");
    expect(duplicateCount).toBe(1);
    await reader.cancel();
  });

  it("stream route does not lose newest head rows during fresh-connect capped replay startup", async () => {
    const subscriberRef: {
      current: ((entry: { id: number; event: unknown; createdAt: string }) => void) | null;
    } = { current: null };
    let outboxHead = 5_000;
    const outboxRows: Array<{ id: number; event: unknown; createdAt: string }> = [
      {
        id: 4_999,
        event: {
          type: "gateway.event",
          event: "runtime.delta",
          seq: 19,
          payload: { sessionKey: "agent:alpha:main", delta: "n-1" },
          asOf: "2026-02-28T02:40:03.000Z",
        },
        createdAt: "2026-02-28T02:40:03.000Z",
      },
      {
        id: 5_000,
        event: {
          type: "gateway.event",
          event: "runtime.delta",
          seq: 20,
          payload: { sessionKey: "agent:alpha:main", delta: "n" },
          asOf: "2026-02-28T02:40:04.000Z",
        },
        createdAt: "2026-02-28T02:40:04.000Z",
      },
    ];
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead,
      }),
      eventsAfter: (lastSeenId: number, limit?: number) => {
        expect(limit).toBe(2_000);
        return outboxRows.filter((entry) => entry.id > lastSeenId).slice(0, limit);
      },
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: (handler) => {
        outboxHead = 5_001;
        outboxRows.push({
          id: 5_001,
          event: {
            type: "gateway.event",
            event: "runtime.delta",
            seq: 21,
            payload: { sessionKey: "agent:alpha:main", delta: "n+1 boundary" },
            asOf: "2026-02-28T02:40:05.000Z",
          },
          createdAt: "2026-02-28T02:40:05.000Z",
        });
        subscriberRef.current = handler;
        return () => {
          subscriberRef.current = null;
        };
      },
    };

    const mod = await loadRouteModule<{ GET: (request: Request) => Promise<Response> }>(
      "@/app/api/runtime/stream/route",
      runtimeMock
    );
    const response = await mod.GET(new Request("http://localhost/api/runtime/stream"));
    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const emit = subscriberRef.current;
    if (!emit) {
      throw new Error("expected runtime stream subscriber to be attached");
    }
    emit({
      id: 5_002,
      event: {
        type: "runtime.status",
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:06.000Z",
      },
      createdAt: "2026-02-28T02:40:06.000Z",
    });

    const reader = response.body!.getReader();
    const output = await readStreamUntil(reader, (text) => text.includes("id: 5002"));
    expect(output).toContain("id: 4999");
    expect(output).toContain("id: 5000");
    expect(output).toContain("id: 5001");
    expect(output).toContain("id: 5002");
    expect(output.indexOf("id: 5000")).toBeLessThan(output.indexOf("id: 5001"));
    expect(output.indexOf("id: 5001")).toBeLessThan(output.indexOf("id: 5002"));
    await reader.cancel();
  });

  it("stream route replays newest window when Last-Event-ID is absent", async () => {
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 5_000,
      }),
      eventsAfter: (lastSeenId: number) => {
        expect(lastSeenId).toBe(3_000);
        return [
          {
            id: 4_999,
            event: {
              type: "gateway.event",
              event: "runtime.delta",
              seq: 20,
              payload: { sessionKey: "agent:alpha:main", delta: "replay" },
              asOf: "2026-02-28T02:40:03.000Z",
            },
            createdAt: "2026-02-28T02:40:03.000Z",
          },
        ];
      },
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
    };

    const mod = await loadRouteModule<{ GET: (request: Request) => Promise<Response> }>(
      "@/app/api/runtime/stream/route",
      runtimeMock
    );
    const response = await mod.GET(new Request("http://localhost/api/runtime/stream"));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    const firstChunk = new TextDecoder().decode(first.value);
    expect(firstChunk).toContain("id: 4999");
    await reader.cancel();
  });

  it("stream route returns 503 when runtime cannot start", async () => {
    vi.resetModules();
    vi.doMock("@/lib/controlplane/runtime", () => ({
      isStudioDomainApiModeEnabled: () => true,
      getControlPlaneRuntime: () => ({
        ensureStarted: async () => {
          throw new Error("gateway unavailable");
        },
      }),
    }));

    const mod = await import("@/app/api/runtime/stream/route");
    const response = await mod.GET(new Request("http://localhost/api/runtime/stream"));
    expect(response.status).toBe(503);
    const body = await response.json() as { enabled: boolean; error: string };
    expect(body.enabled).toBe(true);
    expect(body.error).toBe("gateway unavailable");
  });

  it("agent-rename and agent-delete intent routes forward to runtime", async () => {
    const callGateway = vi.fn(async () => ({ ok: true }));
    vi.doMock("@/lib/controlplane/runtime", () => ({
      isStudioDomainApiModeEnabled: () => true,
      getControlPlaneRuntime: () => ({
        ensureStarted: async () => {},
        callGateway,
      }),
    }));

    const renameRoute = await import("@/app/api/intents/agent-rename/route");
    const deleteRoute = await import("@/app/api/intents/agent-delete/route");

    const renameRes = await renameRoute.POST(
      new Request("http://localhost/api/intents/agent-rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "agent-1", name: "Agent One Renamed" }),
      })
    );
    expect(renameRes.status).toBe(200);

    const deleteRes = await deleteRoute.POST(
      new Request("http://localhost/api/intents/agent-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "agent-1" }),
      })
    );
    expect(deleteRes.status).toBe(200);

    expect(callGateway).toHaveBeenCalledWith("agents.update", {
      agentId: "agent-1",
      name: "Agent One Renamed",
    });
    expect(callGateway).toHaveBeenCalledWith("agents.delete", {
      agentId: "agent-1",
    });
  });

  it("intent routes return 503 when runtime initialization fails", async () => {
    vi.resetModules();
    vi.doMock("@/lib/controlplane/runtime", () => ({
      isStudioDomainApiModeEnabled: () => true,
      getControlPlaneRuntime: () => {
        throw new Error("runtime init failed");
      },
    }));

    const renameRoute = await import("@/app/api/intents/agent-rename/route");
    const renameRes = await renameRoute.POST(
      new Request("http://localhost/api/intents/agent-rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "agent-1", name: "Agent One Renamed" }),
      })
    );
    expect(renameRes.status).toBe(503);
    const body = await renameRes.json() as { error: string; code: string; reason: string };
    expect(body.error).toBe("runtime init failed");
    expect(body.code).toBe("CONTROLPLANE_RUNTIME_INIT_FAILED");
    expect(body.reason).toBe("runtime_init_failed");
  });

  it("runtime fleet route hydrates through control-plane runtime", async () => {
    const callGateway = vi.fn(async () => ({ ok: true }));
    vi.doMock("@/lib/controlplane/runtime", () => ({
      isStudioDomainApiModeEnabled: () => true,
      getControlPlaneRuntime: () => ({
        ensureStarted: async () => {},
        snapshot: () => ({
          status: "connected",
          reason: null,
          asOf: "2026-02-28T02:40:00.000Z",
          outboxHead: 0,
        }),
        eventsAfter: () => [],
        callGateway,
      }),
    }));
    vi.doMock("@/lib/studio/settings-store", () => ({
      loadStudioSettings: () => ({
        version: 1,
        gateway: { url: "ws://localhost:3000/ws", token: "" },
        localGatewayDefaults: { url: "", token: "" },
        focused: {},
        avatars: {},
      }),
    }));
    vi.doMock("@/features/agents/operations/agentFleetHydration", () => ({
      hydrateAgentFleetFromGateway: vi.fn(async () => ({
        seeds: [{ agentId: "agent-1", name: "Agent One", sessionKey: "agent:agent-1:main" }],
        sessionCreatedAgentIds: ["agent-1"],
        sessionSettingsSyncedAgentIds: ["agent-1"],
        summaryPatches: [],
        suggestedSelectedAgentId: "agent-1",
        configSnapshot: null,
      })),
    }));
    const route = await import("@/app/api/runtime/fleet/route");
    const response = await route.POST(
      new Request("http://localhost/api/runtime/fleet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cachedConfigSnapshot: null }),
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { seeds: Array<{ agentId: string }> } };
    expect(body.result.seeds[0]?.agentId).toBe("agent-1");
  });

  it("runtime fleet route returns degraded projection payload when runtime cannot start", async () => {
    vi.resetModules();
    vi.doMock("@/lib/controlplane/runtime", () => ({
      isStudioDomainApiModeEnabled: () => true,
      getControlPlaneRuntime: () => ({
        ensureStarted: async () => {
          throw new Error("gateway unavailable");
        },
        snapshot: () => ({
          status: "error",
          reason: "gateway_closed",
          asOf: "2026-02-28T02:40:00.000Z",
          outboxHead: 5,
        }),
        eventsAfter: () => [
          {
            id: 2,
            event: {
              type: "gateway.event",
              event: "runtime.delta",
              seq: 11,
              payload: {
                sessionKey: "agent:../alpha:main",
              },
              asOf: "2026-02-28T02:40:02.000Z",
            },
            createdAt: "2026-02-28T02:40:02.000Z",
          },
          {
            id: 3,
            event: {
              type: "gateway.event",
              event: "runtime.delta",
              seq: 12,
              payload: {
                sessionKey: "agent:alpha:main",
              },
              asOf: "2026-02-28T02:40:03.000Z",
            },
            createdAt: "2026-02-28T02:40:03.000Z",
          },
          {
            id: 4,
            event: {
              type: "gateway.event",
              event: "runtime.delta",
              seq: 13,
              payload: {
                agentId: "beta",
                agentName: "Beta Agent",
              },
              asOf: "2026-02-28T02:40:04.000Z",
            },
            createdAt: "2026-02-28T02:40:04.000Z",
          },
        ],
      }),
    }));
    vi.doMock("@/lib/controlplane/degraded-read", async () => {
      const actual = await vi.importActual<typeof import("@/lib/controlplane/degraded-read")>(
        "@/lib/controlplane/degraded-read"
      );
      return {
        ...actual,
        probeOpenClawLocalState: vi.fn(async () => ({
          at: "2026-02-28T02:41:00.000Z",
          status: { ok: false, error: "openclaw_cli_not_found" },
          sessions: { ok: false, error: "openclaw_cli_not_found" },
        })),
      };
    });
    const route = await import("@/app/api/runtime/fleet/route");
    const response = await route.POST(
      new Request("http://localhost/api/runtime/fleet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cachedConfigSnapshot: null }),
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      enabled: boolean;
      degraded: boolean;
      error: string;
      code: string;
      reason: string;
      result: {
        seeds: Array<{ agentId: string; name: string; sessionKey: string }>;
        sessionCreatedAgentIds: string[];
      };
    };
    expect(body.enabled).toBe(true);
    expect(body.degraded).toBe(true);
    expect(body.error).toBe("gateway unavailable");
    expect(body.code).toBe("GATEWAY_UNAVAILABLE");
    expect(body.reason).toBe("gateway_unavailable");
    expect(body.result.seeds).toEqual([
      { agentId: "alpha", name: "alpha", sessionKey: "agent:alpha:main" },
      { agentId: "beta", name: "Beta Agent", sessionKey: "agent:beta:main" },
    ]);
    expect(body.result.sessionCreatedAgentIds).toEqual(["alpha", "beta"]);
  });

  it("runtime fleet route degrades when hydration fails with missing scope", async () => {
    vi.resetModules();
    vi.doMock("@/lib/controlplane/runtime", () => ({
      isStudioDomainApiModeEnabled: () => true,
      getControlPlaneRuntime: () => ({
        ensureStarted: async () => {},
        snapshot: () => ({
          status: "connected",
          reason: null,
          asOf: "2026-02-28T02:40:00.000Z",
          outboxHead: 3,
        }),
        eventsAfter: () => [
          {
            id: 3,
            event: {
              type: "gateway.event",
              event: "runtime.delta",
              seq: 12,
              payload: {
                sessionKey: "agent:alpha:main",
              },
              asOf: "2026-02-28T02:40:03.000Z",
            },
            createdAt: "2026-02-28T02:40:03.000Z",
          },
        ],
        callGateway: vi.fn(),
      }),
    }));
    vi.doMock("@/lib/studio/settings-store", () => ({
      loadStudioSettings: () => ({
        version: 1,
        gateway: { url: "ws://localhost:3000/ws", token: "" },
        localGatewayDefaults: { url: "", token: "" },
        focused: {},
        avatars: {},
      }),
    }));
    vi.doMock("@/lib/controlplane/degraded-read", async () => {
      const actual = await vi.importActual<typeof import("@/lib/controlplane/degraded-read")>(
        "@/lib/controlplane/degraded-read"
      );
      return {
        ...actual,
        probeOpenClawLocalState: vi.fn(async () => ({
          at: "2026-02-28T02:41:00.000Z",
          status: { ok: false, error: "openclaw_cli_not_found" },
          sessions: { ok: false, error: "openclaw_cli_not_found" },
        })),
      };
    });
    vi.doMock("@/features/agents/operations/agentFleetHydration", () => ({
      hydrateAgentFleetFromGateway: vi.fn(async () => {
        const error = new Error("missing scope: operator.read") as Error & { code: string };
        error.code = "INVALID_REQUEST";
        throw error;
      }),
    }));

    const route = await import("@/app/api/runtime/fleet/route");
    const response = await route.POST(
      new Request("http://localhost/api/runtime/fleet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cachedConfigSnapshot: null }),
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      enabled: boolean;
      degraded: boolean;
      code: string;
      reason: string;
      result: { seeds: Array<{ agentId: string }>; sessionCreatedAgentIds: string[] };
    };
    expect(body.enabled).toBe(true);
    expect(body.degraded).toBe(true);
    expect(body.code).toBe("INSUFFICIENT_SCOPE");
    expect(body.reason).toBe("insufficient_scope");
    expect(body.result.seeds.map((entry) => entry.agentId)).toEqual(["alpha"]);
    expect(body.result.sessionCreatedAgentIds).toEqual(["alpha"]);
  });

  it("agent preview route loads focused sessions.preview and filters to conversation items", async () => {
    const callGateway = vi.fn().mockResolvedValue({
      previews: [
        {
          key: "agent:alpha:main",
          items: [
            { role: "tool", text: "hidden" },
            { role: "assistant", text: "[reply_to_current] hi", timestamp: 123 },
            { role: "user", text: "hello there", timestamp: "2026-02-28T02:40:01.000Z" },
          ],
        },
      ],
    });
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 10,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
      callGateway,
    };

    const mod = await loadRouteModule<{
      GET: (
        request: Request,
        context: { params: Promise<{ agentId: string }> }
      ) => Promise<Response>;
    }>("@/app/api/runtime/agents/[agentId]/preview/route", runtimeMock);

    const response = await mod.GET(
      new Request(
        "http://localhost/api/runtime/agents/alpha/preview?sessionKey=agent:alpha:main&limit=50&maxChars=480"
      ),
      { params: Promise.resolve({ agentId: "alpha" }) }
    );

    expect(response.status).toBe(200);
    expect(callGateway).toHaveBeenCalledWith("sessions.preview", {
      keys: ["agent:alpha:main"],
      limit: 50,
      maxChars: 480,
    });
    const body = (await response.json()) as {
      enabled: boolean;
      agentId: string;
      sessionKey: string;
      items: Array<{ role: string; text: string }>;
    };
    expect(body.enabled).toBe(true);
    expect(body.agentId).toBe("alpha");
    expect(body.sessionKey).toBe("agent:alpha:main");
    expect(body.items).toEqual([
      { role: "assistant", text: "hi", timestamp: 123 },
      { role: "user", text: "hello there", timestamp: "2026-02-28T02:40:01.000Z" },
    ]);
  });

  it("agent preview route rejects session keys for another agent", async () => {
    const callGateway = vi.fn().mockResolvedValue({ previews: [] });
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 10,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
      callGateway,
    };

    const mod = await loadRouteModule<{
      GET: (
        request: Request,
        context: { params: Promise<{ agentId: string }> }
      ) => Promise<Response>;
    }>("@/app/api/runtime/agents/[agentId]/preview/route", runtimeMock);

    const response = await mod.GET(
      new Request(
        "http://localhost/api/runtime/agents/alpha/preview?sessionKey=agent:beta:main"
      ),
      { params: Promise.resolve({ agentId: "alpha" }) }
    );
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("sessionKey does not match agentId.");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("agent preview route rejects malformed explicit session keys", async () => {
    const callGateway = vi.fn().mockResolvedValue({ previews: [] });
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 10,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
      callGateway,
    };

    const mod = await loadRouteModule<{
      GET: (
        request: Request,
        context: { params: Promise<{ agentId: string }> }
      ) => Promise<Response>;
    }>("@/app/api/runtime/agents/[agentId]/preview/route", runtimeMock);

    const response = await mod.GET(
      new Request(
        "http://localhost/api/runtime/agents/alpha/preview?sessionKey=main"
      ),
      { params: Promise.resolve({ agentId: "alpha" }) }
    );
    const body = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("sessionKey does not match agentId.");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("agent preview route does not fall back to a mismatched preview key", async () => {
    const callGateway = vi.fn().mockResolvedValue({
      previews: [
        {
          key: "agent:beta:main",
          items: [{ role: "assistant", text: "beta secret" }],
        },
      ],
    });
    const runtimeMock: RuntimeMock = {
      ensureStarted: async () => {},
      snapshot: () => ({
        status: "connected",
        reason: null,
        asOf: "2026-02-28T02:40:00.000Z",
        outboxHead: 10,
      }),
      eventsAfter: () => [],
      eventsBefore: () => [],
      eventsBeforeForAgent: () => [],
      backfillAgentHistoryIndex: () => ({ scannedRows: 0, updatedRows: 0, exhausted: true }),
      subscribe: () => () => {},
      callGateway,
    };

    const mod = await loadRouteModule<{
      GET: (
        request: Request,
        context: { params: Promise<{ agentId: string }> }
      ) => Promise<Response>;
    }>("@/app/api/runtime/agents/[agentId]/preview/route", runtimeMock);

    const response = await mod.GET(
      new Request(
        "http://localhost/api/runtime/agents/alpha/preview?sessionKey=agent:alpha:main"
      ),
      { params: Promise.resolve({ agentId: "alpha" }) }
    );
    const body = await response.json() as { items?: Array<{ text?: string }> };

    expect(response.status).toBe(200);
    expect(body.items).toEqual([]);
  });

  it("runtime fleet route returns 503 when runtime initialization fails", async () => {
    vi.resetModules();
    vi.doMock("@/lib/controlplane/runtime", () => ({
      isStudioDomainApiModeEnabled: () => true,
      getControlPlaneRuntime: () => {
        throw new Error("runtime init failed");
      },
    }));
    const route = await import("@/app/api/runtime/fleet/route");
    const response = await route.POST(
      new Request("http://localhost/api/runtime/fleet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cachedConfigSnapshot: null }),
      })
    );
    expect(response.status).toBe(503);
    const body = await response.json() as {
      enabled: boolean;
      error: string;
      code: string;
      reason: string;
    };
    expect(body.enabled).toBe(true);
    expect(body.error).toBe("runtime init failed");
    expect(body.code).toBe("CONTROLPLANE_RUNTIME_INIT_FAILED");
    expect(body.reason).toBe("runtime_init_failed");
  });
});
