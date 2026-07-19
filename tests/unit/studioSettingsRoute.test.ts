import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GET, PUT } from "@/app/api/studio/route";

const makeTempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

describe("studio settings route", () => {
  const priorStateDir = process.env.OPENCLAW_STATE_DIR;
  const priorStudioDomainApiMode = process.env.STUDIO_DOMAIN_API_MODE;
  const priorNextPublicStudioDomainApiMode = process.env.NEXT_PUBLIC_STUDIO_DOMAIN_API_MODE;
  let tempDir: string | null = null;

  afterEach(() => {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
    process.env.STUDIO_DOMAIN_API_MODE = priorStudioDomainApiMode;
    process.env.NEXT_PUBLIC_STUDIO_DOMAIN_API_MODE = priorNextPublicStudioDomainApiMode;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("GET returns default settings when missing", async () => {
    tempDir = makeTempDir("studio-settings-get-default");
    process.env.OPENCLAW_STATE_DIR = tempDir;

    const response = await GET();
    const body = (await response.json()) as {
      settings?: Record<string, unknown>;
      localGatewayDefaults?: unknown;
      localGatewayDefaultsMeta?: { hasToken?: unknown };
      gatewayMeta?: { hasStoredToken?: unknown; credentialScope?: unknown };
      installContext?: Record<string, unknown>;
      domainApiModeEnabled?: unknown;
    };

    expect(response.status).toBe(200);
    expect(body.settings?.gateway).toBe(null);
    expect(body.localGatewayDefaults ?? null).toBeNull();
    expect(body.localGatewayDefaultsMeta?.hasToken).toBe(false);
    expect(body.gatewayMeta?.hasStoredToken).toBe(false);
    expect(body.gatewayMeta?.credentialScope).toBe("");
    expect(body.installContext).toBeTruthy();
    expect(typeof body.domainApiModeEnabled).toBe("boolean");
    expect(body.settings?.version).toBe(1);
    expect(body.settings?.gatewayAutoStart).toBe(true);
  });

  it("GET always reports domain mode enabled", async () => {
    tempDir = makeTempDir("studio-settings-domain-mode");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    process.env.NEXT_PUBLIC_STUDIO_DOMAIN_API_MODE = "true";
    process.env.STUDIO_DOMAIN_API_MODE = "false";

    const response = await GET();
    const body = (await response.json()) as { domainApiModeEnabled?: unknown };
    expect(response.status).toBe(200);
    expect(body.domainApiModeEnabled).toBe(true);
  });

  it("GET returns local gateway defaults from openclaw.json", async () => {
    tempDir = makeTempDir("studio-settings-get-local-defaults");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    fs.writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify({ gateway: { port: 18791, auth: { token: "local-token" } } }, null, 2),
      "utf8"
    );

    const response = await GET();
    const body = (await response.json()) as {
      settings?: { gateway?: { url?: string; token?: string } | null };
      localGatewayDefaults?: { url?: string; token?: string } | null;
      localGatewayDefaultsMeta?: { hasToken?: unknown };
      gatewayMeta?: { hasStoredToken?: unknown; credentialScope?: unknown };
    };

    expect(response.status).toBe(200);
    expect(body.localGatewayDefaults).toEqual({
      url: "ws://localhost:18791",
      token: "",
    });
    expect(body.localGatewayDefaultsMeta?.hasToken).toBe(true);
    expect(body.gatewayMeta?.hasStoredToken).toBe(false);
    expect(typeof body.gatewayMeta?.credentialScope).toBe("string");
    expect(body.gatewayMeta?.credentialScope).not.toBe("");
    expect(body.settings?.gateway).toEqual({
      url: "ws://localhost:18791",
      token: "",
    });
  });

  it("PUT returns 400 for non-object JSON payload", async () => {
    tempDir = makeTempDir("studio-settings-put-invalid");
    process.env.OPENCLAW_STATE_DIR = tempDir;

    const response = await PUT({
      json: async () => "nope",
    } as unknown as Request);
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(typeof body.error).toBe("string");
    expect(body.error?.length).toBeGreaterThan(0);
  });

  it("PUT returns 400 for array JSON payload", async () => {
    tempDir = makeTempDir("studio-settings-put-array-invalid");
    process.env.OPENCLAW_STATE_DIR = tempDir;

    const response = await PUT({
      json: async () => [],
    } as unknown as Request);
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid settings payload.");
  });

  it("PUT returns 400 for malformed JSON payload", async () => {
    tempDir = makeTempDir("studio-settings-put-json-invalid");
    process.env.OPENCLAW_STATE_DIR = tempDir;

    const response = await PUT(
      new Request("http://localhost/api/studio", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    );
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON payload.");
  });

  it("PUT persists a patch and GET returns merged settings", async () => {
    tempDir = makeTempDir("studio-settings-put-persist");
    process.env.OPENCLAW_STATE_DIR = tempDir;

    const patch = {
      gateway: { url: "ws://example.test:1234", token: "t" },
    };

    const putResponse = await PUT({
      json: async () => patch,
    } as unknown as Request);
    expect(putResponse.status).toBe(200);

    const getResponse = await GET();
    const body = (await getResponse.json()) as {
      settings?: { gateway?: { url?: string; token?: string } | null };
      gatewayMeta?: { hasStoredToken?: unknown; credentialScope?: unknown };
    };

    expect(getResponse.status).toBe(200);
    expect(body.settings?.gateway).toEqual({ url: "ws://example.test:1234", token: "" });
    expect(body.gatewayMeta?.hasStoredToken).toBe(true);
    expect(typeof body.gatewayMeta?.credentialScope).toBe("string");
    expect(body.gatewayMeta?.credentialScope).not.toContain("t");

    const settingsPath = path.join(tempDir, "openclaw-studio", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      gateway?: { url?: string; token?: string } | null;
      gatewayAutoStart?: boolean;
    };
    expect(parsed.gateway).toEqual({ url: "ws://example.test:1234", token: "t" });
    expect(parsed.gatewayAutoStart).toBe(true);
  });

  it("PUT url-only gateway patch clears existing token when upstream changes", async () => {
    tempDir = makeTempDir("studio-settings-put-url-only-new-upstream");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    fs.mkdirSync(path.join(tempDir, "openclaw-studio"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "openclaw-studio", "settings.json"),
      JSON.stringify(
        {
          version: 1,
          gateway: { url: "ws://old.example:18789", token: "secret-token" },
          focused: {},
          avatars: {},
        },
        null,
        2
      ),
      "utf8"
    );

    const putResponse = await PUT({
      json: async () => ({ gateway: { url: "ws://new.example:18789" } }),
    } as unknown as Request);
    expect(putResponse.status).toBe(200);

    const getResponse = await GET();
    const body = (await getResponse.json()) as {
      settings?: { gateway?: { url?: string; token?: string } | null };
      gatewayMeta?: { hasStoredToken?: unknown; credentialScope?: unknown };
    };
    expect(getResponse.status).toBe(200);
    expect(body.settings?.gateway).toEqual({ url: "ws://new.example:18789", token: "" });
    expect(body.gatewayMeta?.hasStoredToken).toBe(false);
    expect(body.gatewayMeta?.credentialScope).toBe("");

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tempDir, "openclaw-studio", "settings.json"), "utf8")
    ) as { gateway?: { url?: string; token?: string }; gatewayAutoStart?: boolean };
    expect(persisted.gateway).toEqual({
      url: "ws://new.example:18789",
      token: "",
    });
    expect(persisted.gatewayAutoStart).toBe(true);
  });

  it("PUT url-only gateway patch preserves an existing token for equivalent loopback urls", async () => {
    tempDir = makeTempDir("studio-settings-put-url-only-loopback");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    fs.mkdirSync(path.join(tempDir, "openclaw-studio"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "openclaw-studio", "settings.json"),
      JSON.stringify(
        {
          version: 1,
          gateway: { url: "ws://127.0.0.1:18789", token: "secret-token" },
          focused: {},
          avatars: {},
        },
        null,
        2
      ),
      "utf8"
    );

    const putResponse = await PUT({
      json: async () => ({ gateway: { url: "ws://[::1]:18789" } }),
    } as unknown as Request);
    expect(putResponse.status).toBe(200);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tempDir, "openclaw-studio", "settings.json"), "utf8")
    ) as { gateway?: { url?: string; token?: string }; gatewayAutoStart?: boolean };
    expect(persisted.gateway).toEqual({
      url: "ws://localhost:18789",
      token: "secret-token",
    });
    expect(persisted.gatewayAutoStart).toBe(true);
  });

  it("PUT url-only remote gateway patch does not preserve a local fallback token", async () => {
    tempDir = makeTempDir("studio-settings-put-remote-no-local-token");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    fs.writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify({ gateway: { port: 18789, auth: { token: "local-token" } } }, null, 2),
      "utf8"
    );

    const putResponse = await PUT({
      json: async () => ({ gateway: { url: "wss://gateway.example" } }),
    } as unknown as Request);
    expect(putResponse.status).toBe(200);
    const body = (await putResponse.json()) as {
      settings?: { gateway?: { url?: string; token?: string } | null };
      gatewayMeta?: { hasStoredToken?: unknown; credentialScope?: unknown };
    };
    expect(body.settings?.gateway).toEqual({ url: "wss://gateway.example", token: "" });
    expect(body.gatewayMeta?.hasStoredToken).toBe(false);
    expect(body.gatewayMeta?.credentialScope).toBe("");

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tempDir, "openclaw-studio", "settings.json"), "utf8")
    ) as { gateway?: { url?: string; token?: string } };
    expect(persisted.gateway).toEqual({
      url: "wss://gateway.example",
      token: "",
    });
  });
});
