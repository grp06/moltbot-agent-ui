import type { Page, Route, Request } from "@playwright/test";
import type { StudioInstallContext } from "@/lib/studio/install-context";

type StudioSettingsFixture = {
  version: 1;
  gateway: { url: string; token: string } | null;
  focused: Record<string, { mode: "focused"; filter: string; selectedAgentId: string | null }>;
  avatars: Record<string, Record<string, string>>;
};

type StudioRouteEnvelopeFixture = {
  localGatewayDefaults?: { url: string; token: string } | null;
  localGatewayDefaultsMeta?: { hasToken: boolean };
  gatewayMeta?: { hasStoredToken: boolean; credentialScope?: string };
  installContext?: StudioInstallContext;
  domainApiModeEnabled?: boolean;
};

const DEFAULT_SETTINGS: StudioSettingsFixture = {
  version: 1,
  gateway: null,
  focused: {},
  avatars: {},
};

const createStudioRoute = (
  initial: StudioSettingsFixture = DEFAULT_SETTINGS,
  envelope: StudioRouteEnvelopeFixture = {}
) => {
  let settings: StudioSettingsFixture = {
    version: 1,
    gateway: initial.gateway ?? null,
    focused: { ...(initial.focused ?? {}) },
    avatars: { ...(initial.avatars ?? {}) },
  };
  const responseEnvelope = () => ({
    settings,
    localGatewayDefaults: envelope.localGatewayDefaults ?? null,
    localGatewayDefaultsMeta: envelope.localGatewayDefaultsMeta ?? {
      hasToken: Boolean(envelope.localGatewayDefaults?.token),
    },
    gatewayMeta: envelope.gatewayMeta ?? {
      hasStoredToken: Boolean(settings.gateway?.token),
    },
    installContext: envelope.installContext,
    domainApiModeEnabled: envelope.domainApiModeEnabled ?? true,
  });

  return async (route: Route, request: Request) => {
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(responseEnvelope()),
      });
      return;
    }
    if (request.method() !== "PUT") {
      await route.fallback();
      return;
    }

    const patch = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
    const next = { ...settings };

    if ("gateway" in patch) {
      const gatewayPatch = (patch.gateway ?? null) as
        | { url?: string; token?: string }
        | null;
      if (gatewayPatch === null) {
        next.gateway = null;
      } else {
        const existing = next.gateway ?? { url: "", token: "" };
        next.gateway = {
          url: gatewayPatch.url ?? existing.url,
          token: gatewayPatch.token ?? existing.token,
        };
      }
    }

    if (patch.focused && typeof patch.focused === "object") {
      const focusedPatch = patch.focused as Record<string, Record<string, unknown>>;
      const focusedNext = { ...next.focused };
      for (const [key, value] of Object.entries(focusedPatch)) {
        const existing = focusedNext[key] ?? {
          mode: "focused" as const,
          filter: "all",
          selectedAgentId: null,
        };
        focusedNext[key] = {
          mode: (value.mode as "focused") ?? existing.mode,
          filter: (value.filter as string) ?? existing.filter,
          selectedAgentId:
            "selectedAgentId" in value
              ? ((value.selectedAgentId as string | null) ?? null)
              : existing.selectedAgentId,
        };
      }
      next.focused = focusedNext;
    }

    if (patch.avatars && typeof patch.avatars === "object") {
      const avatarsPatch = patch.avatars as Record<string, Record<string, string | null> | null>;
      const avatarsNext: StudioSettingsFixture["avatars"] = { ...next.avatars };
      for (const [gatewayKey, gatewayPatch] of Object.entries(avatarsPatch)) {
        if (gatewayPatch === null) {
          delete avatarsNext[gatewayKey];
          continue;
        }
        const existing = avatarsNext[gatewayKey] ? { ...avatarsNext[gatewayKey] } : {};
        for (const [agentId, seedPatch] of Object.entries(gatewayPatch)) {
          if (seedPatch === null) {
            delete existing[agentId];
            continue;
          }
          const seed = typeof seedPatch === "string" ? seedPatch.trim() : "";
          if (!seed) {
            delete existing[agentId];
            continue;
          }
          existing[agentId] = seed;
        }
        avatarsNext[gatewayKey] = existing;
      }
      next.avatars = avatarsNext;
    }

    settings = next;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(responseEnvelope()),
    });
  };
};

export const stubStudioRoute = async (
  page: Page,
  initial: StudioSettingsFixture = DEFAULT_SETTINGS,
  envelope?: StudioRouteEnvelopeFixture
) => {
  await page.route("**/api/studio", createStudioRoute(initial, envelope));
};
