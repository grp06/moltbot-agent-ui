import { NextResponse } from "next/server";

import { isSafeAgentId } from "@/lib/agents/agentIds";
import { executeGatewayIntent, parseIntentBody } from "@/lib/controlplane/intent-route";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const bodyOrError = await parseIntentBody(request);
  if (bodyOrError instanceof Response) {
    return bodyOrError as NextResponse;
  }
  const agentId = typeof bodyOrError.agentId === "string" ? bodyOrError.agentId.trim() : "";
  if (!agentId) {
    return NextResponse.json({ error: "agentId is required." }, { status: 400 });
  }
  if (!isSafeAgentId(agentId)) {
    return NextResponse.json({ error: `Invalid agentId: ${agentId}` }, { status: 400 });
  }
  return await executeGatewayIntent("agents.delete", { agentId });
}
