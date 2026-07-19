#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_SAMPLES = 15;
const DEFAULT_WARMUP = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SLO_P95_MS = 750;
const DEFAULT_AGENT_ID = "main";
const DEFAULT_LOG_DIR = ".agent/local/latency-probes";
const DEFAULT_LOG_FILENAME = "probe-agent-latency-runs.jsonl";
const DEFAULT_LATEST_LOG_FILENAME = "probe-agent-latency-latest.json";
const MAX_LOGGED_ERRORS_PER_ENDPOINT = 25;

const asTrimmed = (value) => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const parseNumericArg = (raw, label) => {
  const normalized = asTrimmed(raw);
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return Math.floor(parsed);
};

export const parseProbeArgs = (argv) => {
  const config = {
    baseUrl: DEFAULT_BASE_URL,
    agentId: null,
    sessionKey: null,
    samples: DEFAULT_SAMPLES,
    warmup: DEFAULT_WARMUP,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sloP95Ms: DEFAULT_SLO_P95_MS,
    json: false,
    allowDisconnected: false,
    logDir: null,
    persistLogs: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = asTrimmed(argv[index]);
    if (!token) continue;
    if (token === "--json") {
      config.json = true;
      continue;
    }
    if (token === "--allow-disconnected") {
      config.allowDisconnected = true;
      continue;
    }
    if (token === "--no-persist-logs") {
      config.persistLogs = false;
      continue;
    }
    const value = asTrimmed(argv[index + 1]);
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${token}`);
    }
    if (token === "--base-url") {
      config.baseUrl = value;
      index += 1;
      continue;
    }
    if (token === "--agent-id") {
      config.agentId = value;
      index += 1;
      continue;
    }
    if (token === "--session-key") {
      config.sessionKey = value;
      index += 1;
      continue;
    }
    if (token === "--samples") {
      config.samples = parseNumericArg(value, "--samples");
      index += 1;
      continue;
    }
    if (token === "--warmup") {
      config.warmup = parseNumericArg(value, "--warmup");
      index += 1;
      continue;
    }
    if (token === "--timeout-ms") {
      config.timeoutMs = parseNumericArg(value, "--timeout-ms");
      index += 1;
      continue;
    }
    if (token === "--slo-p95-ms") {
      config.sloP95Ms = parseNumericArg(value, "--slo-p95-ms");
      index += 1;
      continue;
    }
    if (token === "--log-dir") {
      config.logDir = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return {
    ...config,
    baseUrl: config.baseUrl.replace(/\/+$/, "") || DEFAULT_BASE_URL,
    agentId: config.agentId ? config.agentId.trim() : null,
    sessionKey: config.sessionKey ? config.sessionKey.trim() : null,
  };
};

export const resolveProbeLogDir = (configuredLogDir) => {
  const normalized = asTrimmed(configuredLogDir);
  if (normalized) return path.resolve(normalized);
  return path.resolve(process.cwd(), DEFAULT_LOG_DIR);
};

const buildRunId = () => {
  const nowPart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${nowPart}-${randomPart}`;
};

export const persistProbeRunLog = (params) => {
  const logDir = resolveProbeLogDir(params.logDir);
  const runsFile = path.join(logDir, DEFAULT_LOG_FILENAME);
  const latestFile = path.join(logDir, DEFAULT_LATEST_LOG_FILENAME);
  const record = {
    runId: buildRunId(),
    loggedAt: new Date().toISOString(),
    argv: Array.isArray(params.rawArgs) ? params.rawArgs : [],
    ...params.payload,
  };

  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(runsFile, `${JSON.stringify(record)}\n`, "utf8");
    fs.writeFileSync(latestFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return {
      persisted: true,
      logDir,
      runsFile,
      latestFile,
      runId: record.runId,
      loggedAt: record.loggedAt,
    };
  } catch (error) {
    return {
      persisted: false,
      logDir,
      runsFile,
      latestFile,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const parseAgentIdFromSessionKey = (sessionKey) => {
  const normalized = asTrimmed(sessionKey);
  if (!normalized) return null;
  const match = normalized.match(/^agent:([^:]+):/i);
  const agentId = asTrimmed(match?.[1] ?? "");
  return agentId || null;
};

export const resolveTargetFromFleet = (params) => {
  const explicitAgentId = asTrimmed(params.explicitAgentId ?? "");
  const explicitSessionKey = asTrimmed(params.explicitSessionKey ?? "");
  const fromSessionKey = parseAgentIdFromSessionKey(explicitSessionKey) ?? "";
  const suggestedAgentId = asTrimmed(params.fleetResult?.suggestedSelectedAgentId ?? "");
  const firstSeedAgentId = asTrimmed(params.fleetResult?.seeds?.[0]?.agentId ?? "");

  const agentId =
    explicitAgentId ||
    fromSessionKey ||
    suggestedAgentId ||
    firstSeedAgentId ||
    DEFAULT_AGENT_ID;
  const sessionKey = explicitSessionKey || `agent:${agentId}:main`;

  return { agentId, sessionKey };
};

export const buildProbePaths = ({ agentId, sessionKey }) => {
  const normalizedAgentId = encodeURIComponent(asTrimmed(agentId));
  const query = new URLSearchParams({
    sessionKey: asTrimmed(sessionKey),
    limit: "50",
    view: "semantic",
    turnLimit: "50",
    scanLimit: "800",
  });
  return [
    {
      name: "summary",
      method: "GET",
      path: "/api/runtime/summary",
      sloBlocking: false,
    },
    {
      name: "semantic-history",
      method: "GET",
      path: `/api/runtime/agents/${normalizedAgentId}/history?${query.toString()}`,
      sloBlocking: true,
    },
  ];
};

export const percentile = (durations, p) => {
  if (!Array.isArray(durations) || durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[index];
};

export const summarizeDurations = (durations, attempts) => {
  if (!Array.isArray(durations) || durations.length === 0) {
    return {
      attempts,
      count: 0,
      minMs: null,
      maxMs: null,
      meanMs: null,
      p50Ms: null,
      p90Ms: null,
      p95Ms: null,
    };
  }
  const count = durations.length;
  const total = durations.reduce((acc, value) => acc + value, 0);
  return {
    attempts,
    count,
    minMs: Math.min(...durations),
    maxMs: Math.max(...durations),
    meanMs: total / count,
    p50Ms: percentile(durations, 50),
    p90Ms: percentile(durations, 90),
    p95Ms: percentile(durations, 95),
  };
};

export const classifyBottleneckHint = (params) => {
  const hasErrors = params.endpoints.some((entry) => (entry.errors?.count ?? 0) > 0);
  if (hasErrors) {
    return "errors present -> fix endpoint failures before latency diagnosis";
  }
  const semantic = params.endpoints.find((entry) => entry.name === "semantic-history") ?? null;
  const summary = params.endpoints.find((entry) => entry.name === "summary") ?? null;
  if (!semantic || !summary) {
    return "incomplete probe results.";
  }
  const semanticP95 = semantic.stats.p95Ms;
  const summaryP95 = summary.stats.p95Ms;
  const semanticSlow = typeof semanticP95 === "number" && semanticP95 > params.sloP95Ms;
  const summarySlow = typeof summaryP95 === "number" && summaryP95 > params.sloP95Ms;
  if (semanticSlow && !summarySlow) {
    return "semantic slow, summary healthy -> transcript-backed gateway history path is likely bottlenecked";
  }
  if (summarySlow && !semanticSlow) {
    return "summary slow, semantic healthy -> runtime snapshot path likely";
  }
  if (semanticSlow && summarySlow) {
    return "summary and semantic slow -> upstream saturation or host contention";
  }
  return "summary and semantic are within SLO";
};

export const assessProbe = (params) => {
  const errorsPresent = params.endpoints.some((entry) => entry.errors.count > 0);
  const blockingSloBreach = params.endpoints.some((entry) => {
    if (!entry.sloBlocking) return false;
    const p95 = entry.stats.p95Ms;
    return typeof p95 === "number" && p95 > params.sloP95Ms;
  });
  return {
    pass: !errorsPresent && !blockingSloBreach,
    bottleneckHint: classifyBottleneckHint(params),
  };
};

export const assessRuntimePreflight = ({ response, allowDisconnected }) => {
  if (!response.ok) {
    return {
      pass: false,
      connected: false,
      status: null,
      message: `runtime preflight failed: unable to read /api/runtime/summary (${response.error || response.status})`,
    };
  }

  const payload = response.body;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      pass: false,
      connected: false,
      status: null,
      message: "runtime preflight failed: invalid /api/runtime/summary payload",
    };
  }
  const summary = payload.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return {
      pass: false,
      connected: false,
      status: null,
      message: "runtime preflight failed: missing summary in /api/runtime/summary payload",
    };
  }
  const runtimeStatus =
    summary && typeof summary === "object" ? asTrimmed(summary.status ?? "") : "";
  if (!runtimeStatus) {
    return {
      pass: false,
      connected: false,
      status: null,
      message: "runtime preflight failed: summary.status missing in /api/runtime/summary payload",
    };
  }
  const normalizedStatus = runtimeStatus;
  const connected = normalizedStatus === "connected";

  if (connected) {
    return {
      pass: true,
      connected: true,
      status: normalizedStatus,
      message: null,
    };
  }

  if (allowDisconnected) {
    return {
      pass: true,
      connected: false,
      status: normalizedStatus,
      message: `runtime preflight warning: summary.status="${normalizedStatus}"; continuing because --allow-disconnected is set`,
    };
  }

  return {
    pass: false,
    connected: false,
    status: normalizedStatus,
    message:
      `runtime preflight failed: summary.status="${normalizedStatus}". ` +
      "Latency samples are invalid for SLO enforcement while disconnected. " +
      "Reconnect runtime or rerun with --allow-disconnected.",
  };
};

const toFixedMs = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value.toFixed(1)}ms`;
};

const readErrorSnippet = async (response) => {
  try {
    const text = await response.text();
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.slice(0, 240);
  } catch {
    return "";
  }
};

const timedRequest = async ({ baseUrl, endpoint, timeoutMs }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}${endpoint.path}`, {
      method: endpoint.method,
      signal: controller.signal,
      headers: endpoint.method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: endpoint.method === "POST" ? "{}" : undefined,
    });
    const durationMs = performance.now() - startedAt;
    if (response.status !== 200) {
      return {
        ok: false,
        status: response.status,
        durationMs,
        error: await readErrorSnippet(response),
      };
    }
    return {
      ok: true,
      status: response.status,
      durationMs,
      body: await response.json(),
    };
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    const message =
      error instanceof Error ? error.message : "request_failed";
    return { ok: false, status: 0, durationMs, error: message };
  } finally {
    clearTimeout(timer);
  }
};

