import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { type StudioSettingsPatch } from "@/lib/studio/settings";
import { defaultStudioInstallContext } from "@/lib/studio/install-context";
import {
  getControlPlaneRuntime,
  isStudioDomainApiModeEnabled,
  peekControlPlaneRuntime,
} from "@/lib/controlplane/runtime";
import {
  applyStudioSettingsPatch,
  loadPersistedStudioSettings,
  loadLocalGatewayDefaults,
  loadStudioSettings,
  redactLocalGatewayDefaultsSecrets,
  redactStudioSettingsSecrets,
} from "@/lib/studio/settings-store";
import { detectInstallContext } from "../../../../server/install-context";

export const runtime = "nodejs";

const isPatch = (value: unknown): value is StudioSettingsPatch =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

type RuntimeReconnectMetadata = {
  attempted: boolean;
  restarted: boolean;
  reason?: string;
  previousStatus?: string;
  error?: string;
};

const normalizeGatewaySettings = (settings: ReturnType<typeof loadStudioSettings>) => {
  const gateway = settings.gateway ?? null;
  return {
    url: typeof gateway?.url === "string" ? gateway.url.trim() : "",
    token: typeof gateway?.token === "string" ? gateway.token.trim() : "",
  };
};

const gatewaySettingsChanged = (
  previous: ReturnType<typeof loadStudioSettings>,
  next: ReturnType<typeof loadStudioSettings>
) => {
  const left = normalizeGatewaySettings(previous);
  const right = normalizeGatewaySettings(next);
  return left.url !== right.url || left.token !== right.token;
};

const hasGatewayConfiguration = (settings: ReturnType<typeof loadStudioSettings>) => {
  const gateway = normalizeGatewaySettings(settings);
  return Boolean(gateway.url && gateway.token);
};

const buildGatewayCredentialScope = (settings: ReturnType<typeof loadStudioSettings>) => {
  const gateway = normalizeGatewaySettings(settings);
  if (!gateway.url || !gateway.token) return "";
  return createHash("sha256")
    .update(gateway.url)
    .update("\0")
    .update(gateway.token)
    .digest("hex");
};

const reconnectRuntimeForGatewaySettingsChange = async (
  previous: ReturnType<typeof loadStudioSettings>,
  next: ReturnType<typeof loadStudioSettings>
): Promise<RuntimeReconnectMetadata | null> => {
  if (!isStudioDomainApiModeEnabled()) {
    return {
      attempted: false,
      restarted: false,
      reason: "domain_api_mode_disabled",
    };
  }
  const runtime = peekControlPlaneRuntime() ?? getControlPlaneRuntime();
  const previousStatus = runtime.connectionStatus();
  if (previousStatus === "stopped") {
    if (!hasGatewayConfiguration(next)) {
      return {
        attempted: false,
        restarted: false,
        reason: "gateway_not_configured",
        previousStatus,
      };
    }
    try {
      await runtime.ensureStarted({ force: true });
      return {
        attempted: true,
        restarted: true,
        previousStatus,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "controlplane_reconnect_failed";
      console.error("Failed to reconnect control-plane runtime after gateway settings update.", error);
      return {
        attempted: true,
        restarted: false,
        previousStatus,
        error: message,
      };
    }
  }
  if (!gatewaySettingsChanged(previous, next)) return null;
  if (!hasGatewayConfiguration(next)) {
    return {
      attempted: false,
      restarted: false,
      reason: "gateway_not_configured",
      previousStatus,
    };
  }
  try {
    await runtime.reconnectForGatewaySettingsChange();
    return {
      attempted: true,
      restarted: true,
      previousStatus,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "controlplane_reconnect_failed";
    console.error("Failed to reconnect control-plane runtime after gateway settings update.", error);
    return {
      attempted: true,
      restarted: false,
      previousStatus,
      error: message,
    };
  }
};

const buildSettingsResponseBody = async (metadata?: RuntimeReconnectMetadata | null) => {
  const settings = loadStudioSettings();
  const persistedSettings = loadPersistedStudioSettings();
  const localGatewayDefaults = loadLocalGatewayDefaults();
  let installContext = defaultStudioInstallContext();
  try {
    installContext = await detectInstallContext(process.env);
  } catch (error) {
    console.error("Failed to detect Studio install context.", error);
  }
  return {
    settings: redactStudioSettingsSecrets(settings),
    localGatewayDefaults: redactLocalGatewayDefaultsSecrets(localGatewayDefaults),
    localGatewayDefaultsMeta: {
      hasToken: Boolean(localGatewayDefaults?.token?.trim()),
    },
    gatewayMeta: {
      hasStoredToken: Boolean(persistedSettings.gateway?.token?.trim()),
      credentialScope: buildGatewayCredentialScope(settings),
    },
    installContext,
    domainApiModeEnabled: isStudioDomainApiModeEnabled(),
    ...(metadata ? { runtimeReconnect: metadata } : {}),
  };
};

export async function GET() {
  try {
    return NextResponse.json(await buildSettingsResponseBody());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load studio settings.";
    console.error(message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }
  if (!isPatch(body)) {
    return NextResponse.json({ error: "Invalid settings payload." }, { status: 400 });
  }

  try {
    const previousSettings = loadStudioSettings();
    const nextSettings = applyStudioSettingsPatch({
      ...body,
      gatewayAutoStart: true,
    });
    const runtimeReconnect = await reconnectRuntimeForGatewaySettingsChange(
      previousSettings,
      nextSettings
    );
    return NextResponse.json(await buildSettingsResponseBody(runtimeReconnect));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save studio settings.";
    console.error(message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
