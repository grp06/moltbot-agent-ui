import type { AgentFileName } from "@/lib/agents/agentFiles";
import { isSafeAgentId } from "@/lib/agents/agentIds";
import type { GatewayClient } from "@/lib/gateway/GatewayClient";

type AgentsFilesGetResponse = {
  file?: { missing?: unknown; content?: unknown };
};

const callGateway = async <T>(
  client: GatewayClient,
  method: string,
  params: unknown
): Promise<T> => {
  const invoke = (
    client as unknown as { call?: (nextMethod: string, nextParams: unknown) => Promise<unknown> }
  ).call;
  if (typeof invoke !== "function") {
    throw new Error("Legacy gateway client call transport is unavailable.");
  }
  return (await invoke(method, params)) as T;
};

const resolveAgentId = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("agentId is required.");
  }
  if (!isSafeAgentId(trimmed)) {
    throw new Error(`Invalid agentId: ${trimmed}`);
  }
  return trimmed;
};

export const readGatewayAgentFile = async (params: {
  client: GatewayClient;
  agentId: string;
  name: AgentFileName;
}): Promise<{ exists: boolean; content: string }> => {
  const agentId = resolveAgentId(params.agentId);
  const response = await callGateway<AgentsFilesGetResponse>(params.client, "agents.files.get", {
    agentId,
    name: params.name,
  });
  const file = response?.file;
  const fileRecord = file && typeof file === "object" ? (file as Record<string, unknown>) : null;
  const missing = fileRecord?.missing === true;
  const content =
    fileRecord && typeof fileRecord.content === "string" ? fileRecord.content : "";
  return { exists: !missing, content };
};

export const writeGatewayAgentFiles = async (params: {
  client: GatewayClient;
  agentId: string;
  files: Partial<Record<AgentFileName, string>>;
}): Promise<void> => {
  const agentId = resolveAgentId(params.agentId);
  const entries = Object.entries(params.files).filter(
    (entry): entry is [AgentFileName, string] => typeof entry[1] === "string"
  );
  for (const [name, content] of entries) {
    await callGateway(params.client, "agents.files.set", {
      agentId,
      name,
      content,
    });
  }
};
