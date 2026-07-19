import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { resolveStateDir } from "@/lib/clawdbot/paths";
import {
  canUseLocalGatewayDefaultsForUrl,
  defaultStudioSettings,
  mergeStudioSettings,
  normalizeGatewayUrl,
  normalizeStudioSettings,
  type StudioSettings,
  type StudioSettingsPatch,
} from "@/lib/studio/settings";

const SETTINGS_DIRNAME = "openclaw-studio";
const SETTINGS_FILENAME = "settings.json";
const OPENCLAW_CONFIG_FILENAME = "openclaw.json";

const resolveStudioSettingsPath = () =>
  path.join(resolveStateDir(), SETTINGS_DIRNAME, SETTINGS_FILENAME);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const readJsonFile = (filePath: string): unknown | null => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
};

const readOpenclawGatewayDefaults = (): { url: string; token: string } | null => {
  try {
    const configPath = path.join(resolveStateDir(), OPENCLAW_CONFIG_FILENAME);
    const parsed = readJsonFile(configPath);
    if (!isRecord(parsed)) return null;
    const gateway = isRecord(parsed.gateway) ? parsed.gateway : null;
    if (!gateway) return null;
    const auth = isRecord(gateway.auth) ? gateway.auth : null;
    const token = typeof auth?.token === "string" ? auth.token.trim() : "";
    const port = typeof gateway.port === "number" && Number.isFinite(gateway.port) ? gateway.port : null;
    if (!token) return null;
    const url = port ? `ws://localhost:${port}` : "";
    if (!url) return null;
    return { url, token };
  } catch {
    return null;
  }
};

export const loadLocalGatewayDefaults = () => {
  return readOpenclawGatewayDefaults();
};

export const loadPersistedStudioSettings = (): StudioSettings => {
  const settingsPath = resolveStudioSettingsPath();
  const parsed = readJsonFile(settingsPath);
  if (parsed === null) {
    return defaultStudioSettings();
  }
  return normalizeStudioSettings(parsed);
};

export const redactStudioSettingsSecrets = (settings: StudioSettings): StudioSettings => {
  if (!settings.gateway) return settings;
  return {
    ...settings,
    gateway: {
      ...settings.gateway,
      token: "",
    },
  };
};

export const redactLocalGatewayDefaultsSecrets = (
  defaults: { url: string; token: string } | null
): { url: string; token: string } | null => {
  if (!defaults) return null;
  return {
    ...defaults,
    token: "",
  };
};

export const loadStudioSettings = (): StudioSettings => {
  const settings = loadPersistedStudioSettings();
  if (!settings.gateway?.token) {
    const gateway = loadLocalGatewayDefaults();
    if (
      gateway &&
      canUseLocalGatewayDefaultsForUrl(settings.gateway?.url ?? "", gateway.url)
    ) {
      return {
        ...settings,
        gateway: settings.gateway?.url?.trim()
          ? { url: settings.gateway.url.trim(), token: gateway.token }
          : gateway,
      };
    }
  }
  return settings;
};

export const resolveGatewayTokenForUrl = (gatewayUrl: unknown): string => {
  const settings = loadPersistedStudioSettings();
  const persistedToken = settings.gateway?.token?.trim() ?? "";
  const persistedUrl = settings.gateway?.url ?? "";
  if (persistedToken && normalizeGatewayUrl(gatewayUrl) === normalizeGatewayUrl(persistedUrl)) {
    return persistedToken;
  }
  const defaults = loadLocalGatewayDefaults();
  if (defaults && canUseLocalGatewayDefaultsForUrl(gatewayUrl, defaults.url)) {
    return defaults.token;
  }
  return "";
};

const saveStudioSettings = (next: StudioSettings) => {
  const settingsPath = resolveStudioSettingsPath();
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path.join(dir, `${SETTINGS_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmpPath, settingsPath);
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup only; preserve the original write error.
    }
    throw error;
  }
};

export const applyStudioSettingsPatch = (patch: StudioSettingsPatch): StudioSettings => {
  const current = loadPersistedStudioSettings();
  const next = mergeStudioSettings(current, patch);
  saveStudioSettings(next);
  return loadStudioSettings();
};
