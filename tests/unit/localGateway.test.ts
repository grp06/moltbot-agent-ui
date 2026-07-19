import { describe, expect, it } from "vitest";

import { isLocalGatewayUrl } from "@/lib/gateway/local-gateway";

describe("isLocalGatewayUrl", () => {
  it("classifies bracketed IPv6 loopback gateway URLs as local", () => {
    expect(isLocalGatewayUrl("ws://[::1]:18789")).toBe(true);
  });

  it("does not classify non-loopback gateway hosts as local", () => {
    expect(isLocalGatewayUrl("wss://gateway.example.test")).toBe(false);
  });
});
