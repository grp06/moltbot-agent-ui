const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { resolveHosts, isPublicHost } = require("./network-policy");
const { readOpenclawGatewayDefaults } = require("./studio-settings");

const execFileAsync = promisify(execFile);
const OPENCLAW_PROBE_TIMEOUT_MS = 1_500;
const TAILSCALE_PROBE_TIMEOUT_MS = 1_200;
const STUDIO_CLI_PROBE_TIMEOUT_MS = 1_200;
const STUDIO_CLI_LATEST_TIMEOUT_MS = 2_500;
const STUDIO_CLI_LATEST_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const STUDIO_CLI_LATEST_ERROR_CACHE_TTL_MS = 1000 * 60 * 10;
const STUDIO_CLI_PACKAGE_NAME = "openclaw-studio";

const normalizeErrorCode = (error) => {
  if (!error || typeof error !== "object") return "";
  if (typeof error.code === "string") return error.code.trim();
  return "";
};

const normalizeErrorMessage = (error) => {
  if (error instanceof Error) {
    return error.message.trim();
  }
  return "";
};

const normalizeJsonValue = (value) => {
  if (!value || typeof value !== "object") return null;
  return value;
};

const coerceString = (value) => {
  return typeof value === "string" ? value.trim() : "";
};

const parseSemver = (value) => {
  const normalized = coerceString(value);
  const match = normalized.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return {
    major,
    minor,
    patch,
    prerelease: match[4] ? match[4].split(".").filter(Boolean) : [],
  };
};

const comparePrereleaseSegment = (left, right) => {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1;
    return 0;
  }
  if (leftNumeric && !rightNumeric) return -1;
  if (!leftNumeric && rightNumeric) return 1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
};

const comparePrerelease = (left, right) => {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftSegment = left[index];
    const rightSegment = right[index];
    if (leftSegment === undefined) return -1;
    if (rightSegment === undefined) return 1;
    const segmentComparison = comparePrereleaseSegment(leftSegment, rightSegment);
    if (segmentComparison !== 0) return segmentComparison;
  }
  return 0;
};

const compareSemverVersions = (currentVersion, latestVersion) => {
  const current = parseSemver(currentVersion);
  const latest = parseSemver(latestVersion);
  if (!current || !latest) return null;
  if (current.major !== latest.major) return current.major > latest.major ? 1 : -1;
  if (current.minor !== latest.minor) return current.minor > latest.minor ? 1 : -1;
  if (current.patch !== latest.patch) return current.patch > latest.patch ? 1 : -1;
  return comparePrerelease(current.prerelease, latest.prerelease);
};

const runJsonCommand = async (command, args, timeoutMs, runner = execFileAsync) => {
  try {
    const { stdout } = await runner(command, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
    });
    const parsed = JSON.parse(String(stdout ?? "").trim());
    return {
      available: true,
      ok: true,
      value: normalizeJsonValue(parsed),
      error: null,
    };
  } catch (error) {
    const code = normalizeErrorCode(error);
    const message = normalizeErrorMessage(error);
    const timedOut =
      code === "ETIMEDOUT" ||
      code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      message.toLowerCase().includes("timed out");
    if (code === "ENOENT") {
      return {
        available: false,
        ok: false,
        value: null,
        error: "cli_not_found",
      };
    }
    return {
      available: true,
      ok: false,
      value: null,
      error: timedOut ? "probe_timeout" : message || "probe_failed",
    };
  }
};

const runTextCommand = async (command, args, timeoutMs, runner = execFileAsync) => {
  try {
    const { stdout } = await runner(command, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
    });
    return {
      available: true,
      ok: true,
      stdout: coerceString(stdout),
      error: null,
    };
  } catch (error) {
    const code = normalizeErrorCode(error);
    const message = normalizeErrorMessage(error);
    const timedOut =
      code === "ETIMEDOUT" ||
      code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      message.toLowerCase().includes("timed out");
    if (code === "ENOENT") {
      return {
        available: false,
        ok: false,
        stdout: "",
        error: "cli_not_found",
      };
    }
    return {
      available: true,
      ok: false,
      stdout: "",
      error: timedOut ? "probe_timeout" : message || "probe_failed",
    };
  }
};

