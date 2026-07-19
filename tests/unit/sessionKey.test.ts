import { describe, expect, it } from "vitest";

import {
  buildAgentMainSessionKey,
  hasMalformedAgentSessionKey,
  isSameSessionKey,
  parseAgentIdFromSessionKey,
  resolveSafeSessionKey,
  sessionKeyBelongsToAgent,
} from "@/lib/gateway/session-keys";

describe("sessionKey helpers", () => {
  it("buildAgentMainSessionKey formats agent session key", () => {
    expect(buildAgentMainSessionKey("agent-1", "main")).toBe("agent:agent-1:main");
  });

  it("parseAgentIdFromSessionKey extracts agent id", () => {
    expect(parseAgentIdFromSessionKey("agent:agent-1:main")).toBe("agent-1");
    expect(parseAgentIdFromSessionKey(" agent:agent-1:main ")).toBe("agent-1");
  });

  it("parseAgentIdFromSessionKey returns null when missing", () => {
    expect(parseAgentIdFromSessionKey("")).toBeNull();
    expect(parseAgentIdFromSessionKey("main")).toBeNull();
    expect(parseAgentIdFromSessionKey("agent:main")).toBeNull();
  });

  it("rejects agent-prefixed session keys whose agent id would be normalized", () => {
    expect(parseAgentIdFromSessionKey("agent:../agent-1:main")).toBeNull();
    expect(parseAgentIdFromSessionKey("agent:agent.1:main")).toBeNull();
    expect(hasMalformedAgentSessionKey("agent:../agent-1:main")).toBe(true);
    expect(hasMalformedAgentSessionKey("main")).toBe(false);
    expect(resolveSafeSessionKey(" agent:agent-1:main ")).toBe("agent:agent-1:main");
    expect(resolveSafeSessionKey("agent:../agent-1:main")).toBeNull();
  });

  it("sessionKeyBelongsToAgent requires a parseable matching agent key", () => {
    expect(sessionKeyBelongsToAgent("agent:agent-1:main", "agent-1")).toBe(true);
    expect(sessionKeyBelongsToAgent("agent:agent-2:main", "agent-1")).toBe(false);
    expect(sessionKeyBelongsToAgent("main", "agent-1")).toBe(false);
  });

  it("isSameSessionKey requires exact session key match", () => {
    expect(isSameSessionKey("agent:main:studio:one", "agent:main:studio:one")).toBe(true);
    expect(isSameSessionKey("agent:main:studio:one", "agent:main:discord:one")).toBe(false);
  });

  it("isSameSessionKey trims whitespace", () => {
    expect(isSameSessionKey(" agent:main:studio:one ", "agent:main:studio:one")).toBe(true);
  });
});
