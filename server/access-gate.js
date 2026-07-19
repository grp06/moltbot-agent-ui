const { URL } = require("node:url");

const parseCookies = (header) => {
  const raw = typeof header === "string" ? header : "";
  if (!raw.trim()) return {};
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
};

const buildRedirectUrl = (req, nextPathWithQuery) => {
  void req;
  return nextPathWithQuery || "/";
};

const writeUnauthorized = (res) => {
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      error:
        "Studio access token required. Open /?access_token=... once to set a cookie.",
    })
  );
};

function createAccessGate(options) {
  const token = String(options?.token ?? "").trim();
  const cookieName = String(options?.cookieName ?? "studio_access").trim() || "studio_access";
  const queryParam = String(options?.queryParam ?? "access_token").trim() || "access_token";

  const enabled = Boolean(token);

  const isAuthorized = (req) => {
    if (!enabled) return true;
    const cookieHeader = req.headers?.cookie;
    const cookies = parseCookies(cookieHeader);
    return cookies[cookieName] === token;
  };

  const handleHttp = (req, res) => {
    if (!enabled) return false;
    const host = req.headers?.host || "localhost";
    const url = new URL(req.url || "/", `http://${host}`);
    const provided = url.searchParams.get(queryParam);

    if (provided !== null) {
      if (provided !== token) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid Studio access token." }));
        return true;
      }

      url.searchParams.delete(queryParam);
      const cookieValue = `${cookieName}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax`;
      res.statusCode = 302;
      res.setHeader("Set-Cookie", cookieValue);
      res.setHeader("Location", buildRedirectUrl(req, url.pathname + url.search));
      res.end();
      return true;
    }

    if (!isAuthorized(req)) {
      writeUnauthorized(res);
      return true;
    }

    return false;
  };

  const allowUpgrade = (req) => {
    if (!enabled) return true;
    return isAuthorized(req);
  };

  return { enabled, handleHttp, allowUpgrade };
}

module.exports = { createAccessGate };
