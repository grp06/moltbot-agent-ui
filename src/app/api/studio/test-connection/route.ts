import { NextResponse } from "next/server";

import {
  OpenClawGatewayAdapter,
  serializeControlPlaneGatewayConnectFailure,
} from "@/lib/controlplane/openclaw-adapter";
import { resolveGatewayTokenForUrl } from "@/lib/studio/settings-store";

export const runtime = "nodejs";

type TestConnectionRequestBody = {
  gateway?: {
    url?: unknown;
    token?: unknown;
  } | null;
  useStoredToken?: unknown;
};

const readString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

export async function POST(request: Request) {
  let adapter: OpenClawGatewayAdapter | null = null;
  let body: TestConnectionRequestBody;
  try {
    body = (await request.json()) as TestConnectionRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON payload." }, { status: 400 });
  }

  try {
    const url = readString(body?.gateway?.url);
    if (!url) {
      return NextResponse.json({ ok: false, error: "Gateway URL is required." }, { status: 400 });
    }

    const tokenInput = readString(body?.gateway?.token);
    const useStoredToken = body?.useStoredToken !== false;
    const token = tokenInput || (useStoredToken ? resolveGatewayTokenForUrl(url) : "");
    if (!token) {
      return NextResponse.json(
        {
          ok: false,
          error: "Gateway token is required. Enter one or keep the stored token.",
        },
        { status: 400 }
      );
    }

    adapter = new OpenClawGatewayAdapter({
      loadSettings: () => ({ url, token }),
    });
    await adapter.start();
    return NextResponse.json({
      ok: true,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    const startFailure = serializeControlPlaneGatewayConnectFailure(error);
    const message = startFailure?.message ?? (error instanceof Error ? error.message : "Connection test failed.");
    return NextResponse.json(
      {
        ok: false,
        error: message,
        ...(startFailure ? { startFailure } : {}),
        checkedAt: new Date().toISOString(),
      },
      { status: 200 }
    );
  } finally {
    if (adapter) {
      try {
        await adapter.stop();
      } catch {}
    }
  }
}
