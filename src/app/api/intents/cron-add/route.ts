import { NextResponse } from "next/server";

import { isSafeAgentId } from "@/lib/agents/agentIds";
import { executeGatewayIntent, parseIntentBody } from "@/lib/controlplane/intent-route";
import { resolveOptionalCronSessionKey } from "@/lib/cron/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const bodyOrError = await parseIntentBody(request);
  if (bodyOrError instanceof Response) {
    return bodyOrError as NextResponse;
  }

  const name = typeof bodyOrError.name === "string" ? bodyOrError.name.trim() : "";
  const agentId = typeof bodyOrError.agentId === "string" ? bodyOrError.agentId.trim() : "";
  if (!name || !agentId) {
    return NextResponse.json({ error: "name and agentId are required." }, { status: 400 });
  }
  if (!isSafeAgentId(agentId)) {
    return NextResponse.json({ error: `Invalid agentId: ${agentId}` }, { status: 400 });
  }
  let sessionKey: string | undefined;
  try {
    sessionKey = resolveOptionalCronSessionKey(bodyOrError.sessionKey, agentId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid sessionKey.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return await executeGatewayIntent("cron.add", {
    ...bodyOrError,
    name,
    agentId,
    ...(bodyOrError.sessionKey !== undefined ? { sessionKey } : {}),
  });
}