let studioCliLatestCache = {
  latestVersion: null,
  checkedAt: null,
  checkedAtMs: 0,
  error: null,
};

const readStudioCliLatestCache = (nowMs = Date.now()) => {
  if (!studioCliLatestCache.checkedAtMs) return null;
  const ttlMs = studioCliLatestCache.error
    ? STUDIO_CLI_LATEST_ERROR_CACHE_TTL_MS
    : STUDIO_CLI_LATEST_CACHE_TTL_MS;
  if (nowMs - studioCliLatestCache.checkedAtMs > ttlMs) return null;
  return {
    latestVersion: studioCliLatestCache.latestVersion,
    checkedAt: studioCliLatestCache.checkedAt,
    error: studioCliLatestCache.error,
  };
};

const writeStudioCliLatestCache = (input) => {
  const checkedAt = input.checkedAt || new Date().toISOString();
  const checkedAtMs = Date.parse(checkedAt);
  studioCliLatestCache = {
    latestVersion: input.latestVersion || null,
    checkedAt,
    checkedAtMs: Number.isFinite(checkedAtMs) ? checkedAtMs : Date.now(),
    error: input.error || null,
  };
  return {
    latestVersion: studioCliLatestCache.latestVersion,
    checkedAt: studioCliLatestCache.checkedAt,
    error: studioCliLatestCache.error,
  };
};

const fetchLatestStudioCliVersion = async (fetchImpl = fetch) => {
  const cached = readStudioCliLatestCache();
  if (cached) return cached;
  if (typeof fetchImpl !== "function") {
    return writeStudioCliLatestCache({
      latestVersion: null,
      error: "version_check_unavailable",
    });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STUDIO_CLI_LATEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      `https://registry.npmjs.org/${encodeURIComponent(STUDIO_CLI_PACKAGE_NAME)}/latest`,
      {
        signal: controller.signal,
        headers: { accept: "application/json" },
      }
    );
    if (!response.ok) {
      return writeStudioCliLatestCache({
        latestVersion: null,
        error: `registry_http_${response.status}`,
      });
    }
    const payload = await response.json();
    const latestVersion = coerceString(payload && payload.version);
    if (!latestVersion) {
      return writeStudioCliLatestCache({
        latestVersion: null,
        error: "invalid_registry_payload",
      });
    }
    return writeStudioCliLatestCache({
      latestVersion,
      checkedAt: new Date().toISOString(),
      error: null,
    });
  } catch (error) {
    const message = normalizeErrorMessage(error).toLowerCase();
    const timeoutLike =
      message.includes("timed out") ||
      message.includes("aborted") ||
      message.includes("aborterror");
    return writeStudioCliLatestCache({
      latestVersion: null,
      error: timeoutLike ? "version_check_timeout" : "version_check_failed",
    });
  } finally {
    clearTimeout(timeout);
  }
};

const resolveVersionFromOutput = (stdout) => {
  const firstLine = coerceString(stdout).split(/\r?\n/, 1)[0] || "";
  const match = firstLine.match(/v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/);
  return match ? coerceString(match[0]) : "";
};

const probeStudioCliVersion = async (runner = execFileAsync) => {
  const probe = await runTextCommand(
    "openclaw-studio",
    ["--version"],
    STUDIO_CLI_PROBE_TIMEOUT_MS,
    runner
  );
  if (!probe.available) {
    return {
      installed: false,
      currentVersion: null,
      error: null,
    };
  }
  if (!probe.ok) {
    return {
      installed: true,
      currentVersion: null,
      error: probe.error || "version_probe_failed",
    };
  }
  const currentVersion = resolveVersionFromOutput(probe.stdout);
  if (!currentVersion) {
    return {
      installed: true,
      currentVersion: null,
      error: "version_parse_failed",
    };
  }
  return {
    installed: true,
    currentVersion,
    error: null,
  };
};