const loadFleetResult = async ({ baseUrl, timeoutMs }) => {
  const endpoint = {
    name: "fleet",
    method: "POST",
    path: "/api/runtime/fleet",
  };
  const response = await timedRequest({ baseUrl, endpoint, timeoutMs });
  if (!response.ok) {
    return { result: null, warning: `fleet probe failed: ${response.error || response.status}` };
  }
  const payload = response.body;
  const result = payload && typeof payload === "object" ? payload.result ?? null : null;
  return { result, warning: null };
};

const runEndpointProbe = async ({ baseUrl, endpoint, warmup, samples, timeoutMs }) => {
  const warmupDurations = [];
  let warmupErrors = 0;
  for (let index = 0; index < warmup; index += 1) {
    const response = await timedRequest({ baseUrl, endpoint, timeoutMs });
    warmupDurations.push(response.durationMs);
    if (!response.ok) {
      warmupErrors += 1;
    }
  }

  const durations = [];
  let errorCount = 0;
  const sampleErrors = [];
  let lastError = null;
  for (let index = 0; index < samples; index += 1) {
    const response = await timedRequest({ baseUrl, endpoint, timeoutMs });
    if (response.ok) {
      durations.push(response.durationMs);
      continue;
    }
    errorCount += 1;
    lastError = {
      status: response.status,
      message: response.error || "request_failed",
    };
    if (sampleErrors.length < MAX_LOGGED_ERRORS_PER_ENDPOINT) {
      sampleErrors.push({
        sample: index + 1,
        status: response.status,
        durationMs: response.durationMs,
        message: response.error || "request_failed",
      });
    }
  }

  return {
    name: endpoint.name,
    path: endpoint.path,
    sloBlocking: endpoint.sloBlocking,
    status: errorCount > 0 ? "fail" : "ok",
    stats: summarizeDurations(durations, samples),
    errors: {
      count: errorCount,
      last: lastError,
    },
    probe: {
      warmupCount: warmup,
      warmupDurationsMs: warmupDurations,
      warmupErrors,
      sampleDurationsMs: durations,
      sampleErrors,
    },
  };
};

