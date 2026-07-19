// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("studio setup paths", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("resolves settings path under OPENCLAW_STATE_DIR when set", async () => {
    const { resolveStudioSettingsPath } = await import("../../server/studio-settings");
    const settingsPath = resolveStudioSettingsPath({
      OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
    } as unknown as NodeJS.ProcessEnv);
    expect(settingsPath).toBe("/tmp/openclaw-state/openclaw-studio/settings.json");
  });

  it("resolves settings path under ~/.openclaw by default", async () => {
    const { resolveStudioSettingsPath } = await import("../../server/studio-settings");
    const settingsPath = resolveStudioSettingsPath({} as NodeJS.ProcessEnv);
    expect(settingsPath).toBe(
      path.join(os.homedir(), ".openclaw", "openclaw-studio", "settings.json")
    );
  });

  it("keeps the previous settings file when an atomic write cannot be renamed", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-setup-atomic-"));
    const settingsDir = path.join(tempDir, "openclaw-studio");
    const settingsPath = path.join(settingsDir, "settings.json");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ version: 1, gateway: { url: "ws://old", token: "old" } }, null, 2),
      "utf8"
    );

    const { writeJsonFileAtomic } = await import("../../server/studio-settings");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rename failed");
    });

    expect(() =>
      writeJsonFileAtomic(settingsPath, {
        version: 1,
        gateway: { url: "ws://new", token: "new" },
      })
    ).toThrow("rename failed");

    const persisted = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      gateway?: { url?: string; token?: string };
    };
    expect(persisted.gateway?.url).toBe("ws://old");
    expect(persisted.gateway?.token).toBe("old");
    expect(fs.readdirSync(settingsDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
