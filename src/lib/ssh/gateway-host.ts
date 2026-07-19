import * as childProcess from "node:child_process";

const SSH_TARGET_ENV = "OPENCLAW_GATEWAY_SSH_TARGET";
const SSH_USER_ENV = "OPENCLAW_GATEWAY_SSH_USER";

const normalizeSshHostname = (value: string): string =>
  value.trim().replace(/^\[(.*)\]$/, "$1");

export const resolveConfiguredSshTarget = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const configuredTarget = env[SSH_TARGET_ENV]?.trim() ?? "";
  const configuredUser = env[SSH_USER_ENV]?.trim() ?? "";

  if (configuredTarget) {
    if (configuredTarget.includes("@")) return configuredTarget;
    if (configuredUser) return `${configuredUser}@${configuredTarget}`;
    return configuredTarget;
  }

  return null;
};

export const resolveGatewaySshTargetFromGatewayUrl = (
  gatewayUrl: string,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const configured = resolveConfiguredSshTarget(env);
  if (configured) return configured;

  const trimmed = gatewayUrl.trim();
  if (!trimmed) {
    throw new Error(
      `Gateway URL is missing. Set it in Studio settings or set ${SSH_TARGET_ENV}.`
    );
  }
  let hostname: string;
  try {
    hostname = normalizeSshHostname(new URL(trimmed).hostname);
  } catch {
    throw new Error(`Invalid gateway URL: ${trimmed}`);
  }
  if (!hostname) {
    throw new Error(`Invalid gateway URL: ${trimmed}`);
  }

  const configuredUser = env[SSH_USER_ENV]?.trim() ?? "";
  const user = configuredUser || "ubuntu";
  return `${user}@${hostname}`;
};

const extractJsonErrorMessage = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const direct = record.error;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    if (direct && typeof direct === "object") {
      const nested = (direct as Record<string, unknown>).message;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
    return null;
  } catch {
    return null;
  }
};

const parseJsonOutput = (raw: string, label: string): unknown => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Command produced empty JSON output (${label}).`);
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error(`Command produced invalid JSON output (${label}).`);
  }
};

export const runSshJson = (params: {
  sshTarget: string;
  argv: string[];
  label: string;
  input?: string;
  fallbackMessage?: string;
  maxBuffer?: number;
}): unknown => {
  const options: childProcess.SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    input: params.input,
  };
  if (params.maxBuffer !== undefined) {
    options.maxBuffer = params.maxBuffer;
  }

  const sshTarget = params.sshTarget.trim();
  if (!sshTarget) {
    throw new Error("SSH target is required.");
  }

  const result = childProcess.spawnSync("ssh", ["-o", "BatchMode=yes", "--", sshTarget, ...params.argv], {
    ...options,
  });
  if (result.error) {
    throw new Error(`Failed to execute ssh: ${result.error.message}`);
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    const stderrText = stderr.trim();
    const stdoutText = stdout.trim();
    const message =
      extractJsonErrorMessage(stdout) ??
      extractJsonErrorMessage(stderr) ??
      (stderrText ||
        stdoutText ||
        params.fallbackMessage ||
        `Command failed (${params.label}).`);
    throw new Error(message);
  }
  return parseJsonOutput(stdout, params.label);
};
