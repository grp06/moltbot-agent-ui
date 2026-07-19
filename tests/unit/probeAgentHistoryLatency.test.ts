// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assessRuntimePreflight,
  assessProbe,
  buildProbePaths,
  classifyBottleneckHint,
  parseProbeArgs,
  persistProbeRunLog,
  percentile,
  resolveProbeLogDir,
  resolveTargetFromFleet,
  summarizeDurations,
} from "../../scripts/probe-agent-history-latency.mjs";

describe("probe-agent-history-latency", () => {
  it("parses cli defaults", () => {
    expect(parseProbeArgs([])).toEqual({
      baseUrl: "http://127.0.0.1:3000",
      agentId: null,
      sessionKey: null,
      samples: 15,
      warmup: 3,
      timeoutMs: 15_000,
      sloP95Ms: 750,
      json: false,
      allowDisconnected: false,
      logDir: null,
      persistLogs: true,
    });
  });

  it("parses cli overrides", () => {
    expect(
      parseProbeArgs([
        "--base-url",
        "http://localhost:3100/",
        "--agent-id",
        "alpha",
        "--session-key",
        "agent:alpha:main",
        "--samples",
        "20",
        "--warmup",
        "4",
        "--timeout-ms",
        "9000",
        "--slo-p95-ms",
        "600",
        "--log-dir",
        ".agent/local/custom-probe-logs",
        "--allow-disconnected",
        "--no-persist-logs",
        "--json",
      ])
    ).toEqual({
      baseUrl: "http://localhost:3100",
      agentId: "alpha",
      sessionKey: "agent:alpha:main",
      samples: 20,
      warmup: 4,
      timeoutMs: 9000,
      sloP95Ms: 600,
      json: true,
      allowDisconnected: true,
      logDir: ".agent/local/custom-probe-logs",
      persistLogs: false,
    });
  });

  it("fails fast when cli option values are missing", () => {
    expect(() => parseProbeArgs(["--base-url", "--json"])).toThrow(
      "Missing value for --base-url"
    );
    expect(() => parseProbeArgs(["--samples", "0"])).toThrow("Invalid --samples: 0");
  });

  it("resolves probe log directory from default and custom values", () => {
    expect(resolveProbeLogDir(null)).toBe(
      path.resolve(process.cwd(), ".agent/local/latency-probes")
    );
    expect(resolveProbeLogDir("./tmp/probe-logs")).toBe(
      path.resolve(process.cwd(), "tmp/probe-logs")
    );
  });

  it("resolves target in priority order", () => {
    expect(
      resolveTargetFromFleet({
        explicitAgentId: "explicit-agent",
        explicitSessionKey: null,
        fleetResult: {
          suggestedSelectedAgentId: "suggested-agent",
          seeds: [{ agentId: "seed-agent" }],
        },
      })
    ).toEqual({
      agentId: "explicit-agent",
      sessionKey: "agent:explicit-agent:main",
    });

    expect(
      resolveTargetFromFleet({
        explicitAgentId: null,
        explicitSessionKey: null,
        fleetResult: {
          suggestedSelectedAgentId: "suggested-agent",
          seeds: [{ agentId: "seed-agent" }],
        },
      })
    ).toEqual({
      agentId: "suggested-agent",
      sessionKey: "agent:suggested-agent:main",
    });

    expect(
      resolveTargetFromFleet({
        explicitAgentId: null,
        explicitSessionKey: null,
        fleetResult: {
          suggestedSelectedAgentId: "",
          seeds: [{ agentId: "seed-agent" }],
        },
      })
    ).toEqual({
      agentId: "seed-agent",
      sessionKey: "agent:seed-agent:main",
    });

    expect(
      resolveTargetFromFleet({
        explicitAgentId: null,
        explicitSessionKey: null,
        fleetResult: null,
      })
    ).toEqual({
      agentId: "main",
      sessionKey: "agent:main:main",
    });
  });

  it("builds tiered endpoint paths for one agent", () => {
    expect(
      buildProbePaths({
        agentId: "main",
        sessionKey: "agent:main:main",
      }).map((entry) => entry.path)
    ).toEqual([
      "/api/runtime/summary",
      "/api/runtime/agents/main/history?sessionKey=agent%3Amain%3Amain&limit=50&view=semantic&turnLimit=50&scanLimit=800",
    ]);
  });

  it("passes the resolved session key into the semantic history probe", () => {
    expect(
      buildProbePaths({
        agentId: "alpha",
        sessionKey: "agent:alpha:work item",
      }).find((entry) => entry.name === "semantic-history")?.path
    ).toBe(
      "/api/runtime/agents/alpha/history?sessionKey=agent%3Aalpha%3Awork+item&limit=50&view=semantic&turnLimit=50&scanLimit=800"
    );
  });

  it("computes percentile and stats summaries", () => {
    const durations = [100, 200, 300, 400, 500];
    expect(percentile(durations, 50)).toBe(300);
    expect(percentile(durations, 90)).toBe(500);
    expect(percentile(durations, 95)).toBe(500);
    expect(summarizeDurations(durations, 5)).toEqual({
      attempts: 5,
      count: 5,
      minMs: 100,
      maxMs: 500,
      meanMs: 300,
      p50Ms: 300,
      p90Ms: 500,
      p95Ms: 500,
    });
  });

  it("classifies bottleneck hints from endpoint stats", () => {
    expect(
      classifyBottleneckHint({
        endpoints: [
          {
            name: "summary",
            stats: { p95Ms: null },
            errors: { count: 1 },
          },
          {
            name: "semantic-history",
            stats: { p95Ms: null },
            errors: { count: 0 },
          },
        ],
        sloP95Ms: 750,
      })
    ).toBe("errors present -> fix endpoint failures before latency diagnosis");

    const baseEndpoints = [
      { name: "summary", stats: { p95Ms: 300 }, errors: { count: 0 } },
      {
        name: "semantic-history",
        stats: { p95Ms: 900 },
        errors: { count: 0 },
      },
    ];
    expect(
      classifyBottleneckHint({
        endpoints: baseEndpoints,
        sloP95Ms: 750,
      })
    ).toBe(
      "semantic slow, summary healthy -> transcript-backed gateway history path is likely bottlenecked"
    );

    expect(
      classifyBottleneckHint({
        endpoints: [
          { name: "summary", stats: { p95Ms: 900 }, errors: { count: 0 } },
          { name: "semantic-history", stats: { p95Ms: 300 }, errors: { count: 0 } },
        ],
        sloP95Ms: 750,
      })
    ).toBe("summary slow, semantic healthy -> runtime snapshot path likely");

    expect(
      classifyBottleneckHint({
        endpoints: [
          { name: "summary", stats: { p95Ms: 900 }, errors: { count: 0 } },
          { name: "semantic-history", stats: { p95Ms: 950 }, errors: { count: 0 } },
        ],
        sloP95Ms: 750,
      })
    ).toBe("summary and semantic slow -> upstream saturation or host contention");
  });

  it("assesses pass/fail with endpoint errors and blocking slo breaches only", () => {
    expect(
      assessProbe({
        sloP95Ms: 750,
        endpoints: [
          {
            name: "summary",
            sloBlocking: false,
            stats: { p95Ms: 2_000 },
            errors: { count: 0 },
          },
          {
            name: "semantic-history",
            sloBlocking: true,
            stats: { p95Ms: 700 },
            errors: { count: 0 },
          },
        ],
      }).pass
    ).toBe(true);

    expect(
      assessProbe({
        sloP95Ms: 750,
        endpoints: [
          {
            name: "summary",
            sloBlocking: false,
            stats: { p95Ms: 300 },
            errors: { count: 0 },
          },
          {
            name: "semantic-history",
            sloBlocking: true,
            stats: { p95Ms: 900 },
            errors: { count: 0 },
          },
        ],
      }).pass
    ).toBe(false);

    expect(
      assessProbe({
        sloP95Ms: 750,
        endpoints: [
          {
            name: "summary",
            sloBlocking: false,
            stats: { p95Ms: 300 },
            errors: { count: 1 },
          },
          {
            name: "semantic-history",
            sloBlocking: true,
            stats: { p95Ms: 300 },
            errors: { count: 0 },
          },
        ],
      }).pass
    ).toBe(false);
  });

  it("enforces runtime connectivity preflight unless explicitly allowed", () => {
    expect(
      assessRuntimePreflight({
        response: {
          ok: true,
          body: {
            summary: { status: "connected" },
          },
        },
        allowDisconnected: false,
      })
    ).toEqual({
      pass: true,
      connected: true,
      status: "connected",
      message: null,
    });

    expect(
      assessRuntimePreflight({
        response: {
          ok: true,
          body: {
            summary: { status: "stopped" },
          },
        },
        allowDisconnected: false,
      })
    ).toEqual({
      pass: false,
      connected: false,
      status: "stopped",
      message:
        'runtime preflight failed: summary.status="stopped". Latency samples are invalid for SLO enforcement while disconnected. Reconnect runtime or rerun with --allow-disconnected.',
    });

    expect(
      assessRuntimePreflight({
        response: {
          ok: true,
          body: {
            summary: { status: "stopped" },
          },
        },
        allowDisconnected: true,
      })
    ).toEqual({
      pass: true,
      connected: false,
      status: "stopped",
      message:
        'runtime preflight warning: summary.status="stopped"; continuing because --allow-disconnected is set',
    });

    expect(
      assessRuntimePreflight({
        response: {
          ok: false,
          status: 503,
          error: "service unavailable",
        },
        allowDisconnected: false,
      })
    ).toEqual({
      pass: false,
      connected: false,
      status: null,
      message:
        "runtime preflight failed: unable to read /api/runtime/summary (service unavailable)",
    });
  });

  it("fails runtime preflight on malformed summary payloads", () => {
    expect(
      assessRuntimePreflight({
        response: { ok: true, body: null },
        allowDisconnected: true,
      }).message
    ).toContain("invalid /api/runtime/summary payload");

    expect(
      assessRuntimePreflight({
        response: { ok: true, body: {} },
        allowDisconnected: true,
      }).message
    ).toContain("missing summary");

    expect(
      assessRuntimePreflight({
        response: { ok: true, body: { summary: {} } },
        allowDisconnected: true,
      }).message
    ).toContain("summary.status missing");
  });

  it("persists run logs as jsonl history and latest snapshot", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-studio-probe-"));
    const persisted = persistProbeRunLog({
      logDir: tempRoot,
      rawArgs: ["--json"],
      payload: {
        run: {
          startedAt: "2026-03-05T16:00:00.000Z",
          finishedAt: "2026-03-05T16:00:01.000Z",
        },
        target: {
          baseUrl: "http://127.0.0.1:3000",
          agentId: "main",
          sessionKey: "agent:main:main",
        },
        config: {
          samples: 2,
          warmup: 1,
          timeoutMs: 1000,
          sloP95Ms: 500,
          allowDisconnected: true,
        },
        endpoints: [],
        assessment: {
          pass: true,
          bottleneckHint: "summary and semantic are within SLO",
        },
        preflight: {
          pass: true,
          connected: true,
          status: "connected",
          message: null,
        },
        trace: [],
      },
    });

    expect(persisted.persisted).toBe(true);
    expect(fs.existsSync(persisted.runsFile)).toBe(true);
    expect(fs.existsSync(persisted.latestFile)).toBe(true);

    const lines = fs
      .readFileSync(persisted.runsFile, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.target?.agentId).toBe("main");
    expect(parsed.runId).toBeTypeOf("string");
    expect(parsed.loggedAt).toBeTypeOf("string");

    const latest = JSON.parse(fs.readFileSync(persisted.latestFile, "utf8"));
    expect(latest.runId).toBe(parsed.runId);
    expect(latest.target?.sessionKey).toBe("agent:main:main");
  });
});