const printHumanOutput = ({
  target,
  config,
  endpoints,
  assessment,
  fleetWarning,
  preflightMessage,
  logInfo,
}) => {
  if (preflightMessage) {
    process.stdout.write(`${preflightMessage}\n`);
  }
  if (fleetWarning) {
    process.stdout.write(`warning: ${fleetWarning}\n`);
  }
  process.stdout.write(
    `target=${target.agentId} session=${target.sessionKey} baseUrl=${target.baseUrl}\n`
  );
  process.stdout.write(
    `samples=${config.samples} warmup=${config.warmup} timeoutMs=${config.timeoutMs} sloP95Ms=${config.sloP95Ms}\n`
  );
  process.stdout.write(
    "endpoint           attempts ok  errors p50      p95      mean     min      max\n"
  );
  for (const endpoint of endpoints) {
    const row = [
      endpoint.name.padEnd(18, " "),
      String(endpoint.stats.attempts).padStart(8, " "),
      String(endpoint.stats.count).padStart(3, " "),
      String(endpoint.errors.count).padStart(6, " "),
      toFixedMs(endpoint.stats.p50Ms).padStart(8, " "),
      toFixedMs(endpoint.stats.p95Ms).padStart(8, " "),
      toFixedMs(endpoint.stats.meanMs).padStart(8, " "),
      toFixedMs(endpoint.stats.minMs).padStart(8, " "),
      toFixedMs(endpoint.stats.maxMs).padStart(8, " "),
    ].join(" ");
    process.stdout.write(`${row}\n`);
    if (endpoint.errors.last) {
      process.stdout.write(
        `  last_error: status=${endpoint.errors.last.status} message=${endpoint.errors.last.message}\n`
      );
    }
  }
  process.stdout.write(`diagnosis: ${assessment.bottleneckHint}\n`);
  if (logInfo?.persisted) {
    process.stdout.write(
      `logs: run=${logInfo.runId} file=${logInfo.runsFile} latest=${logInfo.latestFile}\n`
    );
  } else if (logInfo?.error) {
    process.stdout.write(`warning: failed to persist logs (${logInfo.error})\n`);
  }
  process.stdout.write(`result: ${assessment.pass ? "PASS" : "FAIL"}\n`);
};

