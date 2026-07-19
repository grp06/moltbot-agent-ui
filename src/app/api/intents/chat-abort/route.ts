import { NextResponse } from "next/server";

import { executeGatewayIntent, parseIntentBody } from "@/lib/controlplane/intent-route";
import { hasMalformedAgentSessionKey, resolveSafeSessionKey } from "@/lib/gateway/session-keys";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const bodyOrError = await parseIntentBody(request);
  if (bodyOrError instanceof Response) {
    return bodyOrError as NextResponse;
  }
  const rawSessionKey =
    typeof bodyOrError.sessionKey === "string" ? bodyOrError.sessionKey : "";
  if (hasMalformedAgentSessionKey(rawSessionKey)) {
    return NextResponse.json({ error: "Invalid sessionKey." }, { status: 400 });
  }
  const sessionKey = resolveSafeSessionKey(rawSessionKey) ?? "";
  if (!sessionKey) {
    return NextResponse.json({ error: "sessionKey is required." }, { status: 400 });
  }
  const runId = typeof bodyOrError.runId === "string" ? bodyOrError.runId.trim() : "";
  return await executeGatewayIntent("chat.abort", runId ? { sessionKey, runId } : { sessionKey });
}
