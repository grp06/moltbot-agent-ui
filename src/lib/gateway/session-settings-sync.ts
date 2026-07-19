import { hasMalformedAgentSessionKey } from "@/lib/gateway/session-keys";

type SessionSettingsPatchPayload = {
  key: string;
  model?: string | null;
  thinkingLevel?: string | null;
  execHost?: "sandbox" | "gateway" | "node" | null;
  execSecurity?: "deny" | "allowlist" | "full" | null;
  execAsk?: "off" | "on-miss" | "always" | null;
};

export type GatewaySessionsPatchResult = {
  ok: true;
  key: string;
  entry?: {
    thinkingLevel?: string;
  };
  resolved?: {
    modelProvider?: string;
    model?: string;
  };
};

type GatewaySessionSettingsSyncClient = {
  call: <T = unknown>(method: string, params: unknown) => Promise<T>;
};

type SyncGatewaySessionSettingsParams = {
  client: GatewaySessionSettingsSyncClient;
  sessionKey: string;
  model?: string | null;
  thinkingLevel?: string | null;
  execHost?: "sandbox" | "gateway" | "node" | null;
  execSecurity?: "deny" | "allowlist" | "full" | null;
  execAsk?: "off" | "on-miss" | "always" | null;
};

export const syncGatewaySessionSettings = async ({
  client,
  sessionKey,
  model,
  thinkingLevel,
  execHost,
  execSecurity,
  execAsk,
}: SyncGatewaySessionSettingsParams) => {
  const key = sessionKey.trim();
  if (!key) {
    throw new Error("Session key is required.");
  }
  if (hasMalformedAgentSessionKey(key)) {
    throw new Error("Invalid sessionKey.");
  }
  const includeModel = model !== undefined;
  const includeThinkingLevel = thinkingLevel !== undefined;
  const includeExecHost = execHost !== undefined;
  const includeExecSecurity = execSecurity !== undefined;
  const includeExecAsk = execAsk !== undefined;
  if (
    !includeModel &&
    !includeThinkingLevel &&
    !includeExecHost &&
    !includeExecSecurity &&
    !includeExecAsk
  ) {
    throw new Error("At least one session setting must be provided.");
  }
  const payload: SessionSettingsPatchPayload = { key };
  if (includeModel) {
    payload.model = model ?? null;
  }
  if (includeThinkingLevel) {
    payload.thinkingLevel = thinkingLevel ?? null;
  }
  if (includeExecHost) {
    payload.execHost = execHost ?? null;
  }
  if (includeExecSecurity) {
    payload.execSecurity = execSecurity ?? null;
  }
  if (includeExecAsk) {
    payload.execAsk = execAsk ?? null;
  }
  return await client.call<GatewaySessionsPatchResult>("sessions.patch", payload);
};
