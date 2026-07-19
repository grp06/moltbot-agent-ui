import { isSafeAgentId } from "@/lib/agents/agentIds";

export const buildAgentMainSessionKey = (agentId: string, mainKey: string) => {
  const trimmedAgent = agentId.trim();
  const trimmedKey = mainKey.trim() || "main";
  return `agent:${trimmedAgent}:${trimmedKey}`;
};

export const parseAgentIdFromSessionKey = (sessionKey: string): string | null => {
  const match = sessionKey.trim().match(/^agent:([^:]+):(.+)$/i);
  const agentId = match?.[1]?.trim() ?? "";
  const rest = match?.[2]?.trim() ?? "";
  if (!agentId || !rest || !isSafeAgentId(agentId)) return null;
  return agentId;
};

export const hasMalformedAgentSessionKey = (sessionKey: string): boolean => {
  const trimmed = sessionKey.trim();
  return /^agent:/i.test(trimmed) && parseAgentIdFromSessionKey(trimmed) === null;
};

export const resolveSafeSessionKey = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  return hasMalformedAgentSessionKey(trimmed) ? null : trimmed;
};

export const sessionKeyBelongsToAgent = (sessionKey: string, agentId: string): boolean => {
  const parsedAgentId = parseAgentIdFromSessionKey(sessionKey);
  if (!parsedAgentId) return false;
  return parsedAgentId.trim().toLowerCase() === agentId.trim().toLowerCase();
};

export const isSameSessionKey = (a: string, b: string) => {
  const left = a.trim();
  const right = b.trim();
  return left.length > 0 && left === right;
};
