import { describe, expect, it } from "vitest";

import {
  defaultStudioSettings,
  mergeStudioSettings,
  normalizeStudioSettings,
  resolveFocusedPreference,
} from "@/lib/studio/settings";

describe("studio settings normalization", () => {
  it("returns defaults for empty input", () => {
    const normalized = normalizeStudioSettings(null);
    expect(normalized.version).toBe(1);
    expect(normalized.gateway).toBeNull();
    expect(normalized.focused).toEqual({});
    expect(normalized.avatars).toEqual({});
  });

  it("returns defaults for array input", () => {
    expect(normalizeStudioSettings([])).toEqual(defaultStudioSettings());
  });

  it("normalizes gateway entries", () => {
    const normalized = normalizeStudioSettings({
      gateway: { url: " ws://localhost:18789 ", token: " token " },
    });

    expect(normalized.gateway?.url).toBe("ws://localhost:18789");
    expect(normalized.gateway?.token).toBe("token");
  });

  it("normalizes loopback ip gateway urls to localhost", () => {
    const normalized = normalizeStudioSettings({
      gateway: { url: "ws://127.0.0.1:18789", token: "token" },
    });

    expect(normalized.gateway?.url).toBe("ws://localhost:18789");
  });

  it("normalizes bracketed ipv6 loopback gateway urls to localhost", () => {
    const normalized = normalizeStudioSettings({
      gateway: { url: "ws://[::1]:18789", token: "token" },
    });

    expect(normalized.gateway?.url).toBe("ws://localhost:18789");
  });

  it("normalizes focused preference keys to canonical loopback url", () => {
    const normalized = normalizeStudioSettings({
      focused: {
        "ws://127.0.0.1:18789": {
          mode: "focused",
          selectedAgentId: "agent-2",
          filter: "all",
        },
      },
    });

    expect(normalized.focused["ws://localhost:18789"]).toEqual({
      mode: "focused",
      selectedAgentId: "agent-2",
      filter: "all",
    });
    expect(resolveFocusedPreference(normalized, "ws://127.0.0.1:18789")).toEqual({
      mode: "focused",
      selectedAgentId: "agent-2",
      filter: "all",
    });
    expect(resolveFocusedPreference(normalized, "ws://localhost:18789")).toEqual({
      mode: "focused",
      selectedAgentId: "agent-2",
      filter: "all",
    });
  });

  it("normalizes_dual_mode_preferences", () => {
    const normalized = normalizeStudioSettings({
      focused: {
        " ws://localhost:18789 ": {
          mode: "focused",
          selectedAgentId: " agent-2 ",
          filter: "running",
        },
        bad: {
          mode: "nope",
          selectedAgentId: 12,
          filter: "bad-filter",
        },
      },
    });

    expect(normalized.focused["ws://localhost:18789"]).toEqual({
      mode: "focused",
      selectedAgentId: "agent-2",
      filter: "running",
    });
    expect(normalized.focused.bad).toEqual({
      mode: "focused",
      selectedAgentId: null,
      filter: "all",
    });
  });

  it("normalizes_legacy_idle_filter_to_approvals", () => {
    const normalized = normalizeStudioSettings({
      focused: {
        "ws://localhost:18789": {
          mode: "focused",
          selectedAgentId: "agent-1",
          filter: "idle",
        },
      },
    });

    expect(normalized.focused["ws://localhost:18789"]).toEqual({
      mode: "focused",
      selectedAgentId: "agent-1",
      filter: "approvals",
    });
  });

  it("merges_dual_mode_preferences", () => {
    const current = normalizeStudioSettings({
      focused: {
        "ws://localhost:18789": {
          mode: "focused",
          selectedAgentId: "main",
          filter: "all",
        },
      },
    });

    const merged = mergeStudioSettings(current, {
      focused: {
        "ws://localhost:18789": {
          filter: "approvals",
        },
      },
    });

    expect(merged.focused["ws://localhost:18789"]).toEqual({
      mode: "focused",
      selectedAgentId: "main",
      filter: "approvals",
    });
  });

  it("merges focused patches across loopback aliases under one key", () => {
    const current = normalizeStudioSettings({
      focused: {
        "ws://localhost:18789": {
          mode: "focused",
          selectedAgentId: "agent-1",
          filter: "all",
        },
      },
    });

    const merged = mergeStudioSettings(current, {
      focused: {
        "ws://127.0.0.1:18789": {
          selectedAgentId: "agent-2",
        },
      },
    });

    expect(merged.focused).toEqual({
      "ws://localhost:18789": {
        mode: "focused",
        selectedAgentId: "agent-2",
        filter: "all",
      },
    });
  });

  it("merges focused patches across ipv6 loopback aliases under one key", () => {
    const current = normalizeStudioSettings({
      focused: {
        "ws://localhost:18789": {
          mode: "focused",
          selectedAgentId: "agent-1",
          filter: "all",
        },
      },
    });

    const merged = mergeStudioSettings(current, {
      focused: {
        "ws://[::1]:18789": {
          selectedAgentId: "agent-2",
        },
      },
    });

    expect(merged.focused).toEqual({
      "ws://localhost:18789": {
        mode: "focused",
        selectedAgentId: "agent-2",
        filter: "all",
      },
    });
  });

  it("preserves gateway token when patching only an equivalent loopback url", () => {
    const current = normalizeStudioSettings({
      gateway: { url: "ws://127.0.0.1:18789", token: "secret-token" },
    });

    const merged = mergeStudioSettings(current, {
      gateway: { url: "ws://[::1]:18789" },
    });

    expect(merged.gateway).toEqual({
      url: "ws://localhost:18789",
      token: "secret-token",
    });
  });

  it("clears gateway token when a url-only patch changes upstream", () => {
    const current = normalizeStudioSettings({
      gateway: { url: "wss://gateway.old.example", token: "secret-token" },
    });

    const merged = mergeStudioSettings(current, {
      gateway: { url: "wss://gateway.new.example" },
    });

    expect(merged.gateway).toEqual({
      url: "wss://gateway.new.example",
      token: "",
    });
  });

  it("normalizes avatar seeds per gateway", () => {
    const normalized = normalizeStudioSettings({
      avatars: {
        " ws://localhost:18789 ": {
          " agent-1 ": " seed-1 ",
          " agent-2 ": " ",
        },
        bad: "nope",
      },
    });

    expect(normalized.avatars["ws://localhost:18789"]).toEqual({
      "agent-1": "seed-1",
    });
  });

  it("merges avatar patches", () => {
    const current = normalizeStudioSettings({
      avatars: {
        "ws://localhost:18789": {
          "agent-1": "seed-1",
        },
      },
    });

    const merged = mergeStudioSettings(current, {
      avatars: {
        "ws://localhost:18789": {
          "agent-1": "seed-2",
          "agent-2": "seed-3",
        },
      },
    });

    expect(merged.avatars["ws://localhost:18789"]).toEqual({
      "agent-1": "seed-2",
      "agent-2": "seed-3",
    });
  });
});
