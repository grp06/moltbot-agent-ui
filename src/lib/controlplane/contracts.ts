export type ControlPlaneConnectionStatus =
  | "stopped"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export type ControlPlaneDomainEvent =
  | {
      type: "runtime.status";
      status: ControlPlaneConnectionStatus;
      asOf: string;
      reason: string | null;
    }
  | {
      type: "gateway.event";
      event: string;
      seq: number | null;
      connectionEpoch?: string | null;
      payload: unknown;
      asOf: string;
    };

export type ControlPlaneOutboxEntry = {
  id: number;
  event: ControlPlaneDomainEvent;
  createdAt: string;
};

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

export type ControlPlaneGatewaySettings = {
  url: string;
  token: string;
  allowSelfSignedCerts?: boolean;
};

export type ControlPlaneRuntimeSnapshot = {
  status: ControlPlaneConnectionStatus;
  reason: string | null;
  asOf: string | null;
  outboxHead: number;
};
