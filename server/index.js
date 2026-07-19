process.env.WS_NO_BUFFER_UTIL = process.env.WS_NO_BUFFER_UTIL || "1";
process.env.WS_NO_UTF_8_VALIDATE = process.env.WS_NO_UTF_8_VALIDATE || "1";

const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const next = require("next");

const { createAccessGate } = require("./access-gate");
const { detectInstallContext, buildStartupGuidance } = require("./install-context");
const { assertPublicHostAllowed, resolveHosts } = require("./network-policy");

const resolvePort = () => {
  const raw = process.env.PORT?.trim() || "3000";
  const port = Number(raw);
  if (!Number.isFinite(port) || port <= 0) return 3000;
  return port;
};

const verifyNativeRuntime = (dev) => {
  if (process.env.OPENCLAW_SKIP_NATIVE_RUNTIME_VERIFY === "1") return;
  const scriptPath = path.resolve(__dirname, "..", "scripts", "verify-native-runtime.mjs");
  const modeArg = dev ? "--repair" : "--check";
  const result = spawnSync(process.execPath, [scriptPath, modeArg], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status === 0) return;
  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
  throw result.error ?? new Error("Failed to verify native runtime dependencies.");
};

async function main() {
  const dev = process.argv.includes("--dev");
  verifyNativeRuntime(dev);
  const hostnames = Array.from(new Set(resolveHosts(process.env)));
  const hostname = hostnames[0] ?? "127.0.0.1";
  const port = resolvePort();
  for (const host of hostnames) {
    assertPublicHostAllowed({
      host,
      studioAccessToken: process.env.STUDIO_ACCESS_TOKEN,
    });
  }

  const app = next({
    dev,
    hostname,
    port,
    ...(dev ? { webpack: true } : null),
  });
  const handle = app.getRequestHandler();

  const accessGate = createAccessGate({
    token: process.env.STUDIO_ACCESS_TOKEN,
  });

  await app.prepare();
  const handleUpgrade = app.getUpgradeHandler();

  const createServer = () => {
    const server = http.createServer((req, res) => {
      if (accessGate.handleHttp(req, res)) return;
      handle(req, res);
    });
    server.on("upgrade", (req, socket, head) => {
      if (!accessGate.allowUpgrade(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      Promise.resolve(handleUpgrade(req, socket, head)).catch((err) => {
        console.error("Failed to handle upgrade request.", err);
        socket.destroy();
      });
    });
    return server;
  };

  const servers = hostnames.map(() => createServer());

  const listenOnHost = (server, host) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off("error", onError);
        reject(err);
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve();
      });
    });

  const closeServer = (server) =>
    new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });

  try {
    await Promise.all(servers.map((server, index) => listenOnHost(server, hostnames[index])));
  } catch (err) {
    await Promise.all(servers.map((server) => closeServer(server)));
    throw err;
  }

  const hostForBrowser = hostnames.some((value) => value === "127.0.0.1" || value === "::1")
    ? "localhost"
    : hostname === "0.0.0.0" || hostname === "::"
      ? "localhost"
      : hostname;

  const browserUrl = `http://${hostForBrowser}:${port}`;
  console.info(`Open in browser: ${browserUrl}`);
  try {
    const installContext = await detectInstallContext(process.env);
    const startupGuidance = buildStartupGuidance({
      installContext,
      port,
    });
    if (startupGuidance.length > 0) {
      console.info("");
      console.info("Studio access guidance:");
      for (const line of startupGuidance) {
        console.info(`- ${line}`);
      }
    }
  } catch (error) {
    console.error("Failed to print Studio access guidance.", error);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
