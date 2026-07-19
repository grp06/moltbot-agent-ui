// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { WebSocket, WebSocketServer } from "ws";

import { OpenClawGatewayAdapter } from "@/lib/controlplane/openclaw-adapter";
import type { ControlPlaneDomainEvent } from "@/lib/controlplane/contracts";

const closeWebSocketServer = (server: WebSocketServer) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

const waitForCondition = async (predicate: () => boolean, timeoutMs: number = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition not met before timeout.");
};

describe("OpenClawGatewayAdapter", () => {
  let upstream: WebSocketServer | null = null;

  afterEach(async () => {
    if (upstream) {
      await closeWebSocketServer(upstream);
      upstream = null;
    }
    vi.useRealTimers();
  });

  it("honors per-request timeout overrides", async () => {
    vi.useFakeTimers();

    class TimeoutSocket extends EventEmitter {
      readyState: number = WebSocket.OPEN;

      close() {
        if (this.readyState === WebSocket.CLOSED) return;
        this.readyState = WebSocket.CLOSED;
        this.emit("close");
      }

      terminate() {
        this.close();
      }

      send(raw: string, callback?: (err?: Error) => void) {
        const parsed = JSON.parse(raw) as { id?: string; method?: string };
        callback?.();
        if (parsed.method !== "connect" || !parsed.id) {
          return;
        }
        queueMicrotask(() => {
          this.emit(
            "message",
            JSON.stringify({
              type: "res",
              id: parsed.id,
              ok: true,
              payload: { type: "hello-ok", protocol: 3 },
            })
          );
        });
      }
    }

    const socket = new TimeoutSocket();
    const adapter = new OpenClawGatewayAdapter({
      loadSettings: () => ({ url: "ws://127.0.0.1:9", token: "tkn" }),
      createWebSocket: () => socket as unknown as WebSocket,
    });

    queueMicrotask(() => {
      socket.emit("message", JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }));
    });

    await adapter.start();

    let settled = false;
    const request = adapter.request("cron.run", { id: "job-1" }, { timeoutMs: 25_000 });
    void request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await vi.advanceTimersByTimeAsync(24_999);
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(request).rejects.toThrow(
      "Gateway request timed out after 25000ms for method: cron.run"
    );

    await adapter.stop();
  });

  it("can stop a connection attempt without wedging the next start", async () => {
    class ManualConnectSocket extends EventEmitter {
      readyState: number;

      constructor(readyState: number) {
        super();
        this.readyState = readyState;
      }

      close() {
        if (this.readyState === WebSocket.CLOSED) return;
        this.readyState = WebSocket.CLOSED;
        this.emit("close");
      }

      terminate() {
        this.close();
      }

      send(raw: string, callback?: (err?: Error) => void) {
        const parsed = JSON.parse(raw) as { id?: string; method?: string };
        callback?.();
        if (parsed.method !== "connect" || !parsed.id) {
          return;
        }
        queueMicrotask(() => {
          this.emit(
            "message",
            JSON.stringify({
              type: "res",
              id: parsed.id,
              ok: true,
              payload: { type: "hello-ok", protocol: 3 },
            })
          );
        });
      }
    }

    const sockets: ManualConnectSocket[] = [];
    const createWebSocket = vi.fn(() => {
      const socket = new ManualConnectSocket(
        sockets.length === 0 ? WebSocket.CONNECTING : WebSocket.OPEN
      );
      sockets.push(socket);
      if (sockets.length > 1) {
        queueMicrotask(() => {
          socket.emit(
            "message",
            JSON.stringify({ type: "event", event: "connect.challenge", payload: {} })
          );
        });
      }
      return socket as unknown as WebSocket;
    });

    const adapter = new OpenClawGatewayAdapter({
      loadSettings: () => ({ url: "ws://127.0.0.1:9", token: "tkn" }),
      createWebSocket,
    });

    const firstStart = adapter.start().then(
      () => null,
      (error: unknown) => error
    );
    await Promise.resolve();
    expect(createWebSocket).toHaveBeenCalledTimes(1);

    await adapter.stop();
    const firstError = await firstStart;
    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toBe("Control-plane adapter stopped.");
    expect(adapter.getStatus()).toBe("stopped");

    await adapter.start();
    expect(createWebSocket).toHaveBeenCalledTimes(2);
    expect(adapter.getStatus()).toBe("connected");

    await adapter.stop();
  });

  it("forces an open socket closed when graceful stop does not finish", async () => {
    vi.useFakeTimers();

    class HangingCloseSocket extends EventEmitter {
      readyState: number = WebSocket.OPEN;
      terminated = false;

      close() {
        this.readyState = WebSocket.CLOSING;
      }

      terminate() {
        this.terminated = true;
        this.readyState = WebSocket.CLOSED;
      }

      send(raw: string, callback?: (err?: Error) => void) {
        const parsed = JSON.parse(raw) as { id?: string; method?: string };
        callback?.();
        if (parsed.method !== "connect" || !parsed.id) {
          return;
        }
        queueMicrotask(() => {
          this.emit(
            "message",
            JSON.stringify({
              type: "res",
              id: parsed.id,
              ok: true,
              payload: { type: "hello-ok", protocol: 3 },
            })
          );
        });
      }
    }

    const socket = new HangingCloseSocket();
    const adapter = new OpenClawGatewayAdapter({
      loadSettings: () => ({ url: "ws://127.0.0.1:9", token: "tkn" }),
      createWebSocket: () => socket as unknown as WebSocket,
    });

    queueMicrotask(() => {
      socket.emit("message", JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }));
    });

    await adapter.start();

    let stopped = false;
    const stopPromise = adapter.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    expect(socket.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await stopPromise;

    expect(stopped).toBe(true);
    expect(socket.terminated).toBe(true);
    expect(adapter.getStatus()).toBe("stopped");
  });

  it("rejects in-flight requests immediately when the socket closes", async () => {
    upstream = new WebSocketServer({ port: 0 });
    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("expected upstream server to provide a numeric port");
    }
    const upstreamUrl = `ws://127.0.0.1:${address.port}`;
    let observedConnectClientId: string | null = null;
    let observedConnectClientMode: string | null = null;
    let observedConnectClientPlatform: string | null = null;
    let observedConnectCaps: string[] | null = null;
    let observedOriginHeader: string | undefined;

    upstream.on("connection", (ws, request) => {
      observedOriginHeader =
        typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }));
      ws.on("message", (raw) => {
        const parsed = JSON.parse(String(raw ?? "")) as {
          id?: string;
          method?: string;
          params?: {
            client?: { id?: string; mode?: string; platform?: string };
            caps?: string[];
          };
        };
        if (parsed?.method === "connect") {
          observedConnectClientId = parsed.params?.client?.id ?? null;
          observedConnectClientMode = parsed.params?.client?.mode ?? null;
          observedConnectClientPlatform = parsed.params?.client?.platform ?? null;
          observedConnectCaps = Array.isArray(parsed.params?.caps) ? parsed.params.caps : null;
          ws.send(
            JSON.stringify({
              type: "res",
              id: parsed.id,
              ok: true,
              payload: { type: "hello-ok", protocol: 3 },
            })
          );
          return;
        }
        if (parsed?.method === "status") {
          ws.close(1011, "upstream closed");
        }
      });
    });

    const adapter = new OpenClawGatewayAdapter({
      loadSettings: () => ({ url: upstreamUrl, token: "tkn" }),
    });

    await adapter.start();
    const startedAt = Date.now();
    await expect(adapter.request("status", {})).rejects.toThrow(
      "Control-plane gateway connection closed."
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(observedConnectClientId).toBe("gateway-client");
    expect(observedConnectClientMode).toBe("backend");
    expect(observedConnectClientPlatform).toBe("node");
    expect(observedConnectCaps).toEqual(expect.arrayContaining(["tool-events"]));
    expect(observedOriginHeader).toBeUndefined();

    await adapter.stop();
  });

  it("cleans up request state when gateway send throws synchronously", async () => {
    class ThrowingRequestSocket extends EventEmitter {
      readyState: number = WebSocket.OPEN;

      close() {
        if (this.readyState === WebSocket.CLOSED) return;
        this.readyState = WebSocket.CLOSED;
        this.emit("close");
      }

      terminate() {
        this.close();
      }

      send(raw: string, callback?: (err?: Error) => void) {
        const parsed = JSON.parse(raw) as { id?: string; method?: string };
        if (parsed.method === "status") {
          throw new Error("socket send failed");
        }
        callback?.();
        if (parsed.method !== "connect" || !parsed.id) {
          return;
        }
        queueMicrotask(() => {
          this.emit(
            "message",
            JSON.stringify({
              type: "res",
              id: parsed.id,
              ok: true,
              payload: { type: "hello-ok", protocol: 3 },
            })
          );
        });
      }
    }

    const socket = new ThrowingRequestSocket();
    const adapter = new OpenClawGatewayAdapter({
      loadSettings: () => ({ url: "ws://127.0.0.1:9", token: "tkn" }),
      createWebSocket: () => socket as unknown as WebSocket,
    });

    queueMicrotask(() => {
      socket.emit("message", JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }));
    });

    await adapter.start();
    await expect(adapter.request("status", {})).rejects.toThrow(
      "Failed to send gateway request for method: status"
    );

    await adapter.stop();
  });

  it("fails connect gracefully when sending the connect request throws", async () => {
    class ThrowingConnectSocket extends EventEmitter {
      readyState: number = WebSocket.OPEN;

      close() {
        if (this.readyState === WebSocket.CLOSED) return;
        this.readyState = WebSocket.CLOSED;
        this.emit("close");
      }

      terminate() {
        this.close();
      }

      send(raw: string) {
        const parsed = JSON.parse(raw) as { method?: string };
        if (parsed.method === "connect") {
          throw new Error("connect send failed");
        }
      }
    }

    const socket = new ThrowingConnectSocket();
    const adapter = new OpenClawGatewayAdapter({
      loadSettings: () => ({ url: "ws://127.0.0.1:9", token: "tkn" }),
      createWebSocket: () => socket as unknown as WebSocket,
    });

    setTimeout(() => {
      socket.emit("message", JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }));
    }, 0);

    await expect(adapter.start()).rejects.toThrow(
      "Control-plane gateway connection closed during connect."
    );

    await adapter.stop();
  });

  it("does not retry after the gateway rejects the connect request", async () => {
    vi.useFakeTimers();

    class RejectingConnectSocket extends EventEmitter {
      readyState: number = WebSocket.OPEN;

      close() {
        if (this.readyState === WebSocket.CLOSED) return;
        this.readyState = WebSocket.CLOSED;
        this.emit("close");
      }

      terminate() {
        this.close();
      }

      send(raw: string, callback?: (err?: Error) => void) {
        const parsed = JSON.parse(raw) as { id?: string; method?: string };
        callback?.();
        if (parsed.method !== "connect" || !parsed.id) {
          return;
        }
        queueMicrotask(() => {
          this.emit(
            "message",
            JSON.stringify({
              type: "res",
              id: parsed.id,
              ok: false,
              error: {
                code: "INVALID_REQUEST",
                message: "control ui requires device identity (use HTTPS or localhost secure context)",
              },
            })
          );
        });
      }
    }

    const createWebSocket = vi.fn(() => {
      const socket = new RejectingConnectSocket();
      queueMicrotask(() => {
        socket.emit(
          "message",
          JSON.stringify({ type: "event", event: "connect.challenge", payload: {} })
        );
      });
      return socket as unknown as WebSocket;
    });

    const adapter = new OpenClawGatewayAdapter({
      loadSettings: () => ({ url: "ws://10.0.0.8:18789", token: "tkn" }),
      createWebSocket,
    });

    await expect(adapter.start()).rejects.toThrow(
      "Control-plane connect rejected: INVALID_REQUEST control ui requires device identity"
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(createWebSocket).toHaveBeenCalledTimes(1);

    await adapter.stop();
  });

  it("ignores late close events from a timed-out stale socket after reconnect succeeds", async () => {
    vi.useFakeTimers();

    class ManualReconnectSocket extends EventEmitter {
      readyState: number = WebSocket.OPEN;

      close() {
        if (this.readyState === WebSocket.CLOSED) return;
        this.readyState = WebSocket.CLOSING;
      }

      terminate() {
        if (this.readyState === WebSocket.CLOSED) return;
        this.readyState = WebSocket.CLOSED;
        this.emit("close");
      }

      send(raw: string, callback?: (err?: Error) => void) {
        const parsed = JSON.parse(raw) as { id?: string; method?: string };
        callback?.();
        if (parsed.method !== "connect" || !parsed.id) {
          return;
        }
        queueMicrotask(() => {
          this.emit(
            "message",
            JSON.stringify({
              type: "res",
              id: parsed.id,
              ok: true,
              payload: { type: "hello-ok", protocol: 3 },
            })
          );
        });
      }
    }

    const sockets: ManualReconnectSocket[] = [];
    const createWebSocket = vi.fn(() => {
      const socket = new ManualReconnectSocket();
      sockets.push(socket);
      if (sockets.length > 1) {
        queueMicrotask(() => {
          socket.emit(
            "message",
            JSON.stringify({ type: "event", event: "connect.challenge", payload: {} })
          );
        });
      }
      return socket as unknown as WebSocket;
    });

    const adapter = new OpenClawGatewayAdapter({
      loadSettings: () => ({ url: "ws://127.0.0.1:9", token: "tkn" }),
      createWebSocket,
    });

    const firstStart = adapter.start().then(
      () => null,
      (error: unknown) => error
    );

    await vi.advanceTimersByTimeAsync(8_000);
    const firstError = await firstStart;
    expect(firstError).toBeInstanceOf(Error);
    expect((firstError as Error).message).toBe(
      "Control-plane connect timed out waiting for connect response."
    );
    expect(adapter.getStatus()).toBe("error");
    expect(createWebSocket).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(createWebSocket).toHaveBeenCalledTimes(2);
    expect(adapter.getStatus()).toBe("connected");

    sockets[0].emit("close");
    expect(adapter.getStatus()).toBe("connected");

    await vi.advanceTimersByTimeAsync(15_000);
    expect(createWebSocket).toHaveBeenCalledTimes(2);

    const stopPromise = adapter.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopPromise;
  });

  it("emits gateway events with unique connection epochs across reconnect cycles", async () => {
    upstream = new WebSocketServer({ port: 0 });
    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("expected upstream server to provide a numeric port");
    }
    const upstreamUrl = `ws://127.0.0.1:${address.port}`;
    let acceptedConnections = 0;

    upstream.on("connection", (ws) => {
      acceptedConnections += 1;
      const connectionIndex = acceptedConnections;
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }));
      ws.on("message", (raw) => {
        const parsed = JSON.parse(String(raw ?? "")) as { id?: string; method?: string };
        if (parsed?.method !== "connect" || !parsed.id) return;
        ws.send(
          JSON.stringify({
            type: "res",
            id: parsed.id,
            ok: true,
            payload: { type: "hello-ok", protocol: 3 },
          })
        );
        ws.send(
          JSON.stringify({
            type: "event",
            event: "agent",
            seq: 1,
            payload: { connectionIndex },
          })
        );
      });
    });

    const observedEvents: ControlPlaneDomainEvent[] = [];
    const adapter = new OpenClawGatewayAdapter({
      loadSettings: () => ({ url: upstreamUrl, token: "tkn" }),
      onDomainEvent: (event) => {
        observedEvents.push(event);
      },
    });

    await adapter.start();
    await waitForCondition(() =>
      observedEvents.some(
        (event) =>
          event.type === "gateway.event" &&
          event.event === "agent" &&
          typeof (event.payload as { connectionIndex?: unknown })?.connectionIndex === "number" &&
          (event.payload as { connectionIndex?: number }).connectionIndex === 1
      )
    );

    await adapter.stop();

    await adapter.start();
    await waitForCondition(() =>
      observedEvents.some(
        (event) =>
          event.type === "gateway.event" &&
          event.event === "agent" &&
          typeof (event.payload as { connectionIndex?: unknown })?.connectionIndex === "number" &&
          (event.payload as { connectionIndex?: number }).connectionIndex === 2
      )
    );

    const firstGatewayEvent = observedEvents.find(
      (event) =>
        event.type === "gateway.event" &&
        (event.payload as { connectionIndex?: number })?.connectionIndex === 1
    );
    const secondGatewayEvent = observedEvents.find(
      (event) =>
        event.type === "gateway.event" &&
        (event.payload as { connectionIndex?: number })?.connectionIndex === 2
    );

    expect(firstGatewayEvent?.type).toBe("gateway.event");
    expect(secondGatewayEvent?.type).toBe("gateway.event");
    if (!firstGatewayEvent || firstGatewayEvent.type !== "gateway.event") {
      throw new Error("Expected first gateway event.");
    }
    if (!secondGatewayEvent || secondGatewayEvent.type !== "gateway.event") {
      throw new Error("Expected second gateway event.");
    }
    expect(firstGatewayEvent.connectionEpoch).toBeTruthy();
    expect(secondGatewayEvent.connectionEpoch).toBeTruthy();
    expect(firstGatewayEvent.connectionEpoch).not.toBe(secondGatewayEvent.connectionEpoch);

    await adapter.stop();
  });

  it("falls back to legacy control-ui identity when operator scopes are rejected", async () => {
    upstream = new WebSocketServer({ port: 0 });
    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("expected upstream server to provide a numeric port");
    }
    const upstreamUrl = `ws://127.0.0.1:${address.port}`;
    let connectionCount = 0;
    const connectedClientIds: string[] = [];
    const connectedClientModes: string[] = [];
    const observedOriginHeaders: Array<string | undefined> = [];

    upstream.on("connection", (ws, request) => {
      connectionCount += 1;
      const activeConnection = connectionCount;
      observedOriginHeaders.push(
        typeof request.headers.origin === "string" ? request.headers.origin : undefined
      );
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }));
      ws.on("message", (raw) => {
        const parsed = JSON.parse(String(raw ?? "")) as {
          id?: string;
          method?: string;
          params?: {
            client?: { id?: string; mode?: string };
          };
        };
        if (parsed.method === "connect" && parsed.id) {
          connectedClientIds.push(parsed.params?.client?.id ?? "unknown");
          connectedClientModes.push(parsed.params?.client?.mode ?? "unknown");
          ws.send(
            JSON.stringify({
              type: "res",
              id: parsed.id,
              ok: true,
              payload: { type: "hello-ok", protocol: 3 },
            })
          );
          return;
        }
        if (parsed.method === "status" && parsed.id) {
          if (activeConnection === 1) {
            ws.send(
              JSON.stringify({
                type: "res",
                id: parsed.id,
                ok: false,
                error: { code: "INVALID_REQUEST", message: "missing scope: operator.read" },
              })
            );
            return;
          }
          ws.send(
            JSON.stringify({
              type: "res",
              id: parsed.id,
              ok: true,
              payload: { ok: true },
            })
          );
        }
      });
    });

    const adapter = new OpenClawGatewayAdapter({
      loadSettings: () => ({ url: upstreamUrl, token: "tkn" }),
    });

    await adapter.start();
    const result = await adapter.request<{ ok: boolean }>("status", {});

    expect(result).toEqual({ ok: true });
    await waitForCondition(() => connectedClientIds.length >= 2);
    expect(connectedClientIds[0]).toBe("gateway-client");
    expect(connectedClientModes[0]).toBe("backend");
    expect(connectedClientIds[1]).toBe("openclaw-control-ui");
    expect(connectedClientModes[1]).toBe("webchat");
    expect(observedOriginHeaders[0]).toBeUndefined();
    expect(observedOriginHeaders[1]).toBe(`http://localhost:${address.port}`);

    await adapter.stop();
  });

  it("resets the connect profile to backend-local after an explicit stop", async () => {
    upstream = new WebSocketServer({ port: 0 });
    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("expected upstream server to provide a numeric port");
    }
    const upstreamUrl = `ws://127.0.0.1:${address.port}`;
    let connectionCount = 0;
    const connectedClientIds: string[] = [];
    const observedOriginHeaders: Array<string | undefined> = [];

    upstream.on("connection", (ws, request) => {
      connectionCount += 1;
      const activeConnection = connectionCount;
      observedOriginHeaders.push(
        typeof request.headers.origin === "string" ? request.headers.origin : undefined
      );
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: {} }));
      ws.on("message", (raw) => {
        const parsed = JSON.parse(String(raw ?? "")) as {
          id?: string;
          method?: string;
          params?: {
            client?: { id?: string };
          };
        };
        if (parsed.method === "connect" && parsed.id) {
          connectedClientIds.push(parsed.params?.client?.id ?? "unknown");
          ws.send(
            JSON.stringify({
              type: "res",
              id: parsed.id,
              ok: true,
              payload: { type: "hello-ok", protocol: 3 },
            })
          );
          return;
        }
        if (parsed.method !== "status" || !parsed.id) {
          return;
        }
        if (activeConnection === 1) {
          ws.send(
            JSON.stringify({
              type: "res",
              id: parsed.id,
              ok: false,
              error: { code: "INVALID_REQUEST", message: "missing scope: operator.read" },
            })
          );
          return;
        }
        ws.send(
          JSON.stringify({
            type: "res",
            id: parsed.id,
            ok: true,
            payload: { ok: true, activeConnection },
          })
        );
      });
    });

    const adapter = new OpenClawGatewayAdapter({
      loadSettings: () => ({ url: upstreamUrl, token: "tkn" }),
    });

    await adapter.start();
    await expect(adapter.request("status", {})).resolves.toEqual({ ok: true, activeConnection: 2 });
    expect(connectedClientIds).toEqual(["gateway-client", "openclaw-control-ui"]);
    expect(observedOriginHeaders).toEqual([undefined, `http://localhost:${address.port}`]);

    await adapter.stop();
    await adapter.start();
    await waitForCondition(() => connectedClientIds.length >= 3);

    expect(connectedClientIds[2]).toBe("gateway-client");
    expect(observedOriginHeaders[2]).toBeUndefined();

    await adapter.stop();
  });
});
