import { NextResponse } from "next/server";

import { isSafeAgentId } from "@/lib/agents/agentIds";
import { restoreAgentStateLocally, trashAgentStateLocally } from "@/lib/agent-state/local";
import { isLocalGatewayUrl } from "@/lib/gateway/local-gateway";
import {
  resolveConfiguredSshTarget,
  resolveGatewaySshTargetFromGatewayUrl,
} from "@/lib/ssh/gateway-host";
import {
  restoreAgentStateOverSsh,
  trashAgentStateOverSsh,
} from "@/lib/ssh/agent-state";
import { loadStudioSettings } from "@/lib/studio/settings-store";

export const runtime = "nodejs";

type TrashAgentStateRequest = {
  agentId: string;
};

type RestoreAgentStateRequest = {
  agentId: string;
  trashDir: string;
};

const resolveAgentStateSshTarget = (): string | null => {
  const configured = resolveConfiguredSshTarget(process.env);
  if (configured) return configured;
  const settings = loadStudioSettings();
  const gatewayUrl = settings.gateway?.url ?? "";
  if (isLocalGatewayUrl(gatewayUrl)) return null;
  return resolveGatewaySshTargetFromGatewayUrl(gatewayUrl, process.env);
};

const parseAgentStateBody = async (
  request: Request
): Promise<Record<string, unknown> | NextResponse> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
  }
  return body as Record<string, unknown>;
};

export async function POST(request: Request) {
  const bodyOrError = await parseAgentStateBody(request);
  if (bodyOrError instanceof Response) {
    return bodyOrError as NextResponse;
  }

  try {
    const { agentId } = bodyOrError as Partial<TrashAgentStateRequest>;
    const trimmed = typeof agentId === "string" ? agentId.trim() : "";
    if (!trimmed) {
      return NextResponse.json({ error: "agentId is required." }, { status: 400 });
    }
    if (!isSafeAgentId(trimmed)) {
      return NextResponse.json({ error: `Invalid agentId: ${trimmed}` }, { status: 400 });
    }

    const sshTarget = resolveAgentStateSshTarget();
    const result = sshTarget
      ? trashAgentStateOverSsh({ sshTarget, agentId: trimmed })
      : trashAgentStateLocally({ agentId: trimmed });
    return NextResponse.json({ result });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to trash agent workspace/state.";
    console.error(message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const bodyOrError = await parseAgentStateBody(request);
  if (bodyOrError instanceof Response) {
    return bodyOrError as NextResponse;
  }

  try {
    const { agentId, trashDir } = bodyOrError as Partial<RestoreAgentStateRequest>;
    const trimmedAgent = typeof agentId === "string" ? agentId.trim() : "";
    const trimmedTrash = typeof trashDir === "string" ? trashDir.trim() : "";
    if (!trimmedAgent) {
      return NextResponse.json({ error: "agentId is required." }, { status: 400 });
    }
    if (!trimmedTrash) {
      return NextResponse.json({ error: "trashDir is required." }, { status: 400 });
    }
    if (!isSafeAgentId(trimmedAgent)) {
      return NextResponse.json({ error: `Invalid agentId: ${trimmedAgent}` }, { status: 400 });
    }

    const sshTarget = resolveAgentStateSshTarget();
    const result = sshTarget
      ? restoreAgentStateOverSsh({
          sshTarget,
          agentId: trimmedAgent,
          trashDir: trimmedTrash,
        })
      : restoreAgentStateLocally({
          agentId: trimmedAgent,
          trashDir: trimmedTrash,
        });
    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to restore agent state.";
    console.error(message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
