import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { restoreAgentStateLocally, trashAgentStateLocally } from "@/lib/agent-state/local";

const tmpDirs: string[] = [];
const mkTmpStateDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-studio-test-"));
  tmpDirs.push(dir);
  return dir;
};

describe("agent state local", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = originalStateDir;
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trashes and restores agent workspace + state", () => {
    const stateDir = mkTmpStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const agentId = "test-agent";
    const workspace = path.join(stateDir, `workspace-${agentId}`);
    const agentDir = path.join(stateDir, "agents", agentId);
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(workspace, "hello.txt"), "hi", "utf8");
    fs.writeFileSync(path.join(agentDir, "state.json"), "{}", "utf8");

    const trashed = trashAgentStateLocally({ agentId });
    expect(fs.existsSync(workspace)).toBe(false);
    expect(fs.existsSync(agentDir)).toBe(false);
    expect(fs.existsSync(trashed.trashDir)).toBe(true);

    const restored = restoreAgentStateLocally({ agentId, trashDir: trashed.trashDir });
    expect(restored.restored.length).toBeGreaterThan(0);
    expect(fs.existsSync(workspace)).toBe(true);
    expect(fs.existsSync(agentDir)).toBe(true);
    expect(fs.readFileSync(path.join(workspace, "hello.txt"), "utf8")).toBe("hi");
  });

  it("trashes broken symlink state entries instead of leaving them behind", () => {
    const stateDir = mkTmpStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const agentId = "test-agent";
    const workspace = path.join(stateDir, `workspace-${agentId}`);
    const missingTarget = path.join(stateDir, "missing-workspace-target");
    fs.symlinkSync(missingTarget, workspace, "dir");

    const trashed = trashAgentStateLocally({ agentId });

    const trashedWorkspace = path.join(
      trashed.trashDir,
      "workspaces",
      `workspace-${agentId}`
    );
    expect(fs.lstatSync(trashedWorkspace).isSymbolicLink()).toBe(true);
    expect(() => fs.lstatSync(workspace)).toThrow();
  });

  it("restores trashed broken symlink state entries when the restored target stays in state", () => {
    const stateDir = mkTmpStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const agentId = "test-agent";
    const workspace = path.join(stateDir, `workspace-${agentId}`);
    const missingTarget = path.join(stateDir, "missing-workspace-target");
    fs.symlinkSync(missingTarget, workspace, "dir");

    const trashed = trashAgentStateLocally({ agentId });
    const restored = restoreAgentStateLocally({ agentId, trashDir: trashed.trashDir });

    expect(restored.restored.map((move) => move.to)).toContain(workspace);
    expect(fs.lstatSync(workspace).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(workspace)).toBe(missingTarget);
  });

  it("restores symlink sources when the restored target stays in state", () => {
    const stateDir = mkTmpStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const agentId = "test-agent";
    const trashDir = path.join(stateDir, "trash", "studio-delete-agent", "restore-test");
    const workspaceSource = path.join(trashDir, "workspaces", `workspace-${agentId}`);
    const workspaceDest = path.join(stateDir, `workspace-${agentId}`);
    fs.mkdirSync(path.dirname(workspaceSource), { recursive: true });
    fs.symlinkSync("workspace-target", workspaceSource, "dir");

    const restored = restoreAgentStateLocally({ agentId, trashDir });

    expect(restored.restored.map((move) => move.to)).toContain(workspaceDest);
    expect(fs.lstatSync(workspaceDest).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(workspaceDest)).toBe("workspace-target");
  });

  it("refuses to restore a symlink source that would escape state after restore", () => {
    const stateDir = mkTmpStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const agentId = "test-agent";
    const trashDir = path.join(stateDir, "trash", "studio-delete-agent", "restore-test");
    const workspaceSource = path.join(trashDir, "workspaces", `workspace-${agentId}`);
    const outsideWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-studio-outside-"));
    tmpDirs.push(outsideWorkspace);
    fs.mkdirSync(path.dirname(workspaceSource), { recursive: true });
    fs.mkdirSync(path.join(trashDir, "agents"), { recursive: true });
    fs.symlinkSync(outsideWorkspace, workspaceSource, "dir");

    expect(() => restoreAgentStateLocally({ agentId, trashDir })).toThrow(
      "Refusing to restore symlink outside stateDir"
    );
    expect(fs.existsSync(path.join(stateDir, `workspace-${agentId}`))).toBe(false);
    expect(fs.existsSync(outsideWorkspace)).toBe(true);
  });

  it("refuses to restore broken symlink sources that would point outside state", () => {
    const stateDir = mkTmpStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const agentId = "test-agent";
    const trashDir = path.join(stateDir, "trash", "studio-delete-agent", "restore-test");
    const workspaceSource = path.join(trashDir, "workspaces", `workspace-${agentId}`);
    fs.mkdirSync(path.dirname(workspaceSource), { recursive: true });
    fs.symlinkSync(path.join(os.tmpdir(), "missing-openclaw-studio-target"), workspaceSource, "dir");

    expect(() => restoreAgentStateLocally({ agentId, trashDir })).toThrow(
      "Refusing to restore symlink outside stateDir"
    );
    expect(fs.existsSync(path.join(stateDir, `workspace-${agentId}`))).toBe(false);
  });

  it("refuses relative symlinks whose restored target would escape state", () => {
    const stateDir = mkTmpStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const agentId = "test-agent";
    const trashDir = path.join(stateDir, "trash", "studio-delete-agent", "restore-test");
    const workspaceSource = path.join(trashDir, "workspaces", `workspace-${agentId}`);
    fs.mkdirSync(path.dirname(workspaceSource), { recursive: true });
    fs.symlinkSync("../outside-state", workspaceSource, "dir");

    expect(() => restoreAgentStateLocally({ agentId, trashDir })).toThrow(
      "Refusing to restore symlink outside stateDir"
    );
    expect(fs.existsSync(path.join(stateDir, `workspace-${agentId}`))).toBe(false);
  });

  it("refuses symlink restore targets that resolve outside state through another symlink", () => {
    const stateDir = mkTmpStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const agentId = "test-agent";
    const trashDir = path.join(stateDir, "trash", "studio-delete-agent", "restore-test");
    const workspaceSource = path.join(trashDir, "workspaces", `workspace-${agentId}`);
    const outsideWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-studio-outside-"));
    tmpDirs.push(outsideWorkspace);
    fs.mkdirSync(path.dirname(workspaceSource), { recursive: true });
    fs.symlinkSync(outsideWorkspace, path.join(stateDir, "redirect"), "dir");
    fs.symlinkSync("redirect/restored-workspace", workspaceSource, "dir");

    expect(() => restoreAgentStateLocally({ agentId, trashDir })).toThrow(
      "Refusing to restore symlink outside stateDir"
    );
    expect(fs.existsSync(path.join(stateDir, `workspace-${agentId}`))).toBe(false);
    expect(fs.existsSync(outsideWorkspace)).toBe(true);
  });

  it("refuses to restore from non-Studio trash directories under the state dir", () => {
    const stateDir = mkTmpStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const agentId = "test-agent";
    const trashDir = path.join(stateDir, "agents", "restore-test");
    fs.mkdirSync(path.join(trashDir, "workspaces", `workspace-${agentId}`), { recursive: true });

    expect(() => restoreAgentStateLocally({ agentId, trashDir })).toThrow(
      "trashDir is not under"
    );
    expect(fs.existsSync(path.join(stateDir, `workspace-${agentId}`))).toBe(false);
  });

  it("refuses to restore over an existing broken symlink destination", () => {
    const stateDir = mkTmpStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const agentId = "test-agent";
    const trashDir = path.join(stateDir, "trash", "studio-delete-agent", "restore-test");
    const workspaceSource = path.join(trashDir, "workspaces", `workspace-${agentId}`);
    const workspaceDest = path.join(stateDir, `workspace-${agentId}`);
    fs.mkdirSync(workspaceSource, { recursive: true });
    fs.symlinkSync(path.join(stateDir, "missing-destination-target"), workspaceDest, "dir");

    expect(() => restoreAgentStateLocally({ agentId, trashDir })).toThrow(
      "Refusing to restore over existing path"
    );
    expect(fs.existsSync(workspaceSource)).toBe(true);
    expect(fs.lstatSync(workspaceDest).isSymbolicLink()).toBe(true);
  });

  it("rolls back already-moved state when trashing fails partway through", () => {
    const stateDir = mkTmpStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const agentId = "test-agent";
    const workspace = path.join(stateDir, `workspace-${agentId}`);
    const agentDir = path.join(stateDir, "agents", agentId);
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(workspace, "hello.txt"), "hi", "utf8");
    fs.writeFileSync(path.join(agentDir, "state.json"), "{}", "utf8");

    const originalRenameSync = fs.renameSync.bind(fs);
    let renameCount = 0;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      renameCount += 1;
      if (renameCount === 2) {
        throw new Error("simulated second move failure");
      }
      return originalRenameSync(from, to);
    });

    try {
      expect(() => trashAgentStateLocally({ agentId })).toThrow("simulated second move failure");
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.existsSync(workspace)).toBe(true);
    expect(fs.existsSync(agentDir)).toBe(true);
    expect(fs.readFileSync(path.join(workspace, "hello.txt"), "utf8")).toBe("hi");
  });

  it("rolls back already-restored state when restore fails partway through", () => {
    const stateDir = mkTmpStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const agentId = "test-agent";
    const trashDir = path.join(stateDir, "trash", "studio-delete-agent", "restore-test");
    const workspaceSource = path.join(trashDir, "workspaces", `workspace-${agentId}`);
    const agentSource = path.join(trashDir, "agents", agentId);
    const workspaceDest = path.join(stateDir, `workspace-${agentId}`);
    const agentDest = path.join(stateDir, "agents", agentId);
    fs.mkdirSync(workspaceSource, { recursive: true });
    fs.mkdirSync(agentSource, { recursive: true });
    fs.writeFileSync(path.join(workspaceSource, "hello.txt"), "hi", "utf8");
    fs.writeFileSync(path.join(agentSource, "state.json"), "{}", "utf8");

    const originalRenameSync = fs.renameSync.bind(fs);
    let renameCount = 0;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      renameCount += 1;
      if (renameCount === 2) {
        throw new Error("simulated restore failure");
      }
      return originalRenameSync(from, to);
    });

    try {
      expect(() => restoreAgentStateLocally({ agentId, trashDir })).toThrow("simulated restore failure");
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.existsSync(workspaceSource)).toBe(true);
    expect(fs.existsSync(agentSource)).toBe(true);
    expect(fs.existsSync(workspaceDest)).toBe(false);
    expect(fs.existsSync(agentDest)).toBe(false);
    expect(fs.readFileSync(path.join(workspaceSource, "hello.txt"), "utf8")).toBe("hi");
  });
});
