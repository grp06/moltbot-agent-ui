import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import type {
  ControlPlaneConnectionStatus,
  ControlPlaneDomainEvent,
  ControlPlaneGatewaySettings,
  GatewayEventFrame,
  GatewayResponseFrame,
} from "@/lib/controlplane/contracts";
import {
  buildGatewayConnectProfile,
  type GatewayConnectProfile,
  type GatewayConnectProfileId,
  type GatewaySocketOptions,
  shouldFallbackToLegacyControlUi,
} from "@/lib/controlplane/gateway-connect-profile";
import { loadStudioSettings } from "@/lib/studio/settings-store";

const CONNECT_TIMEOUT_MS = 8_000;
const STOP_CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000;
const CONNECT_PROTOCOL = 3;
const CONNECT_CAPABILITIES = ["tool-events"];

const DEFAULT_METHOD_ALLOWLIST = new Set<string>([
  "status",
  "chat.send",
  "chat.abort",
  "chat.history",
  "agents.create",
  "agents.update",
  "agents.delete",
  "agents.list",
  "agents.files.get",
  "agents.files.set",
  "sessions.list",
  "sessions.preview",
  "sessions.patch",
  "sessions.reset",
  "cron.list",
  "cron.run",
  "cron.remove",
  "cron.add",
  "config.get",
  "config.set",
  "models.list",
  "exec.approval.resolve",
  "exec.approvals.get",
  "exec.approvals.set",
  "agent.wait",
]);

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class ControlPlaneGatewayError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(params: { code: string; message: string; details?: unknown }) {
    super(params.message);
    this.name = "ControlPlaneGatewayError";
    this.code = params.code;
    this.details = params.details;
  }
}

export type SerializedControlPlaneGatewayConnectFailure = {
  code: string;
  message: string;
  profileId: GatewayConnectProfileId;
  details?: unknown;
};

export class ControlPlaneGatewayConnectError extends Error {
  readonly code: string;
  readonly profileId: GatewayConnectProfileId;
  readonly details?: unknown;
  readonly rejectedByGateway: boolean;

  constructor(params: {
    code: string;
    message: string;
    profileId: GatewayConnectProfileId;
    details?: unknown;
    rejectedByGateway: boolean;
  }) {
    super(params.message);
    this.name = "ControlPlaneGatewayConnectError";
    this.code = params.code;
    this.profileId = params.profileId;
    this.details = params.details;
    this.rejectedByGateway = params.rejectedByGateway;
  }
}

const isSerializedGatewayConnectFailure = (
  error: unknown
): error is SerializedControlPlaneGatewayConnectFailure => {
  if (!isObject(error)) {
    return false;
  }
  if (typeof error.code !== "string" || typeof error.message !== "string") {
    return false;
  }
  const profileId = error.profileId;
  return profileId === "backend-local" || profileId === "legacy-control-ui";
};