const probeStudioCli = async (env = process.env, runner = execFileAsync, fetchImpl = fetch) => {
  const current = await probeStudioCliVersion(runner);
  if (!current.installed) {
    return {
      installed: false,
      currentVersion: null,
      latestVersion: null,
      updateAvailable: false,
      checkedAt: null,
      checkError: null,
    };
  }

  if (env && String(env.NODE_ENV || "").trim() === "test") {
    return {
      installed: true,
      currentVersion: current.currentVersion,
      latestVersion: null,
      updateAvailable: false,
      checkedAt: null,
      checkError: current.error,
    };
  }

  if (!current.currentVersion) {
    return {
      installed: true,
      currentVersion: null,
      latestVersion: null,
      updateAvailable: false,
      checkedAt: null,
      checkError: current.error || "version_probe_failed",
    };
  }

  const latest = await fetchLatestStudioCliVersion(fetchImpl);
  const versionComparison = latest.latestVersion
    ? compareSemverVersions(current.currentVersion, latest.latestVersion)
    : null;

  return {
    installed: true,
    currentVersion: current.currentVersion,
    latestVersion: latest.latestVersion,
    updateAvailable: versionComparison === -1,
    checkedAt: latest.checkedAt,
    checkError:
      current.error ||
      latest.error ||
      (latest.latestVersion && versionComparison === null ? "version_compare_failed" : null),
  };
};

const normalizeDnsName = (value) => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  return trimmed.replace(/\.$/, "");
};

const probeTailscale = async (runner = execFileAsync) => {
  const result = await runJsonCommand(
    "tailscale",
    ["status", "--json"],
    TAILSCALE_PROBE_TIMEOUT_MS,
    runner
  );
  if (!result.available) {
    return {
      installed: false,
      loggedIn: false,
      dnsName: null,
    };
  }
  const parsed = result.value;
  const backendState =
    parsed && typeof parsed.BackendState === "string" ? parsed.BackendState.trim() : "";
  const dnsName = normalizeDnsName(parsed && parsed.Self ? parsed.Self.DNSName : "");
  const loggedIn =
    result.ok &&
    backendState !== "NeedsLogin" &&
    backendState !== "NoState" &&
    backendState !== "Stopped";
  return {
    installed: true,
    loggedIn,
    dnsName: loggedIn ? dnsName : null,
  };
};

const probeLocalGateway = async (runner = execFileAsync) => {
  const [statusProbe, sessionsProbe] = await Promise.all([
    runJsonCommand("openclaw", ["status", "--json"], OPENCLAW_PROBE_TIMEOUT_MS, runner),
    runJsonCommand("openclaw", ["sessions", "--json"], OPENCLAW_PROBE_TIMEOUT_MS, runner),
  ]);
  const issues = Array.from(
    new Set([statusProbe.error, sessionsProbe.error].filter((value) => typeof value === "string" && value))
  );
  return {
    cliAvailable: statusProbe.available || sessionsProbe.available,
    statusProbeOk: statusProbe.ok,
    sessionsProbeOk: sessionsProbe.ok,
    probeHealthy: statusProbe.ok || sessionsProbe.ok,
    issues,
  };
};

const resolveRemoteShell = (env = process.env) => {
  return Boolean(
    String(env.SSH_CONNECTION ?? "").trim() ||
      String(env.SSH_CLIENT ?? "").trim() ||
      String(env.SSH_TTY ?? "").trim()
  );
};

const resolveHostname = () => {
  const hostname = String(os.hostname?.() ?? "").trim();
  return hostname || null;
};

