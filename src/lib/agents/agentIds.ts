const SAFE_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DEFAULT_AGENT_ID = "main";
const INVALID_AGENT_ID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

export const isSafeAgentId = (value: string): boolean => SAFE_AGENT_ID_RE.test(value.trim());

export const resolveSafeAgentId = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  return isSafeAgentId(trimmed) ? trimmed : null;
};

export const normalizeOpenClawAgentId = (value: unknown): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return DEFAULT_AGENT_ID;
  const normalized = trimmed.toLowerCase();
  if (isSafeAgentId(trimmed)) return normalized;
  return (
    normalized
      .replace(INVALID_AGENT_ID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
};

export const resolveCreatableOpenClawAgentId = (name: string): string => {
  const agentId = normalizeOpenClawAgentId(name);
  if (agentId === DEFAULT_AGENT_ID) {
    throw new Error('Agent name resolves to reserved agent id "main".');
  }
  return agentId;
};
