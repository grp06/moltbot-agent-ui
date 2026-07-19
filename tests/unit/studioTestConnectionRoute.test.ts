// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const makeTempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

describe("studio test-connection route", () => {
  const priorStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempDir: string | null = null;

  afterEach(() => {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    vi.restoreAllMocks();
    vi.doUnmock("@/lib/controlplane/openclaw-adapter");
    vi.doUnmock("@/lib/studio/settings-store");
    vi.resetModules();
  });

  it("returns 400 when the gateway URL is missing", async () => {
    const { POST } = await import("@/app/api/studio/test-connection/route");
    const response = await POST(
      new Request("http://localhost/api/studio/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gateway: { token: "secret" } }),
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Gateway URL is required.");
  });

  it("returns 400 for malformed JSON", async () => {
    const { POST } = await import("@/app/api/studio/test-connection/route");
    const response = await POST(
      new Request("http://localhost/api/studio/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Invalid JSON payload.");
  });

  it("returns structured start failure metadata when adapter startup fails", async () => {
    vi.doMock("@/lib/controlplane/openclaw-adapter", async () => {
      const actual = await vi.importActual<typeof import("@/lib/controlplane/openclaw-adapter")>(
        "@/lib/controlplane/openclaw-adapter"
      );
      return {
        ...actual,
        OpenClawGatewayAdapter: class {
          async start() {
            throw new actual.ControlPlaneGatewayConnectError({
              code: "INVALID_REQUEST",
              message:
                "Control-plane connect rejected: INVALID_REQUEST control ui requires device identity (use HTTPS or localhost secure context)",
              profileId: "legacy-control-ui",
              details: { code: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED" },
              rejectedByGateway: true,
            });
          }

          async stop() {}
        },
      };
    });
    vi.doMock("@/lib/studio/settings-store", () => ({
      resolveGatewayTokenForUrl: () => "stored-secret",
    }));

    const { POST } = await import("@/app/api/studio/test-connection/route");
    const response = await POST(
      new Request("http://localhost/api/studio/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gateway: { url: "ws://localhost:18789" },
          useStoredToken: true,
        }),
      })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok?: boolean;
      error?: string;
      startFailure?: {
        code?: string;
        message?: string;
        profileId?: string;
        details?: unknown;
      };
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("control ui requires device identity");
    expect(body.startFailure).toEqual({
      code: "INVALID_REQUEST",
      message:
        "Control-plane connect rejected: INVALID_REQUEST control ui requires device identity (use HTTPS or localhost secure context)",
      profileId: "legacy-control-ui",
      details: { code: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED" },
    });
  });

  it("does not use a local openclaw token when testing a remote gateway url", async () => {
    tempDir = makeTempDir("studio-test-connection-remote-local-token");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    fs.writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify({ gateway: { port: 18789, auth: { token: "local-token" } } }, null, 2),
      "utf8"
    );

    const { POST } = await import("@/app/api/studio/test-connection/route");
    const response = await POST(
      new Request("http://localhost/api/studio/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gateway: { url: "wss://gateway.example" },
          useStoredToken: true,
        }),
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Gateway token is required. Enter one or keep the stored token.");
  });

  it("does not use a stored token when testing a different gateway url", async () => {
    tempDir = makeTempDir("studio-test-connection-stored-token-scope");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    fs.mkdirSync(path.join(tempDir, "openclaw-studio"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "openclaw-studio", "settings.json"),
      JSON.stringify(
        { version: 1, gateway: { url: "wss://gateway.old.example", token: "stored-token" } },
        null,
        2
      ),
      "utf8"
    );

    const { POST } = await import("@/app/api/studio/test-connection/route");
    const response = await POST(
      new Request("http://localhost/api/studio/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gateway: { url: "wss://gateway.new.example" },
          useStoredToken: true,
        }),
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Gateway token is required. Enter one or keep the stored token.");
  });
});