const finalizeProbeResult = ({ args, rawArgs, payload, endpointResults, fleetWarning }) => {
  const logInfo = args.persistLogs
    ? persistProbeRunLog({
        logDir: args.logDir,
        payload,
        rawArgs,
      })
    : { persisted: false, reason: "disabled" };

  const outputPayload = {
    ...payload,
    log: logInfo,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(outputPayload, null, 2)}\n`);
  } else {
    printHumanOutput({
      target: outputPayload.target,
      config: outputPayload.config,
      endpoints: endpointResults,
      assessment: outputPayload.assessment,
      fleetWarning,
      preflightMessage: outputPayload.preflight.message,
      logInfo,
    });
  }

  if (!outputPayload.assessment.pass) {
    process.exitCode = 1;
  }
};

export const runProbe = async (rawArgs) => {
  const startedAt = new Date().toISOString();
  const trace = [];
  const addTrace = (phase, meta = {}) => {
    trace.push({
      at: new Date().toISOString(),
      phase,
      ...meta,
    });
  };

  const args = parseProbeArgs(rawArgs);
  addTrace("probe:start", {
    baseUrl: args.baseUrl,
    agentId: args.agentId,
    sessionKey: args.sessionKey,
    samples: args.samples,
    warmup: args.warmup,
    timeoutMs: args.timeoutMs,
    sloP95Ms: args.sloP95Ms,
    allowDisconnected: args.allowDisconnected,
    persistLogs: args.persistLogs,
  });

  const preflightStartedAt = performance.now();
  const preflightResponse = await timedRequest({
    baseUrl: args.baseUrl,
    endpoint: {
      name: "summary-preflight",
      method: "GET",
      path: "/api/runtime/summary",
    },
    timeoutMs: args.timeoutMs,
  });
  const preflight = assessRuntimePreflight({
    response: preflightResponse,
    allowDisconnected: args.allowDisconnected,
  });
  addTrace("probe:preflight", {
    pass: preflight.pass,
    status: preflight.status,
    connected: preflight.connected,
    durationMs: performance.now() - preflightStartedAt,
  });

  if (!preflight.pass) {
    finalizeProbeResult({
      args,
      rawArgs,
      endpointResults: [],
      fleetWarning: null,
      payload: {
        run: {
          startedAt,
          finishedAt: new Date().toISOString(),
        },
        target: {
          baseUrl: args.baseUrl,
          agentId: args.agentId,
          sessionKey: args.sessionKey,
        },
        config: {
          samples: args.samples,
          warmup: args.warmup,
          timeoutMs: args.timeoutMs,
          sloP95Ms: args.sloP95Ms,
          allowDisconnected: args.allowDisconnected,
        },
        endpoints: [],
        assessment: {
          pass: false,
          bottleneckHint: "preflight failed",
        },
        preflight,
        trace,
      },
    });
    return;
  }

  const fleetResolutionNeeded = !args.agentId && !parseAgentIdFromSessionKey(args.sessionKey);
  const fleetStartedAt = performance.now();
  const fleetLoaded = fleetResolutionNeeded
    ? await loadFleetResult({ baseUrl: args.baseUrl, timeoutMs: args.timeoutMs })
    : { result: null, warning: null };
  addTrace("probe:fleet", {
    resolvedViaFleet: fleetResolutionNeeded,
    warning: fleetLoaded.warning,
    durationMs: performance.now() - fleetStartedAt,
  });

  const target = resolveTargetFromFleet({
    explicitAgentId: args.agentId,
    explicitSessionKey: args.sessionKey,
    fleetResult: fleetLoaded.result,
  });
  const endpoints = buildProbePaths(target);

  const endpointResults = [];
  for (const endpoint of endpoints) {
    const endpointStartedAt = performance.now();
    addTrace("probe:endpoint:start", {
      endpoint: endpoint.name,
      path: endpoint.path,
    });
    const endpointResult =
      await runEndpointProbe({
        baseUrl: args.baseUrl,
        endpoint,
        warmup: args.warmup,
        samples: args.samples,
        timeoutMs: args.timeoutMs,
      });
    endpointResults.push(endpointResult);
    addTrace("probe:endpoint:finish", {
      endpoint: endpoint.name,
      status: endpointResult.status,
      errors: endpointResult.errors.count,
      p95Ms: endpointResult.stats.p95Ms,
      durationMs: performance.now() - endpointStartedAt,
    });
  }

  const assessment = assessProbe({
    endpoints: endpointResults,
    sloP95Ms: args.sloP95Ms,
  });
  addTrace("probe:assessment", {
    pass: assessment.pass,
    bottleneckHint: assessment.bottleneckHint,
  });

  const payload = {
    run: {
      startedAt,
      finishedAt: new Date().toISOString(),
    },
    target: {
      baseUrl: args.baseUrl,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
    },
    config: {
      samples: args.samples,
      warmup: args.warmup,
      timeoutMs: args.timeoutMs,
      sloP95Ms: args.sloP95Ms,
      allowDisconnected: args.allowDisconnected,
    },
    endpoints: endpointResults.map((entry) => ({
      name: entry.name,
      path: entry.path,
      status: entry.status,
      stats: entry.stats,
      errors: entry.errors,
      probe: entry.probe,
    })),
    assessment,
    preflight,
    trace,
  };

  finalizeProbeResult({
    args,
    rawArgs,
    payload,
    endpointResults,
    fleetWarning: fleetLoaded.warning,
  });
};

const isDirectRun = (() => {
  const scriptArg = process.argv[1];
  if (!scriptArg) return false;
  try {
    return new URL(`file://${scriptArg}`).pathname === new URL(import.meta.url).pathname;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  runProbe(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
