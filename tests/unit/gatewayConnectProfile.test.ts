import { describe, expect, it } from "vitest";

import { buildGatewayConnectProfile } from "@/lib/controlplane/gateway-connect-profile";

describe("gateway connect profile", () => {
  it("normalizes loopback IPv6 origins for legacy control-ui fallback", () => {
    const profile = buildGatewayConnectProfile({
      profileId: "legacy-control-ui",
      upstreamUrl: "ws://[::1]:18789",
      token: "token",
      protocol: 3,
      capabilities: ["tool-events"],
    });

    expect(profile.socketOptions.origin).toBe("http://localhost:18789");
  });

  it("preserves brackets for non-loopback IPv6 origins", () => {
    const profile = buildGatewayConnectProfile({
      profileId: "legacy-control-ui",
      upstreamUrl: "wss://[2001:db8::1]:18789",
      token: "token",
      protocol: 3,
      capabilities: ["tool-events"],
    });

    expect(profile.socketOptions.origin).toBe("https://[2001:db8::1]:18789");
  });
});
