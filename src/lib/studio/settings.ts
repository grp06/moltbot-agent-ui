export type StudioGatewaySettings = {
  url: string;
  token: string;
};

type StudioGatewaySettingsPatch = {
  url?: string | null;
  token?: string | null;
};

type FocusFilter = "all" | "running" | "approvals";
type StudioViewMode = "focused";

export type StudioFocusedPreference = {
  mode: StudioViewMode;
  selectedAgentId: string | null;
  filter: FocusFilter;
};

export type StudioSettings = {
  version: 1;
  gateway: StudioGatewaySettings | null;
  gatewayAutoStart: boolean;
  focused: Record<string, StudioFocusedPreference>;
  avatars: Record<string, Record<string, string>>;
};

export type StudioSettingsPatch = {
  gateway?: StudioGatewaySettingsPatch | null;
  gatewayAutoStart?: boolean | null;
  focused?: Record<string, Partial<StudioFocusedPreference> | null>;
  avatars?: Record<string, Record<string, string | null> | null>;
};

const SETTINGS_VERSION = 1 as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const coerceString = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "0.0.0.0"]);

const normalizeParsedHostname = (value: string) =>
  value.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");

export const normalizeGatewayUrl = (value: unknown) => {
  const url = coerceString(value);
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

export const canUseLocalGatewayDefaultsForUrl = (
  configuredUrl: unknown,
  defaultsUrl: unknown
) => {
  const fallbackUrl = normalizeGatewayUrl(defaultsUrl);
  if (!fallbackUrl) return false;
  const url = normalizeGatewayUrl(configuredUrl);
  return !url || url === fallbackUrl;
};

const normalizeGatewayKey = (value: unknown) => {
  const key = normalizeGatewayUrl(value);
  return key ? key : null;
};

const normalizeFocusFilter = (
  value: unknown,
  fallback: FocusFilter = "all"
): FocusFilter => {
  const filter = coerceString(value);
  if (filter === "needs-attention") return "all";
  if (filter === "idle") return "approvals";
  if (
    filter === "all" ||
    filter === "running" ||
    filter === "approvals"
  ) {
    return filter;
  }
  return fallback;
};

const normalizeViewMode = (
  value: unknown,
  fallback: StudioViewMode = "focused"
): StudioViewMode => {
  const mode = coerceString(value);
  if (mode === "focused") {
    return mode;
  }
  return fallback;
};

const normalizeSelectedAgentId = (value: unknown, fallback: string | null = null) => {
  if (value === null) return null;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const defaultFocusedPreference = (): StudioFocusedPreference => ({
  mode: "focused",
  selectedAgentId: null,
  filter: "all",
});

const normalizeFocusedPreference = (
  value: unknown,
  fallback: StudioFocusedPreference = defaultFocusedPreference()
): StudioFocusedPreference => {
  if (!isRecord(value)) return fallback;
  return {
    mode: normalizeViewMode(value.mode, fallback.mode),
    selectedAgentId: normalizeSelectedAgentId(
      value.selectedAgentId,
      fallback.selectedAgentId
    ),
    filter: normalizeFocusFilter(value.filter, fallback.filter),
  };
};

const normalizeGatewaySettings = (value: unknown): StudioGatewaySettings | null => {
  if (!isRecord(value)) return null;
  const url = normalizeGatewayUrl(value.url);
  if (!url) return null;
  const token = coerceString(value.token);
  return { url, token };
};

const hasOwn = (value: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const mergeGatewaySettings = (
  current: StudioGatewaySettings | null,
  patch: StudioGatewaySettingsPatch | null | undefined
): StudioGatewaySettings | null => {
  if (patch === undefined) return current;
  if (patch === null) return null;
  if (!isRecord(patch)) return current;

  const patchHasUrl = hasOwn(patch, "url");
  const patchHasToken = hasOwn(patch, "token");
  const nextUrl = hasOwn(patch, "url") ? normalizeGatewayUrl(patch.url) : current?.url ?? "";
  const sameGatewayUrl = normalizeGatewayUrl(current?.url ?? "") === nextUrl;
  const nextToken = patchHasToken
    ? coerceString(patch.token)
    : patchHasUrl && !sameGatewayUrl
      ? ""
      : current?.token ?? "";
  if (!nextUrl) return null;
  return { url: nextUrl, token: nextToken };
};

const normalizeFocused = (value: unknown): Record<string, StudioFocusedPreference> => {
  if (!isRecord(value)) return {};
  const focused: Record<string, StudioFocusedPreference> = {};
  for (const [gatewayKeyRaw, focusedRaw] of Object.entries(value)) {
    const gatewayKey = normalizeGatewayKey(gatewayKeyRaw);
    if (!gatewayKey) continue;
    focused[gatewayKey] = normalizeFocusedPreference(focusedRaw);
  }
  return focused;
};

const normalizeAvatars = (value: unknown): Record<string, Record<string, string>> => {
  if (!isRecord(value)) return {};
  const avatars: Record<string, Record<string, string>> = {};
  for (const [gatewayKeyRaw, gatewayRaw] of Object.entries(value)) {
    const gatewayKey = normalizeGatewayKey(gatewayKeyRaw);
    if (!gatewayKey) continue;
    if (!isRecord(gatewayRaw)) continue;
    const entries: Record<string, string> = {};
    for (const [agentIdRaw, seedRaw] of Object.entries(gatewayRaw)) {
      const agentId = coerceString(agentIdRaw);
      if (!agentId) continue;
      const seed = coerceString(seedRaw);
      if (!seed) continue;
      entries[agentId] = seed;
    }
    avatars[gatewayKey] = entries;
  }
  return avatars;
};

export const defaultStudioSettings = (): StudioSettings => ({
  version: SETTINGS_VERSION,
  gateway: null,
  gatewayAutoStart: true,
  focused: {},
  avatars: {},
});

export const normalizeStudioSettings = (raw: unknown): StudioSettings => {
  if (!isRecord(raw)) return defaultStudioSettings();
  const gateway = normalizeGatewaySettings(raw.gateway);
  const gatewayAutoStart = typeof raw.gatewayAutoStart === "boolean" ? raw.gatewayAutoStart : true;
  const focused = normalizeFocused(raw.focused);
  const avatars = normalizeAvatars(raw.avatars);
  return {
    version: SETTINGS_VERSION,
    gateway,
    gatewayAutoStart,
    focused,
    avatars,
  };
};

export const mergeStudioSettings = (
  current: StudioSettings,
  patch: StudioSettingsPatch
): StudioSettings => {
  const nextGateway = mergeGatewaySettings(current.gateway, patch.gateway);
  const nextGatewayAutoStart =
    typeof patch.gatewayAutoStart === "boolean" ? patch.gatewayAutoStart : current.gatewayAutoStart;
  const nextFocused = { ...current.focused };
  const nextAvatars = { ...current.avatars };
  if (patch.focused) {
    for (const [keyRaw, value] of Object.entries(patch.focused)) {
      const key = normalizeGatewayKey(keyRaw);
      if (!key) continue;
      if (value === null) {
        delete nextFocused[key];
        continue;
      }
      const fallback = nextFocused[key] ?? defaultFocusedPreference();
      nextFocused[key] = normalizeFocusedPreference(value, fallback);
    }
  }
  if (patch.avatars) {
    for (const [gatewayKeyRaw, gatewayPatch] of Object.entries(patch.avatars)) {
      const gatewayKey = normalizeGatewayKey(gatewayKeyRaw);
      if (!gatewayKey) continue;
      if (gatewayPatch === null) {
        delete nextAvatars[gatewayKey];
        continue;
      }
      if (!isRecord(gatewayPatch)) continue;
      const existing = nextAvatars[gatewayKey] ? { ...nextAvatars[gatewayKey] } : {};
      for (const [agentIdRaw, seedPatchRaw] of Object.entries(gatewayPatch)) {
        const agentId = coerceString(agentIdRaw);
        if (!agentId) continue;
        if (seedPatchRaw === null) {
          delete existing[agentId];
          continue;
        }
        const seed = coerceString(seedPatchRaw);
        if (!seed) {
          delete existing[agentId];
          continue;
        }
        existing[agentId] = seed;
      }
      nextAvatars[gatewayKey] = existing;
    }
  }
  return {
    version: SETTINGS_VERSION,
    gateway: nextGateway ?? null,
    gatewayAutoStart: nextGatewayAutoStart,
    focused: nextFocused,
    avatars: nextAvatars,
  };
};

export const resolveFocusedPreference = (
  settings: StudioSettings,
  gatewayUrl: string
): StudioFocusedPreference | null => {
  const key = normalizeGatewayKey(gatewayUrl);
  if (!key) return null;
  return settings.focused[key] ?? null;
};

export const resolveAgentAvatarSeed = (
  settings: StudioSettings,
  gatewayUrl: string,
  agentId: string
): string | null => {
  const gatewayKey = normalizeGatewayKey(gatewayUrl);
  if (!gatewayKey) return null;
  const agentKey = coerceString(agentId);
  if (!agentKey) return null;
  return settings.avatars[gatewayKey]?.[agentKey] ?? null;
};
