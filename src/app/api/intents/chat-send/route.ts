import { NextResponse } from "next/server";

import { executeGatewayIntent, parseIntentBody } from "@/lib/controlplane/intent-route";
import { hasMalformedAgentSessionKey, resolveSafeSessionKey } from "@/lib/gateway/session-keys";

export const runtime = "nodejs";

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
  const message = typeof bodyOrError.message === "string" ? bodyOrError.message : "";
  const idempotencyKey =
    typeof bodyOrError.idempotencyKey === "string" ? bodyOrError.idempotencyKey.trim() : "";
  const deliver = Boolean(bodyOrError.deliver);

  if (!sessionKey || !message.trim() || !idempotencyKey) {
    return NextResponse.json(
      { error: "sessionKey, message, and idempotencyKey are required." },
      { status: 400 }
    );
  }

  return await executeGatewayIntent("chat.send", {
    sessionKey,
    message,
    idempotencyKey,
    deliver,
  });
}
