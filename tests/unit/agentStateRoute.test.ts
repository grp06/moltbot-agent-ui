import { beforeEach, describe, expect, it, vi } from "vitest";

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { POST, PUT } from "@/app/api/runtime/agent-state/route";

const ORIGINAL_ENV = { ...process.env };

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process"
  );
  return {
    default: actual,
    ...actual,
    spawnSync: vi.fn(),
  };
});

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});

const writeStudioSettings = (gatewayUrl: string) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-state-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;

  const settingsDir = path.join(stateDir, "openclaw-studio");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, "settings.json"),
    JSON.stringify(
      {
        version: 1,
        gateway: { url: gatewayUrl, token: "token-123" },
        focused: {},
      },
      null,
      2
    ),
    "utf8"
  );
};

describe("agent state route", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.OPENCLAW_GATEWAY_SSH_TARGET;
    delete process.env.OPENCLAW_GATEWAY_SSH_USER;
    delete process.env.OPENCLAW_STATE_DIR;
    mockedSpawnSync.mockReset();
    mockedConsoleError.mockClear();
  });

  it("rejects missing agentId", async () => {
    const response = await POST(
      new Request("http://localhost/api/runtime/agent-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(response.status).toBe(400);
  });

  it("rejects malformed trash JSON without running mutations", async () => {
    const response = await POST(
      new Request("http://localhost/api/runtime/agent-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    );
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON payload.");
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });

  it("rejects unsafe agentId", async () => {
    const response = await POST(
      new Request("http://localhost/api/runtime/agent-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "../nope" }),
      })
    );
    expect(response.status).toBe(400);
  });

  it("moves agent state via ssh", async () => {
    writeStudioSettings("ws://example.test:18789");

    mockedSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ trashDir: "/home/ubuntu/.openclaw/trash/x", moved: [] }),
      stderr: "",
      error: undefined,
    } as never);

    const response = await POST(
      new Request("http://localhost/api/runtime/agent-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "my-agent" }),
      })
    );

    expect(response.status).toBe(200);
    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);

    const [cmd, args, options] = mockedSpawnSync.mock.calls[0] as [
      string,
      string[],
      { encoding?: string; input?: string }
    ];
    expect(cmd).toBe("ssh");
    expect(args).toEqual(
      expect.arrayContaining([
        "-o",
        "BatchMode=yes",
        "ubuntu@example.test",
        "bash",
        "-s",
        "--",
        "my-agent",
      ])
    );
    expect(options.encoding).toBe("utf8");
    expect(options.input).toContain("python3 - \"$1\"");
    expect(options.input).toContain("workspace-{agent_id}");
  });

  it("restores agent state via ssh", async () => {
    writeStudioSettings("ws://example.test:18789");

    mockedSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ restored: [] }),
      stderr: "",
      error: undefined,
    } as never);

    const response = await PUT(
      new Request("http://localhost/api/runtime/agent-state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "my-agent", trashDir: "/tmp/trash" }),
      })
    );

    expect(response.status).toBe(200);
    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);

    const [cmd, args] = mockedSpawnSync.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("ssh");
    expect(args).toEqual(
      expect.arrayContaining([
        "-o",
        "BatchMode=yes",
        "ubuntu@example.test",
        "bash",
        "-s",
        "--",
        "my-agent",
        "/tmp/trash",
      ])
    );
  });

  it("uses configured ssh target without studio settings", async () => {
    process.env.OPENCLAW_GATEWAY_SSH_TARGET = "me@host.test";

    mockedSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ trashDir: "/home/ubuntu/.openclaw/trash/x", moved: [] }),
      stderr: "",
      error: undefined,
    } as never);

    const response = await POST(
      new Request("http://localhost/api/runtime/agent-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: "my-agent" }),
      })
    );

    expect(response.status).toBe(200);
    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);

    const [cmd, args] = mockedSpawnSync.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("ssh");
    expect(args).toEqual(expect.arrayContaining(["me@host.test"]));
  });

  it("rejects malformed restore JSON without running mutations", async () => {
    const response = await PUT(
      new Request("http://localhost/api/runtime/agent-state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    );
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON payload.");
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });
});
