const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const NEW_STATE_DIRNAME = ".openclaw";

const resolveUserPath = (input) => {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
};

const resolveDefaultHomeDir = () => {
  const home = os.homedir();
  if (home) {
    try {
      if (fs.existsSync(home)) return home;
    } catch {}
  }
  return os.tmpdir();
};

const resolveStateDir = (env = process.env) => {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) return resolveUserPath(override);

  const home = resolveDefaultHomeDir();
  return path.join(home, NEW_STATE_DIRNAME);
};

const resolveStudioSettingsPath = (env = process.env) => {
  return path.join(resolveStateDir(env), "openclaw-studio", "settings.json");
};

const readJsonFile = (filePath) => {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const writeJsonFileAtomic = (filePath, value) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    throw err;
  }
};

const DEFAULT_GATEWAY_URL = "ws://localhost:18789";
const OPENCLAW_CONFIG_FILENAME = "openclaw.json";

const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "0.0.0.0"]);

const normalizeParsedHostname = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");

const normalizeGatewayUrl = (value) => {
  const url = String(value ?? "").trim();
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (!LOOPBACK_HOSTNAMES.has(normalizeParsedHostname(parsed.hostname))) {
      return url;
    }
    const auth =
      parsed.username || parsed.password
        ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ""}@`
        : "";
    const host = parsed.port ? `localhost:${parsed.port}` : "localhost";
    const dropDefaultPath =
      parsed.pathname === "/" && !url.endsWith("/") && !parsed.search && !parsed.hash;
    const pathname = dropDefaultPath ? "" : parsed.pathname;
    return `${parsed.protocol}//${auth}${host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
};

const canUseLocalGatewayDefaultsForUrl = (configuredUrl, defaultsUrl) => {
  const fallbackUrl = normalizeGatewayUrl(defaultsUrl);
  if (!fallbackUrl) return false;
  const url = normalizeGatewayUrl(configuredUrl);
  return !url || url === fallbackUrl;
};

const readOpenclawGatewayDefaults = (env = process.env) => {
  try {
    const stateDir = resolveStateDir(env);
    const configPath = path.join(stateDir, OPENCLAW_CONFIG_FILENAME);
    const parsed = readJsonFile(configPath);
    if (!isRecord(parsed)) return null;
    const gateway = isRecord(parsed.gateway) ? parsed.gateway : null;
    if (!gateway) return null;
    const auth = isRecord(gateway.auth) ? gateway.auth : null;
    const token = typeof auth?.token === "string" ? auth.token.trim() : "";
    const port =
      typeof gateway.port === "number" && Number.isFinite(gateway.port) ? gateway.port : null;
    if (!token) return null;
    const url = port ? `ws://localhost:${port}` : "";
    if (!url) return null;
    return { url, token };
  } catch {
    return null;
  }
};

const loadUpstreamGatewaySettings = (env = process.env) => {
  const parsed = readJsonFile(resolveStudioSettingsPath(env));
  const gateway = parsed && typeof parsed === "object" ? parsed.gateway : null;
  const url = typeof gateway?.url === "string" ? gateway.url.trim() : "";
  const token = typeof gateway?.token === "string" ? gateway.token.trim() : "";
  if (!token) {
    const defaults = readOpenclawGatewayDefaults(env);
    if (defaults && canUseLocalGatewayDefaultsForUrl(url, defaults.url)) {
      return {
        url: url || defaults.url,
        token: defaults.token,
      };
    }
  }
  return {
    url: url || DEFAULT_GATEWAY_URL,
    token,
  };
};

module.exports = {
  resolveStudioSettingsPath,
  loadUpstreamGatewaySettings,
  readOpenclawGatewayDefaults,
  writeJsonFileAtomic,
};
