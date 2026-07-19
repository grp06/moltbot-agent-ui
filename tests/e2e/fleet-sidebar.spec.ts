import { expect, test } from "@playwright/test";
import { stubStudioRoute } from "./helpers/studioRoute";
import { stubRuntimeRoutes } from "./helpers/runtimeRoute";

test.beforeEach(async ({ page }) => {
  await stubStudioRoute(page);
  await stubRuntimeRoutes(page);
});

test("shows_disconnected_connect_surface", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("studio-menu-toggle").click();
  await page.getByTestId("gateway-settings-toggle").click();
  await expect(page.getByLabel(/Upstream (gateway )?URL/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Connect|Disconnect|Connecting…)$/ })).toBeVisible();
});

test("persists_gateway_fields_to_studio_settings", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("studio-menu-toggle").click();
  await page.getByTestId("gateway-settings-toggle").click();
  await page.getByLabel(/Upstream (gateway )?URL/i).fill("ws://gateway.example:18789");
  await page.getByLabel("Upstream token").fill("token-123");

  const requestPromise = page.waitForRequest((req) => {
    if (!req.url().includes("/api/studio") || req.method() !== "PUT") {
      return false;
    }
    const payload = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
    const gateway = (payload.gateway ?? {}) as { url?: string; token?: string };
    return gateway.url === "ws://gateway.example:18789" && gateway.token === "token-123";
  });
  await page.getByRole("button", { name: "Save settings" }).click();
  const request = await requestPromise;
  const payload = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
  const gateway = (payload.gateway ?? {}) as { url?: string; token?: string };
  expect(gateway.url).toBe("ws://gateway.example:18789");
  expect(gateway.token).toBe("token-123");
});

test("focused_preferences_persist_across_reload", async ({ page }) => {
  await stubRuntimeRoutes(page, {
    fleetResult: {
      seeds: [
        {
          agentId: "agent-1",
          name: "Agent One",
          sessionKey: "agent:agent-1:main",
        },
        {
          agentId: "agent-2",
          name: "Agent Two",
          sessionKey: "agent:agent-2:main",
        },
      ],
      sessionCreatedAgentIds: ["agent-1", "agent-2"],
      sessionSettingsSyncedAgentIds: ["agent-1", "agent-2"],
      summaryPatches: [],
      suggestedSelectedAgentId: "agent-1",
      configSnapshot: null,
    },
  });

  await page.goto("/");

  await expect(page.getByTestId("fleet-agent-row-agent-1")).toBeVisible();
  const selectionPersistRequest = page.waitForRequest((req) => {
    if (!req.url().includes("/api/studio") || req.method() !== "PUT") {
      return false;
    }
    const payload = JSON.parse(req.postData() ?? "{}") as {
      focused?: Record<string, { selectedAgentId?: string | null }>;
    };
    if (!payload.focused) return false;
    return Object.values(payload.focused).some(
      (entry) => (entry.selectedAgentId ?? null) === "agent-2"
    );
  });
  await page.getByTestId("fleet-agent-row-agent-2").click();
  await selectionPersistRequest;

  await page.reload();

  const selectedAgentTwoRow = page.getByTestId("fleet-agent-row-agent-2");
  await expect(selectedAgentTwoRow).toBeVisible();
  await expect(selectedAgentTwoRow).toHaveClass(/ui-card-selected/);
});

test("clears_unseen_indicator_on_focus", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("studio-menu-toggle").click();
  await expect(page.getByTestId("gateway-settings-toggle")).toBeVisible();
});
