const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const readline = require("node:readline/promises");

const { resolveStudioSettingsPath, writeJsonFileAtomic } = require("../server/studio-settings");

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

const parseArgs = (argv) => {
  return {
    force: argv.includes("--force"),
  };
};

const tryReadGatewayTokenFromOpenclawCli = () => {
  try {
    const raw = execFileSync("openclaw", ["config", "get", "gateway.auth.token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const token = String(raw ?? "").trim();
    return token || null;
  } catch {
    return null;
  }
};

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const settingsPath = resolveStudioSettingsPath(process.env);

  if (fs.existsSync(settingsPath) && !args.force) {
    console.error(
      `Studio settings already exist at ${settingsPath}. Re-run with --force to overwrite.`
    );
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const urlAnswer = await rl.question(
      `Upstream Gateway URL [${DEFAULT_GATEWAY_URL}]: `
    );
    const gatewayUrl = (urlAnswer || DEFAULT_GATEWAY_URL).trim();
    if (!gatewayUrl) {
      throw new Error("Gateway URL is required.");
    }

    const tokenDefault = tryReadGatewayTokenFromOpenclawCli();
    const tokenPrompt = tokenDefault
      ? "Upstream Gateway Token [detected from openclaw]: "
      : "Upstream Gateway Token: ";
    const tokenAnswer = await rl.question(tokenPrompt);
    const token = (tokenAnswer || tokenDefault || "").trim();
    if (!token) {
      throw new Error(
        "Gateway token is required. Provide it, or install/openclaw so it can be auto-detected."
      );
    }

    const next = {
      version: 1,
      gateway: {
        url: gatewayUrl,
        token,
      },
    };
    writeJsonFileAtomic(settingsPath, next);

    console.info(`Wrote Studio settings to ${settingsPath}.`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exitCode = 1;
});
