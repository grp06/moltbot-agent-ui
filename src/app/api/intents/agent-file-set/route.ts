import { NextResponse } from "next/server";

import { executeGatewayIntent, parseIntentBody } from "@/lib/controlplane/intent-route";
import { isAgentFileName } from "@/lib/agents/agentFiles";
import { isSafeAgentId } from "@/lib/agents/agentIds";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const bodyOrError = await parseIntentBody(request);
  if (bodyOrError instanceof Response) {
    return bodyOrError as NextResponse;
  }

  const agentId = typeof bodyOrError.agentId === "string" ? bodyOrError.agentId.trim() : "";
  const name = typeof bodyOrError.name === "string" ? bodyOrError.name.trim() : "";
  const content = typeof bodyOrError.content === "string" ? bodyOrError.content : null;
  if (!agentId || !name || content === null) {
    return NextResponse.json({ error: "agentId, name, and content are required." }, { status: 400 });
  }
  if (!isSafeAgentId(agentId)) {
    return NextResponse.json({ error: `Invalid agentId: ${agentId}` }, { status: 400 });
  }
  if (!isAgentFileName(name)) {
    return NextResponse.json({ error: `Unsupported agent file name: ${name}` }, { status: 400 });
  }

  return await executeGatewayIntent("agents.files.set", {
    agentId,
    name,
    content,
  });
}
