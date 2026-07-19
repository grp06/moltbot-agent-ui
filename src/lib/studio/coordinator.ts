import { fetchJson } from "@/lib/http";
import type {
  StudioFocusedPreference,
  StudioGatewaySettings,
  StudioSettings,
  StudioSettingsPatch,
} from "@/lib/studio/settings";
import type { StudioInstallContext } from "@/lib/studio/install-context";

export type StudioSettingsResponse = {
  settings: StudioSettings;
  localGatewayDefaults?: StudioGatewaySettings | null;
  localGatewayDefaultsMeta?: {
    hasToken: boolean;
  };
  gatewayMeta?: {
    hasStoredToken: boolean;
    credentialScope?: string;
  };
  installContext?: StudioInstallContext;
  domainApiModeEnabled?: boolean;
  runtimeReconnect?: {
    attempted: boolean;
    restarted: boolean;
    reason?: string;
    previousStatus?: string;
    error?: string;
  } | null;
};

type FocusedPatch = Record<string, Partial<StudioFocusedPreference> | null>;
type AvatarsPatch = Record<string, Record<string, string | null> | null>;

type StudioSettingsCoordinatorTransport = {
  fetchSettings: () => Promise<StudioSettingsResponse>;
  updateSettings: (patch: StudioSettingsPatch) => Promise<StudioSettingsResponse>;
};

const mergeFocusedPatch = (
  current: FocusedPatch | undefined,
  next: FocusedPatch | undefined
): FocusedPatch | undefined => {
  if (!current && !next) return undefined;
  return {
    ...(current ?? {}),
    ...(next ?? {}),
  };
};

const mergeAvatarsPatch = (
  current: AvatarsPatch | undefined,
  next: AvatarsPatch | undefined
): AvatarsPatch | undefined => {
  if (!current && !next) return undefined;
  const merged: AvatarsPatch = { ...(current ?? {}) };
  for (const [gatewayKey, value] of Object.entries(next ?? {})) {
    if (value === null) {
      merged[gatewayKey] = null;
      continue;
    }
    const existing = merged[gatewayKey];
    if (existing && existing !== null) {
      merged[gatewayKey] = { ...existing, ...value };
      continue;
    }
    merged[gatewayKey] = { ...value };
  }
  return merged;
};

const mergeStudioPatch = (
  current: StudioSettingsPatch | null,
  next: StudioSettingsPatch
): StudioSettingsPatch => {
  if (!current) {
    return {
      ...(next.gateway !== undefined ? { gateway: next.gateway } : {}),
      ...(next.focused ? { focused: { ...next.focused } } : {}),
      ...(next.avatars ? { avatars: { ...next.avatars } } : {}),
    };
  }
  const focused = mergeFocusedPatch(current.focused, next.focused);
  const avatars = mergeAvatarsPatch(current.avatars, next.avatars);
  return {
    ...(next.gateway !== undefined
      ? { gateway: next.gateway }
      : current.gateway !== undefined
        ? { gateway: current.gateway }
        : {}),
    ...(focused ? { focused } : {}),
    ...(avatars ? { avatars } : {}),
  };
};

export class StudioSettingsCoordinator {
  private pendingPatch: StudioSettingsPatch | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly transport: StudioSettingsCoordinatorTransport,
    private readonly defaultDebounceMs: number = 350
  ) {}

  async loadSettings(): Promise<StudioSettings | null> {
    const result = await this.loadSettingsEnvelope();
    return result.settings ?? null;
  }

  async loadSettingsEnvelope(): Promise<StudioSettingsResponse> {
    return await this.transport.fetchSettings();
  }

  schedulePatch(patch: StudioSettingsPatch, debounceMs: number = this.defaultDebounceMs): void {
    if (this.disposed) return;
    this.pendingPatch = mergeStudioPatch(this.pendingPatch, patch);
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushPending().catch((err) => {
        console.error("Failed to flush pending studio settings patch.", err);
      });
    }, debounceMs);
  }

  async applyPatchNow(patch: StudioSettingsPatch): Promise<void> {
    if (this.disposed) return;
    this.pendingPatch = mergeStudioPatch(this.pendingPatch, patch);
    await this.flushPending();
  }

  async flushPending(): Promise<void> {
    if (this.disposed) {
      return this.queue;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const patch = this.pendingPatch;
    if (!patch) {
      return this.queue;
    }
    const write = this.queue.then(async () => {
      if (this.pendingPatch === patch) {
        this.pendingPatch = null;
      }
      try {
        await this.transport.updateSettings(patch);
      } catch (err) {
        this.pendingPatch = mergeStudioPatch(this.pendingPatch, patch);
        throw err;
      }
    });
    this.queue = write.catch((err) => {
      console.error("Failed to persist studio settings patch.", err);
    });
    return write;
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingPatch = null;
    this.disposed = true;
  }
}

const fetchStudioSettings = async (): Promise<StudioSettingsResponse> => {
  return fetchJson<StudioSettingsResponse>("/api/studio", { cache: "no-store" });
};

const updateStudioSettings = async (
  patch: StudioSettingsPatch
): Promise<StudioSettingsResponse> => {
  return fetchJson<StudioSettingsResponse>("/api/studio", {
    method: "PUT",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
};

export const createStudioSettingsCoordinator = (options?: {
  debounceMs?: number;
}): StudioSettingsCoordinator => {
  return new StudioSettingsCoordinator(
    {
      fetchSettings: fetchStudioSettings,
      updateSettings: updateStudioSettings,
    },
    options?.debounceMs
  );
};
