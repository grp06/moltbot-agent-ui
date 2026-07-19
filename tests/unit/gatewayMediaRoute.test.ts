// @vitest-environment node

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

let GET: typeof import("@/app/api/runtime/media/route")["GET"];

const makeTempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

const writeStudioSettings = (stateDir: string, gatewayUrl: string) => {
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

beforeAll(async () => {
  ({ GET } = await import("@/app/api/runtime/media/route"));
});

describe("/api/runtime/media route", () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.OPENCLAW_GATEWAY_SSH_TARGET;
    delete process.env.OPENCLAW_GATEWAY_SSH_USER;
    delete process.env.OPENCLAW_STATE_DIR;
    mockedSpawnSync.mockReset();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("returns binary image data when reading remote media over ssh", async () => {
    tempDir = makeTempDir("gateway-media-route-remote");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    process.env.OPENCLAW_GATEWAY_SSH_TARGET = "me@host.test";
    writeStudioSettings(tempDir, "ws://example.test:18789");

    const payloadBytes = Buffer.from("fake", "utf8");
    mockedSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        ok: true,
        mime: "image/png",
        size: payloadBytes.length,
        data: payloadBytes.toString("base64"),
      }),
      stderr: "",
      error: undefined,
    } as never);

    const remotePath = "/home/ubuntu/.openclaw/images/pic.png";
    const response = await GET(
      new Request(
        `http://localhost/api/runtime/media?path=${encodeURIComponent(remotePath)}`
      )
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Length")).toBe(String(payloadBytes.length));

    const buf = Buffer.from(await response.arrayBuffer());
    expect(buf.equals(payloadBytes)).toBe(true);

    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = mockedSpawnSync.mock.calls[0] as [
      string,
      string[],
      { encoding?: string; input?: string; maxBuffer?: number },
    ];
    expect(cmd).toBe("ssh");
    expect(args).toEqual(
      expect.arrayContaining([
        "-o",
        "BatchMode=yes",
        "me@host.test",
        "bash",
        "-s",
        "--",
        remotePath,
      ])
    );
    expect(options.encoding).toBe("utf8");
    expect(options.input).toContain("python3 - \"$1\"");
    expect(typeof options.maxBuffer).toBe("number");
    expect(options.maxBuffer).toBeGreaterThan(payloadBytes.length);
  });

  it("uses configured ssh target for media even when gateway url is loopback", async () => {
    tempDir = makeTempDir("gateway-media-route-tunnel");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    process.env.OPENCLAW_GATEWAY_SSH_TARGET = "me@tunnel-host.test";
    writeStudioSettings(tempDir, "ws://localhost:18789");

    const payloadBytes = Buffer.from("fake", "utf8");
    mockedSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        ok: true,
        mime: "image/png",
        size: payloadBytes.length,
        data: payloadBytes.toString("base64"),
      }),
      stderr: "",
      error: undefined,
    } as never);

    const remotePath = "/home/ubuntu/.openclaw/images/tunnel.png";
    const response = await GET(
      new Request(`http://localhost/api/runtime/media?path=${encodeURIComponent(remotePath)}`)
    );

    expect(response.status).toBe(200);
    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    const [, args] = mockedSpawnSync.mock.calls[0] as [string, string[]];
    expect(args).toEqual(expect.arrayContaining(["me@tunnel-host.test", "bash", "-s", "--", remotePath]));
  });

  it("rejects remote media when decoded payload exceeds the route limit", async () => {
    tempDir = makeTempDir("gateway-media-route-remote-size");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    process.env.OPENCLAW_GATEWAY_SSH_TARGET = "me@host.test";
    writeStudioSettings(tempDir, "ws://example.test:18789");

    const payloadBytes = Buffer.alloc(25 * 1024 * 1024 + 1, 1);
    mockedSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        ok: true,
        mime: "image/png",
        size: 1,
        data: payloadBytes.toString("base64"),
      }),
      stderr: "",
      error: undefined,
    } as never);

    const response = await GET(
      new Request(
        `http://localhost/api/runtime/media?path=${encodeURIComponent("/home/ubuntu/.openclaw/images/too-large.png")}`
      )
    );
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("media file too large");
  });

  it("falls back to extension MIME when remote media returns an unsupported MIME", async () => {
    tempDir = makeTempDir("gateway-media-route-remote-mime");
    process.env.OPENCLAW_STATE_DIR = tempDir;
    process.env.OPENCLAW_GATEWAY_SSH_TARGET = "me@host.test";
    writeStudioSettings(tempDir, "ws://example.test:18789");

    const payloadBytes = Buffer.from("fake", "utf8");
    mockedSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        ok: true,
        mime: "text/html",
        size: payloadBytes.length,
        data: payloadBytes.toString("base64"),
      }),
      stderr: "",
      error: undefined,
    } as never);

    const response = await GET(
      new Request(
        `http://localhost/api/runtime/media?path=${encodeURIComponent("/home/ubuntu/.openclaw/images/pic.png")}`
      )
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
  });

  it("returns local media from the configured OpenClaw state directory", async () => {
    tempDir = makeTempDir("gateway-media-route-local");
    const stateDir = path.join(tempDir, "state");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeStudioSettings(stateDir, "ws://localhost:18789");

    const mediaDir = path.join(stateDir, "agents", "agent-1");
    fs.mkdirSync(mediaDir, { recursive: true });
    const mediaPath = path.join(mediaDir, "screenshot.png");
    const payloadBytes = Buffer.from("fake-png", "utf8");
    fs.writeFileSync(mediaPath, payloadBytes);

    const response = await GET(
      new Request(`http://localhost/api/runtime/media?path=${encodeURIComponent(mediaPath)}`)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Length")).toBe(String(payloadBytes.length));

    const buf = Buffer.from(await response.arrayBuffer());
    expect(buf.equals(payloadBytes)).toBe(true);
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });

  it("rejects local media paths that symlink outside the configured state directory", async () => {
    tempDir = makeTempDir("gateway-media-route-symlink");
    const stateDir = path.join(tempDir, "state");
    const outsideDir = path.join(tempDir, "outside");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    writeStudioSettings(stateDir, "ws://localhost:18789");

    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsidePath = path.join(outsideDir, "secret.png");
    const linkPath = path.join(stateDir, "linked-secret.png");
    fs.writeFileSync(outsidePath, Buffer.from("outside", "utf8"));
    fs.symlinkSync(outsidePath, linkPath);

    const response = await GET(
      new Request(`http://localhost/api/runtime/media?path=${encodeURIComponent(linkPath)}`)
    );
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("Refusing to read media outside");
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });
});
