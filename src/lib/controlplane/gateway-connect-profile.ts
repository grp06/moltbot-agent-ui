export type GatewayConnectProfileId = "backend-local" | "legacy-control-ui";

export type GatewaySocketOptions = {
  origin?: string;
};

export type GatewayConnectProfile = {
  id: GatewayConnectProfileId;
  socketOptions: GatewaySocketOptions;
  connectParams: {
    minProtocol: number;
    maxProtocol: number;
    client: {
      id: string;
      version: string;
      platform: string;
      mode: string;
    };
    role: "operator";
    scopes: string[];
    caps: string[];
    auth: { token: string };
  };
};

const CONNECT_CLIENT_ID_BACKEND = "gateway-client";
const CONNECT_CLIENT_MODE_BACKEND = "backend";
const CONNECT_CLIENT_PLATFORM_BACKEND = "node";
const CONNECT_CLIENT_ID_LEGACY = "openclaw-control-ui";
const CONNECT_CLIENT_MODE_LEGACY = "webchat";
const CONNECT_CLIENT_PLATFORM_LEGACY = "web";
const OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeParsedHostname = (hostname: string): string =>
  hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");

const resolveOriginForUpstream = (upstreamUrl: string): string => {
  const url = new URL(upstreamUrl);
  const proto = url.protocol === "wss:" ? "https:" : "http:";
  const normalizedHostname = normalizeParsedHostname(url.hostname);
  const hostname =
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1" ||
    normalizedHostname === "0.0.0.0"
      ? "localhost"
      : url.hostname;
  const host = url.port ? `${hostname}:${url.port}` : hostname;
  return `${proto}//${host}`;
};

const resolveGatewayErrorCode = (error: unknown): string => {
  if (!isRecord(error) || typeof error.code !== "string") {
    return "";
  }
  return error.code.trim().toUpperCase();
};

const resolveGatewayErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message.trim().toLowerCase();
  }
  if (!isRecord(error) || typeof error.message !== "string") {
    return "";
  }
  return error.message.trim().toLowerCase();
};

export function buildGatewayConnectProfile(args: {
  profileId: GatewayConnectProfileId;
  upstreamUrl: string;
  token: string;
  protocol: number;
  capabilities: string[];
}): GatewayConnectProfile {
  const baseParams = {
    minProtocol: args.protocol,
    maxProtocol: args.protocol,
    role: "operator" as const,
    scopes: [...OPERATOR_SCOPES],
    caps: [...args.capabilities],
    auth: { token: args.token },
  };

  if (args.profileId === "legacy-control-ui") {
    return {
      id: args.profileId,
      socketOptions: { origin: resolveOriginForUpstream(args.upstreamUrl) },
      connectParams: {
        ...baseParams,
        client: {
          id: CONNECT_CLIENT_ID_LEGACY,
          version: "dev",
          platform: CONNECT_CLIENT_PLATFORM_LEGACY,
          mode: CONNECT_CLIENT_MODE_LEGACY,
        },
      },
    };
  }

  return {
    id: args.profileId,
    socketOptions: {},
    connectParams: {
      ...baseParams,
      client: {
        id: CONNECT_CLIENT_ID_BACKEND,
        version: "dev",
        platform: CONNECT_CLIENT_PLATFORM_BACKEND,
        mode: CONNECT_CLIENT_MODE_BACKEND,
      },
    },
  };
}

export function shouldFallbackToLegacyControlUi(error: unknown): boolean {
  if (resolveGatewayErrorCode(error) !== "INVALID_REQUEST") {
    return false;
  }
  const message = resolveGatewayErrorMessage(error);
  return (
    message.includes("missing scope: operator.read") ||
    message.includes("missing scope: operator.write") ||
    message.includes("missing scope: operator.admin")
  );
}