export const serializeControlPlaneGatewayConnectFailure = (
  error: unknown
): SerializedControlPlaneGatewayConnectFailure | null => {
  if (error instanceof ControlPlaneGatewayConnectError) {
    return {
      code: error.code,
      message: error.message,
      profileId: error.profileId,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (!isSerializedGatewayConnectFailure(error)) {
    return null;
  }
  return {
    code: error.code,
    message: error.message,
    profileId: error.profileId,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object");

const resolveRequestTimeoutMs = (timeoutMs?: number): number => {
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return Math.max(1, Math.floor(timeoutMs));
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
};

const resolveConnectFailureMessage = (error: unknown, upstreamUrl: string): string => {
  if (!(error instanceof Error)) {
    return "Control-plane gateway connection failed.";
  }
  const details = error.message.trim();
  if (!details) {
    return "Control-plane gateway connection failed.";
  }
  if (details.includes("Unexpected server response: 502")) {
    return `Control-plane gateway connection failed: upstream ${upstreamUrl} returned HTTP 502 during websocket upgrade.`;
  }
  return `Control-plane gateway connection failed: ${details}`;
};

const isConnectRejectionError = (error: unknown): boolean => {
  if (error instanceof ControlPlaneGatewayConnectError) {
    return error.rejectedByGateway;
  }
  if (!(error instanceof Error)) return false;
  return error.message.startsWith("Control-plane connect rejected:");
};

const loadGatewaySettings = (): ControlPlaneGatewaySettings => {
  const settings = loadStudioSettings();
  const gateway = settings.gateway;
  const url = typeof gateway?.url === "string" ? gateway.url.trim() : "";
  const token = typeof gateway?.token === "string" ? gateway.token.trim() : "";
  if (!url) {
    throw new Error("Control-plane start failed: Studio gateway URL is not configured.");
  }
  if (!token) {
    throw new Error("Control-plane start failed: Studio gateway token is not configured.");
  }
  return { url, token };
};

export type OpenClawAdapterOptions = {
  loadSettings?: () => ControlPlaneGatewaySettings;
  createWebSocket?: (url: string, opts: GatewaySocketOptions) => WebSocket;
  methodAllowlist?: Set<string>;
  onDomainEvent?: (event: ControlPlaneDomainEvent) => void;
};

export class OpenClawGatewayAdapter {
  private ws: WebSocket | null = null;
  private status: ControlPlaneConnectionStatus = "stopped";
  private statusReason: string | null = null;
  private connectRequestId: string | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private startPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopping = false;
  private nextRequestNumber = 1;
  private connectionEpoch: string | null = null;
  private pending = new Map<string, PendingRequest>();
  private loadSettings: () => ControlPlaneGatewaySettings;
  private createWebSocket: (url: string, opts: GatewaySocketOptions) => WebSocket;
  private methodAllowlist: Set<string>;
  private onDomainEvent?: (event: ControlPlaneDomainEvent) => void;
  private connectProfileId: GatewayConnectProfileId = "backend-local";
  private legacyProfileSwitchPromise: Promise<void> | null = null;
  private preserveConnectProfileOnStop = false;

  constructor(options?: OpenClawAdapterOptions) {
    this.loadSettings = options?.loadSettings ?? loadGatewaySettings;
    this.createWebSocket = options?.createWebSocket ?? ((url, opts) => new WebSocket(url, opts));
    this.methodAllowlist = options?.methodAllowlist ?? DEFAULT_METHOD_ALLOWLIST;
    this.onDomainEvent = options?.onDomainEvent;
  }

  getStatus(): ControlPlaneConnectionStatus {
    return this.status;
  }

  getStatusReason(): string | null {
    return this.statusReason;
  }

  async start(): Promise<void> {
    if (this.status === "connected") return;
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = this.connect().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const inFlightStart = this.startPromise;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.rejectPending("Control-plane adapter stopped.");
    const ws = this.ws;
    this.ws = null;
    this.connectRequestId = null;
    this.connectionEpoch = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING)) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          ws.off("close", finish);
          resolve();
        };
        const timer = setTimeout(() => {
          ws.terminate();
          finish();
        }, STOP_CLOSE_TIMEOUT_MS);
        ws.once("close", finish);
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, "controlplane stopping");
        }
      });
    } else {
      ws?.terminate();
    }
    if (inFlightStart) {
      await inFlightStart.catch(() => {});
    }
    if (!this.preserveConnectProfileOnStop) {
      this.connectProfileId = "backend-local";
    }
    this.updateStatus("stopped", null);
  }

  async request<T = unknown>(
    method: string,
    params: unknown,
    options?: { timeoutMs?: number }
  ): Promise<T> {
    const normalizedMethod = method.trim();
    if (!normalizedMethod) {
      throw new Error("Gateway method is required.");
    }
    if (!this.methodAllowlist.has(normalizedMethod)) {
      throw new Error(`Gateway method is not allowlisted: ${normalizedMethod}`);
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.status !== "connected") {
      throw new ControlPlaneGatewayError({
        code: "GATEWAY_UNAVAILABLE",
        message: "Gateway is unavailable.",
      });
    }

    const id = String(this.nextRequestNumber++);
    const frame = { type: "req", id, method: normalizedMethod, params };
    const timeoutMs = resolveRequestTimeoutMs(options?.timeoutMs);

    try {
      const response = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new Error(`Gateway request timed out after ${timeoutMs}ms for method: ${normalizedMethod}`)
          );
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        const rejectSendFailure = () => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`Failed to send gateway request for method: ${normalizedMethod}`));
        };
        try {
          ws.send(JSON.stringify(frame), (err) => {
            if (!err) return;
            rejectSendFailure();
          });
        } catch {
          rejectSendFailure();
        }
      });
      return response as T;
    } catch (error) {
      if (shouldFallbackToLegacyControlUi(error)) {
        await this.switchToLegacyControlUiProfile();
        return this.request<T>(method, params, options);
      }
      if (this.legacyProfileSwitchPromise && this.isTransientProfileSwitchError(error)) {
        await this.legacyProfileSwitchPromise;
        return this.request<T>(method, params, options);
      }
      throw error;
    }
  }

  private async connect(): Promise<void> {
    const settings = this.loadSettings();
    const profile = buildGatewayConnectProfile({
      profileId: this.connectProfileId,
      upstreamUrl: settings.url,
      token: settings.token,
      protocol: CONNECT_PROTOCOL,
      capabilities: CONNECT_CAPABILITIES,
    });
    const connectionEpoch = randomUUID();
    this.connectionEpoch = connectionEpoch;
    const ws = this.createWebSocket(settings.url, profile.socketOptions);
    this.ws = ws;
    this.connectRequestId = null;
    this.updateStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting", null);
    const isActiveConnection = () => this.ws === ws && this.connectionEpoch === connectionEpoch;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let allowReconnectAfterClose = true;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (this.connectTimer) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        fn();
      };

      this.connectTimer = setTimeout(() => {
        settle(() => {
          ws.close(1011, "connect timeout");
          reject(
            new ControlPlaneGatewayConnectError({
              code: "CONNECT_TIMEOUT",
              message: "Control-plane connect timed out waiting for connect response.",
              profileId: profile.id,
              rejectedByGateway: false,
            })
          );
        });
      }, CONNECT_TIMEOUT_MS);

      ws.on("message", (raw) => {
        if (this.stopping || !isActiveConnection()) return;
        const parsed = this.parseFrame(String(raw ?? ""));
        if (!parsed) return;
        if (parsed.type === "event") {
          if (parsed.event === "connect.challenge") {
            this.sendConnectRequest(profile);
            return;
          }
          this.emitEvent({
            type: "gateway.event",
            event: parsed.event,
            seq: typeof parsed.seq === "number" ? parsed.seq : null,
            connectionEpoch: this.connectionEpoch,
            payload: parsed.payload,
            asOf: new Date().toISOString(),
          });
          return;
        }
        if (!this.handleResponseFrame(parsed)) return;
        if (parsed.id === this.connectRequestId) {
          if (parsed.ok) {
            this.reconnectAttempt = 0;
            this.updateStatus("connected", null);
            settle(() => resolve());
            return;
          }
          const code = parsed.error?.code ?? "CONNECT_FAILED";
          const message = parsed.error?.message ?? "Connect failed.";
          settle(() => {
            allowReconnectAfterClose = false;
            ws.close(1011, "connect failed");
            reject(
              new ControlPlaneGatewayConnectError({
                code,
                message: `Control-plane connect rejected: ${code} ${message}`,
                profileId: profile.id,
                details: parsed.error?.details,
                rejectedByGateway: true,
              })
            );
          });
        }
      });

      ws.on("close", () => {
        const activeConnection = isActiveConnection();
        if (!activeConnection && !this.stopping) return;
        if (!settled) {
          if (this.stopping) {
            settle(() => reject(new Error("Control-plane adapter stopped.")));
            return;
          }
          if (!activeConnection) return;
          settle(() =>
            reject(
              new ControlPlaneGatewayConnectError({
                code: "CONNECT_CLOSED",
                message: "Control-plane gateway connection closed during connect.",
                profileId: profile.id,
                rejectedByGateway: false,
              })
            )
          );
          return;
        }
        if (this.stopping) return;
        if (!activeConnection) return;
        this.rejectPending("Control-plane gateway connection closed.");
        this.connectionEpoch = null;
        if (!allowReconnectAfterClose) {
          return;
        }
        this.updateStatus("reconnecting", "gateway_closed");
        this.scheduleReconnect();
      });

      ws.on("error", (error) => {
        if (this.stopping) return;
        if (!isActiveConnection()) return;
        if (!settled) {
          settle(() =>
            reject(
              new ControlPlaneGatewayConnectError({
                code: "CONNECT_FAILED",
                message: resolveConnectFailureMessage(error, settings.url),
                profileId: profile.id,
                rejectedByGateway: false,
              })
            )
          );
        }
      });
    }).catch((err) => {
      this.connectionEpoch = null;
      if (this.stopping) {
        throw err;
      }
      this.updateStatus("error", err instanceof Error ? err.message : "connect_error");
      if (!isConnectRejectionError(err)) {
        this.scheduleReconnect();
      }
      throw err;
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * Math.pow(1.7, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start().catch(() => {});
    }, delay);
  }

  private sendConnectRequest(profile: GatewayConnectProfile): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.connectRequestId) return;
    const id = String(this.nextRequestNumber++);
    this.connectRequestId = id;
    try {
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "connect",
          params: profile.connectParams,
        })
      );
    } catch (err) {
      this.connectRequestId = null;
      const reason = err instanceof Error ? err.message : "connect_send_failed";
      this.updateStatus("error", reason);
      try {
        ws.close(1011, "connect send failed");
      } catch (closeErr) {
        console.error("Failed to close gateway socket after connect-send failure.", closeErr);
      }
    }
  }

  private async switchToLegacyControlUiProfile(): Promise<void> {
    if (this.legacyProfileSwitchPromise) {
      await this.legacyProfileSwitchPromise;
      return;
    }
    if (this.connectProfileId === "legacy-control-ui") return;
    this.legacyProfileSwitchPromise = (async () => {
      this.connectProfileId = "legacy-control-ui";
      this.preserveConnectProfileOnStop = true;
      try {
        await this.stop();
        this.stopping = false;
        await this.start();
      } finally {
        this.preserveConnectProfileOnStop = false;
      }
    })();
    try {
      await this.legacyProfileSwitchPromise;
    } finally {
      this.legacyProfileSwitchPromise = null;
    }
  }

  private isTransientProfileSwitchError(error: unknown): boolean {
    if (error instanceof ControlPlaneGatewayError) {
      return error.code.trim().toUpperCase() === "GATEWAY_UNAVAILABLE";
    }
    if (error instanceof ControlPlaneGatewayConnectError) {
      return !error.rejectedByGateway;
    }
    if (!(error instanceof Error)) return false;
    const message = error.message.trim().toLowerCase();
    return message.includes("adapter stopped") || message.includes("connection closed");
  }

  private parseFrame(raw: string): GatewayEventFrame | GatewayResponseFrame | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isObject(parsed) || typeof parsed.type !== "string") return null;
    if (parsed.type === "event" && typeof parsed.event === "string") {
      return parsed as GatewayEventFrame;
    }
    if (parsed.type === "res" && typeof parsed.id === "string") {
      return parsed as GatewayResponseFrame;
    }
    return null;
  }

  private handleResponseFrame(frame: GatewayResponseFrame): boolean {
    const pending = this.pending.get(frame.id);
    if (!pending) return true;
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.ok) {
      pending.resolve(frame.payload);
      return true;
    }
    pending.reject(
      new ControlPlaneGatewayError({
        code: frame.error?.code ?? "GATEWAY_REQUEST_FAILED",
        message: frame.error?.message ?? "Gateway request failed.",
        details: frame.error?.details,
      })
    );
    return true;
  }

  private rejectPending(message: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private updateStatus(status: ControlPlaneConnectionStatus, reason: string | null): void {
    this.status = status;
    this.statusReason = reason;
    this.emitEvent({
      type: "runtime.status",
      status,
      reason,
      asOf: new Date().toISOString(),
    });
  }

  private emitEvent(event: ControlPlaneDomainEvent): void {
    this.onDomainEvent?.(event);
  }
}
