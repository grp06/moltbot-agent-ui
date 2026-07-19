import { describe, expect, it } from "vitest";

import {
  isSafeAgentId,
  normalizeOpenClawAgentId,
  resolveCreatableOpenClawAgentId,
  resolveSafeAgentId,
} from "@/lib/agents/agentIds";

describe("agent id validation", () => {
  it("accepts OpenClaw path-safe agent ids", () => {
    expect(isSafeAgentId("main")).toBe(true);
    expect(isSafeAgentId("agent-1")).toBe(true);
    expect(isSafeAgentId("Agent_1")).toBe(true);
  });

  it("rejects ids that the gateway would normalize to another agent", () => {
    expect(isSafeAgentId("../agent-1")).toBe(false);
    expect(isSafeAgentId("agent.1")).toBe(false);
    expect(isSafeAgentId("-agent")).toBe(false);
    expect(isSafeAgentId("a".repeat(65))).toBe(false);
  });

  it("resolves unknown input to a safe trimmed id or null", () => {
    expect(resolveSafeAgentId(" agent-1 ")).toBe("agent-1");
    expect(resolveSafeAgentId("../agent-1")).toBeNull();
    expect(resolveSafeAgentId(null)).toBeNull();
  });

  it("mirrors OpenClaw agent id normalization for create names", () => {
    expect(normalizeOpenClawAgentId("Agent_One")).toBe("agent_one");
    expect(normalizeOpenClawAgentId("Agent One")).toBe("agent-one");
    expect(normalizeOpenClawAgentId("../Agent.One")).toBe("agent-one");
    expect(normalizeOpenClawAgentId("!!!")).toBe("main");
  });

  it("rejects create names that normalize to the reserved main agent id", () => {
    expect(() => resolveCreatableOpenClawAgentId("main")).toThrow(
      'Agent name resolves to reserved agent id "main".'
    );
    expect(() => resolveCreatableOpenClawAgentId("!!!")).toThrow(
      'Agent name resolves to reserved agent id "main".'
    );
  });
});
