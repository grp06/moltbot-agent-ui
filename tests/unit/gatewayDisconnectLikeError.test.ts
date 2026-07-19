import { describe, expect, it } from "vitest";

import { isGatewayDisconnectLikeError } from "@/lib/gateway/gateway-disconnect";

describe("isGatewayDisconnectLikeError", () => {
  it("recognizes gateway close code 1012 as disconnect-like", () => {
    expect(isGatewayDisconnectLikeError(new Error("gateway closed (1012): service restart"))).toBe(
      true
    );
  });

  it("does not classify unexpected close codes as disconnect-like", () => {
    expect(isGatewayDisconnectLikeError(new Error("gateway closed (1006): abnormal closure"))).toBe(
      false
    );
  });

  it("keeps existing stopped-client messages disconnect-like", () => {
    expect(isGatewayDisconnectLikeError(new Error("gateway client stopped"))).toBe(true);
  });
});
