import {
  parseIntentBody,
  executeGatewayIntent,
  LONG_RUNNING_GATEWAY_INTENT_TIMEOUT_MS,
} from "@/lib/controlplane/intent-route";

export const runtime = "nodejs";

const AGENT_WAIT_TRANSPORT_TIMEOUT_OVERHEAD_MS = 5_000;

const resolveAgentWaitTransportTimeoutMs = (timeoutMs: number | undefined): number => {
  if (typeof timeoutMs !== "number") return LONG_RUNNING_GATEWAY_INTENT_TIMEOUT_MS;
  return Math.min(
    LONG_RUNNING_GATEWAY_INTENT_TIMEOUT_MS,
    timeoutMs + AGENT_WAIT_TRANSPORT_TIMEOUT_OVERHEAD_MS
  );
};

export async function POST(request: Request) {
  const parsed = await parseIntentBody(request);
  if (parsed instanceof Response) return parsed;

  const runId = typeof parsed.runId === "string" ? parsed.runId.trim() : "";
  if (!runId) {
    return Response.json({ error: "runId is required." }, { status: 400 });
  }
  const timeoutMs =
    typeof parsed.timeoutMs === "number" && Number.isFinite(parsed.timeoutMs)
      ? Math.max(1, Math.floor(parsed.timeoutMs))
      : undefined;

  return executeGatewayIntent("agent.wait", {
    runId,
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
  }, {
    timeoutMs: resolveAgentWaitTransportTimeoutMs(timeoutMs),
  });
}
