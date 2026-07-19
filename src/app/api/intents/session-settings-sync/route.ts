import { NextResponse } from "next/server";

import { executeGatewayIntent, parseIntentBody } from "@/lib/controlplane/intent-route";
import { hasMalformedAgentSessionKey, resolveSafeSessionKey } from "@/lib/gateway/session-keys";

export const runtime = "nodejs";

const hasOwn = (value: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

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

  const includeModel = hasOwn(bodyOrError, "model");
  const includeThinkingLevel = hasOwn(bodyOrError, "thinkingLevel");
  const includeExecHost = hasOwn(bodyOrError, "execHost");
  const includeExecSecurity = hasOwn(bodyOrError, "execSecurity");
  const includeExecAsk = hasOwn(bodyOrError, "execAsk");
  if (
    !includeModel &&
    !includeThinkingLevel &&
    !includeExecHost &&
    !includeExecSecurity &&
    !includeExecAsk
  ) {
    return NextResponse.json(
      { error: "At least one session setting field is required." },
      { status: 400 }
    );
  }

  return await executeGatewayIntent("sessions.patch", {
    key: sessionKey,
    ...(includeModel ? { model: bodyOrError.model ?? null } : {}),
    ...(includeThinkingLevel ? { thinkingLevel: bodyOrError.thinkingLevel ?? null } : {}),
    ...(includeExecHost ? { execHost: bodyOrError.execHost ?? null } : {}),
    ...(includeExecSecurity ? { execSecurity: bodyOrError.execSecurity ?? null } : {}),
    ...(includeExecAsk ? { execAsk: bodyOrError.execAsk ?? null } : {}),
  });
}
