import { describe, expect, it } from "vitest";

import {
  resolveConfiguredSshTarget,
  resolveGatewaySshTargetFromGatewayUrl,
} from "@/lib/ssh/gateway-host";

describe("gateway ssh target resolution", () => {
  it("uses_configured_target_with_at_sign", () => {
    expect(
      resolveConfiguredSshTarget({
        OPENCLAW_GATEWAY_SSH_TARGET: "me@example.test",
      } as unknown as NodeJS.ProcessEnv)
    ).toBe("me@example.test");
  });

  it("combines_user_and_target_when_target_missing_at_sign", () => {
    expect(
      resolveConfiguredSshTarget({
        OPENCLAW_GATEWAY_SSH_TARGET: "example.test",
        OPENCLAW_GATEWAY_SSH_USER: "me",
      } as unknown as NodeJS.ProcessEnv)
    ).toBe("me@example.test");
  });

  it("derives_target_from_gateway_url_with_default_user_ubuntu", () => {
    expect(
      resolveGatewaySshTargetFromGatewayUrl(
        "ws://example.test:18789",
        {} as unknown as NodeJS.ProcessEnv
      )
    ).toBe("ubuntu@example.test");
  });

  it("strips brackets from ipv6 gateway urls when deriving ssh target", () => {
    expect(
      resolveGatewaySshTargetFromGatewayUrl(
        "wss://[fd7a:115c:a1e0::1]:18789",
        {} as unknown as NodeJS.ProcessEnv
      )
    ).toBe("ubuntu@fd7a:115c:a1e0::1");
  });

  it("throws_on_missing_gateway_url_when_no_env_override", () => {
    expect(() =>
      resolveGatewaySshTargetFromGatewayUrl("", {} as unknown as NodeJS.ProcessEnv)
    ).toThrow("Gateway URL is missing.");
  });

  it("throws_on_invalid_gateway_url", () => {
    expect(() =>
      resolveGatewaySshTargetFromGatewayUrl("not a url", {} as unknown as NodeJS.ProcessEnv)
    ).toThrow("Invalid gateway URL:");
  });
});