async function detectInstallContext(env = process.env, options = {}) {
  const resolveHostsImpl = options.resolveHosts || resolveHosts;
  const isPublicHostImpl = options.isPublicHost || isPublicHost;
  const readOpenclawGatewayDefaultsImpl =
    options.readOpenclawGatewayDefaults || readOpenclawGatewayDefaults;
  const runCommand = options.runCommand || execFileAsync;
  const fetchImpl = options.fetch || fetch;
  const configuredHosts = Array.from(
    new Set(resolveHostsImpl(env).map((value) => String(value ?? "").trim()).filter(Boolean))
  );
  const publicHosts = configuredHosts.filter((host) => isPublicHostImpl(host));
  const localDefaults = readOpenclawGatewayDefaultsImpl(env);
  const [localGatewayProbe, tailscale, studioCli] = await Promise.all([
    probeLocalGateway(runCommand),
    probeTailscale(runCommand),
    probeStudioCli(env, runCommand, fetchImpl),
  ]);

  return {
    studioHost: {
      hostname: resolveHostname(),
      configuredHosts,
      publicHosts,
      loopbackOnly: publicHosts.length === 0,
      remoteShell: resolveRemoteShell(env),
      studioAccessTokenConfigured: Boolean(String(env.STUDIO_ACCESS_TOKEN ?? "").trim()),
    },
    localGateway: {
      defaultsDetected: Boolean(localDefaults?.url),
      url: localDefaults?.url ?? null,
      hasToken: Boolean(localDefaults?.token),
      cliAvailable: localGatewayProbe.cliAvailable,
      statusProbeOk: localGatewayProbe.statusProbeOk,
      sessionsProbeOk: localGatewayProbe.sessionsProbeOk,
      probeHealthy: localGatewayProbe.probeHealthy,
      issues: localGatewayProbe.issues,
    },
    studioCli,
    tailscale,
  };
}

function buildStartupGuidance(params) {
  const installContext = params.installContext;
  const port = Number.isFinite(params.port) && params.port > 0 ? params.port : 3000;
  const hostLabel =
    installContext.tailscale.dnsName ||
    installContext.studioHost.publicHosts[0] ||
    "<studio-host>";
  const sshTarget = installContext.tailscale.dnsName || hostLabel;
  const lines = [];

  if (installContext.studioHost.remoteShell && installContext.studioHost.loopbackOnly) {
    lines.push(
      `Studio is running on a remote host. http://localhost:${port} only opens on that machine.`
    );
    if (installContext.localGateway.defaultsDetected || installContext.localGateway.probeHealthy) {
      lines.push("If OpenClaw is on this same host, keep Studio's upstream at ws://localhost:18789.");
    }
    if (installContext.tailscale.loggedIn && installContext.tailscale.dnsName) {
      lines.push(
        `Recommended: tailscale serve --yes --bg --https 443 http://127.0.0.1:${port}`
      );
      lines.push(`Then open: https://${installContext.tailscale.dnsName}`);
    } else {
      lines.push("Recommended: install/login to Tailscale, or keep Studio on loopback and use SSH tunneling.");
    }
    lines.push(`SSH tunnel fallback: ssh -L ${port}:127.0.0.1:${port} ${sshTarget}`);
    return lines;
  }

  if (installContext.studioHost.publicHosts.length > 0) {
    lines.push(`Studio is exposed on ${installContext.studioHost.publicHosts.join(", ")}.`);
    if (installContext.studioHost.studioAccessTokenConfigured) {
      lines.push("Open /?access_token=... once from each new browser to set the Studio access cookie.");
    }
    if (installContext.localGateway.defaultsDetected || installContext.localGateway.probeHealthy) {
      lines.push("If OpenClaw is on this same host, keep Studio's upstream at ws://localhost:18789.");
    }
    return lines;
  }

  return lines;
}

module.exports = {
  detectInstallContext,
  buildStartupGuidance,
};
