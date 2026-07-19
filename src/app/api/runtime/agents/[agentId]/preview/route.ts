import { NextResponse } from "next/server";

import { deriveRuntimeFreshness } from "@/lib/controlplane/degraded-read";
import { ControlPlaneGatewayError } from "@/lib/controlplane/openclaw-adapter";
import { serializeRuntimeInitFailure } from "@/lib/controlplane/runtime-init-errors";
import { bootstrapDomainRuntime } from "@/lib/controlplane/runtime-route-bootstrap";
import { extractText, stripUiMetadata } from "@/lib/text/message-extract";
import { isSafeAgentId } from "@/lib/agents/agentIds";
import { sessionKeyBelongsToAgent } from "@/lib/gateway/session-keys";

export const runtime = "nodejs";

type GatewayPreviewItem = {
  role?: unknown;
  text?: unknown;
  timestamp?: unknown;
};

type SessionsPreviewPayload = {
  previews?: Array<{
    key?: unknown;
    items?: unknown[];
  }>;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;
const DEFAULT_MAX_CHARS = 360;
const MIN_MAX_CHARS = 40;
const MAX_MAX_CHARS = 2000;

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const resolveBoundedPositiveInt = (params: {
  raw: string | null;
  fallback: number;
  min: number;
  max: number;
}): number => {
  if (!params.raw) return params.fallback;
  const parsed = Number(params.raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return params.fallback;
  return Math.min(params.max, Math.max(params.min, Math.floor(parsed)));
};

const mapGatewayError = (error: unknown): NextResponse => {
  if (error instanceof ControlPlaneGatewayError) {
    if (error.code.trim().toUpperCase() === "GATEWAY_UNAVAILABLE") {
      return NextResponse.json(
        {
          error: error.message,
          code: "GATEWAY_UNAVAILABLE",
          reason: "gateway_unavailable",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        details: error.details,
      },
      { status: 400 }
    );
  }
  const message = error instanceof Error ? error.message : "runtime_read_failed";
  return NextResponse.json({ error: message }, { status: 500 });
};

const sanitizePreviewItems = (items: unknown[]): Array<{
  role: "user" | "assistant";
  text: string;
  timestamp?: number | string;
}> => {
  const sanitized: Array<{
    role: "user" | "assistant";
    text: string;
    timestamp?: number | string;
  }> = [];
  for (const item of items) {
    const record = asRecord(item) as GatewayPreviewItem | null;
    if (!record) continue;
    const roleRaw = typeof record.role === "string" ? record.role.trim().toLowerCase() : "";
    if (roleRaw !== "user" && roleRaw !== "assistant") continue;
    const rawText = typeof record.text === "string" ? record.text : "";
    const extracted = extractText({
      role: roleRaw,
      text: rawText,
    });
    const text = stripUiMetadata(extracted ?? rawText).trim();
    if (!text) continue;
    sanitized.push({
      role: roleRaw,
      text,
      ...(typeof record.timestamp === "number" || typeof record.timestamp === "string"
        ? { timestamp: record.timestamp }
        : {}),
    });
  }
  return sanitized;
};

export async function GET(
  request: Request,
  context: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await context.params;
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return NextResponse.json({ error: "agentId is required." }, { status: 400 });
  }
  if (!isSafeAgentId(normalizedAgentId)) {
    return NextResponse.json({ error: `Invalid agentId: ${normalizedAgentId}` }, { status: 400 });
  }

  const bootstrap = await bootstrapDomainRuntime();
  if (bootstrap.kind === "mode-disabled") {
    return NextResponse.json({ enabled: false, error: "domain_api_mode_disabled" }, { status: 404 });
  }
  if (bootstrap.kind === "runtime-init-failed") {
    return NextResponse.json(
      {
        enabled: true,
        ...serializeRuntimeInitFailure(bootstrap.failure),
      },
      { status: 503 }
    );
  }
  const controlPlane = bootstrap.runtime;
  const startError = bootstrap.kind === "start-failed" ? bootstrap.message : null;

  const url = new URL(request.url);
  const sessionKeyRaw = (url.searchParams.get("sessionKey") ?? "").trim();
  const sessionKey = sessionKeyRaw || `agent:${normalizedAgentId}:main`;
  if (!sessionKeyBelongsToAgent(sessionKey, normalizedAgentId)) {
    return NextResponse.json(
      { error: "sessionKey does not match agentId." },
      { status: 400 }
    );
  }
  const limit = resolveBoundedPositiveInt({
    raw: url.searchParams.get("limit"),
    fallback: DEFAULT_LIMIT,
    min: 1,
    max: MAX_LIMIT,
  });
  const maxChars = resolveBoundedPositiveInt({
    raw: url.searchParams.get("maxChars"),
    fallback: DEFAULT_MAX_CHARS,
    min: MIN_MAX_CHARS,
    max: MAX_MAX_CHARS,
  });

  const snapshot = controlPlane.snapshot();
  let payload: SessionsPreviewPayload;
  try {
    payload = await controlPlane.callGateway<SessionsPreviewPayload>("sessions.preview", {
      keys: [sessionKey],
      limit,
      maxChars,
    });
  } catch (error) {
    return mapGatewayError(error);
  }

  const previews = Array.isArray(payload?.previews) ? payload.previews : [];
  const matched =
    previews.find((entry) => {
      const key = typeof entry?.key === "string" ? entry.key.trim() : "";
      return key === sessionKey;
    }) ?? null;
  const rawItems = Array.isArray(matched?.items) ? matched.items : [];

  return NextResponse.json({
    enabled: true,
    ...(startError ? { error: startError } : {}),
    agentId: normalizedAgentId,
    sessionKey,
    items: sanitizePreviewItems(rawItems),
    freshness: deriveRuntimeFreshness(snapshot, null),
  });
}
