import { defineConfig } from "@playwright/test";
import path from "node:path";

const e2ePort = Number(process.env.PLAYWRIGHT_PORT ?? "3100");
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: `http://127.0.0.1:${e2ePort}`,
  },
  webServer: {
    command: "npm run dev",
    port: e2ePort,
    reuseExistingServer,
    env: {
      ...process.env,
      PORT: String(e2ePort),
      OPENCLAW_STATE_DIR: path.resolve("./tests/fixtures/openclaw-empty-state"),
      NEXT_PUBLIC_GATEWAY_URL: "",
    },
  },
});
