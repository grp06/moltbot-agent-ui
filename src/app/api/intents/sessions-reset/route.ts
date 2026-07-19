import { parseIntentBody, executeGatewayIntent } from "@/lib/controlplane/intent-route";
import { hasMalformedAgentSessionKey, resolveSafeSessionKey } from "@/lib/gateway/session-keys";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = await parseIntentBody(request);
  if (parsed instanceof Response) return parsed;

  const rawKey = typeof parsed.key === "string" ? parsed.key : "";
  if (hasMalformedAgentSessionKey(rawKey)) {
    return Response.json({ error: "Invalid key." }, { status: 400 });
  }
  const key = resolveSafeSessionKey(rawKey) ?? "";
  if (!key) {
    return Response.json({ error: "key is required." }, { status: 400 });
  }

  return executeGatewayIntent("sessions.reset", { key });
}
