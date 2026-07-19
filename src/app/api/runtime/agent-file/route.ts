import { NextResponse } from "next/server";

import { executeRuntimeGatewayRead } from "@/lib/controlplane/runtime-read-route";
import { isAgentFileName } from "@/lib/agents/agentFiles";
import { isSafeAgentId } from "@/lib/agents/agentIds";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const agentId = (url.searchParams.get("agentId") ?? "").trim();
  const name = (url.searchParams.get("name") ?? "").trim();
  if (!agentId || !name) {
    return NextResponse.json({ error: "agentId and name are required." }, { status: 400 });
  }
  if (!isSafeAgentId(agentId)) {
    return NextResponse.json({ error: `Invalid agentId: ${agentId}` }, { status: 400 });
  }
  if (!isAgentFileName(name)) {
    return NextResponse.json({ error: `Unsupported agent file name: ${name}` }, { status: 400 });
  }

  return await executeRuntimeGatewayRead("agents.files.get", {
    agentId,
    name,
  });
}
