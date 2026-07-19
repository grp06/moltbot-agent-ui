// @vitest-environment node

import { describe, expect, it } from "vitest";

describe("createAccessGate", () => {
  it("allows when token is unset", async () => {
    const { createAccessGate } = await import("../../server/access-gate");
    const gate = createAccessGate({ token: "" });
    expect(gate.allowUpgrade({ headers: {} })).toBe(true);
  });

  it("rejects /api requests without cookie when enabled", async () => {
    const { createAccessGate } = await import("../../server/access-gate");
    const gate = createAccessGate({ token: "abc" });

    let statusCode = 0;
    let ended = false;
    const res = {
      setHeader: () => {},
      end: () => {
        ended = true;
      },
      get statusCode() {
        return statusCode;
      },
      set statusCode(value: number) {
        statusCode = value;
      },
    };

    const handled = gate.handleHttp(
      { url: "/api/studio", headers: { host: "example.test" } },
      res
    );

    expect(handled).toBe(true);
    expect(statusCode).toBe(401);
    expect(ended).toBe(true);
  });

  it("rejects app shell requests without cookie when enabled", async () => {
    const { createAccessGate } = await import("../../server/access-gate");
    const gate = createAccessGate({ token: "abc" });
    const headers: Record<string, string> = {};
    let body = "";
    const res = {
      statusCode: 0,
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      end: (value?: string) => {
        body = value ?? "";
      },
    };

    const handled = gate.handleHttp(
      { url: "/", headers: { host: "example.test" } },
      res
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(body)).toEqual({
      error: "Studio access token required. Open /?access_token=... once to set a cookie.",
    });
  });

  it("allows app shell requests when token cookie matches", async () => {
    const { createAccessGate } = await import("../../server/access-gate");
    const gate = createAccessGate({ token: "abc" });

    expect(
      gate.handleHttp(
        { url: "/", headers: { host: "example.test", cookie: "studio_access=abc" } },
        { setHeader: () => {}, end: () => {}, statusCode: 0 }
      )
    ).toBe(false);
  });

  it("allows upgrades when cookie matches", async () => {
    const { createAccessGate } = await import("../../server/access-gate");
    const gate = createAccessGate({ token: "abc" });
    expect(
      gate.allowUpgrade({ headers: { cookie: "studio_access=abc" } })
    ).toBe(true);
  });

  it("rejects upgrades when token cookie is missing", async () => {
    const { createAccessGate } = await import("../../server/access-gate");
    const gate = createAccessGate({ token: "abc" });
    expect(gate.allowUpgrade({ headers: {} })).toBe(false);
  });

  it("encodes access-token cookie values before redirecting", async () => {
    const { createAccessGate } = await import("../../server/access-gate");
    const gate = createAccessGate({ token: "abc;def" });
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 0,
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      end: () => {},
    };

    const handled = gate.handleHttp(
      { url: "/?access_token=abc%3Bdef", headers: { host: "example.test" } },
      res
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(302);
    expect(headers["Set-Cookie"]).toContain("studio_access=abc%3Bdef;");
    expect(gate.allowUpgrade({ headers: { cookie: "studio_access=abc%3Bdef" } })).toBe(true);
  });

  it("uses a relative redirect after accepting an access token", async () => {
    const { createAccessGate } = await import("../../server/access-gate");
    const gate = createAccessGate({ token: "abc" });
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 0,
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      end: () => {},
    };

    const handled = gate.handleHttp(
      {
        url: "/agents/agent-1/settings?access_token=abc&tab=tools",
        headers: { host: "attacker.example", "x-forwarded-proto": "https" },
      },
      res
    );

    expect(handled).toBe(true);
    expect(headers.Location).toBe("/agents/agent-1/settings?tab=tools");
  });
});
