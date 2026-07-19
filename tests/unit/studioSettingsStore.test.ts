import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyStudioSettingsPatch,
  loadStudioSettings,
  resolveGatewayTokenForUrl,
} from "@/lib/studio/settings-store";

const makeTempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

describe("studio settings store", () => {
  const priorStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempDir: string | null = null;

  afterEach(() => {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
    vi.restoreAllMocks();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("falls back to defaults when settings JSON is corrupt", () => {
    tempDir = makeTempDir("studio-settings-corrupt");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    const settingsDir = path.join(tempDir, "openclaw-studio");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, "settings.json"), "{not-json", "utf8");

    const settings = loadStudioSettings();

    expect(settings.gateway).toBeNull();
    expect(settings.gatewayAutoStart).toBe(true);
  });

  it("keeps the previous settings file when the atomic rename fails", () => {
    tempDir = makeTempDir("studio-settings-atomic");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    const settingsDir = path.join(tempDir, "openclaw-studio");
    const settingsPath = path.join(settingsDir, "settings.json");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ version: 1, gateway: { url: "ws://old.example", token: "old" } }, null, 2),
      "utf8"
    );

    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated rename failure");
    });

    expect(() =>
      applyStudioSettingsPatch({ gateway: { url: "ws://new.example", token: "new" } })
    ).toThrow("simulated rename failure");

    const persisted = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      gateway?: { url?: string; token?: string };
    };
    expect(persisted.gateway).toEqual({ url: "ws://old.example", token: "old" });
    expect(fs.readdirSync(settingsDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not apply a local openclaw token to a configured remote gateway", () => {
    tempDir = makeTempDir("studio-settings-remote-no-local-token");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    fs.mkdirSync(path.join(tempDir, "openclaw-studio"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "openclaw-studio", "settings.json"),
      JSON.stringify(
        { version: 1, gateway: { url: "wss://gateway.example", token: "" } },
        null,
        2
      ),
      "utf8"
    );
    fs.writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify({ gateway: { port: 18789, auth: { token: "local-token" } } }, null, 2),
      "utf8"
    );

    expect(loadStudioSettings().gateway).toEqual({
      url: "wss://gateway.example",
      token: "",
    });
    expect(resolveGatewayTokenForUrl("wss://gateway.example")).toBe("");
  });

  it("uses a local openclaw token when the configured gateway matches local defaults", () => {
    tempDir = makeTempDir("studio-settings-local-token-match");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    fs.mkdirSync(path.join(tempDir, "openclaw-studio"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "openclaw-studio", "settings.json"),
      JSON.stringify(
        { version: 1, gateway: { url: "ws://127.0.0.1:18789", token: "" } },
        null,
        2
      ),
      "utf8"
    );
    fs.writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify({ gateway: { port: 18789, auth: { token: "local-token" } } }, null, 2),
      "utf8"
    );

    expect(loadStudioSettings().gateway).toEqual({
      url: "ws://localhost:18789",
      token: "local-token",
    });
    expect(resolveGatewayTokenForUrl("ws://127.0.0.1:18789")).toBe("local-token");
  });

  it("does not resolve a stored token for a different gateway url", () => {
    tempDir = makeTempDir("studio-settings-stored-token-scope");
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

    expect(resolveGatewayTokenForUrl("wss://gateway.old.example")).toBe("stored-token");
    expect(resolveGatewayTokenForUrl("wss://gateway.new.example")).toBe("");
  });

  it("does not persist local fallback tokens through url-only remote patches", () => {
    tempDir = makeTempDir("studio-settings-url-only-remote");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    fs.writeFileSync(
      path.join(tempDir, "openclaw.json"),
      JSON.stringify({ gateway: { port: 18789, auth: { token: "local-token" } } }, null, 2),
      "utf8"
    );

    const settings = applyStudioSettingsPatch({
      gateway: { url: "wss://gateway.example" },
    });

    expect(settings.gateway).toEqual({
      url: "wss://gateway.example",
      token: "",
    });
    const persisted = JSON.parse(
      fs.readFileSync(path.join(tempDir, "openclaw-studio", "settings.json"), "utf8")
    ) as { gateway?: { url?: string; token?: string } };
    expect(persisted.gateway).toEqual({
      url: "wss://gateway.example",
      token: "",
    });
  });
});
