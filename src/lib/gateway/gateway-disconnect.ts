import { GatewayResponseError } from "@/lib/gateway/errors";

export const isGatewayDisconnectLikeError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (!msg) return false;
  if (
    msg.includes("gateway not connected") ||
    msg.includes("gateway is not connected") ||
    msg.includes("gateway client stopped")
  ) {
    return true;
  }

  const match = msg.match(/gateway closed \((\d+)\)/);
  if (!match) return false;
  const code = Number(match[1]);
  return Number.isFinite(code) && code === 1012;
};

const WEBCHAT_SESSION_MUTATION_BLOCKED_RE = /webchat clients cannot (patch|delete) sessions/i;
const WEBCHAT_SESSION_MUTATION_HINT_RE = /use chat\.send for session-scoped updates/i;

export const isWebchatSessionMutationBlockedError = (error: unknown): boolean => {
  if (!(error instanceof GatewayResponseError)) return false;
  if (error.code.trim().toUpperCase() !== "INVALID_REQUEST") return false;
  const message = error.message.trim();
  if (!message) return false;
  return (
    WEBCHAT_SESSION_MUTATION_BLOCKED_RE.test(message) &&
    WEBCHAT_SESSION_MUTATION_HINT_RE.test(message)
  );
};
