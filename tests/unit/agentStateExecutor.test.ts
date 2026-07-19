import { beforeEach, describe, expect, it, vi } from "vitest";

import { runSshJson } from "@/lib/ssh/gateway-host";
import {
  restoreAgentStateOverSsh,
  trashAgentStateOverSsh,
} from "@/lib/ssh/agent-state";

vi.mock("@/lib/ssh/gateway-host", () => ({
  runSshJson: vi.fn(),
}));

describe("agent state ssh executor", () => {
  const mockedRunSshJson = vi.mocked(runSshJson);

  beforeEach(() => {
    mockedRunSshJson.mockReset();
  });

  it("trashes agent state via ssh", () => {
    mockedRunSshJson.mockReturnValueOnce({ trashDir: "/tmp/trash", moved: [] });

    const result = trashAgentStateOverSsh({ sshTarget: "me@host", agentId: "my-agent" });

    expect(result).toEqual({ trashDir: "/tmp/trash", moved: [] });
    expect(runSshJson).toHaveBeenCalledTimes(1);
    expect(runSshJson).toHaveBeenCalledWith(
      expect.objectContaining({
        sshTarget: "me@host",
        argv: ["bash", "-s", "--", "my-agent"],
        label: "trash agent state (my-agent)",
        input: expect.stringContaining('python3 - "$1"'),
      })
    );
    const call = mockedRunSshJson.mock.calls[0]?.[0];
    expect(call?.input).toContain("workspace-{agent_id}");
    expect(call?.input).toContain("rollback_moves");
    expect(call?.input).toContain("Rollback also failed");
  });

  it("restores agent state via ssh", () => {
    mockedRunSshJson.mockReturnValueOnce({ restored: [] });

    const result = restoreAgentStateOverSsh({
      sshTarget: "me@host",
      agentId: "my-agent",
      trashDir: "/tmp/trash",
    });

    expect(result).toEqual({ restored: [] });
    expect(runSshJson).toHaveBeenCalledTimes(1);
    expect(runSshJson).toHaveBeenCalledWith(
      expect.objectContaining({
        sshTarget: "me@host",
        argv: ["bash", "-s", "--", "my-agent", "/tmp/trash"],
        label: "restore agent state (my-agent)",
        input: expect.stringContaining('python3 - "$1" "$2"'),
      })
    );
    const call = mockedRunSshJson.mock.calls[0]?.[0];
    expect(call?.input).toContain("Refusing to restore source outside trashDir");
    expect(call?.input).toContain("Refusing to restore symlink outside stateDir");
    expect(call?.input).toContain("resolve_restored_symlink_target(dest, os.readlink(src))");
    expect(call?.input).toContain('trash_root = base / "trash" / "studio-delete-agent"');
    expect(call?.input).toContain("trashDir is not under {trash_root}");
    expect(call?.input).not.toMatch(/^\t/m);
    expect(call?.input).toContain("rollback_moves");
    expect(call?.input).toContain("Rollback also failed");
  });
});
